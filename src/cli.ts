import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { resolve } from "node:path";
import { loadOutputs } from "./outputs.ts";
import { type SherpaTts, startReading } from "./playback.ts";
import { openReadingLock } from "./reading-lock.ts";
import { loadSpeed, parseSpeed, SPEED_HINT } from "./settings.ts";
import { speechNarration } from "./speech-text.ts";
import { downloadVoice, findVoice, SPEAKERS, type SpeakerName, type Voice, VOICE_ARCHIVE, type VoiceArchive } from "./voice.ts";

/** What `reply-reader --help` prints (S6). */
export const USAGE = `Usage: reply-reader [options] <file.md | ->

Reads a Markdown file aloud with local text-to-speech; "-" reads standard input.

Options:
  --output <name>      where it sounds: local (default) or a name from outputs.json
  --speed <n>          voice speed from 0.5 to 2.0 for this run (default: the saved speed, else 1.1)
  --voice male|female  the voice (default: male)
  -h, --help           show this help

Ctrl+C stops the reading.
Exit codes: 0 read (or nothing to read), 1 cannot read, download or play, 2 bad arguments, 130 stopped with Ctrl+C.
`;

/** Exit codes of the command. */
const OK = 0;
const FAILED = 1;
const USAGE_ERROR = 2;
const INTERRUPTED = 130;

/** How often a reading checks whether a newer one, or /read-stop, in another session took over (as /read does). */
const WATCH_MS = 250;
const SPEAKER_NAMES = Object.keys(SPEAKERS) as SpeakerName[];

export interface CliDeps {
	env: NodeJS.ProcessEnv;
	/** Where a relative file path starts. */
	cwd?: string;
	hostname?: string;
	stdin: AsyncIterable<Buffer | string>;
	stdout: { write(text: string): unknown };
	stderr: { write(text: string): unknown };
	/** Whether a person can answer the download confirm (standard input and error are a terminal). */
	isTTY: boolean;
	/** Asks the y/N download question; only called when `isTTY`. */
	confirm: (message: string) => Promise<boolean>;
	loadSherpa?: (voice: Voice) => Promise<SherpaTts>;
	/** Aborted on Ctrl+C: the reading or download stops and the command exits 130. */
	signal?: AbortSignal;
	/** The voice archive to download; the pinned one unless a test serves its own. */
	archive?: VoiceArchive;
}

interface Options {
	file: string;
	output: string;
	speed?: string;
	voice: string;
}

/** Why a Markdown file could not be read, in the user's words (the same reasons as `/read <file.md>`). */
export function readProblem(error: NodeJS.ErrnoException): string {
	if (error.code === "ENOENT") return "file not found";
	if (error.code === "EISDIR") return "it is a folder";
	if (error.code === "EACCES" || error.code === "EPERM") return "permission denied";
	return error.message;
}

/** The options, `"help"`, or the problem with the arguments. */
function parse(argv: string[]): Options | "help" | { problem: string } {
	const files: string[] = [];
	const values: Record<"output" | "speed" | "voice", string | undefined> = { output: undefined, speed: undefined, voice: undefined };
	let rest = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (rest || arg === "-" || !arg.startsWith("-")) {
			files.push(arg);
			continue;
		}
		if (arg === "--") {
			rest = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") return "help";
		const name = arg.slice(2);
		if (arg !== `--${name}` || !Object.hasOwn(values, name)) return { problem: `unknown option "${arg}"` };
		if (i + 1 >= argv.length) return { problem: `${arg} needs a value` };
		values[name as keyof typeof values] = argv[++i];
	}
	if (files.length === 0) return { problem: "no file given" };
	if (files.length > 1) return { problem: "only one file can be read" };
	return { file: files[0], output: values.output ?? "local", speed: values.speed, voice: values.voice ?? "male" };
}

