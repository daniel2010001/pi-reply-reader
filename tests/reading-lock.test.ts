import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * T21 (S1, "One reading per machine"): every Pi session here is a real Node process that loads the extension,
 * as a second Pi or gsh session would, sharing one temporary XDG_RUNTIME_DIR (never the real one).
 */

const EXTENSION = pathToFileURL(resolve(import.meta.dirname, "..", "extensions", "reply-reader.ts")).href;

/**
 * One session: loads the extension into a recording Pi with a fake engine, runs the given commands in order,
 * then stays until its reading clears the footer (or 20 s), and keeps `<out>` up to date with what the user saw.
 * When `<root>/hold-<name>` exists at start, loading the voice waits until it is removed.
 */
const DRIVER = `
import { existsSync, renameSync, writeFileSync } from "node:fs";
const [extension, envJson, root, name, ...commands] = process.argv.slice(2);
const { createReplyReader } = await import(extension);
const env = JSON.parse(envJson);
const out = root + "/" + name + ".json";
const state = { pid: process.pid, notes: [], statuses: [], ran: false, consumedEsc: [] };
const save = () => { writeFileSync(out + ".tmp", JSON.stringify(state)); renameSync(out + ".tmp", out); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hold = root + "/hold-" + name;
const loadSherpa = async () => {
	while (existsSync(hold)) await sleep(20);
	return { sampleRate: 44100, async generateAsync() { return { samples: new Float32Array(1).fill(0.125) }; } };
};
const registered = new Map();
const events = new Map();
createReplyReader({ env, hostname: "hs-node", loadSherpa })({
	registerCommand: (n, o) => registered.set(n, o),
	on: (e, h) => events.set(e, h),
});
let input;
const user = (id, text) => ({ type: "message", id, timestamp: "t", message: { role: "user", content: text } });
const assistant = (id, text) => ({ type: "message", id, timestamp: "t", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
const branch = [user("u1", "hola"), assistant("a1", "Primera respuesta."), user("u2", "otra"), assistant("a2", "Segunda respuesta.")];
const ctx = {
	hasUI: true, mode: "tui", cwd: root, sessionManager: { getBranch: () => branch },
	ui: {
		notify: (message, type) => { state.notes.push([message, type]); save(); },
		select: async () => undefined,
		confirm: async () => false,
		setStatus: (_key, text) => { state.statuses.push(text ?? null); save(); },
		onTerminalInput: (handler) => ((input = handler), () => (input = undefined)),
	},
};
events.get("session_start")({ reason: "startup" }, ctx);
for (const command of commands) {
	const [cmd, ...args] = command.split(" ");
	await registered.get(cmd).handler(args.join(" "), ctx);
}
state.ran = true;
save();
const end = Date.now() + 20000;
while (Date.now() < end && state.statuses.length > 0 && state.statuses.at(-1) !== null) await sleep(20);
// Esc after the reading ended must not be taken by the reader any more.
state.consumedEsc.push(input?.("\\x1b") ?? null);
save();
process.exit(0);
`;

let root: string;
let env: NodeJS.ProcessEnv;
let spawned: ChildProcess[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reply-reader-lock-"));
	spawned = [];
	mkdirSync(join(root, "bin"));
	mkdirSync(join(root, "run"));
	env = { PATH: join(root, "bin"), HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "run") };
	writeFileSync(join(root, "driver.mjs"), DRIVER);
	installVoice();
});

afterEach(async () => {
	for (const child of spawned) child.kill("SIGKILL");
	for (const pid of pidsIn(root)) kill(pid);
	rmSync(root, { recursive: true, force: true });
});

const BUNDLE = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11";
const MODEL_FILES = ["duration_predictor.int8.onnx", "text_encoder.int8.onnx", "vector_estimator.int8.onnx", "vocoder.int8.onnx", "tts.json", "unicode_indexer.bin", "voice.bin"];

/**
 * An installed voice and a paplay that records its pid as `play-<session pid>.pid` and plays for 30 s. Its sleep
 * holds none of the session's pipes, so the session sees the player end as soon as it is killed.
 */
