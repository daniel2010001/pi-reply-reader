import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, resolve } from "node:path";
import { loadOutputs } from "./outputs.ts";
import { serve, startOutputReading } from "./listener.ts";
import { createMusic, loadMusic } from "./music.ts";
import type { SherpaTts } from "./playback.ts";
import { checkDeathSignal, PLAYER_MARK, playerTimeoutMs, signalledPlayersEnded } from "./player.ts";
import { projectChanged, projectOf } from "./project.ts";
import { openReadingLock } from "./reading-lock.ts";
import { loadSpeed, parseSpeed, SPEED_HINT } from "./settings.ts";
import { projectAnnouncement, speechNarration } from "./speech-text.ts";
import { downloadVoice, findVoice, onPath, SPEAKERS, type SpeakerName, type Voice, VOICE_ARCHIVE, type VoiceArchive } from "./voice.ts";

/** What `reply-reader --help` prints (S6). */
export const USAGE = `Usage: reply-reader [options] <file.md | ->
       reply-reader --download-voice
       reply-reader --serve

Reads a Markdown file aloud with local text-to-speech; "-" reads standard input.

Options:
  --output <name>      where it sounds: local (default) or a name from outputs.json
  --speed <n>          voice speed from 0.5 to 2.0 for this run (default: the saved speed, else 1.1)
  --voice male|female  the voice (default: male)
  --download-voice     download the voice (asks first, so it needs a terminal) and exit
  --serve              act as a listener: play what an agent host sends over SSH (a listener output in outputs.json)
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

	// A listener (S20): the agent host runs `reply-reader --serve --client-name=pi-reply-reader` over SSH.
	if (argv[0] === "--serve") {
		const extra = argv.slice(1).find((arg) => arg !== PLAYER_MARK);
		if (extra !== undefined) {
			stderr.write(`reply-reader: --serve takes no other arguments ("${extra}").\n\n${USAGE}`);
			return USAGE_ERROR;
		}
		// The agent host gone (EPIPE on standard output, A5): the reading stops quietly, like standard input closing.
		const gone = new AbortController();
		const leave = (): void => gone.abort();
		signal?.addEventListener("abort", leave, { once: true });
		if (signal?.aborted) leave();
		const out = stdout as CliDeps["stdout"] & { on?: (event: "error", listener: () => void) => unknown };
		out.on?.("error", leave);
		const write = (text: string): void => {
			if (gone.signal.aborted) return;
			try {
				stdout.write(text);
			} catch {
				leave();
			}
		};
		try {
			return await serve({ env, stdin: deps.stdin, write, warn: say, loadSherpa: deps.loadSherpa, signal: gone.signal });
		} finally {
			signal?.removeEventListener("abort", leave);
			await signalledPlayersEnded();
		}
	}
	if (argv[0] === "--download-voice") {
		if (argv.length === 1) return downloadOnly(deps);
		stderr.write(`reply-reader: --download-voice takes no other arguments ("${argv[1]}").\n\n${USAGE}`);
		return USAGE_ERROR;
	}

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

	// The one-time setpriv check (S13 h) runs from here, while the file and the voice load; the first player waits for
	// it below, so a one-shot reading gets the death signal too. A terminal command is not Pi's UI thread: it may wait.
	const deathSignal = checkDeathSignal(onPath("setpriv", env));

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

	// An invalid REPLY_READER_PLAYER_TIMEOUT is reported once and the default used (S13 f).
	const timeoutMs = playerTimeoutMs(env, say);

	// At most the check's 2 s limit; Ctrl+C meanwhile ends the command.
	if (await untilAborted(deathSignal, signal)) return INTERRUPTED;

	// Without a usable XDG_RUNTIME_DIR there is no claim, and only Ctrl+C stops this reading. Like a manual /read it drops
	// the auto-reads waiting in Pi sessions (S8, T33); it never asks.
	const lock = openReadingLock(env);
	const claim = lock?.claim({ dropWaiting: true });
	// Music steps aside while it reads, here for a local or PULSE_SERVER output (a listener's steps aside there), and comes
	// back once nothing reads or waits on the machine; the command waits for that before it exits (S22).
	let musicWarned = false;
	const music = createMusic({
		env,
		settings: () => loadMusic(env).music,
		idle: () => (lock ? !lock.busy() && lock.waitingList().length === 0 : true),
		warn: (message) => {
			if (musicWarned) return;
			musicWarned = true;
			say(message);
		},
	});
	const stepAside = (): void => {
		const { problem } = loadMusic(env);
		if (problem && !musicWarned) {
			musicWarned = true;
			say(problem);
		}
		music.stepAside();
	};
	// A project other than the last reading's on the machine is said first (S19); without XDG_RUNTIME_DIR this process
	// remembers none, so it always is.
	const project = projectOf(deps.cwd ?? process.cwd());
	const said = projectChanged(env, project, {}) ? projectAnnouncement(project, narration.language) : [];
	let interrupted = false;
	const reading = startOutputReading({
		voice,
		speaker,
		fragments: [...said, ...narration.fragments],
		output,
		env,
		loadSherpa: deps.loadSherpa,
		speed,
		timeoutMs,
		onPlayer: (pid) => {
			if (claim && !claim.setPlayer(pid)) reading.stop();
		},
		// A listener that cannot read sends the reading through its fallback (S20); one reading, so said once. It sounds
		// here then, so the music here steps aside (S22).
		onFallback: (message) => {
			say(message);
			stepAside();
		},
		lost: () => claim?.lost() ?? false,
	});
	if (!output.ssh) stepAside();
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
		music.settle();
		await music.idle();
		// A player this command signalled (a reaped orphan, the reading it took over) gets its SIGKILL before the
		// command exits (S13 e).
		await signalledPlayersEnded();
	}
	return interrupted ? INTERRUPTED : OK;
}

/** Waits for `promise`; true when `signal` aborted first (or already had). */
async function untilAborted(promise: Promise<unknown>, signal: AbortSignal | undefined): Promise<boolean> {
	if (!signal) {
		await promise;
		return false;
	}
	if (signal.aborted) return true;
	let leave!: () => void;
	const aborted = new Promise<true>((done) => (leave = () => done(true)));
	signal.addEventListener("abort", leave, { once: true });
	try {
		return await Promise.race([promise.then(() => false), aborted]);
	} finally {
		signal.removeEventListener("abort", leave);
	}
}

/**
 * `reply-reader --download-voice` (S20: how a listener gets its voice, which `--serve` never downloads): asks y/N on a
 * terminal, then downloads it. Exit 0 when it is installed, 1 otherwise.
 */
async function downloadOnly(deps: CliDeps): Promise<number> {
	const { env, signal } = deps;
	const say = (message: string): void => void deps.stderr.write(`${message}\n`);
	const existing = findVoice(env);
	if (existing) {
		say(`The voice is already installed in ${dirname(dirname(existing.supertonic.ttsJson))}.`);
		return OK;
	}
	if (!deps.isTTY) {
		const megabytes = Math.round((deps.archive ?? VOICE_ARCHIVE).bytes / 1_000_000);
		say(`Downloading the voice (${megabytes} MB) needs a terminal to confirm it. Run reply-reader --download-voice from a terminal.`);
		return FAILED;
	}
	try {
		const voice = await downloadVoice({ env, confirm: deps.confirm, archive: deps.archive, signal });
		if (signal?.aborted) return INTERRUPTED;
		if (!voice) {
			say("Download cancelled: the voice was not downloaded.");
			return FAILED;
		}
		say(`Voice installed in ${dirname(dirname(voice.supertonic.ttsJson))}.`);
		return OK;
	} catch (error) {
		if (signal?.aborted) return INTERRUPTED;
		say((error as Error).message);
		return FAILED;
	}
}

async function readAll(input: AsyncIterable<Buffer | string>): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of input) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks).toString("utf8");
}
