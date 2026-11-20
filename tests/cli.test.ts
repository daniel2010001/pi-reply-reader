import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.ts";
import type { SherpaRequest, SherpaTts } from "../src/playback.ts";
import { openReadingLock } from "../src/reading-lock.ts";
import { PLAYER_MARK } from "../src/reading-lock.ts";
import { VOICE_ARCHIVE, type VoiceArchive } from "../src/voice.ts";
import { endProcessesOf } from "./processes.ts";

/**
 * T24 (S6, the standalone command): `reply-reader <file.md>` through main()'s public interface, with a fake paplay on
 * PATH, a fake engine and temporary HOME/XDG folders (never the real ones), plus real spawns of bin/reply-reader.ts.
 */

const BIN = resolve(import.meta.dirname, "..", "bin", "reply-reader.ts");
const BUNDLE = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11";
const MODEL_FILES = [
	"duration_predictor.int8.onnx",
	"text_encoder.int8.onnx",
	"vector_estimator.int8.onnx",
	"vocoder.int8.onnx",
	"tts.json",
	"unicode_indexer.bin",
	"voice.bin",
];

const USAGE = `Usage: reply-reader [options] <file.md | ->

Reads a Markdown file aloud with local text-to-speech; "-" reads standard input.

Options:
  --output <name>      where it sounds: local (default) or a name from outputs.json
  --speed <n>          voice speed from 0.5 to 2.0 for this run (default: the saved speed, else 1.1)
  --voice male|female  the voice (default: male)
  -h, --help           show this help

Ctrl+C stops the reading.
Exit codes: 0 read (or nothing to read), 1 cannot read, download or play, 2 bad arguments, 130 stopped with Ctrl+C.
`;

let root: string;
let env: NodeJS.ProcessEnv;
let synthesized: SherpaRequest[];
let server: Server | undefined;
let spawned: ChildProcess[];