function installVoice(): void {
	const paplay = join(root, "bin", "paplay");
	writeFileSync(
		paplay,
		`#!/bin/sh\nPATH=/usr/bin:/bin\necho $$ > "${root}/play-$PPID.pid"\ntrap 'kill $s 2>/dev/null; exit 143' TERM\nsleep 30 </dev/null >/dev/null 2>&1 &\ns=$!\nwait $s\ncat > /dev/null\n`,
	);
	chmodSync(paplay, 0o755);
	const dir = join(root, "data", "pi-reply-reader", "voices", BUNDLE);
	mkdirSync(dir, { recursive: true });
	for (const name of MODEL_FILES) writeFileSync(join(dir, name), name);
}

interface Seen {
	pid: number;
	notes: [string, string][];
	statuses: (string | null)[];
	ran: boolean;
	consumedEsc: unknown[];
}

/** Starts a session process named `name` that runs `commands`, with `sessionEnv` as the extension's env. */
function start(name: string, commands: string[], sessionEnv: NodeJS.ProcessEnv = env): Session {
	const child = spawn(process.execPath, [join(root, "driver.mjs"), EXTENSION, JSON.stringify(sessionEnv), root, name, ...commands], {
		env: { PATH: process.env.PATH, HOME: join(root, "home") },
		stdio: ["ignore", "ignore", "inherit"],
	});
	spawned.push(child);
	const exited = new Promise<void>((done) => child.on("exit", () => done()));
	return { name, child, exited, seen: () => JSON.parse(readFileSync(join(root, `${name}.json`), "utf8")) as Seen };
}

interface Session {
	name: string;
	child: ChildProcess;
	seen: () => Seen;
	exited: Promise<void>;
}

/** The pid of the player a session started, once it exists. */
async function playerOf(child: ChildProcess): Promise<number> {
	const file = join(root, `play-${child.pid}.pid`);
	await waitFor(() => existsSync(file) && readFileSync(file, "utf8").trim() !== "");
	return Number(readFileSync(file, "utf8"));
}

/** What a session saw once its commands ran. */
async function ran(s: Session): Promise<Seen> {
	await waitFor(() => existsSync(join(root, `${s.name}.json`)) && s.seen().ran);
	return s.seen();
}

/** Writes the shared entry as another (or a vanished) reader would have left it. */
function writeEntry(entry: Record<string, unknown>): void {
	mkdirSync(join(root, "run", "pi-reply-reader"), { recursive: true });
	writeFileSync(join(root, "run", "pi-reply-reader", "reading.json"), JSON.stringify(entry));
}

/** A process of this user that is not a reader's player, kept to check it is never signalled. */
function bystander(args: string[]): ChildProcess {
	const child = spawn("/bin/sh", ["-c", "sleep 30; :", ...args], { stdio: "ignore" });
	spawned.push(child);
	return child;
}

