import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReplyReader } from "../extensions/reply-reader.ts";
import { main } from "../src/cli.ts";
import { MAX_LINE_BYTES, MAX_FRAGMENTS, startOutputReading } from "../src/listener.ts";
import type { SherpaRequest, SherpaTts } from "../src/playback.ts";
import { isListenerServe, reapOrphans } from "../src/player.ts";
import { openReadingLock, PLAYER_MARK } from "../src/reading-lock.ts";
import { SPEAKERS } from "../src/voice.ts";
import { endProcessesOf } from "./processes.ts";

/**
 * S20 (T45): an output that synthesizes on the listener. The agent host runs `ssh … <host> reply-reader --serve`; here
 * `ssh` is a fake on PATH that runs, as the listener, the real bin/reply-reader.ts (sherpa-onnx-node swapped for a fake
 * engine through a module hook) with the listener's own folders, a fake paplay, and no PI_REPLY_READER_OWNER (ssh
 * does not pass it on). Nothing reaches another machine; every folder is under this test's mkdtemp.
 */

const BIN = resolve(import.meta.dirname, "..", "bin", "reply-reader.ts");
const VERSION = (JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
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
const FALLBACK = "unix:/run/user/1000/reply-reader-pulse.sock";
const SSH_ARGS = [
	"-o",
	"BatchMode=yes",
	"-o",
	"ConnectTimeout=15",
	"-o",
	"ServerAliveInterval=5",
	"-o",
	"ServerAliveCountMax=2",
	"--",
	"you@host",
	"reply-reader",
	"--serve",
	"--client-name=pi-reply-reader",
];
const VOICE_HINT = 'the listener has no voice (install it there with "reply-reader --download-voice")';
const fellBack = (reason: string) => `Output "desk": ${reason}; reading here through its fallback.\n`;

let root: string;
/** The agent host's environment. */
let env: NodeJS.ProcessEnv;
/** The listener's folders. */
let dev: string;
let synthesized: SherpaRequest[];
let spawned: ChildProcess[];
/** Process groups of the stand-in players this test started (detached), ended whole in afterEach. */
let groups: number[];

beforeEach(() => {
	synthesized = [];
	spawned = [];
	groups = [];
	root = mkdtempSync(join(tmpdir(), "reply-reader-listener-"));
	dev = join(root, "device");
	for (const dir of ["bin", "work", "run", join("device", "bin"), join("device", "run"), join("device", "home")]) mkdirSync(join(root, dir), { recursive: true });
	env = {
		PATH: join(root, "bin"),
		HOME: join(root, "home"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_RUNTIME_DIR: join(root, "run"),
	};
	openReadingLock(env)!.swapProject("work");
	// The agent host: its voice (for the fallback), a fake paplay, the outputs.
	installVoice(join(root, "data"));
	script(join(root, "bin", "paplay"), `echo "\${PULSE_SERVER-unset}" > "${root}/play.server"; echo $$ > "${root}/play.pid"; cat > "${root}/play.audio"`);
	mkdirSync(join(root, "config", "pi-reply-reader"), { recursive: true });
	writeFileSync(
		join(root, "config", "pi-reply-reader", "outputs.json"),
		JSON.stringify({ desk: { ssh: "you@host", fallback: FALLBACK }, bare: { ssh: "you@host" } }),
	);
	// The listener: reply-reader on its PATH, its fake engine, its paplay (set per test), its voice (per test).
	writeFileSync(
		join(dev, "fake-sherpa.mjs"),
		`import { appendFileSync } from "node:fs";
class GenerationConfig { constructor(options) { Object.assign(this, options); } }
const OfflineTts = {
	async createAsync() {
		return {
			sampleRate: 44100,
			async generateAsync({ text, generationConfig }) {
				appendFileSync(${JSON.stringify(join(dev, "synth.log"))}, JSON.stringify([text, generationConfig.sid, generationConfig.speed]) + "\\n");
				return { samples: new Float32Array(1).fill(0.125), sampleRate: 44100 };
			},
		};
	},
};
export default { OfflineTts, GenerationConfig };
`,
	);
	writeFileSync(
		join(dev, "hook.mjs"),
		`import { registerHooks } from "node:module";
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "sherpa-onnx-node") return { url: ${JSON.stringify(pathToFileURL(join(dev, "fake-sherpa.mjs")).href)}, shortCircuit: true };
		return next(specifier, context);
	},
});
`,
	);
	// Not through script(): the listener's PATH must stay its own, or a real paplay could be found.
	writeFileSync(
		join(dev, "bin", "reply-reader"),
		`#!/bin/sh\necho '["start"]' >> "${dev}/synth.log"\nexec "${process.execPath}" --import "${pathToFileURL(join(dev, "hook.mjs")).href}" "${BIN}" "$@"\n`,
	);
	chmodSync(join(dev, "bin", "reply-reader"), 0o755);
	devicePaplay();
	fakeSsh();
});

afterEach(async () => {
	for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	// A stand-in player's whole group, its `sleep` too (a SIGKILL of the shell alone orphans it).
	for (const group of groups) {
		try {
			process.kill(-group, "SIGKILL");
		} catch {}
	}
	await endProcessesOf(root);
	rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await sleep(20);
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

function script(path: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\nPATH=/usr/bin:/bin\n${body}\n`);
	chmodSync(path, 0o755);
}

function installVoice(data: string): void {
	const dir = join(data, "pi-reply-reader", "voices", BUNDLE);
	mkdirSync(dir, { recursive: true });
	for (const name of MODEL_FILES) writeFileSync(join(dir, name), name);
}

/** A player of the listener's own (its mark in its command line), in its own process group. */
function ownPlayer(): ChildProcess {
	const own = spawn("/bin/sh", ["-c", "sleep 30; :", "paplay", PLAYER_MARK], { stdio: "ignore", detached: true });
	spawned.push(own);
	if (own.pid) groups.push(own.pid);
	return own;
}

/** The listener's paplay: records its pid and audio; `before` runs first (a hold, a failure). */
function devicePaplay(before = ""): void {
	script(join(dev, "bin", "paplay"), `echo $$ > "${dev}/play.pid"; ${before} cat > "${dev}/play.audio"`);
}

/**
 * The fake ssh: records its arguments and pid; by default runs the command after the host as the listener would (a
 * fresh environment with the listener's folders); `body` replaces that (a refused connection, a hang).
 */
function fakeSsh(body?: string): void {
	const run = `while [ $# -gt 0 ]; do case "$1" in -o) shift 2;; --) shift; break;; *) break;; esac; done
shift
exec env -i PATH="${dev}/bin" HOME="${dev}/home" XDG_DATA_HOME="${dev}/data" XDG_CONFIG_HOME="${dev}/config" XDG_RUNTIME_DIR="${dev}/run" REPLY_READER_PLAYER_TIMEOUT=5 "$@"`;
	script(join(root, "bin", "ssh"), `printf '%s\\n' "$@" > "${root}/ssh.args"; echo $$ > "${root}/ssh.pid"\n${body ?? run}`);
}

const deviceEnv = (): NodeJS.ProcessEnv => ({
	PATH: join(dev, "bin"),
	HOME: join(dev, "home"),
	XDG_DATA_HOME: join(dev, "data"),
	XDG_CONFIG_HOME: join(dev, "config"),
	XDG_RUNTIME_DIR: join(dev, "run"),
});

/** The listener's synthesis log, one array per start of `reply-reader` there. */
function deviceRuns(): [string, number, number][][] {
	if (!existsSync(join(dev, "synth.log"))) return [];
	const runs: [string, number, number][][] = [];
	for (const line of readFileSync(join(dev, "synth.log"), "utf8").trim().split("\n")) {
		const entry = JSON.parse(line);
		if (entry[0] === "start" && entry.length === 1) runs.push([]);
		else runs.at(-1)!.push(entry);
	}
	return runs;
}
const deviceTexts = () => deviceRuns().map((run) => run.map(([text]) => text));
const sshArgs = () => readFileSync(join(root, "ssh.args"), "utf8").trim().split("\n");
const sshPid = () => Number(readFileSync(join(root, "ssh.pid"), "utf8"));
const devicePlayed = () => existsSync(join(dev, "play.pid"));
const devicePlayer = () => Number(readFileSync(join(dev, "play.pid"), "utf8"));
const agentTexts = () => synthesized.map((request) => request.text);

const loadSherpa = async (): Promise<SherpaTts> => ({
	sampleRate: 44100,
	async generateAsync(request) {
		synthesized.push(request);
		return { samples: new Float32Array(1).fill(0.125) };
	},
});

/** A listener paplay that takes 64 KiB a second, a little slower than real time, so a reading lasts. */
const SLOW = 'while :; do n=$(head -c 65536 | wc -c); [ "$n" -eq 0 ] && exit 0; sleep 1; done;';

const PARAGRAPHS = ["Uno.", "Dos.", "Tres.", "Cuatro.", "Cinco.", "Seis."];

function note(name: string, content: string): void {
	writeFileSync(join(root, "work", name), content);
}

/** Runs the agent host's `reply-reader` (main(), as bin/reply-reader.ts does). */
function cli(argv: string[], options: { signal?: AbortSignal; isTTY?: boolean; confirm?: (message: string) => Promise<boolean>; env?: NodeJS.ProcessEnv } = {}) {
	let out = "";
	let err = "";
	const asked: string[] = [];
	const code = main(argv, {
		env: options.env ?? env,
		cwd: join(root, "work"),
		hostname: "agent-node",
		stdin: Readable.from([]),
		stdout: { write: (text: string) => ((out += text), true) },
		stderr: { write: (text: string) => ((err += text), true) },
		isTTY: options.isTTY ?? false,
		confirm: async (message) => (asked.push(message), (options.confirm ?? (async () => false))(message)),
		loadSherpa,
		signal: options.signal,
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

describe("an output whose listener synthesizes (S20)", () => {
	it("sends the fragments over ssh (argv, BatchMode, the player mark) and the listener speaks them in order", async () => {
		installVoice(join(dev, "data"));
		note("notes.md", "# Notas\n\nUno.\n\nDos.");
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe("");
		expect(sshArgs()).toEqual(SSH_ARGS);
		expect(deviceRuns()).toEqual([
			[
				["Notas.", 6, 1.1],
				["Uno.", 6, 1.1],
				["Dos.", 6, 1.1],
			],
		]);
		expect(readFileSync(join(dev, "play.audio")).length).toBeGreaterThan(6);
		// Nothing was synthesized or played on the agent host.
		expect(agentTexts()).toEqual([]);
		expect(existsSync(join(root, "play.pid"))).toBe(false);
		// The listener wrote nothing besides its own reading lock.
		expect(existsSync(join(dev, "config"))).toBe(false);
		expect(readdirSync(join(dev, "data", "pi-reply-reader", "voices"))).toEqual([BUNDLE]);
	});

	it("(S19) the project announcement is made on the agent host and spoken by the listener with the reading", async () => {
		installVoice(join(dev, "data"));
		openReadingLock(env)!.swapProject("other");
		note("notes.md", "Hola.");
		expect(await cli(["--output", "desk", "notes.md"]).code).toBe(0);
		expect(deviceTexts()).toEqual([["work.", "Hola."]]);
		// The listener's own machine keeps no project of the agent host's.
		expect(existsSync(join(dev, "run", "pi-reply-reader", "project.json"))).toBe(false);
	});

	it("passes the voice and speed; the listener uses them", async () => {
		installVoice(join(dev, "data"));
		note("notes.md", "Hola.");
		expect(await cli(["--output", "desk", "--voice", "female", "--speed", "1.3", "notes.md"]).code).toBe(0);
		expect(deviceRuns()).toEqual([[["Hola.", SPEAKERS.female.sid, 1.3]]]);
	});

	it("a listener without the voice: reads here through the fallback, warning with the command that installs it", async () => {
		note("notes.md", "Uno.\n\nDos.");
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(fellBack(VOICE_HINT));
		expect(agentTexts()).toEqual(["Uno.", "Dos."]);
		expect(readFileSync(join(root, "play.server"), "utf8")).toBe(`${FALLBACK}\n`);
		expect(deviceTexts()).toEqual([[]]);
		expect(existsSync(join(dev, "data"))).toBe(false);
	});

	it("without a fallback, a listener without the voice fails the reading with the reason", async () => {
		note("notes.md", "Uno.");
		const run = cli(["--output", "bare", "notes.md"]);
		expect(await run.code).toBe(1);
		expect(run.err).toBe(`Playback on "bare" failed: ${VOICE_HINT}\n`);
		expect(agentTexts()).toEqual([]);
		expect(existsSync(join(root, "play.pid"))).toBe(false);
	});

	it("ssh failing to connect (exit 255) reads here through the fallback with ssh's reason", async () => {
		fakeSsh('echo "ssh: connect to host host port 22: Connection refused" >&2; exit 255');
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(fellBack("the listener did not answer (ssh: connect to host host port 22: Connection refused)"));
		expect(agentTexts()).toEqual(["Uno."]);
	});

	it("a listener without reply-reader (exit 127) reads here through the fallback", async () => {
		fakeSsh('echo "sh: reply-reader: command not found" >&2; exit 127');
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(fellBack("reply-reader is not installed on the listener"));
		expect(agentTexts()).toEqual(["Uno."]);
	});

	it("no ssh on the agent host: through the fallback", async () => {
		rmSync(join(root, "bin", "ssh"));
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(fellBack("ssh was not found on PATH"));
	});

	it("a listener speaking another protocol version: through the fallback, its ssh ended", async () => {
		fakeSsh(`echo '{"type":"ready","v":2,"version":"9.0.0"}'; exec sleep 30`);
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(fellBack("the listener's reply-reader speaks protocol 2, this one 1 (update both)"));
		await waitFor(() => !alive(sshPid()));
	});

	it("(S13) a listener that never answers: the watchdog ends ssh and the reading goes to the fallback", { timeout: 20000 }, async () => {
		fakeSsh("exec sleep 30");
		env.REPLY_READER_PLAYER_TIMEOUT = "5";
		note("notes.md", "Uno.");
		const began = Date.now();
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(Date.now() - began).toBeGreaterThanOrEqual(5000);
		expect(run.err).toBe(fellBack("the listener did not answer"));
		expect(agentTexts()).toEqual(["Uno."]);
		expect(alive(sshPid())).toBe(false);
	});

	it("(S13) without a fallback, a listener that never answers fails with timed out", { timeout: 20000 }, async () => {
		fakeSsh("exec sleep 30");
		env.REPLY_READER_PLAYER_TIMEOUT = "5";
		note("notes.md", "Uno.");
		const run = cli(["--output", "bare", "notes.md"]);
		expect(await run.code).toBe(1);
		expect(run.err).toBe('Playback on "bare" failed: timed out\n');
		await waitFor(() => !alive(sshPid()));
	});

	it("a failure mid-reading goes on through the fallback from the fragment last heard", { timeout: 20000 }, async () => {
		installVoice(join(dev, "data"));
		devicePaplay('sleep 2.5; echo "Connection failure: refused" >&2; exit 1;');
		note("notes.md", PARAGRAPHS.join("\n\n"));
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(fellBack('the listener failed (Playback on "listener" failed: Connection failure: refused)'));
		const rest = agentTexts();
		expect(rest.length).toBeGreaterThan(0);
		expect(rest.length).toBeLessThan(PARAGRAPHS.length);
		expect(rest).toEqual(PARAGRAPHS.slice(PARAGRAPHS.length - rest.length));
	});

	it("(S1) Ctrl+C ends ssh and the listener's player", async () => {
		installVoice(join(dev, "data"));
		devicePaplay("trap 'kill $! 2>/dev/null; exit 143' TERM; sleep 30 & wait;");
		note("notes.md", "Uno.");
		const abort = new AbortController();
		const run = cli(["--output", "desk", "notes.md"], { signal: abort.signal });
		await waitFor(devicePlayed);
		const [ssh, player] = [sshPid(), devicePlayer()];
		abort.abort();
		expect(await run.code).toBe(130);
		await waitFor(() => !alive(ssh) && !alive(player));
		expect(run.err).toBe("");
	});

	it("(S1) the ssh child is the reading's player: another session's /read-stop ends it and the listener's player", async () => {
		installVoice(join(dev, "data"));
		devicePaplay("trap 'kill $! 2>/dev/null; exit 143' TERM; sleep 30 & wait;");
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		await waitFor(devicePlayed);
		const [ssh, player] = [sshPid(), devicePlayer()];
		const entry = () => JSON.parse(readFileSync(join(root, "run", "pi-reply-reader", "reading.json"), "utf8")) as { player?: number };
		await waitFor(() => entry().player === ssh);
		expect(openReadingLock(env)!.stopOthers()).toBe(true);
		expect(await run.code).toBe(0);
		expect(run.err).toBe("");
		await waitFor(() => !alive(ssh) && !alive(player));
		expect(agentTexts()).toEqual([]);
	});

	it("the listener waits while it reads something of its own (its beats keep the watchdog quiet), then reads", { timeout: 25000 }, async () => {
		installVoice(join(dev, "data"));
		env.REPLY_READER_PLAYER_TIMEOUT = "5";
		const own = ownPlayer();
		const theirs = openReadingLock(deviceEnv())!.claim();
		expect(theirs.setPlayer(own.pid!)).toBe(true);
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		await sleep(6500);
		expect(devicePlayed()).toBe(false);
		expect(run.err).toBe("");
		theirs.release();
		expect(await run.code).toBe(0);
		expect(run.err).toBe("");
		expect(deviceTexts()).toEqual([["Uno."]]);
		expect(agentTexts()).toEqual([]);
	});

	it("a reading of the listener's own stops the one it serves; the agent host's ends quietly, without fallback", async () => {
		installVoice(join(dev, "data"));
		devicePaplay("trap 'kill $! 2>/dev/null; exit 143' TERM; sleep 30 & wait;");
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		await waitFor(devicePlayed);
		const player = devicePlayer();
		const mine = openReadingLock(deviceEnv())!.claim();
		expect(await run.code).toBe(0);
		expect(run.err).toBe("");
		await waitFor(() => !alive(player));
		expect(agentTexts()).toEqual([]);
		mine.release();
	});
});

describe("startOutputReading on a listener (S15)", () => {
	it("position() follows the fragment the listener reports; replaying from it starts there", { timeout: 20000 }, async () => {
		installVoice(join(dev, "data"));
		devicePaplay(SLOW);
		const fragments = PARAGRAPHS.map((text) => ({ text, role: "paragraph" as const, after: "paragraph" as const }));
		const output = { name: "desk", label: "desk", ssh: "you@host", fallback: FALLBACK };
		const voice = { supertonic: {} as never };
		const first = startOutputReading({ voice, speaker: SPEAKERS.male, fragments, output, env, loadSherpa });
		await waitFor(() => first.position() >= 2);
		const from = first.position();
		first.stop();
		await first.done;
		const second = startOutputReading({ voice, speaker: SPEAKERS.male, fragments: fragments.slice(from), output, env, loadSherpa });
		await waitFor(() => deviceRuns().length === 2 && deviceRuns()[1].length === PARAGRAPHS.length - from);
		second.stop();
		await second.done;
		expect(deviceTexts()[1]).toEqual(PARAGRAPHS.slice(from));
		expect(agentTexts()).toEqual([]);
	});
});

/** A Pi session with the extension, enough for /read-output, /read and /read-pause. */
function session() {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: unknown) => void>();
	const notes: [string, string | undefined][] = [];
	const footers: (string | undefined)[] = [];
	createReplyReader({ env, hostname: "agent-node", loadSherpa, lastProject: "work" })({
		registerCommand: (name: string, options: never) => commands.set(name, options),
		registerShortcut: () => {},
		on: (event: string, handler: never) => events.set(event, handler),
	} as never);
	const reply = (text: string) => ({ type: "message", id: `a${text.length}`, timestamp: "t", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
	const branch = [{ type: "message", id: "u1", timestamp: "t", message: { role: "user", content: "hola" } }, reply(PARAGRAPHS.join("\n\n"))];
	const ctx = {
		hasUI: false,
		mode: "rpc",
		cwd: join(root, "work"),
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string, type?: string) => notes.push([message, type]),
			setStatus: (_key: string, text: string | undefined) => footers.push(text),
			select: async () => undefined,
			confirm: async () => false,
		},
	};
	events.get("session_start")!({ reason: "startup" }, ctx);
	return { notes, footers, run: (name: string, args = "") => commands.get(name)!.handler(args, ctx) };
}

describe("the Pi extension on a listener output (S15, S20)", () => {
	it("/read-pause and again resume from the fragment the listener was in", { timeout: 20000 }, async () => {
		installVoice(join(dev, "data"));
		devicePaplay(SLOW);
		const pi = session();
		await pi.run("read-output", "desk");
		await pi.run("read");
		await waitFor(devicePlayed);
		await sleep(2500);
		await pi.run("read-pause");
		await pi.run("read-pause");
		await waitFor(() => deviceRuns().length === 2 && deviceRuns()[1].length > 0);
		await sleep(300);
		const [first, second] = deviceTexts();
		expect(first).toEqual(PARAGRAPHS.slice(0, first.length));
		expect(second.length).toBeLessThan(PARAGRAPHS.length);
		expect(PARAGRAPHS.length - second.length).toBeLessThanOrEqual(first.length);
		expect(second).toEqual(PARAGRAPHS.slice(PARAGRAPHS.length - second.length));
		expect(pi.notes).toEqual([
			["Readings will sound on desk (listener you@host).", "info"],
			["Reading paused.", "info"],
			["Reading resumed.", "info"],
		]);
		await pi.run("read-stop");
		expect(agentTexts()).toEqual([]);
	});

	for (const how of ["another session's /read-stop", "a newer reading in another process"] as const) {
		it(`a listener reading ended by ${how} ends quietly: no error, no fallback, footer cleared (S1, S20)`, { timeout: 20000 }, async () => {
			installVoice(join(dev, "data"));
			devicePaplay("trap 'kill $! 2>/dev/null; exit 143' TERM; sleep 30 & wait;");
			const pi = session();
			await pi.run("read-output", "desk");
			await pi.run("read");
			await waitFor(devicePlayed);
			const [ssh, player] = [sshPid(), devicePlayer()];
			const entry = () => JSON.parse(readFileSync(join(root, "run", "pi-reply-reader", "reading.json"), "utf8")) as { player?: number };
			await waitFor(() => entry().player === ssh);
			expect(pi.footers.at(-1)).toBe("Reading P1.R1 on desk · Alt+M pauses");
			let newer: ReturnType<NonNullable<ReturnType<typeof openReadingLock>>["claim"]> | undefined;
			if (how === "another session's /read-stop") await session().run("read-stop");
			else newer = openReadingLock(env)!.claim();
			await waitFor(() => !alive(ssh) && !alive(player));
			await waitFor(() => pi.footers.at(-1) === undefined);
			await sleep(500);
			newer?.release();
			expect(pi.footers.at(-1)).toBeUndefined();
			expect(pi.notes).toEqual([["Readings will sound on desk (listener you@host).", "info"]]);
			expect(agentTexts()).toEqual([]);
			expect(existsSync(join(root, "play.audio"))).toBe(false);
		});
	}

	it("warns about the fallback once per session", async () => {
		const pi = session();
		await pi.run("read-output", "desk");
		await pi.run("read");
		await waitFor(() => agentTexts().length === PARAGRAPHS.length);
		await waitFor(() => existsSync(join(root, "play.audio")));
		await sleep(300);
		await pi.run("read");
		await waitFor(() => agentTexts().length === 2 * PARAGRAPHS.length);
		await sleep(300);
		expect(pi.notes).toEqual([
			["Readings will sound on desk (listener you@host).", "info"],
			[fellBack(VOICE_HINT).trimEnd(), "warning"],
		]);
	});
});

describe("reply-reader --serve (the listener's side, S20)", () => {
	const PROTOCOL_LINES = (lines: object[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");

	/** The listener's side in this process; its standard input stays open (as ssh keeps it) unless `close`. */
	function serve(input: string, close = false) {
		let out = "";
		let err = "";
		const stdin = new PassThrough();
		stdin.write(input);
		if (close) stdin.end();
		const code = main(["--serve", PLAYER_MARK], {
			env: deviceEnv(),
			hostname: "listener-node",
			stdin,
			stdout: { write: (text: string) => ((out += text), true) },
			stderr: { write: (text: string) => ((err += text), true) },
			isTTY: false,
			confirm: async () => false,
			loadSherpa,
		});
		code.finally(() => stdin.end());
		return {
			code,
			get lines() {
				return out
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { type: string })
					.filter((line) => line.type !== "beat" && line.type !== "progress");
			},
			get err() {
				return err;
			},
		};
	}
	const hello = { type: "hello", v: 1, voice: "male" };
	const fragments = (items: object[]) => ({ type: "fragments", lead: 0, speed: 1.1, items });

	it("answers ready, plays what it is sent, and says done", async () => {
		installVoice(join(dev, "data"));
		const run = serve(PROTOCOL_LINES([hello, fragments([{ text: "Hola.", after: "sentence" }]), { type: "end" }]));
		expect(await run.code).toBe(0);
		expect(run.lines).toEqual([{ type: "ready", v: 1, version: expect.any(String) }, { type: "done" }]);
		expect(agentTexts()).toEqual(["Hola."]);
		expect(run.err).toBe("");
	});

	it("without the voice answers missing voice and downloads nothing", async () => {
		const run = serve(PROTOCOL_LINES([hello]));
		expect(await run.code).toBe(1);
		expect(run.lines).toEqual([{ type: "missing", what: "voice" }]);
		expect(existsSync(join(dev, "data"))).toBe(false);
	});

	it("without paplay answers missing player", async () => {
		installVoice(join(dev, "data"));
		rmSync(join(dev, "bin", "paplay"));
		const run = serve(PROTOCOL_LINES([hello]));
		expect(await run.code).toBe(1);
		expect(run.lines).toEqual([{ type: "missing", what: "player" }]);
	});

	it("refuses a line longer than its cap, too many fragments, and an unknown voice", async () => {
		installVoice(join(dev, "data"));
		const long = serve(`${JSON.stringify(hello)}\n${"x".repeat(1024 * 1024 + 1)}\n`);
		expect(await long.code).toBe(1);
		expect(long.lines).toEqual([{ type: "ready", v: 1, version: expect.any(String) }, { type: "error", message: "a line is longer than 1048576 bytes" }]);
		const many = serve(PROTOCOL_LINES([hello, fragments(Array.from({ length: 5001 }, () => ({ text: "a", after: "sentence" })))]));
		expect(await many.code).toBe(1);
		expect(many.lines.at(-1)).toEqual({ type: "error", message: "more than 5000 fragments" });
		const voice = serve(PROTOCOL_LINES([{ type: "hello", v: 1, voice: "robot" }]));
		expect(await voice.code).toBe(1);
		expect(voice.lines).toEqual([{ type: "error", message: 'no voice named "robot"' }]);
		expect(agentTexts()).toEqual([]);
	});

	it("standard input closing before the fragments ends it with nothing played", async () => {
		installVoice(join(dev, "data"));
		const run = serve(PROTOCOL_LINES([hello]), true);
		expect(await run.code).toBe(0);
		expect(run.lines).toEqual([{ type: "ready", v: 1, version: VERSION }]);
		expect(devicePlayed()).toBe(false);
	});
});

/** `reply-reader --serve` as the listener runs it (the real bin through the listener's PATH), with pipes. */
function serveProcess(extra: NodeJS.ProcessEnv = {}) {
	const child = spawn(join(dev, "bin", "reply-reader"), ["--serve", PLAYER_MARK], {
		env: { ...deviceEnv(), REPLY_READER_PLAYER_TIMEOUT: "5", ...extra },
		stdio: ["pipe", "pipe", "pipe"],
	});
	spawned.push(child);
	let out = "";
	let err = "";
	child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
	child.stderr!.on("data", (chunk: Buffer) => (err += chunk.toString()));
	child.stdin!.on("error", () => {});
	const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
	return {
		child,
		exited,
		send: (lines: object[]) => child.stdin!.write(lines.map((line) => `${JSON.stringify(line)}\n`).join("")),
		get out() {
			return out;
		},
		get err() {
			return err;
		},
	};
}

const HELLO = { type: "hello", v: 1, voice: "male" };
const OUTPUT = { name: "desk", label: "desk", ssh: "you@host", fallback: FALLBACK };
const VOICE = { supertonic: {} as never };
const items = (texts: string[]) => texts.map((text) => ({ text, role: "paragraph" as const, after: "sentence" as const }));

describe("T45 correction: the listener's text and lines on the agent host (A2, R1-001)", () => {
	it("a line from the listener longer than 64 KiB ends the reading through the fallback, with the reason", async () => {
		fakeSsh("head -c 70000 /dev/zero | tr '\\0' x; exec sleep 30");
		note("notes.md", "Uno.");
		const began = Date.now();
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(fellBack("the listener sent a line longer than 65536 bytes"));
		expect(Date.now() - began).toBeLessThan(5000);
		expect(agentTexts()).toEqual(["Uno."]);
		await waitFor(() => !alive(sshPid()));
	});

	it("control characters in the listener's error message are stripped from the warning", async () => {
		writeFileSync(join(root, "said"), `${JSON.stringify({ type: "error", message: "bad\u001b[31m\u0085\u0007\u009b\u0000x\r" })}\n`);
		fakeSsh(`cat "${root}/said"; exec sleep 30`);
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(fellBack("the listener failed (bad[31mx)"));
	});

	it("control characters in ssh's last stderr line are stripped from the failure", async () => {
		writeFileSync(join(root, "said"), "first\nssh: \u001b]0;t\u0007refused\u0085\r\n");
		fakeSsh(`cat "${root}/said" >&2; exit 255`);
		note("notes.md", "Uno.");
		const run = cli(["--output", "bare", "notes.md"]);
		expect(await run.code).toBe(1);
		expect(run.err).toBe('Playback on "bare" failed: the listener did not answer (ssh: ]0;trefused)\n');
	});

	it("control characters in the listener's protocol version are stripped from the warning", async () => {
		writeFileSync(join(root, "said"), `${JSON.stringify({ type: "ready", v: "2\u001b[2J\u0085" })}\n`);
		fakeSsh(`cat "${root}/said"; exec sleep 30`);
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(fellBack("the listener's reply-reader speaks protocol 2[2J, this one 1 (update both)"));
	});
});

describe("T45 correction: --serve and the reaper (A3)", () => {
	it("a --serve started with PI_REPLY_READER_OWNER naming a gone process is never reaped while it runs", async () => {
		installVoice(join(dev, "data"));
		const listener = serveProcess({ PI_REPLY_READER_OWNER: "999999:1" });
		listener.send([HELLO]);
		await waitFor(() => listener.out.includes('"ready"'));
		expect(reapOrphans()).not.toContain(listener.child.pid);
		await sleep(300);
		expect(alive(listener.child.pid!)).toBe(true);
		listener.child.stdin!.end();
		expect(await listener.exited).toBe(0);
	});

	it("only a reply-reader script's --serve is spared: the agent host's ssh child stays reapable (S13)", () => {
		expect(isListenerServe(["node", BIN, "--serve", PLAYER_MARK])).toBe(true);
		expect(isListenerServe(["node", "/usr/lib/node_modules/pi-reply-reader/dist/bin/reply-reader.js", "--serve", PLAYER_MARK])).toBe(true);
		expect(isListenerServe(["node", "/home/you/.local/bin/reply-reader", "--serve", PLAYER_MARK])).toBe(true);
		expect(isListenerServe(["ssh", ...SSH_ARGS])).toBe(false);
		expect(isListenerServe(["/usr/bin/setpriv", "--pdeathsig", "KILL", "/usr/bin/ssh", ...SSH_ARGS])).toBe(false);
		expect(isListenerServe(["paplay", "--raw", PLAYER_MARK])).toBe(false);
	});
});

describe("T45 correction: large readings stay on the listener (A4)", () => {
	it(`a text of more than ${MAX_FRAGMENTS} fragments plays on the listener, not the fallback`, { timeout: 60000 }, async () => {
		installVoice(join(dev, "data"));
		script(join(dev, "bin", "paplay"), `echo $$ > "${dev}/play.pid"; cat > /dev/null`);
		const texts = Array.from({ length: MAX_FRAGMENTS + 700 }, (_, index) => `F${index}.`);
		const warned: string[] = [];
		const reading = startOutputReading({ voice: VOICE, speaker: SPEAKERS.male, fragments: items(texts), output: OUTPUT, env, loadSherpa, onFallback: (message) => warned.push(message) });
		await reading.done;
		expect(warned).toEqual([]);
		expect(agentTexts()).toEqual([]);
		expect(deviceTexts()).toEqual([texts]);
	});

	it("fragments that add up to more than one line's cap are sent in several messages and play on the listener", { timeout: 20000 }, async () => {
		installVoice(join(dev, "data"));
		const texts = ["a", "b", "c"].map((letter) => letter.repeat(600 * 1024));
		const warned: string[] = [];
		const reading = startOutputReading({ voice: VOICE, speaker: SPEAKERS.male, fragments: items(texts), output: OUTPUT, env, loadSherpa, onFallback: (message) => warned.push(message) });
		await reading.done;
		expect(warned).toEqual([]);
		expect(deviceTexts()).toEqual([texts]);
	});

	it("a single fragment too large for one line reads through the fallback, saying why", { timeout: 20000 }, async () => {
		installVoice(join(dev, "data"));
		const texts = ["Uno.", "x".repeat(MAX_LINE_BYTES)];
		const warned: string[] = [];
		const reading = startOutputReading({ voice: VOICE, speaker: SPEAKERS.male, fragments: items(texts), output: OUTPUT, env, loadSherpa, onFallback: (message) => warned.push(message) });
		await reading.done;
		expect(warned).toEqual([`Output "desk": a sentence is too long to send to the listener (over ${MAX_LINE_BYTES} bytes); reading here through its fallback.`]);
		expect(agentTexts()).toEqual(texts);
		expect(existsSync(join(root, "ssh.pid"))).toBe(false);
	});

	it("a huge lead and speed: the listener reads at speed 1.1 and says done", { timeout: 20000 }, async () => {
		installVoice(join(dev, "data"));
		const warned: string[] = [];
		const reading = startOutputReading({
			voice: VOICE,
			speaker: SPEAKERS.male,
			fragments: items(["Hola."]),
			output: OUTPUT,
			env,
			loadSherpa,
			speed: 1e300,
			leadSilence: 1e300,
			onFallback: (message) => warned.push(message),
		});
		await reading.done;
		expect(warned).toEqual([]);
		expect(deviceRuns()).toEqual([[["Hola.", SPEAKERS.male.sid, 1.1]]]);
		expect(agentTexts()).toEqual([]);
	});
});

describe("T45 correction: --serve when the agent host is gone (A5)", () => {
	it("EPIPE on its standard output stops its player and exits 0 quietly", { timeout: 20000 }, async () => {
		installVoice(join(dev, "data"));
		devicePaplay("trap 'kill $! 2>/dev/null; exit 143' TERM; sleep 30 & wait;");
		const listener = serveProcess();
		listener.send([HELLO]);
		await waitFor(() => listener.out.includes('"ready"'));
		listener.send([{ type: "fragments", lead: 0, speed: 1.1, items: [{ text: "Uno.", after: "sentence" }] }, { type: "end" }]);
		await waitFor(devicePlayed);
		const player = devicePlayer();
		listener.child.stdout!.destroy();
		expect(await listener.exited).toBe(0);
		expect(listener.err).toBe("");
		await waitFor(() => !alive(player));
	});
});

describe("T45 correction: a remote reading waiting its turn on the listener (A6)", () => {
	it("/read-stop on the listener drops it: --serve answers stopped, the agent host ends it quietly, no fallback", { timeout: 25000 }, async () => {
		installVoice(join(dev, "data"));
		const own = ownPlayer();
		const theirs = openReadingLock(deviceEnv())!.claim();
		expect(theirs.setPlayer(own.pid!)).toBe(true);
		note("notes.md", "Uno.");
		const run = cli(["--output", "desk", "notes.md"]);
		await waitFor(() => deviceRuns().length === 1);
		await sleep(2500);
		expect(devicePlayed()).toBe(false);
		expect(openReadingLock(deviceEnv())!.stopOthers()).toBe(true);
		expect(await run.code).toBe(0);
		expect(run.err).toBe("");
		expect(devicePlayed()).toBe(false);
		expect(deviceTexts()).toEqual([[]]);
		expect(agentTexts()).toEqual([]);
		theirs.release();
	});

	it("--serve answers stopped when the listener's waiting readings are dropped (S8)", { timeout: 25000 }, async () => {
		installVoice(join(dev, "data"));
		const theirs = openReadingLock(deviceEnv())!.claim();
		const listener = serveProcess();
		listener.send([HELLO, { type: "fragments", lead: 0, speed: 1.1, items: [{ text: "Uno.", after: "sentence" }] }, { type: "end" }]);
		await waitFor(() => listener.out.includes('"ready"'));
		await sleep(1000);
		openReadingLock(deviceEnv())!.dropWaiting();
		expect(await listener.exited).toBe(0);
		const said = listener.out.trim().split("\n").map((line) => (JSON.parse(line) as { type: string }).type).filter((type) => type !== "beat");
		expect(said).toEqual(["ready", "stopped"]);
		expect(devicePlayed()).toBe(false);
		theirs.release();
	});
});

describe("reply-reader --download-voice (S20: how a listener gets its voice)", () => {
	it("says so when the voice is already installed", async () => {
		const run = cli(["--download-voice"]);
		expect(await run.code).toBe(0);
		expect(run.err).toBe(`The voice is already installed in ${join(root, "data", "pi-reply-reader", "voices")}.\n`);
	});

	it("needs a terminal to confirm, and a no keeps nothing", async () => {
		const bare = { ...env, XDG_DATA_HOME: join(root, "empty") };
		const noTty = cli(["--download-voice"], { env: bare });
		expect(await noTty.code).toBe(1);
		expect(noTty.err).toBe("Downloading the voice (129 MB) needs a terminal to confirm it. Run reply-reader --download-voice from a terminal.\n");
		const no = cli(["--download-voice"], { env: bare, isTTY: true });
		expect(await no.code).toBe(1);
		expect(no.asked).toHaveLength(1);
		expect(no.asked[0]).toMatch(/^Download the Spanish voice Supertonic 3 \(129 MB\)/);
		expect(no.err).toBe("Download cancelled: the voice was not downloaded.\n");
		expect(existsSync(join(root, "empty"))).toBe(false);
	});
});