beforeEach(() => {
	synthesized = [];
	spawned = [];
	root = mkdtempSync(join(tmpdir(), "reply-reader-cli-"));
	for (const dir of ["bin", "work", "run"]) mkdirSync(join(root, dir));
	env = {
		PATH: join(root, "bin"),
		HOME: join(root, "home"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_RUNTIME_DIR: join(root, "run"),
	};
	// The machine already remembers the project of `<root>/work`, as after an earlier reading there, so tests of other
	// rules hear no project (S19); the S19 tests read elsewhere or without XDG_RUNTIME_DIR.
	openReadingLock(env)!.swapProject("work");
});

afterEach(async () => {
	for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	server?.closeAllConnections();
	await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
	server = undefined;
	// Every player (and its children) this test started goes before its folder (L138: tests leaked fake players).
	await endProcessesOf(root);
	rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await sleep(10);
	}
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

function script(name: string, body: string): void {
	const path = join(root, "bin", name);
	writeFileSync(path, `#!/bin/sh\nPATH=/usr/bin:/bin\n${body}\n`);
	chmodSync(path, 0o755);
}

/** A paplay that records its PULSE_SERVER, pid and audio; with `hold` it plays until stopped (then exits 143). */
function fakePaplay(hold = false): void {
	const wait = hold ? `trap 'kill $! 2>/dev/null; exit 143' TERM; sleep 30 & wait;` : "";
	script("paplay", `echo "\${PULSE_SERVER-unset}" > "${root}/play.server"; echo $$ > "${root}/play.pid"; ${wait} cat > "${root}/play.audio"`);
}

function installVoice(hold = false): void {
	fakePaplay(hold);
	const dir = join(root, "data", "pi-reply-reader", "voices", BUNDLE);
	mkdirSync(dir, { recursive: true });
	for (const name of MODEL_FILES) writeFileSync(join(dir, name), name);
}

const loadSherpa = async (): Promise<SherpaTts> => ({
	sampleRate: 44100,
	async generateAsync(request) {
		synthesized.push(request);
		return { samples: new Float32Array(1).fill(0.125) };
	},
});

const texts = () => synthesized.map((request) => request.text);
const played = () => existsSync(join(root, "play.pid"));
const playerPid = () => Number(readFileSync(join(root, "play.pid"), "utf8"));
const settingsPath = () => join(root, "config", "pi-reply-reader", "settings.json");
const voicesDir = () => join(root, "data", "pi-reply-reader", "voices");

function writeConfig(name: string, content: string): void {
	mkdirSync(join(root, "config", "pi-reply-reader"), { recursive: true });
	writeFileSync(join(root, "config", "pi-reply-reader", name), content);
}

function note(name: string, content: string): void {
	writeFileSync(join(root, "work", name), content);
}

interface RunOptions {
	stdin?: string;
	isTTY?: boolean;
	confirm?: (message: string) => Promise<boolean>;
	signal?: AbortSignal;
	archive?: VoiceArchive;
	/** Where the command runs (S19 names its project); `<root>/work` by default. */
	cwd?: string;
}

/** Runs main() the way bin/reply-reader.ts does, capturing what it prints and its exit code. */
function run(argv: string[], options: RunOptions = {}) {
	let out = "";
	let err = "";
	const asked: string[] = [];
	const confirm = options.confirm ?? (async () => false);
	const code = main(argv, {
		env,
		cwd: options.cwd ?? join(root, "work"),
		hostname: "hs-node",
		stdin: Readable.from(options.stdin === undefined ? [] : [Buffer.from(options.stdin)]),
		stdout: { write: (text: string) => ((out += text), true) },
		stderr: { write: (text: string) => ((err += text), true) },
		isTTY: options.isTTY ?? false,
		confirm: async (message: string) => (asked.push(message), confirm(message)),
		loadSherpa,
		signal: options.signal,
		archive: options.archive,
	});
	return {
		code,
		asked,
		get out() {
			return out;
		},
		get err() {
			return err;
		},
	};
}

async function finished(argv: string[], options: RunOptions = {}) {
	const result = run(argv, options);
	return { code: await result.code, out: result.out, err: result.err, asked: result.asked };
}

describe("reply-reader command (S6)", () => {
	it("reads a Markdown file, cleaned for speech, with the male voice at the default speed on local, and exits 0", async () => {
		installVoice();
		note("notes.md", "# Notas\n\nHola **mundo**.");
		expect(await finished(["notes.md"])).toEqual({ code: 0, out: "", err: "", asked: [] });
		expect(texts()).toEqual(["Notas.", "Hola mundo."]);
		expect(synthesized.map((request) => [request.generationConfig.sid, request.generationConfig.speed])).toEqual([
			[6, 1.1],
			[6, 1.1],
		]);
		expect(readFileSync(join(root, "play.server"), "utf8")).toBe("unset\n");
		expect(readFileSync(join(root, "play.audio"))).toHaveLength((1 + 33075 + 1) * 2);
	});

	it("uses the English words of S7 for an English file", async () => {
		installVoice();
		note("en.md", "Run `/reload` and then read the notes, because the reader is ready for this.");
		expect((await finished(["en.md"])).code).toBe(0);
		expect(texts().join(" ")).toContain("the command reload");
	});

	it('"-" reads standard input', async () => {
		installVoice();
		expect(await finished(["-"], { stdin: "## Desde\n\nla entrada." })).toEqual({ code: 0, out: "", err: "", asked: [] });
		expect(texts()).toEqual(["Desde.", "la entrada."]);
	});

	it("--output <name> plays on that output from outputs.json", async () => {
		installVoice();
		writeConfig("outputs.json", JSON.stringify({ desktop: "tcp:127.0.0.1:4714" }));
		note("notes.md", "Hola.");
		expect(await finished(["--output", "desktop", "notes.md"])).toEqual({ code: 0, out: "", err: "", asked: [] });
		expect(readFileSync(join(root, "play.server"), "utf8")).toBe("tcp:127.0.0.1:4714\n");
	});

	it("an unknown --output lists the valid names on stderr and exits 2, with nothing synthesized or played", async () => {
		installVoice();
		writeConfig("outputs.json", JSON.stringify({ desktop: "tcp:127.0.0.1:4714" }));
		note("notes.md", "Hola.");
		expect(await finished(["--output", "nope", "notes.md"])).toEqual({
			code: 2,
			out: "",
			err: 'No output named "nope". Outputs: local, desktop.\n',
			asked: [],
		});
		expect(texts()).toEqual([]);
		expect(played()).toBe(false);
	});

	it("reports skipped entries of outputs.json on stderr and still reads", async () => {
		installVoice();
		writeConfig("outputs.json", JSON.stringify({ "bad name": "tcp:x" }));
		note("notes.md", "Hola.");
		const result = await finished(["notes.md"]);
		expect(result.code).toBe(0);
		expect(result.err).toBe(
			`Ignored output "bad name" in ${join(root, "config", "pi-reply-reader", "outputs.json")}: names use letters, digits and "-".\n`,
		);
		expect(texts()).toEqual(["Hola."]);
	});

	it("uses the saved speed when --speed is not given", async () => {
		installVoice();
		writeConfig("settings.json", '{ "speed": 1.5 }');
		note("notes.md", "Hola.");
		expect((await finished(["notes.md"])).code).toBe(0);
		expect(synthesized.map((request) => request.generationConfig.speed)).toEqual([1.5]);
	});

	it("--speed <n> overrides the saved speed for this run only, comma decimals too, and settings.json is left as it was", async () => {
		installVoice();
		writeConfig("settings.json", '{ "speed": 1.5, "other": true }\n');
		const before = readFileSync(settingsPath());
		note("notes.md", "Hola.");
		expect(await finished(["--speed", "1,3", "notes.md"])).toEqual({ code: 0, out: "", err: "", asked: [] });
		expect(synthesized.map((request) => request.generationConfig.speed)).toEqual([1.3]);
		expect(readFileSync(settingsPath())).toEqual(before);
	});

	it("an invalid --speed prints the speed message and exits 2, with nothing read or saved", async () => {
		installVoice();
		note("notes.md", "Hola.");
		for (const bad of ["3", "0.4", "abc", "1.2.3", ""]) {
			expect(await finished(["--speed", bad, "notes.md"])).toEqual({
				code: 2,
				out: "",
				err: "Speed must be a number from 0.5 to 2.0.\n",
				asked: [],
			});
		}
		expect(texts()).toEqual([]);
		expect(played()).toBe(false);
		expect(existsSync(settingsPath())).toBe(false);
	});

	it("warns about an invalid settings.json on stderr and reads at the default speed", async () => {
		installVoice();
		writeConfig("settings.json", "{ nope");
		note("notes.md", "Hola.");
		const result = await finished(["notes.md"]);
		expect(result.code).toBe(0);
		expect(result.err).toMatch(new RegExp(`^Ignored ${settingsPath().replace(/[.]/g, "\\.")}: not valid JSON \\(.*\\)\\. Readings use speed 1\\.1\\.\\n$`));
		expect(synthesized.map((request) => request.generationConfig.speed)).toEqual([1.1]);
	});

	it("--voice female reads with speaker 0, --voice male with speaker 6", async () => {
		installVoice();
		note("notes.md", "Hola.");
		expect((await finished(["--voice", "female", "notes.md"])).code).toBe(0);
		expect((await finished(["--voice", "male", "notes.md"])).code).toBe(0);
		expect(synthesized.map((request) => request.generationConfig.sid)).toEqual([0, 6]);
	});

	it("an unknown --voice lists the voices on stderr and exits 2", async () => {
		installVoice();
		note("notes.md", "Hola.");
		expect(await finished(["--voice", "robot", "notes.md"])).toEqual({
			code: 2,
			out: "",
			err: 'No voice named "robot". Voices: male, female.\n',
			asked: [],
		});
		expect(played()).toBe(false);
	});

	it("--help and -h print the usage to stdout and exit 0, reading nothing", async () => {
		installVoice();
		note("notes.md", "Hola.");
		expect(await finished(["--help"])).toEqual({ code: 0, out: USAGE, err: "", asked: [] });
		expect(await finished(["-h", "notes.md"])).toEqual({ code: 0, out: USAGE, err: "", asked: [] });
		expect(texts()).toEqual([]);
	});

	it("bad or missing arguments print the problem and the usage to stderr and exit 2", async () => {
		installVoice();
		note("notes.md", "Hola.");
		const cases: [string[], string][] = [
			[[], "no file given"],
			[["--loud", "notes.md"], 'unknown option "--loud"'],
			[["notes.md", "other.md"], "only one file can be read"],
			[["notes.md", "--output"], "--output needs a value"],
			[["--speed"], "--speed needs a value"],
			[["notes.md", "--voice"], "--voice needs a value"],
		];
		for (const [argv, problem] of cases) {
			expect(await finished(argv)).toEqual({ code: 2, out: "", err: `reply-reader: ${problem}.\n\n${USAGE}`, asked: [] });
		}
		expect(texts()).toEqual([]);
		expect(played()).toBe(false);
	});

	it('"--" ends the options, so a file named like an option can be read', async () => {
		installVoice();
		note("-notes.md", "Hola.");
		expect((await finished(["--", "-notes.md"])).code).toBe(0);
		expect(texts()).toEqual(["Hola."]);
	});

	it('a missing, folder or unreadable file prints `Cannot read "<path>": <reason>.` and exits 1, with no download prompt', async () => {
		fakePaplay();
		mkdirSync(join(root, "work", "folder.md"));
		note("locked.md", "Hola.");
		chmodSync(join(root, "work", "locked.md"), 0o000);
		const cases: [string, string][] = [
			["nope.md", "file not found"],
			["folder.md", "it is a folder"],
			["P12.R1", "file not found"],
		];
		if (process.getuid?.() !== 0) cases.push(["locked.md", "permission denied"]);
		for (const [path, reason] of cases) {
			expect(await finished([path], { isTTY: true, confirm: async () => true })).toEqual({
				code: 1,
				out: "",
				err: `Cannot read "${path}": ${reason}.\n`,
				asked: [],
			});
		}
		expect(texts()).toEqual([]);
		expect(played()).toBe(false);
		expect(existsSync(voicesDir())).toBe(false);
	});

	it("a file or standard input with nothing to read says so and exits 0, with nothing played", async () => {
		installVoice();
		note("empty.md", "  \n\n");
		expect(await finished(["empty.md"])).toEqual({ code: 0, out: "", err: "empty.md has nothing to read.\n", asked: [] });
		expect(await finished(["-"], { stdin: "\n" })).toEqual({ code: 0, out: "", err: "Standard input has nothing to read.\n", asked: [] });
		expect(texts()).toEqual([]);
		expect(played()).toBe(false);
	});

	it("without a terminal, a missing voice is an error with exit 1 and nothing is asked or downloaded", async () => {
		fakePaplay();
		note("notes.md", "Hola.");
		expect(await finished(["notes.md"], { isTTY: false, confirm: async () => true })).toEqual({
			code: 1,
			out: "",
			err: "The voice is not installed and there is no terminal to confirm its download (129 MB). Run reply-reader from a terminal once to download it.\n",
			asked: [],
		});
		expect(existsSync(voicesDir())).toBe(false);
		expect(played()).toBe(false);
	});

	it("reading standard input never asks for the download, even on a terminal", async () => {
		fakePaplay();
		const result = await finished(["-"], { stdin: "Hola.", isTTY: true, confirm: async () => true });
		expect(result.code).toBe(1);
		expect(result.asked).toEqual([]);
		expect(existsSync(voicesDir())).toBe(false);
	});

	it("on a terminal, a missing voice asks first; declining downloads nothing and exits 1", async () => {
		fakePaplay();
		note("notes.md", "Hola.");
		expect(await finished(["notes.md"], { isTTY: true, confirm: async () => false })).toEqual({
			code: 1,
			out: "",
			err: "Reading cancelled: the voice was not downloaded.\n",
			asked: [`Download the Spanish voice Supertonic 3 (129 MB) from github.com into ${voicesDir()}?`],
		});
		expect(existsSync(join(voicesDir(), BUNDLE))).toBe(false);
		expect(played()).toBe(false);
	});

	it("on a terminal, accepting downloads the voice and then reads", async () => {
		fakePaplay();
		note("notes.md", "Hola.");
		const archive = await serveArchive();
		const result = await finished(["notes.md"], { isTTY: true, confirm: async () => true, archive });
		expect(result.code).toBe(0);
		expect(result.asked).toHaveLength(1);
		expect(existsSync(join(voicesDir(), BUNDLE, "tts.json"))).toBe(true);
		expect(texts()).toEqual(["Hola."]);
	});

	it("a failed download prints why and exits 1, keeping nothing", async () => {
		fakePaplay();
		note("notes.md", "Hola.");
		const archive = { ...(await serveArchive()), sha256: "0".repeat(64) };
		const result = await finished(["notes.md"], { isTTY: true, confirm: async () => true, archive });
		expect(result.code).toBe(1);
		expect(result.err).toMatch(/^Voice download failed: sha256 mismatch .*\. Nothing was kept\.\n$/);
		expect(readdirSync(voicesDir())).toEqual([]);
		expect(played()).toBe(false);
	});

	it("Ctrl+C during the download stops it, keeps nothing and exits 130", async () => {
		fakePaplay();
		note("notes.md", "Hola.");
		const archive = await serveArchive({ stall: true });
		const interrupt = new AbortController();
		const result = run(["notes.md"], { isTTY: true, confirm: async () => true, archive, signal: interrupt.signal });
		await waitFor(() => existsSync(voicesDir()) && readdirSync(voicesDir()).length > 0);
		interrupt.abort();
		expect(await Promise.race([result.code, sleep(5000).then(() => "still downloading")])).toBe(130);
		expect(readdirSync(voicesDir())).toEqual([]);
		expect(played()).toBe(false);
	});

	it("Ctrl+C stops the player and exits 130, releasing the machine-wide reading", async () => {
		installVoice(true);
		note("notes.md", "Hola.");
		const interrupt = new AbortController();
		const result = run(["notes.md"], { signal: interrupt.signal });
		await waitFor(played);
		const pid = playerPid();
		expect(existsSync(join(root, "run", "pi-reply-reader", "reading.json"))).toBe(true);
		interrupt.abort();
		expect(await result.code).toBe(130);
		await waitFor(() => !alive(pid));
		expect(result.err).toBe("");
		expect(existsSync(join(root, "run", "pi-reply-reader", "reading.json"))).toBe(false);
	});

	it("a player that fails prints the error on stderr and exits 1", async () => {
		installVoice();
		script("paplay", 'cat > /dev/null; echo "Connection refused" >&2; exit 1');
		note("notes.md", "Hola.");
		expect(await finished(["notes.md"])).toEqual({ code: 1, out: "", err: 'Playback on "local" failed: Connection refused\n', asked: [] });
	});

	it("one reading per machine: a newer reading elsewhere (/read in Pi) stops this one quietly, exit 0", async () => {
		installVoice(true);
		note("notes.md", "Hola.");
		const result = run(["notes.md"]);
		await waitFor(played);
		const pid = playerPid();
		await waitFor(() => readFileSync(join(root, "run", "pi-reply-reader", "reading.json"), "utf8").includes('"player"'));
		// A fake second reader: what /read in another Pi session does first.
		const other = openReadingLock(env)!.claim();
		expect(await Promise.race([result.code, sleep(5000).then(() => "still playing")])).toBe(0);
		await waitFor(() => !alive(pid));
		expect(result.err).toBe("");
		// The CLI must not drop the newer reading's entry.
		expect(other.lost()).toBe(false);
		other.release();
	});

	it("one reading per machine: this reading stops the one playing elsewhere", async () => {
		installVoice();
		note("notes.md", "Hola.");
		// A fake reader in another session: its player carries the mark the lock checks.
		const otherPlayer = spawn("/bin/sh", ["-c", "sleep 30; :", "paplay", PLAYER_MARK], { stdio: "ignore" });
		spawned.push(otherPlayer);
		const exited = new Promise((done) => otherPlayer.on("exit", (_code, signal) => done(signal)));
		const other = openReadingLock(env)!.claim();
		expect(other.setPlayer(otherPlayer.pid!)).toBe(true);
		expect((await finished(["notes.md"])).code).toBe(0);
		expect(await exited).toBe("SIGTERM");
	});

	it("(S13 e) a lock takeover kills a TERM-ignoring player elsewhere before the command finishes", { timeout: 15000 }, async () => {
		installVoice();
		note("notes.md", "Hola.");
		const otherPlayer = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 0.1; done", "paplay", PLAYER_MARK], { stdio: "ignore" });
		spawned.push(otherPlayer);
		const ended = new Promise((done) => otherPlayer.on("exit", (_code, signal) => done(signal)));
		await sleep(200);
		const other = openReadingLock(env)!.claim();
		expect(other.setPlayer(otherPlayer.pid!)).toBe(true);
		expect((await finished(["notes.md"])).code).toBe(0);
		expect(await Promise.race([ended, sleep(300).then(() => "still running")])).toBe("SIGKILL");
	});

	it("drops the auto-reads waiting in Pi sessions when it starts reading, as a manual /read does, and never asks (S8)", async () => {
		installVoice();
		note("notes.md", "Hola.");
		// Another reader's reading holds the machine; its player carries the mark the lock checks.
		const otherPlayer = spawn("/bin/sh", ["-c", "sleep 30; :", "paplay", PLAYER_MARK], { stdio: "ignore" });
		spawned.push(otherPlayer);
		const other = openReadingLock(env)!.claim();
		expect(other.setPlayer(otherPlayer.pid!)).toBe(true);
		writeFileSync(join(root, "pi.mjs"), PI_SESSION);
		const pi = spawn(process.execPath, [join(root, "pi.mjs"), EXTENSION, JSON.stringify(env), root], { stdio: "ignore" });
		spawned.push(pi);
		const seen = () => JSON.parse(readFileSync(join(root, "pi.json"), "utf8")) as { statuses: unknown[]; notes: unknown[]; asked: unknown[]; waiting: boolean };
		await waitFor(() => existsSync(join(root, "pi.json")) && seen().waiting, 10000);
		await sleep(600);
		expect(seen().statuses).toEqual([]);
		expect(await finished(["notes.md"])).toEqual({ code: 0, out: "", err: "", asked: [] });
		expect(texts()).toEqual(["Hola."]);
		// Free now: a reply still waiting would start within the reader's 250 ms checks.
		await sleep(900);
		expect(seen()).toEqual({ statuses: [], notes: [["Auto-read on: full replies.", "info"]], asked: [], waiting: true });
	}, 20000);

	it("(S19) says the project (its working folder's Git root) when it differs from the last reading's on the machine", async () => {
		installVoice();
		for (const repo of ["p1", "p2"]) mkdirSync(join(root, repo, ".git"), { recursive: true });
		mkdirSync(join(root, "p1", "docs"));
		writeFileSync(join(root, "notas.md"), "Hola.");
		const file = join(root, "notas.md");
		const readIn = async (cwd: string) => {
			const before = synthesized.length;
			expect(await finished([file], { cwd })).toEqual({ code: 0, out: "", err: "", asked: [] });
			return texts().slice(before);
		};
		expect(await readIn(join(root, "p1", "docs"))).toEqual(["p uno.", "Hola."]);
		expect(await readIn(join(root, "p1"))).toEqual(["Hola."]);
		expect(await readIn(join(root, "p2"))).toEqual(["p dos.", "Hola."]);
		expect(await readIn(join(root, "p1"))).toEqual(["p uno.", "Hola."]);
	});

	it("(S19) without a usable XDG_RUNTIME_DIR each run is its own process: it always says the project", async () => {
		installVoice();
		delete env.XDG_RUNTIME_DIR;
		note("notes.md", "Hola.");
		expect((await finished(["notes.md"])).code).toBe(0);
		expect((await finished(["notes.md"])).code).toBe(0);
		expect(texts()).toEqual(["work.", "Hola.", "work.", "Hola."]);
	});
});

const TIMEOUT_HINT = "REPLY_READER_PLAYER_TIMEOUT must be a number of seconds from 5 to 86400; using 15.";

/**
 * A marked player left by a reader that is gone (S13): it ignores SIGTERM, and its PI_REPLY_READER_OWNER names a
 * process that already exited.
 */
function deadOwnersPlayer(): ChildProcess {
	const gone = execFileSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).trim();
	const child = spawn("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 0.1; done", "paplay", PLAYER_MARK], {
		stdio: "ignore",
		env: { PATH: "/usr/bin:/bin", PI_REPLY_READER_OWNER: `${gone}:` },
	});
	spawned.push(child);
	return child;
}