/**
 * `reply-reader <file.md>` (S6): reads a Markdown file, or standard input with "-", aloud from a terminal without Pi,
 * through the same cleanup (S2, S7), voice and download confirm, saved speed (S3), named outputs (S4) and one reading
 * per machine (S1) as `/read`; starting to read drops the auto-reads waiting in Pi sessions (S8). Resolves with the
 * exit code; nothing throws.
 */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
	const { env, stdout, stderr, signal } = deps;
	const say = (message: string): void => void stderr.write(`${message}\n`);

	const parsed = parse(argv);
	if (parsed === "help") {
		stdout.write(USAGE);
		return OK;
	}
	if ("problem" in parsed) {
		stderr.write(`reply-reader: ${parsed.problem}.\n\n${USAGE}`);
		return USAGE_ERROR;
	}

	let speed: number | undefined;
	if (parsed.speed !== undefined) {
		speed = parseSpeed(parsed.speed);
		if (speed === undefined) {
			say(SPEED_HINT);
			return USAGE_ERROR;
		}
	}
	if (!SPEAKER_NAMES.includes(parsed.voice as SpeakerName)) {
		say(`No voice named "${parsed.voice}". Voices: ${SPEAKER_NAMES.join(", ")}.`);
		return USAGE_ERROR;
	}
	const speaker = SPEAKERS[parsed.voice as SpeakerName];
	const { outputs, problems } = loadOutputs(env, deps.hostname ?? osHostname());
	const output = outputs.find((candidate) => candidate.name === parsed.output);
	if (!output) {
		say(`No output named "${parsed.output}". Outputs: ${outputs.map((o) => o.name).join(", ")}.`);
		return USAGE_ERROR;
	}

	const fromStdin = parsed.file === "-";
	let markdown: string;
	try {
		markdown = fromStdin ? await readAll(deps.stdin) : readFileSync(resolve(deps.cwd ?? process.cwd(), parsed.file), "utf8");
	} catch (error) {
		say(`Cannot read "${parsed.file}": ${readProblem(error as NodeJS.ErrnoException)}.`);
		return FAILED;
	}
	const narration = speechNarration(markdown);
	if (!narration.text) {
		say(`${fromStdin ? "Standard input" : parsed.file} has nothing to read.`);
		return OK;
	}

	// A typo in outputs.json must not silently send the reading elsewhere; it is reported as /read does.
	for (const problem of problems) say(problem);

	let voice = findVoice(env);
	if (!voice) {
		// Standard input is the text, so it cannot also answer the question.
		if (!deps.isTTY || fromStdin) {
			const megabytes = Math.round((deps.archive ?? VOICE_ARCHIVE).bytes / 1_000_000);
			say(
				`The voice is not installed and there is no terminal to confirm its download (${megabytes} MB). Run reply-reader from a terminal once to download it.`,
			);
			return FAILED;
		}
		try {
			voice = await downloadVoice({ env, confirm: deps.confirm, archive: deps.archive, signal });
		} catch (error) {
			if (signal?.aborted) return INTERRUPTED;
			say((error as Error).message);
			return FAILED;
		}
		if (signal?.aborted) return INTERRUPTED;
		if (!voice) {
			say("Reading cancelled: the voice was not downloaded.");
			return FAILED;
		}
	}

	if (speed === undefined) {
		const saved = loadSpeed(env);
		if (saved.problem) say(saved.problem);
		speed = saved.speed;
	}
	if (signal?.aborted) return INTERRUPTED;

	// Without a usable XDG_RUNTIME_DIR there is no claim, and only Ctrl+C stops this reading. Like a manual /read it drops
	// the auto-reads waiting in Pi sessions (S8, T33); it never asks.
	const claim = openReadingLock(env)?.claim({ dropWaiting: true });
	let interrupted = false;
	const reading = startReading({
		voice,
		speaker,
		fragments: narration.fragments,
		output,
		env,
		loadSherpa: deps.loadSherpa,
		speed,
		onPlayer: (pid) => {
			if (claim && !claim.setPlayer(pid)) reading.stop();
		},
	});
	const interrupt = (): void => {
		interrupted = true;
		reading.stop();
	};
	signal?.addEventListener("abort", interrupt, { once: true });
	// Stopped by a newer reading or /read-stop elsewhere: quietly, as a Pi session is.
	const watch = claim && setInterval(() => claim.lost() && reading.stop(), WATCH_MS);
	try {
		await reading.done;
	} catch (error) {
		// A player killed by a newer reading elsewhere fails; that is not an error here.
		if (!interrupted && !claim?.lost()) {
			say((error as Error).message);
			return FAILED;
		}
	} finally {
		clearInterval(watch || undefined);
		signal?.removeEventListener("abort", interrupt);
		claim?.release();
	}
	return interrupted ? INTERRUPTED : OK;
}

async function readAll(input: AsyncIterable<Buffer | string>): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of input) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks).toString("utf8");
}
