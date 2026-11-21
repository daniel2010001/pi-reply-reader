import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReplyReader } from "../extensions/reply-reader.ts";
import { main } from "../src/cli.ts";
import type { SherpaRequest, SherpaTts } from "../src/playback.ts";
import { endProcessesOf } from "./processes.ts";

/**
 * S22 (T49): music steps aside while the reader speaks. `gentle-stream` is a fake on the test's PATH that records each
 * call and holds its state (running, playing, volume) in files under this test's mkdtemp folder; the real one is never
 * run. Readings go through the public interfaces: the Pi extension, the CLI's main(), bin/reply-reader.ts and
 * `reply-reader --serve` behind a fake ssh.
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

let root: string;
let env: NodeJS.ProcessEnv;
let synthesized: SherpaRequest[];
let spawned: ChildProcess[];

beforeEach(() => {
	synthesized = [];
	spawned = [];
	root = mkdtempSync(join(tmpdir(), "reply-reader-music-"));
	for (const dir of ["bin", "work", "run", "gs"]) mkdirSync(join(root, dir), { recursive: true });
	env = {
		PATH: join(root, "bin"),
		HOME: join(root, "home"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_RUNTIME_DIR: join(root, "run"),
	};
	installVoice(join(root, "data"));
	paplay(join(root, "bin"), root);
	writeFileSync(join(root, "work", "notes.md"), "Uno.\n\nDos.");
});

afterEach(async () => {
	for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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

function script(path: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\nPATH=/usr/bin:/bin\n${body}\n`);
	chmodSync(path, 0o755);
}

function installVoice(data: string): void {
	const dir = join(data, "pi-reply-reader", "voices", BUNDLE);
	mkdirSync(dir, { recursive: true });
	for (const name of MODEL_FILES) writeFileSync(join(dir, name), name);
}

/** A paplay that holds each reading until `<dir>/go` exists (the test lets it end), counting its plays. */
function paplay(bin: string, dir: string): void {
	script(join(bin, "paplay"), `echo $$ >> "${dir}/play.pids"; while [ ! -f "${dir}/go" ]; do sleep 0.02; done; cat > /dev/null`);
}
const go = (dir = root) => writeFileSync(join(dir, "go"), "");
const plays = (dir = root) => (existsSync(join(dir, "play.pids")) ? readFileSync(join(dir, "play.pids"), "utf8").trim().split("\n").length : 0);

/**
 * The fake gentle-stream in `bin`, its state in `state`: `volume` (absent: nothing plays, every ctl exits 1),
 * `playing` (present: playing), `log` (each call's arguments).
 */
function gentleStream(bin: string, state: string, music?: { volume: number; playing: boolean }): void {
	mkdirSync(state, { recursive: true });
	script(
		join(bin, "gentle-stream"),
		`d="${state}"
echo "$*" >> "$d/log"
if [ ! -f "$d/volume" ]; then [ "$2" = status ] && echo '{"ok":false,"running":false,"playing":false}'; exit 1; fi
case "$2" in
status) p=false; [ -f "$d/playing" ] && p=true; echo "{\\"ok\\":true,\\"running\\":true,\\"playing\\":$p,\\"volume\\":$(cat "$d/volume"),\\"title\\":\\"x\\"}";;
volume) echo "$3" > "$d/volume";;
pause) rm -f "$d/playing";;
play) touch "$d/playing";;
*) exit 2;;
esac`,
	);
	if (music) setMusic(state, music);
}
function setMusic(state: string, music: { volume: number; playing: boolean }): void {
	writeFileSync(join(state, "volume"), `${music.volume}\n`);
	if (music.playing) writeFileSync(join(state, "playing"), "");
	else rmSync(join(state, "playing"), { force: true });
}
const gsDir = () => join(root, "gs");
const calls = (state = gsDir()) => (existsSync(join(state, "log")) ? readFileSync(join(state, "log"), "utf8").trim().split("\n") : []);
const volume = (state = gsDir()) => Number(readFileSync(join(state, "volume"), "utf8"));
const musicPlaying = (state = gsDir()) => existsSync(join(state, "playing"));
const STATUS = "ctl status --json";