const EXTENSION = pathToFileURL(resolve(import.meta.dirname, "..", "extensions", "reply-reader.ts")).href;

/**
 * A Pi session in its own process (as in tests/reading-lock.test.ts): loads the extension with a fake engine, turns
 * auto-read on, ends a turn with a reply, and keeps `<root>/pi.json` up to date with its footer, messages and every
 * question it was asked, until it is killed.
 */
const PI_SESSION = `
import { renameSync, writeFileSync } from "node:fs";
const [extension, envJson, root] = process.argv.slice(2);
const { createReplyReader } = await import(extension);
const state = { statuses: [], notes: [], asked: [], waiting: false };
const save = () => { writeFileSync(root + "/pi.json.tmp", JSON.stringify(state)); renameSync(root + "/pi.json.tmp", root + "/pi.json"); };
const commands = new Map();
const events = new Map();
const loadSherpa = async () => ({ sampleRate: 44100, async generateAsync() { return { samples: new Float32Array(1).fill(0.125) }; } });
createReplyReader({ env: JSON.parse(envJson), hostname: "hs-node", loadSherpa })({ registerCommand: (n, o) => commands.set(n, o), registerShortcut: () => {}, on: (e, h) => events.set(e, h) });
const message = (id, role, text) => ({ type: "message", id, timestamp: "t", message: role === "user" ? { role, content: text } : { role, stopReason: "stop", content: [{ type: "text", text }] } });
const branch = [message("u1", "user", "hola"), message("a1", "assistant", "Primera respuesta.")];
const ctx = {
	hasUI: true, mode: "tui", cwd: root, sessionManager: { getBranch: () => branch },
	ui: {
		notify: (text, type) => { state.notes.push([text, type]); save(); },
		select: async (title) => { state.asked.push(title); save(); return undefined; },
		confirm: async () => false,
		custom: async () => { state.asked.push("custom"); save(); return undefined; },
		setStatus: (_key, text) => { state.statuses.push(text ?? null); save(); },
		onTerminalInput: () => () => {},
	},
};
events.get("session_start")({ reason: "startup" }, ctx);
await commands.get("read-auto").handler("on", ctx);
// Pi stores each message after its message_end handlers return; the reader looks on the next turn (T42).
for (const entry of [message("u2", "user", "sigue"), message("a2", "assistant", "Uno.")]) {
	events.get("message_end")({ type: "message_end", message: entry.message }, ctx);
	branch.push(entry);
}
await new Promise((resolve) => setTimeout(resolve, 0));
state.waiting = true;
save();
setInterval(() => {}, 1000);
`;