/** Linux start time of `pid` (field 22 of /proc/<pid>/stat). */
function startTime(pid: number): string {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

describe("one reading per machine (T21)", { timeout: 30000 }, () => {
	it("a new /read in another process stops the reading playing there", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const b = start("b", ["read P1.R1"]);
		const playerB = await playerOf(b.child);
		await waitFor(() => !alive(playerA));
		expect(alive(playerB)).toBe(true);
		expect((await ran(b)).notes).toEqual([]);
	});

	it("the session whose reading another stopped clears its footer quietly, with no error", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		start("b", ["read P1.R1"]);
		await a.exited;
		expect(alive(playerA)).toBe(false);
		expect(a.seen()).toMatchObject({ notes: [], statuses: ["Reading P2.R1 on local · Esc stops", null], consumedEsc: [null] });
	});

	it("a reading still loading the voice when a newer one starts never plays, and ends quietly", async () => {
		writeFileSync(join(root, "hold-a"), "");
		const a = start("a", ["read"]);
		await waitFor(() => existsSync(join(root, "a.json")) && a.seen().statuses.length === 1);
		const b = start("b", ["read P1.R1"]);
		const playerB = await playerOf(b.child);
		rmSync(join(root, "hold-a"));
		await a.exited;
		const file = join(root, `play-${a.child.pid}.pid`);
		if (existsSync(file)) expect(alive(Number(readFileSync(file, "utf8")))).toBe(false);
		expect(a.seen()).toMatchObject({ notes: [], statuses: ["Reading P2.R1 on local · Esc stops", null], consumedEsc: [null] });
		expect(alive(playerB)).toBe(true);
	});

	it("/read-stop stops a reading started by another session, and says so", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const b = start("b", ["read-stop"]);
		expect((await ran(b)).notes).toEqual([["Reading stopped.", "info"]]);
		await a.exited;
		expect(alive(playerA)).toBe(false);
		expect(a.seen()).toMatchObject({ notes: [], statuses: ["Reading P2.R1 on local · Esc stops", null], consumedEsc: [null] });
		const c = start("c", ["read-stop"]);
		expect((await ran(c)).notes).toEqual([["Nothing is being read.", "info"]]);
	});

	it("a stale entry, its process gone, is ignored and replaced", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		a.child.kill("SIGKILL");
		kill(playerA);
		await a.exited;
		await waitFor(() => !alive(playerA));
		const b = start("b", ["read-stop"]);
		expect((await ran(b)).notes).toEqual([["Nothing is being read.", "info"]]);
		const c = start("c", ["read"]);
		const playerC = await playerOf(c.child);
		expect(c.seen().notes).toEqual([]);
		const d = start("d", ["read-stop"]);
		expect((await ran(d)).notes).toEqual([["Reading stopped.", "info"]]);
		await waitFor(() => !alive(playerC));
	});

	it("never signals a process that is not a reader's player (pid reuse)", async () => {
		const plain = bystander([]);
		const marked = bystander(["sh", "--client-name=pi-reply-reader"]);
		await waitFor(() => readFileSync(`/proc/${marked.pid}/cmdline`, "utf8").includes("--client-name=pi-reply-reader"));
		// The pid now belongs to a process that is not a player at all.
		writeEntry({ token: "old-1", pid: plain.pid, player: plain.pid, started: Date.now() });
		const b = start("b", ["read-stop"]);
		expect((await ran(b)).notes).toEqual([["Nothing is being read.", "info"]]);
		// The pid now belongs to a newer process that looks like a player but did not start when the entry says.
		writeEntry({ token: "old-2", pid: process.pid, pidStart: startTime(process.pid), player: marked.pid, playerStart: "1", started: Date.now() });
		const c = start("c", ["read"]);
		const playerC = await playerOf(c.child);
		expect(c.seen().notes).toEqual([]);
		expect(alive(plain.pid!)).toBe(true);
		expect(alive(marked.pid!)).toBe(true);
		expect(alive(playerC)).toBe(true);
	});

	it("without a usable XDG_RUNTIME_DIR each session keeps to itself, without errors", async () => {
		const file = join(root, "not-a-dir");
		writeFileSync(file, "");
		const relative = `reply-reader-relative-${process.pid}`;
		for (const runtime of [undefined, file, relative]) {
			const own = { ...env, XDG_RUNTIME_DIR: runtime };
			if (runtime === undefined) delete own.XDG_RUNTIME_DIR;
			const a = start(`a-${spawned.length}`, ["read"], own);
			const playerA = await playerOf(a.child);
			const b = start(`b-${spawned.length}`, ["read P1.R1"], own);
			const playerB = await playerOf(b.child);
			const c = start(`c-${spawned.length}`, ["read-stop"], own);
			expect((await ran(c)).notes).toEqual([["Nothing is being read.", "info"]]);
			expect(alive(playerA)).toBe(true);
			expect(alive(playerB)).toBe(true);
			expect(a.seen().notes).toEqual([]);
			expect(b.seen().notes).toEqual([]);
			kill(playerA);
			kill(playerB);
			await Promise.all([a.exited, b.exited]);
		}
		expect(readFileSync(file, "utf8")).toBe("");
		expect(existsSync(join(root, relative))).toBe(false);
		expect(existsSync(resolve(relative))).toBe(false);
	});
});

/** Every player pid recorded under `dir`. */
function pidsIn(dir: string): number[] {
	try {
		return readdirSync(dir)
			.filter((name) => /^play-\d+\.pid$/.test(name))
			.map((name) => Number(readFileSync(join(dir, name), "utf8")))
			.filter((pid) => pid > 0);
	} catch {
		return [];
	}
}

/** Ends a player the way a stop does (SIGTERM), so its sleep goes with it. */
function kill(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	// A killed child of this process stays a zombie until reaped; it is not playing.
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, ms = 10000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