const settingsPath = () => join(root, "config", "pi-reply-reader", "settings.json");
function writeSettings(settings: unknown): void {
	mkdirSync(join(root, "config", "pi-reply-reader"), { recursive: true });
	writeFileSync(settingsPath(), JSON.stringify(settings));
}

const loadSherpa = async (): Promise<SherpaTts> => ({
	sampleRate: 44100,
	async generateAsync(request) {
		synthesized.push(request);
		return { samples: new Float32Array(1).fill(0.125) };
	},
});

let next = 0;
const assistant = (text: string) => ({
	type: "message",
	id: `a${++next}`,
	timestamp: "t",
	message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});

type Handler = (...args: never[]) => unknown;

/** A Pi session with the extension: commands, the pause key, agent turns, restarts. */
function session(answers: { select?: string } = {}) {
	const entries: unknown[] = [{ type: "message", id: "u0", timestamp: "t", message: { role: "user", content: "hola" } }, assistant("Primera.")];
	const commands = new Map<string, { handler: Handler; getArgumentCompletions?: Handler; description?: string }>();
	const events = new Map<string, Handler>();
	const shortcuts = new Map<string, { handler: Handler }>();
	const notes: [string, string | undefined][] = [];
	const footers: (string | undefined)[] = [];
	createReplyReader({ env, hostname: "hs-node", loadSherpa, lastProject: "work" })({
		registerCommand: (name: string, options: never) => commands.set(name, options),
		registerShortcut: (key: string, options: never) => shortcuts.set(key, options),
		on: (event: string, handler: Handler) => events.set(event, handler),
	} as never);
	const ctx = {
		hasUI: true,
		mode: "rpc",
		cwd: join(root, "work"),
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: (message: string, type?: string) => notes.push([message, type]),
			setStatus: (_key: string, text: string | undefined) => footers.push(text),
			select: async () => answers.select,
			confirm: async () => false,
		},
	};
	const fire = (name: string, event: unknown = {}) => (events.get(name) as ((event: unknown, ctx: unknown) => unknown) | undefined)?.(event, ctx);
	fire("session_start", { reason: "startup" });
	return {
		notes,
		commands,
		run: (name: string, args = "") => (commands.get(name)!.handler as (a: string, c: unknown) => Promise<void>)(args, ctx),
		complete: (name: string, prefix: string) => (commands.get(name)!.getArgumentCompletions as (p: string) => unknown)(prefix),
		pauseKey: () => (shortcuts.get("alt+m")!.handler as (c: unknown) => Promise<void>)(ctx),
		/** Stores `added` replies as Pi does (message_end, then the entry), then lets the reader see the branch. */
		turn: async (added: unknown[]) => {
			for (const entry of added) {
				fire("message_end", { type: "message_end", message: (entry as { message: unknown }).message });
				entries.push(entry);
			}
			await sleep(0);
		},
		/** Whether nothing is read in this session (its footer shows no reading; auto-read's indicator may stay, S23). */
		idle: () => footers.length > 0 && !/Reading|Paused/.test(footers.at(-1) ?? ""),
		restart: () => fire("session_start", { reason: "new" }),
		shutdown: () => fire("session_shutdown"),
	};
}

/** Runs the CLI (main(), as bin/reply-reader.ts does). */
function cli(argv: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
	let err = "";
	const code = main(argv, {
		env: options.env ?? env,
		cwd: join(root, "work"),
		hostname: "hs-node",
		stdin: Readable.from([]),
		stdout: { write: () => true },
		stderr: { write: (text: string) => ((err += text), true) },
		isTTY: false,
		confirm: async () => false,
		loadSherpa,
	});
	return {
		code,
		get err() {
			return err;
		},
	};
}