/** The voice archive served from 127.0.0.1; with `stall` the server sends the headers and part of it, then waits. */
async function serveArchive(options: { stall?: boolean } = {}): Promise<VoiceArchive> {
	const staging = join(root, "staging");
	mkdirSync(join(staging, BUNDLE), { recursive: true });
	for (const name of MODEL_FILES) writeFileSync(join(staging, BUNDLE, name), name);
	const file = join(root, "voice.tar.bz2");
	execFileSync("tar", ["-cjf", file, "-C", staging, BUNDLE]);
	const body = readFileSync(file);
	server = createServer((_req, res) => {
		if (options.stall) {
			res.writeHead(200, { "content-length": body.length });
			res.write(body.subarray(0, 10));
			return;
		}
		res.writeHead(200).end(body);
	});
	await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
	const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/voice.tar.bz2`;
	return { ...VOICE_ARCHIVE, url, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
}

/**
 * The real command: bin/reply-reader.ts run by Node, with sherpa-onnx-node swapped for a fake engine through a module
 * hook (the bin itself has no test switch), a fake paplay and temporary HOME/XDG folders.
 */
describe("bin/reply-reader.ts", () => {
	function prepare(): string[] {
		const fake = join(root, "fake-sherpa.mjs");
		writeFileSync(
			fake,
			`import { appendFileSync } from "node:fs";
class GenerationConfig { constructor(options) { Object.assign(this, options); } }
const OfflineTts = {
	async createAsync() {
		return {
			sampleRate: 44100,
			async generateAsync({ text, generationConfig }) {
				appendFileSync(${JSON.stringify(join(root, "synth.log"))}, JSON.stringify([text, generationConfig.sid, generationConfig.speed]) + "\\n");
				return { samples: new Float32Array(1).fill(0.125), sampleRate: 44100 };
			},
		};
	},
};
export default { OfflineTts, GenerationConfig };
`,
		);
		const hook = join(root, "hook.mjs");
		writeFileSync(
			hook,
			`import { registerHooks } from "node:module";
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "sherpa-onnx-node") return { url: ${JSON.stringify(pathToFileURL(fake).href)}, shortCircuit: true };
		return next(specifier, context);
	},
});
`,
		);
		return ["--import", pathToFileURL(hook).href, BIN];
	}

	function launch(args: string[], input?: string) {
		const child = spawn(process.execPath, [...prepare(), ...args], { cwd: join(root, "work"), env, stdio: ["pipe", "pipe", "pipe"] });
		spawned.push(child);
		let out = "";
		let err = "";
		child.stdout!.on("data", (chunk) => (out += chunk));
		child.stderr!.on("data", (chunk) => (err += chunk));
		child.stdin!.end(input);
		const code = new Promise<number | null>((done) => child.on("close", (exit) => done(exit)));
		return {
			child,
			code,
			get out() {
				return out;
			},
			get err() {
				return err;
			},
		};
	}

	const logged = () =>
		existsSync(join(root, "synth.log"))
			? readFileSync(join(root, "synth.log"), "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];

	it("starts with a node shebang", () => {
		expect(readFileSync(BIN, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
	});

	it("is registered as the reply-reader command through its compiled build (tests/package.test.ts)", () => {
		const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"));
		expect(pkg.bin).toEqual({ "reply-reader": "./dist/bin/reply-reader.js" });
		expect(pkg.files).toContain("dist");
	});

	it("--help prints the usage and exits 0", async () => {
		const result = launch(["--help"]);
		expect(await result.code).toBe(0);
		expect(result.out).toBe(USAGE);
		expect(result.err).toBe("");
	});

	it("reads a file through the fake paplay with the given options and exits 0", async () => {
		installVoice();
		note("notes.md", "# Notas\n\nHola.");
		const result = launch(["--voice", "female", "--speed", "1.2", "notes.md"]);
		expect(await result.code).toBe(0);
		expect(result.err).toBe("");
		expect(logged()).toEqual([
			["Notas.", 0, 1.2],
			["Hola.", 0, 1.2],
		]);
		expect(readFileSync(join(root, "play.audio"))).toHaveLength((1 + 33075 + 1) * 2);
	});

	it('reads standard input with "-"', async () => {
		installVoice();
		const result = launch(["-"], "Desde la entrada.");
		expect(await result.code).toBe(0);
		expect(logged().map(([text]) => text)).toEqual(["Desde la entrada."]);
	});

	it("exits 1 with the message for a missing file and 2 for an unknown output", async () => {
		installVoice();
		const missing = launch(["nope.md"]);
		expect(await missing.code).toBe(1);
		expect(missing.err).toBe('Cannot read "nope.md": file not found.\n');
		note("notes.md", "Hola.");
		const output = launch(["--output", "nope", "notes.md"]);
		expect(await output.code).toBe(2);
		expect(output.err).toBe('No output named "nope". Outputs: local.\n');
	});

	it("exits 1 without a terminal when the voice is missing, downloading nothing", async () => {
		fakePaplay();
		note("notes.md", "Hola.");
		const result = launch(["notes.md"]);
		expect(await result.code).toBe(1);
		expect(result.err).toBe(
			"The voice is not installed and there is no terminal to confirm its download (129 MB). Run reply-reader from a terminal once to download it.\n",
		);
		expect(existsSync(voicesDir())).toBe(false);
	});

	it("Ctrl+C (SIGINT) stops the player and exits 130", async () => {
		installVoice(true);
		note("notes.md", "Hola.");
		const result = launch(["notes.md"]);
		await waitFor(played);
		const pid = playerPid();
		result.child.kill("SIGINT");
		expect(await result.code).toBe(130);
		await waitFor(() => !alive(pid));
		expect(result.err).toBe("");
	});

	it("(S13 e) does not exit before a TERM-ignoring orphan it reaped has been SIGKILLed", { timeout: 15000 }, async () => {
		installVoice();
		note("notes.md", "Hola.");
		const orphan = deadOwnersPlayer();
		const ended = new Promise((done) => orphan.on("exit", (_code, signal) => done(signal)));
		await sleep(200);
		const result = launch(["notes.md"]);
		expect(await result.code).toBe(0);
		expect(await Promise.race([ended, sleep(500).then(() => "still running")])).toBe("SIGKILL");
		expect(result.err).toBe("");
	});

	it("(S13 f) REPLY_READER_PLAYER_TIMEOUT=3000000 warns once on stderr, uses 15 s and still plays", async () => {
		installVoice();
		note("notes.md", "Hola.");
		env.REPLY_READER_PLAYER_TIMEOUT = "3000000";
		const result = launch(["notes.md"]);
		expect(await result.code).toBe(0);
		expect(result.err).toBe(`${TIMEOUT_HINT}\n`);
		expect(readFileSync(join(root, "play.audio"))).toHaveLength(2);
	});

	for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
		it(`${signal} (a closed terminal or kill) stops the player and exits ${code}`, async () => {
			installVoice(true);
			note("notes.md", "Hola.");
			const result = launch(["notes.md"]);
			await waitFor(played);
			const pid = playerPid();
			result.child.kill(signal);
			expect(await result.code).toBe(code);
			await waitFor(() => !alive(pid));
			expect(result.err).toBe("");
		});
	}
});