describe("music steps aside while the reader speaks (S22)", () => {
	it("by default ducks gentle-stream to 20 % while a reading plays and restores its volume after", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read");
		await waitFor(() => volume() === 20);
		expect(calls()).toEqual([STATUS, "ctl volume 20"]);
		expect(musicPlaying()).toBe(true);
		go();
		await waitFor(() => volume() === 70);
		await waitFor(pi.idle);
		expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 70"]);
		expect(pi.notes).toEqual([]);
		// Nothing is left saved once restored.
		expect(existsSync(join(root, "run", "pi-reply-reader", "music.json"))).toBe(false);
	});

	it("never raises a volume already at or below the level, and leaves it as it is after", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 10, playing: true });
		const pi = session();
		await pi.run("read");
		await waitFor(() => calls().length === 1);
		await sleep(200);
		go();
		await waitFor(pi.idle);
		await sleep(300);
		expect(calls().filter((call) => call !== STATUS)).toEqual([]);
		expect(volume()).toBe(10);
	});

	it("pause mode pauses playing music and plays it again after", { timeout: 15000 }, async () => {
		writeSettings({ music: { mode: "pause" } });
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read");
		await waitFor(() => !musicPlaying());
		expect(calls()).toEqual([STATUS, "ctl pause"]);
		go();
		await waitFor(musicPlaying);
		expect(calls()).toEqual([STATUS, "ctl pause", STATUS, "ctl play"]);
		expect(volume()).toBe(70);
	});

	it("music already paused is left untouched in pause and duck mode (never started)", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: false });
		for (const mode of ["pause", "duck"]) {
			writeSettings({ music: { mode } });
			rmSync(join(root, "go"), { force: true });
			const pi = session();
			await pi.run("read");
			await waitFor(() => calls().length > 0);
			await sleep(200);
			go();
			await waitFor(pi.idle);
			await sleep(300);
			pi.shutdown();
		}
		expect(calls().filter((call) => call !== STATUS)).toEqual([]);
		expect(musicPlaying()).toBe(false);
		expect(volume()).toBe(70);
	});

	it("mode off leaves gentle-stream alone", { timeout: 15000 }, async () => {
		writeSettings({ music: { mode: "off" } });
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read");
		await sleep(300);
		go();
		await waitFor(pi.idle);
		await sleep(200);
		expect(calls()).toEqual([]);
	});

	it("readings queued one after another do not flap the music: one duck before the first, one restore after the last", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read-auto", "on");
		await pi.turn([assistant("Segunda."), assistant("Tercera.")]);
		await waitFor(() => volume() === 20);
		go();
		await waitFor(() => plays() === 2);
		await waitFor(pi.idle);
		await waitFor(() => volume() === 70);
		await sleep(200);
		expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 70"]);
	});

	it("the pause key restores the music and resuming steps it aside again", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read");
		await waitFor(() => volume() === 20);
		await pi.pauseKey();
		await waitFor(() => volume() === 70);
		await pi.pauseKey();
		await waitFor(() => volume() === 20);
		go();
		await waitFor(() => volume() === 70);
		await waitFor(pi.idle);
		expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 70", STATUS, "ctl volume 20", STATUS, "ctl volume 70"]);
	});

	it("keeps a volume the user lowered below the level", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read");
		await waitFor(() => volume() === 20);
		setMusic(gsDir(), { volume: 5, playing: true });
		go();
		await waitFor(pi.idle);
		await waitFor(() => calls().length === 3);
		await sleep(300);
		expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS]);
		expect(volume()).toBe(5);
	});

	it("a pause restores and a resume ducks again, in pause mode too", { timeout: 15000 }, async () => {
		writeSettings({ music: { mode: "pause" } });
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read");
		await waitFor(() => !musicPlaying());
		await pi.run("read-pause");
		await waitFor(musicPlaying);
		await pi.run("read-pause");
		await waitFor(() => !musicPlaying());
		go();
		await waitFor(musicPlaying);
		await waitFor(pi.idle);
		expect(calls()).toEqual([STATUS, "ctl pause", STATUS, "ctl play", STATUS, "ctl pause", STATUS, "ctl play"]);
		expect(volume()).toBe(70);
	});

	it("a new /read in the session already reading keeps the music aside: one duck, one restore at the end", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session({ select: "Stop it and read now" });
		await pi.run("read");
		await waitFor(() => volume() === 20);
		await pi.run("read");
		await waitFor(() => plays() === 2);
		await sleep(500);
		expect(calls()).toEqual([STATUS, "ctl volume 20"]);
		go();
		await waitFor(pi.idle);
		await waitFor(() => volume() === 70);
		await sleep(200);
		expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 70"]);
	});

	for (const [what, content] of [
		["empty", ""],
		["garbage", "{not json"],
		["with a volume out of range", JSON.stringify({ token: "t", music: { mode: "duck", volume: 1e9, playing: true, set: 20 } })],
		["with a volume that is not whole", JSON.stringify({ token: "t", music: { mode: "duck", volume: 33.5, playing: true, set: 20 } })],
		["with playing not a boolean", JSON.stringify({ token: "t", music: { mode: "pause", volume: 70, playing: "yes" } })],
		["with a set volume out of range", JSON.stringify({ token: "t", music: { mode: "duck", volume: 70, playing: true, set: -3 } })],
	] as const) {
		it(`a music.json ${what} counts as no state: it is replaced at the next duck and removed at the restore`, { timeout: 15000 }, async () => {
			const file = join(root, "run", "pi-reply-reader", "music.json");
			mkdirSync(join(root, "run", "pi-reply-reader"), { recursive: true });
			writeFileSync(file, content);
			gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
			const pi = session();
			await sleep(300);
			// The session start found nothing to restore: gentle-stream is not called with what the file says.
			expect(calls()).toEqual([]);
			await pi.run("read");
			await waitFor(() => volume() === 20);
			go();
			await waitFor(() => volume() === 70);
			await waitFor(pi.idle);
			await sleep(200);
			expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 70"]);
			expect(existsSync(file)).toBe(false);
			expect(pi.notes).toEqual([]);
		});
	}

	it("a volume the user changed during the reading is left as the user set it", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read");
		await waitFor(() => volume() === 20);
		setMusic(gsDir(), { volume: 45, playing: true });
		go();
		await waitFor(pi.idle);
		await waitFor(() => calls().length === 3);
		await sleep(300);
		expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS]);
		expect(volume()).toBe(45);
	});

	it("without gentle-stream on PATH nothing is run and nothing is said", { timeout: 15000 }, async () => {
		const pi = session();
		await pi.run("read");
		await sleep(200);
		go();
		await waitFor(pi.idle);
		expect(pi.notes).toEqual([]);
		expect(existsSync(join(root, "run", "pi-reply-reader", "music.json"))).toBe(false);
	});

	it("with nothing playing (every ctl exits 1) nothing changes and nothing is said", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir());
		const pi = session();
		await pi.run("read");
		await waitFor(() => calls().length === 1);
		go();
		await waitFor(pi.idle);
		await sleep(300);
		expect(calls()).toEqual([STATUS]);
		expect(pi.notes).toEqual([]);
	});

	it("the CLI steps the music aside too, and restores it before it exits", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const run = cli(["notes.md"]);
		await waitFor(() => volume() === 20);
		go();
		expect(await run.code).toBe(0);
		expect(run.err).toBe("");
		expect(volume()).toBe(70);
		expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 70"]);
	});

	it("a reader killed while the music was ducked: the next session start restores it", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		writeFileSync(
			join(root, "fake-sherpa.mjs"),
			`class GenerationConfig { constructor(options) { Object.assign(this, options); } }
const OfflineTts = { async createAsync() { return { sampleRate: 44100, async generateAsync() { return { samples: new Float32Array(1).fill(0.125), sampleRate: 44100 }; } }; } };
export default { OfflineTts, GenerationConfig };
`,
		);
		writeFileSync(
			join(root, "hook.mjs"),
			`import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
	if (specifier === "sherpa-onnx-node") return { url: ${JSON.stringify(pathToFileURL(join(root, "fake-sherpa.mjs")).href)}, shortCircuit: true };
	return next(specifier, context);
} });
`,
		);
		const reader = spawn(process.execPath, ["--import", pathToFileURL(join(root, "hook.mjs")).href, BIN, join(root, "work", "notes.md")], {
			env,
			stdio: "ignore",
		});
		spawned.push(reader);
		await waitFor(() => volume() === 20);
		reader.kill("SIGKILL");
		await new Promise((done) => reader.once("exit", done));
		expect(volume()).toBe(20);
		const pi = session();
		await waitFor(() => volume() === 70);
		expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 70"]);
		expect(pi.notes).toEqual([]);
	});

	it("a restore after a crash never starts music the user paused since", { timeout: 15000 }, async () => {
		writeSettings({ music: { mode: "pause" } });
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read");
		await waitFor(() => !musicPlaying());
		// The user played it and paused it again with their own volume: not the state the reader left.
		setMusic(gsDir(), { volume: 30, playing: false });
		go();
		await waitFor(pi.idle);
		await waitFor(() => calls().length === 3);
		await sleep(300);
		expect(calls()).toEqual([STATUS, "ctl pause", STATUS]);
		expect(musicPlaying()).toBe(false);
	});

	it("before and after hooks run (through sh) at the same moments, with or without gentle-stream", { timeout: 15000 }, async () => {
		const hooks = join(root, "hooks.log");
		writeSettings({ music: { before: `echo before >> "${hooks}"`, after: `echo after >> "${hooks}"` } });
		const pi = session();
		await pi.run("read");
		await waitFor(() => existsSync(hooks));
		expect(readFileSync(hooks, "utf8")).toBe("before\n");
		go();
		await waitFor(pi.idle);
		await waitFor(() => readFileSync(hooks, "utf8") === "before\nafter\n");
		expect(pi.notes).toEqual([]);
	});

	it("a hook that hangs is ended after 3 s with one warning per session, and never delays speech", { timeout: 20000 }, async () => {
		const marker = join(root, "hung");
		writeSettings({ music: { mode: "off", before: `/usr/bin/sleep 30 # ${marker}` } });
		const pi = session();
		const started = Date.now();
		await pi.run("read");
		await waitFor(() => plays() === 1);
		// Speech started while the hook still ran.
		expect(Date.now() - started).toBeLessThan(2000);
		expect(pi.notes).toEqual([]);
		await waitFor(() => pi.notes.length > 0, 6000);
		expect(pi.notes).toEqual([['Music hook "before" timed out after 3 s; it was ended.', "warning"]]);
		go();
		await waitFor(pi.idle);
		rmSync(join(root, "go"));
		await pi.run("read");
		await waitFor(() => plays() === 2);
		await sleep(3500);
		go();
		await waitFor(pi.idle);
		// Said once per session.
		expect(pi.notes).toEqual([['Music hook "before" timed out after 3 s; it was ended.', "warning"]]);
	});
});

describe("/read-music (S22)", () => {
	it("with no argument shows the setting: the default is duck to 20 %", { timeout: 15000 }, async () => {
		const pi = session();
		await pi.run("read-music");
		expect(pi.notes).toEqual([["Music goes down to 20 % while reading.", "info"]]);
	});

	it("off, pause and duck [level] are saved, keeping the other keys and the hooks", { timeout: 15000 }, async () => {
		writeSettings({ speed: 1.2, music: { before: "true" } });
		const pi = session();
		await pi.run("read-music", "pause");
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ speed: 1.2, music: { before: "true", mode: "pause" } });
		await pi.run("read-music", "duck 35");
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ speed: 1.2, music: { before: "true", mode: "duck", level: 35 } });
		await pi.run("read-music", "off");
		await pi.run("read-music");
		await pi.run("read-music", "duck");
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ speed: 1.2, music: { before: "true", mode: "duck", level: 35 } });
		expect(pi.notes).toEqual([
			["Music will pause while reading.", "info"],
			["Music will go down to 35 % while reading.", "info"],
			["Music will be left as it is while reading.", "info"],
			['Music is left as it is while reading. Hooks: before "true".', "info"],
			["Music will go down to 35 % while reading.", "info"],
		]);
	});

	it("a level used by the next reading", { timeout: 15000 }, async () => {
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read-music", "duck 40");
		await pi.run("read");
		await waitFor(() => volume() === 40);
		go();
		await waitFor(() => volume() === 70);
	});

	it("anything else warns and changes nothing, the saved file included", { timeout: 15000 }, async () => {
		writeSettings({ music: { mode: "pause" } });
		const before = readFileSync(settingsPath(), "utf8");
		const pi = session();
		for (const args of ["loud", "duck 101", "duck -5", "duck 2.5", "pause 20", "off now", "duck 20 30"]) await pi.run("read-music", args);
		expect(readFileSync(settingsPath(), "utf8")).toBe(before);
		const usage = "Use /read-music off, pause, or duck with a level from 0 to 100.";
		const level = "Level must be a whole number from 0 to 100.";
		expect(pi.notes).toEqual([
			[usage, "warning"],
			[level, "warning"],
			[level, "warning"],
			[level, "warning"],
			[usage, "warning"],
			[usage, "warning"],
			[usage, "warning"],
		]);
		await pi.run("read-music");
		expect(pi.notes.at(-1)).toEqual(["Music pauses while reading.", "info"]);
	});

	it("offers off, pause and duck as completions and says what it does in its description", () => {
		const pi = session();
		expect((pi.complete("read-music", "") as { value: string }[]).map((choice) => choice.value)).toEqual(["off", "pause", "duck"]);
		expect((pi.complete("read-music", "p") as { value: string }[]).map((choice) => choice.value)).toEqual(["pause"]);
		expect(pi.commands.get("read-music")!.description).toMatch(/music/i);
	});

	it("an invalid music setting warns once per session and uses the default", { timeout: 15000 }, async () => {
		writeSettings({ music: { mode: "loud" } });
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		const pi = session();
		await pi.run("read");
		await waitFor(() => volume() === 20);
		go();
		await waitFor(pi.idle);
		await pi.run("read");
		await waitFor(pi.idle);
		expect(pi.notes.filter(([, type]) => type === "warning")).toEqual([
			[`Ignored "music" in ${settingsPath()}: mode must be off, pause or duck. Music goes down to 20 % while reading.`, "warning"],
		]);
	});
});

describe("music on a listener output (S20, S22)", () => {
	let dev: string;
	const devGs = () => join(dev, "gs");

	beforeEach(() => {
		dev = join(root, "device");
		for (const dir of ["bin", "run", "home"]) mkdirSync(join(dev, dir), { recursive: true });
		installVoice(join(dev, "data"));
		paplay(join(dev, "bin"), dev);
		mkdirSync(join(root, "config", "pi-reply-reader"), { recursive: true });
		writeFileSync(join(root, "config", "pi-reply-reader", "outputs.json"), JSON.stringify({ desk: { ssh: "you@host" } }));
		writeFileSync(
			join(dev, "fake-sherpa.mjs"),
			`class GenerationConfig { constructor(options) { Object.assign(this, options); } }
const OfflineTts = { async createAsync() { return { sampleRate: 44100, async generateAsync() { return { samples: new Float32Array(1).fill(0.125), sampleRate: 44100 }; } }; } };
export default { OfflineTts, GenerationConfig };
`,
		);
		writeFileSync(
			join(dev, "hook.mjs"),
			`import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
	if (specifier === "sherpa-onnx-node") return { url: ${JSON.stringify(pathToFileURL(join(dev, "fake-sherpa.mjs")).href)}, shortCircuit: true };
	return next(specifier, context);
} });
`,
		);
		writeFileSync(join(dev, "bin", "reply-reader"), `#!/bin/sh\nexec "${process.execPath}" --import "${pathToFileURL(join(dev, "hook.mjs")).href}" "${BIN}" "$@"\n`);
		chmodSync(join(dev, "bin", "reply-reader"), 0o755);
		// As a real ssh client: ending it closes the connection, not the remote command (which only sees its input end).
		script(
			join(root, "bin", "ssh"),
			`while [ $# -gt 0 ]; do case "$1" in -o) shift 2;; --) shift; break;; *) break;; esac; done
shift
env -i PATH="${dev}/bin" HOME="${dev}/home" XDG_DATA_HOME="${dev}/data" XDG_CONFIG_HOME="${dev}/config" XDG_RUNTIME_DIR="${dev}/run" "$@" <&0 &
wait $!`,
		);
		// Music plays on both machines; only the listener's may step aside for a listener reading.
		gentleStream(join(root, "bin"), gsDir(), { volume: 70, playing: true });
		gentleStream(join(dev, "bin"), devGs(), { volume: 80, playing: true });
	});

	it("--serve steps the listener's music aside and restores it; the agent host's is never touched", { timeout: 20000 }, async () => {
		const run = cli(["--output", "desk", "notes.md"]);
		await waitFor(() => existsSync(join(devGs(), "log")) && volume(devGs()) === 20);
		go(dev);
		expect(await run.code).toBe(0);
		await waitFor(() => volume(devGs()) === 80, 10000);
		expect(calls(devGs())).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 80"]);
		expect(calls()).toEqual([]);
		expect(volume()).toBe(70);
	});

	it("a listener reading that fell back to local playback ducks here again on resume after a pause", { timeout: 20000 }, async () => {
		writeFileSync(join(root, "config", "pi-reply-reader", "outputs.json"), JSON.stringify({ desk: { ssh: "you@host", fallback: "unix:/nowhere" } }));
		writeSettings({ output: "desk" });
		script(join(root, "bin", "ssh"), 'echo "ssh: connect to host host port 22: Connection refused" >&2; exit 255');
		const pi = session();
		await pi.run("read");
		await waitFor(() => volume() === 20);
		await waitFor(() => plays() === 1);
		await pi.run("read-pause");
		await waitFor(() => volume() === 70);
		// The resume steps the music aside at once, before ssh is even tried again.
		script(join(root, "bin", "ssh"), `while [ ! -f "${root}/go" ]; do sleep 0.02; done; exit 255`);
		await pi.run("read-pause");
		await waitFor(() => volume() === 20);
		go();
		await waitFor(pi.idle);
		await waitFor(() => volume() === 70);
		await sleep(200);
		expect(calls()).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 70", STATUS, "ctl volume 20", STATUS, "ctl volume 70"]);
		expect(calls(devGs())).toEqual([]);
	});

	it("two readings one after another on the listener do not flap its music", { timeout: 25000 }, async () => {
		go(dev);
		expect(await cli(["--output", "desk", "notes.md"]).code).toBe(0);
		await sleep(1500);
		expect(await cli(["--output", "desk", "notes.md"]).code).toBe(0);
		await waitFor(() => volume(devGs()) === 80, 12000);
		expect(calls(devGs())).toEqual([STATUS, "ctl volume 20", STATUS, "ctl volume 80"]);
		expect(calls()).toEqual([]);
	});
});
