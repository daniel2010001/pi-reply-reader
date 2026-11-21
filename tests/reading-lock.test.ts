import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { endProcessesOf, processesOf } from "./processes.ts";

/**
 * T21 (S1, "One reading per machine"): every Pi session here is a real Node process that loads the extension,
 * as a second Pi or gsh session would, sharing one temporary XDG_RUNTIME_DIR (never the real one).
 */

const EXTENSION = pathToFileURL(resolve(import.meta.dirname, "..", "extensions", "reply-reader.ts")).href;
const LOCK = pathToFileURL(resolve(import.meta.dirname, "..", "src", "reading-lock.ts")).href;

/**
 * One session: loads the extension into a recording Pi with a fake engine, runs the given commands in order,
 * then stays until its reading clears the footer (or 20 s), and keeps `<out>` up to date with what the user saw.
 * When `<root>/hold-<name>` exists at start, loading the voice waits until it is removed.
 * Besides commands: `turn <text>` is an agent run that ends with that reply (T32), `await <file>` waits until
 * `<root>/<file>` exists, `name <label>` names the session as Pi's /name does, and `pause-key` presses the pause key (Alt+M). The "Something is being read." question (T33) is answered as Pi's TUI
 * would, with the keys of `answer now|after|dismiss` (default now, today's behaviour), and recorded in `asked`.
 * `shutdown` ends the session as Pi does (session_shutdown) and `exit` ends the process at once. While
 * `<root>/ask-<name>` exists, the output question stays open (`<root>/asked-<name>` says it was asked), as a human who
 * has not answered yet. `<root>/yield-cap` (ms), when present, replaces the 10 s yield cap (S16).
 */
const DRIVER = `
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [extension, envJson, root, name, ...commands] = process.argv.slice(2);
const { createReplyReader } = await import(extension);
const env = JSON.parse(envJson);
const out = root + "/" + name + ".json";
const state = { pid: process.pid, notes: [], statuses: [], ran: false, consumedEsc: [], asked: [] };
const KEYS = { now: ["\\r"], after: ["\\x1b[B", "\\r"], dismiss: ["\\x1b"] };
let answer = "now";
let sessionName;
const save = () => { writeFileSync(out + ".tmp", JSON.stringify(state)); renameSync(out + ".tmp", out); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hold = root + "/hold-" + name;
const loadSherpa = async () => {
	while (existsSync(hold)) await sleep(20);
	return { sampleRate: 44100, async generateAsync() { return { samples: new Float32Array(1).fill(0.125) }; } };
};
const registered = new Map();
const shortcuts = new Map();
const events = new Map();
// While <root>/slow-<name> exists, the session's line starts nothing, as a session slow to claim (S16).
const holdLine = () => existsSync(root + "/slow-" + name);
const yieldCapMs = existsSync(root + "/yield-cap") ? Number(readFileSync(root + "/yield-cap", "utf8")) : undefined;
createReplyReader({ env, hostname: "hs-node", loadSherpa, holdLine, yieldCapMs })({
	registerCommand: (n, o) => registered.set(n, o),
	registerShortcut: (k, o) => shortcuts.set(k, o),
	on: (e, h) => events.set(e, h),
});
let input;
const user = (id, text) => ({ type: "message", id, timestamp: "t", message: { role: "user", content: text } });
const assistant = (id, text) => ({ type: "message", id, timestamp: "t", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
const branch = [user("u1", "hola"), assistant("a1", "Primera respuesta."), user("u2", "otra"), assistant("a2", "Segunda respuesta.")];
const ctx = {
	hasUI: true, mode: "tui", cwd: root, sessionManager: { getBranch: () => branch, getSessionName: () => sessionName },
	ui: {
		notify: (message, type) => { state.notes.push([message, type]); save(); },
		select: async () => {
			if (!existsSync(root + "/ask-" + name)) return undefined;
			writeFileSync(root + "/asked-" + name, "");
			while (existsSync(root + "/ask-" + name)) await sleep(20);
			return undefined;
		},
		confirm: async () => false,
		// The reading's part of each footer change: the auto-read indicator (S23) taken off, null when only it is left,
		// repeats skipped; footers keeps every footer as shown.
		setStatus: (_key, text) => {
			(state.footers ??= []).push(text ?? null);
			const indicator = /^Auto-read (?:on|questions)(?: · (.*))?$/.exec(text ?? "");
			const part = !indicator ? (text ?? null) : indicator[1] && /^(?:Reading|Paused) /.test(indicator[1]) ? indicator[1] : null;
			if (part !== (state.statuses.length > 0 ? state.statuses.at(-1) : null)) state.statuses.push(part);
			save();
		},
		onTerminalInput: (handler) => ((input = handler), () => (input = undefined)),
		custom: (factory) => new Promise((resolve) => {
			const component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, undefined, resolve);
			state.asked.push(component.render(60).map((line) => line.trim()).filter((line) => line && !/^─+$/.test(line)).slice(0, 3));
			save();
			for (const key of KEYS[answer]) if (!input?.(key)?.consume) component.handleInput(key);
		}),
	},
};
events.get("session_start")({ reason: "startup" }, ctx);
for (const command of commands) {
	const [cmd, ...args] = command.split(" ");
	const rest = args.join(" ");
	if (cmd === "turn") {
		// Pi stores each message after its message_end handlers return; the reader looks on the next turn (T42).
		for (const entry of [user("u" + branch.length, "sigue"), assistant("a" + branch.length, rest)]) {
			events.get("message_end")({ type: "message_end", message: entry.message }, ctx);
			branch.push(entry);
		}
		await sleep(0);
	} else if (cmd === "await") {
		while (!existsSync(root + "/" + rest)) await sleep(20);
	} else if (cmd === "answer") {
		answer = rest;
	} else if (cmd === "name") {
		sessionName = rest;
	} else if (cmd === "shutdown") {
		events.get("session_shutdown")({ type: "session_shutdown" }, ctx);
	} else if (cmd === "exit") {
		process.exit(0);
	} else if (cmd === "pause-key") {
		// Esc reaches Pi, never the reader (L145): it is recorded as not taken, then the pause key is pressed.
		state.notes.push(["esc", input?.("\\x1b") ?? null]);
		await shortcuts.get("alt+m").handler(ctx);
		save();
	} else {
		await registered.get(cmd).handler(rest, ctx);
	}
}
state.ran = true;
save();
const end = Date.now() + 20000;
while (Date.now() < end && state.statuses.length > 0 && state.statuses.at(-1) !== null) await sleep(20);
// Esc is never taken by the reader (L145, L147), with or without a reading.
state.consumedEsc.push(input?.("\\x1b") ?? null);
save();
process.exit(0);
`;

let root: string;
let env: NodeJS.ProcessEnv;
let spawned: ChildProcess[];
/** The process groups of the sessions this test started (each session leads its own, with its players in it). */
let groups: number[];

/** Every temp folder this file created: afterAll ends anything still naming one of them (T47). */
const roots: string[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reply-reader-lock-"));
	roots.push(root);
	spawned = [];
	groups = [];
	mkdirSync(join(root, "bin"));
	mkdirSync(join(root, "run"));
	env = { PATH: join(root, "bin"), HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "run") };
	writeFileSync(join(root, "driver.mjs"), DRIVER);
	installVoice();
});

afterEach(async () => {
	for (const child of spawned) child.kill("SIGKILL");
	const players = pidsIn(root);
	for (const pid of players) kill(pid);
	// A stopped player still logs "term"; let it finish before its folder goes.
	await waitFor(() => players.every((pid) => !alive(pid)), 3000).catch(() => {});
	// Whatever else this test started and is still there (an earlier player of a session, a player's sleep or watcher
	// orphaned by a SIGKILL) goes too: a test leaves no process behind (L138).
	await endProcessesOf(root, groups);
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// A process that names a test's folder but showed up after that test's afterEach (T47: two fake players were found
// running minutes after a full run, under `$TMPDIR/reply-reader-lock-*`) is ended once the file is done.
afterAll(async () => {
	for (const dir of roots) await endProcessesOf(dir);
});

const BUNDLE = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11";
const MODEL_FILES = ["duration_predictor.int8.onnx", "text_encoder.int8.onnx", "vector_estimator.int8.onnx", "vocoder.int8.onnx", "tts.json", "unicode_indexer.bin", "voice.bin"];

/**
 * An installed voice and a paplay that records its pid as `play-<session pid>.pid` and plays for 30 s, or until
 * `<root>/end-<its pid>` exists (T32). Its sleep holds none of the session's pipes, so the session sees the player
 * end as soon as it is killed; once the player is gone however it ended (a SIGKILL skips its trap), its watcher ends
 * the sleep and itself, so nothing of it is left behind. `<root>/log` gets `start <session pid>`, then `end <session pid>` when it played
 * through or `term <session pid>` when it was stopped.
 */
function installVoice(): void {
	const paplay = join(root, "bin", "paplay");
	writeFileSync(
		paplay,
		`#!/bin/sh\nPATH=/usr/bin:/bin\necho "start $PPID" >> "${root}/log"\necho $$ > "${root}/play-$PPID.pid"\nsleep 30 </dev/null >/dev/null 2>&1 &\ns=$!\n(while [ ! -e "${root}/end-$$" ] && kill -0 $$ 2>/dev/null; do sleep 0.02; done; kill $s) </dev/null >/dev/null 2>&1 &\nw=$!\ntrap 'kill $s $w 2>/dev/null; echo "term $PPID" >> "${root}/log"; exit 143' TERM\nwait $s\nkill $w 2>/dev/null\ncat > /dev/null\necho "end $PPID" >> "${root}/log"\n`,
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
	asked: string[][];
}

/** Starts a session process named `name` that runs `commands`, with `sessionEnv` as the extension's env. */
function start(name: string, commands: string[], sessionEnv: NodeJS.ProcessEnv = env): Session {
	const child = spawn(process.execPath, [join(root, "driver.mjs"), EXTENSION, JSON.stringify(sessionEnv), root, name, ...commands], {
		env: { PATH: process.env.PATH, HOME: join(root, "home") },
		stdio: ["ignore", "ignore", "inherit"],
		// Its own process group, so afterEach ends it with every player and child it left (L138).
		detached: true,
	});
	spawned.push(child);
	if (child.pid) groups.push(child.pid);
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

	it("(S13) a new reading kills a player that ignores SIGTERM, even when its own session cannot stop it", async () => {
		const paplay = join(root, "bin", "paplay");
		// It ignores SIGTERM and loops while its session lives (stopped or not), so it can never outlive the test (T47).
		writeFileSync(paplay, `#!/bin/sh\nPATH=/usr/bin:/bin\ntrap '' TERM\necho $$ > "${root}/play-$PPID.pid"\nwhile kill -0 $PPID 2>/dev/null; do sleep 0.1; done\n`);
		chmodSync(paplay, 0o755);
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		installVoice();
		// The player can write its pid before session a records it in the entry; frozen before that, no reading could
		// know which player to end (the cause of L138's timeout, not load).
		const entry = join(root, "run", "pi-reply-reader", "reading.json");
		await waitFor(() => {
			try {
				return (JSON.parse(readFileSync(entry, "utf8")) as { player?: number }).player === playerA;
			} catch {
				return false;
			}
		});
		// Session a is frozen, so only the newer reading can end its player.
		a.child.kill("SIGSTOP");
		try {
			const b = start("b", ["read P1.R1"]);
			const playerB = await playerOf(b.child);
			await new Promise((done) => setTimeout(done, 1000));
			expect(alive(playerA)).toBe(true);
			// SIGKILL comes 2 s after the SIGTERM, from b's timer: room for a loaded machine (L138: 3 s once fell short at
			// load average 5-7). That it ignored SIGTERM for the first second is still checked above.
			await waitFor(() => !alive(playerA), 8000);
			expect(alive(playerB)).toBe(true);
		} finally {
			try {
				process.kill(playerA, "SIGKILL");
			} catch {}
		}
	});

	it("the session whose reading another stopped clears its footer quietly, with no error", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		start("b", ["read P1.R1"]);
		await a.exited;
		expect(alive(playerA)).toBe(false);
		expect(a.seen()).toMatchObject({ notes: [], statuses: ["Reading P2.R1 on local · Alt+M pauses", null], consumedEsc: [null] });
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
		expect(a.seen()).toMatchObject({ notes: [], statuses: ["Reading P2.R1 on local · Alt+M pauses", null], consumedEsc: [null] });
		expect(alive(playerB)).toBe(true);
	});

	it("/read-stop stops a reading started by another session, and says so", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const b = start("b", ["read-stop"]);
		expect((await ran(b)).notes).toEqual([["Reading stopped.", "info"]]);
		await a.exited;
		expect(alive(playerA)).toBe(false);
		expect(a.seen()).toMatchObject({ notes: [], statuses: ["Reading P2.R1 on local · Alt+M pauses", null], consumedEsc: [null] });
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

	it("(L138) a session that exits while its reading plays leaves no process of its player behind", async () => {
		const a = start("a", ["read", "await exit-a", "exit"]);
		await playerOf(a.child);
		writeFileSync(join(root, "exit-a"), "");
		await a.exited;
		// The reader SIGKILLs its player as it exits (S13 c), which skips the fake player's trap.
		await waitFor(() => processesOf(root).length === 0, 2000).catch(() => {});
		expect(processesOf(root)).toEqual([]);
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

describe("auto-read queue across sessions (T32, S8)", { timeout: 40000 }, () => {
	/** Longer than two of the reader's 250 ms checks. */
	const wait = () => new Promise((resolve) => setTimeout(resolve, 700));
	const go = (file: string) => writeFileSync(join(root, file), "");
	/** Lets the player `pid` play to its end. */
	const finish = (pid: number) => writeFileSync(join(root, `end-${pid}`), "");
	/** Footers without the waiting count (S16), where which session reads first is not fixed. */
	const plain = (statuses: (string | null)[]) => statuses.map((status) => status?.replace(/ · \d+ waiting/, "") ?? null);
	const lines = () => (existsSync(join(root, "log")) ? readFileSync(join(root, "log"), "utf8").trim().split("\n") : []);
	const hasPlayer = (s: Session) => existsSync(join(root, `play-${s.child.pid}.pid`));
	/** Another session's pause as this one's footer shows it (S25): every session here has the same label, so its tag too. */
	const pausedHere = expect.stringMatching(/^Paused in reply-reader-lock-\w+ #\w{4} · 1 waiting · Alt\+M resumes$/);
	const showsPause = (s: Session) => waitFor(() => s.seen().statuses.some((status) => /^Paused in /.test(status ?? "")));
	/** Whether the session read its reply P3.R1 to its end (its footer cleared after it). */
	const readP3 = (s: Session) => {
		const statuses = s.seen().statuses;
		const at = statuses.indexOf("Reading P3.R1 on local · Alt+M pauses");
		return at >= 0 && statuses.slice(at).includes(null);
	};
	/** What the session's footer showed, once it showed `n` readings and cleared after the last. */
	const readings = async (s: Session, n: number) => {
		await waitFor(() => existsSync(join(root, `${s.name}.json`)) && s.seen().statuses.filter((x) => x === null).length === n);
		return s.seen().statuses;
	};
	/** A session with auto-read on whose turn ended with each of `replies`, then waits for `<root>/go-<name>`. */
	const auto = (name: string, replies: string[], after: string[] = []) => start(name, ["read-auto on", ...replies.map((text) => `turn ${text}`), ...after, `await go-${name}`]);
	const noted = (s: Session) => waitFor(() => existsSync(join(root, `${s.name}.json`)) && s.seen().notes.length > 0);
	/** Plays every player that shows up to its end, one at a time as they come, until `done` holds. */
	const playThrough = async (done: () => boolean) => {
		const end = Date.now() + 20000;
		while (!done()) {
			if (Date.now() > end) throw new Error("timed out playing through");
			for (const pid of pidsIn(root)) if (alive(pid)) finish(pid);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	};

	it("a reply due while another session reads waits, without stopping it, and is read after it, in order", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const b = auto("b", ["Uno.", "Dos."]);
		await noted(b);
		await wait();
		expect(alive(playerA)).toBe(true);
		expect(hasPlayer(b)).toBe(false);
		finish(playerA);
		await a.exited;
		await playThrough(() => b.seen().statuses.filter((x) => x === null).length === 2);
		expect(await readings(b, 2)).toEqual(["Reading P3.R1 on local · 1 waiting · Alt+M pauses", null, "Reading P4.R1 on local · Alt+M pauses", null]);
		go("go-b");
		await b.exited;
		expect(lines()).toEqual([`start ${a.child.pid}`, `end ${a.child.pid}`, `start ${b.child.pid}`, `end ${b.child.pid}`, `start ${b.child.pid}`, `end ${b.child.pid}`]);
		// S16: the footer counts what waits on the machine, here the other session's two replies. Its 250 ms check may
		// also catch the moment only the first had joined.
		const footers = a.seen().statuses.filter((status) => status !== "Reading P2.R1 on local · 1 waiting · Alt+M pauses");
		expect({ notes: a.seen().notes, footers }).toEqual({
			notes: [],
			footers: ["Reading P2.R1 on local · Alt+M pauses", "Reading P2.R1 on local · 2 waiting · Alt+M pauses", null],
		});
		expect(b.seen().notes).toEqual([["Auto-read on: full replies.", "info"]]);
	});

	it("two sessions waiting at once read one after the other, neither stopping the other", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const b = auto("b", ["Uno."]);
		const c = auto("c", ["Uno."]);
		await Promise.all([noted(b), noted(c)]);
		await wait();
		expect(alive(playerA)).toBe(true);
		expect([hasPlayer(b), hasPlayer(c)]).toEqual([false, false]);
		finish(playerA);
		await playThrough(() => [b, c].every((s) => s.seen().statuses.includes(null)));
		go("go-b");
		go("go-c");
		await Promise.all([a.exited, b.exited, c.exited]);
		const log = lines();
		expect(log.filter((line) => line.startsWith("term"))).toEqual([]);
		// Never two players at once: every start is followed by its own end.
		for (let i = 0; i < log.length; i += 2) expect(log[i + 1]).toBe(log[i].replace("start", "end"));
		expect(log).toHaveLength(6);
		// Which of the two goes first is not fixed, so the machine-wide count (S16) is left out.
		for (const s of [b, c]) expect({ ...s.seen(), statuses: plain(s.seen().statuses) }).toMatchObject({ notes: [["Auto-read on: full replies.", "info"]], statuses: ["Reading P3.R1 on local · Alt+M pauses", null] });
	});

	for (const [what, commands, notes] of [
		["a manual /read", ["read P1.R1"], []],
		["/read-stop", ["read-stop"], [["Reading stopped.", "info"]]],
	] as const) {
		it(`${what} in another session stops the reading and drops every waiting reply on the machine; later ones are read`, async () => {
			const a = start("a", ["read"]);
			const playerA = await playerOf(a.child);
			const b = auto("b", ["Uno.", "Dos."], ["await later-b", "turn Tres."]);
			await noted(b);
			await wait();
			const c = start("c", [...commands, "await go-c"]);
			await waitFor(() => !alive(playerA));
			await waitFor(() => existsSync(join(root, "c.json")) && c.seen().notes.length === notes.length);
			if (what === "a manual /read") finish(await playerOf(c.child));
			await wait();
			expect(hasPlayer(b)).toBe(false);
			go("later-b");
			await playThrough(() => b.seen().statuses.includes(null));
			go("go-b");
			go("go-c");
			await Promise.all([a.exited, b.exited, c.exited]);
			expect(b.seen()).toMatchObject({ notes: [["Auto-read on: full replies.", "info"]], statuses: ["Reading P5.R1 on local · Alt+M pauses", null] });
			expect(c.seen().notes).toEqual(notes);
			expect(a.seen()).toMatchObject({ notes: [], statuses: ["Reading P2.R1 on local · Alt+M pauses", "Reading P2.R1 on local · 2 waiting · Alt+M pauses", null] });
		});
	}

	it("the pause key pauses the reading (S15), Esc is not taken: it keeps the machine with no player, the waiting replies wait, and play after it resumes", async () => {
		const a = start("a", ["read", "await esc-a", "pause-key", "await esc2-a", "pause-key"]);
		const playerA = await playerOf(a.child);
		const b = auto("b", ["Uno."]);
		await noted(b);
		await wait();
		go("esc-a");
		await waitFor(() => !alive(playerA));
		const file = join(root, "run", "pi-reply-reader", "reading.json");
		await waitFor(() => (JSON.parse(readFileSync(file, "utf8")) as { paused?: boolean }).paused === true);
		const entry = JSON.parse(readFileSync(file, "utf8")) as { pid: number; player?: number; paused?: boolean };
		expect([entry.pid, entry.player, entry.paused]).toEqual([a.child.pid, undefined, true]);
		await wait();
		expect(hasPlayer(b)).toBe(false);
		// The other session's footer shows the pause (S25).
		await showsPause(b);
		go("esc2-a");
		const pidFile = join(root, `play-${a.child.pid}.pid`);
		await waitFor(() => readFileSync(pidFile, "utf8").trim() !== "" && Number(readFileSync(pidFile, "utf8")) !== playerA);
		finish(Number(readFileSync(pidFile, "utf8")));
		await a.exited;
		await playThrough(() => readP3(b));
		go("go-b");
		await b.exited;
		expect(a.seen().notes).toEqual([
			["esc", null],
			["Reading paused.", "info"],
			["esc", null],
			["Reading resumed.", "info"],
		]);
		expect(a.seen().statuses).toEqual([
			"Reading P2.R1 on local · Alt+M pauses",
			"Reading P2.R1 on local · 1 waiting · Alt+M pauses",
			"Paused P2.R1 · 1 waiting · Alt+M resumes · /read-stop ends",
			"Reading P2.R1 on local · 1 waiting · Alt+M pauses",
			null,
		]);
		expect(b.seen().notes).toEqual([["Auto-read on: full replies.", "info"]]);
		expect(b.seen().statuses.filter((status) => status !== null)).toEqual([pausedHere, "Reading P3.R1 on local · Alt+M pauses"]);
		expect(b.seen().statuses.at(-1)).toBe(null);
	});

	it("the pause key in another session pauses the reading playing here, as /read-pause does (S15, L147)", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const b = start("b", ["pause-key"]);
		expect((await ran(b)).notes).toEqual([
			["esc", null],
			["Reading paused.", "info"],
		]);
		await waitFor(() => !alive(playerA));
		await waitFor(() => a.seen().statuses.at(-1) === "Paused P2.R1 · Alt+M resumes · /read-stop ends");
		expect(a.seen().notes).toEqual([]);
	});

	it("a leftover mutex that cannot be deleted (read-only folder) never hangs: auto-read is busy, /read goes ahead (S1, S8)", () => {
		const dir = join(root, "run", "pi-reply-reader");
		mkdirSync(dir, { recursive: true });
		const script = join(root, "claim.mjs");
		writeFileSync(
			script,
			`const { openReadingLock } = await import(process.argv[2]);
const lock = openReadingLock({ XDG_RUNTIME_DIR: process.argv[3] });
const auto = lock.claimIfFree(lock.waitingMark());
const claim = lock.claim({ dropWaiting: true });
console.log(JSON.stringify({ auto: typeof auto === "string" ? auto : "claim", claim: typeof claim.lost }));
`,
		);
		const victim = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
		for (const content of [`${Number(victim.stdout)} 1`, ""]) {
			writeFileSync(join(dir, "reading.lock"), content);
			if (content === "") {
				const old = new Date(Date.now() - 5000);
				utimesSync(join(dir, "reading.lock"), old, old);
			}
			chmodSync(dir, 0o500);
			try {
				const result = spawnSync(process.execPath, [script, LOCK, join(root, "run")], { encoding: "utf8", timeout: 5000 });
				expect({ signal: result.signal, stdout: result.stdout.trim() }).toEqual({ signal: null, stdout: JSON.stringify({ auto: "busy", claim: "function" }) });
			} finally {
				chmodSync(dir, 0o700);
			}
		}
	});

	it("three sessions waiting at once read one at a time, one session's replies in order (S8 Queue)", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const [b, c, d] = [auto("b", ["Uno.", "Dos."]), auto("c", ["Uno."]), auto("d", ["Uno."])];
		await Promise.all([noted(b), noted(c), noted(d)]);
		await wait();
		expect([b, c, d].map(hasPlayer)).toEqual([false, false, false]);
		finish(playerA);
		const nulls = (s: Session) => s.seen().statuses.filter((x) => x === null).length;
		await playThrough(() => nulls(b) === 2 && nulls(c) === 1 && nulls(d) === 1);
		for (const n of ["b", "c", "d"]) go(`go-${n}`);
		await Promise.all([a.exited, b.exited, c.exited, d.exited]);
		const log = lines();
		expect(log).toHaveLength(10);
		for (let i = 0; i < log.length; i += 2) expect(log[i + 1]).toBe(log[i].replace("start", "end"));
		// The machine-wide count (S16) depends on which session goes first, so it is left out.
		expect(plain(b.seen().statuses)).toEqual(["Reading P3.R1 on local · Alt+M pauses", null, "Reading P4.R1 on local · Alt+M pauses", null]);
	});

	it("a manual /read cancelled at the output question drops nothing and stops nothing (S8)", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const b = auto("b", ["Uno."]);
		await noted(b);
		mkdirSync(join(root, "config2", "pi-reply-reader"), { recursive: true });
		writeFileSync(join(root, "config2", "pi-reply-reader", "outputs.json"), JSON.stringify({ desk: "tcp:desk:4713" }));
		const c = start("c", ["read P1.R1"], { ...env, XDG_CONFIG_HOME: join(root, "config2") });
		await c.exited;
		expect(c.seen().notes).toEqual([["Reading cancelled: no output chosen.", "info"]]);
		await wait();
		expect([alive(playerA), hasPlayer(b)]).toEqual([true, false]);
		finish(playerA);
		await playThrough(() => b.seen().statuses.includes(null));
		go("go-b");
		await Promise.all([a.exited, b.exited]);
		expect(lines()).toEqual([`start ${a.child.pid}`, `end ${a.child.pid}`, `start ${b.child.pid}`, `end ${b.child.pid}`]);
	});

	it("a mutex left by a SIGKILLed holder is broken: auto-read and /read still work (S1, S8)", async () => {
		const dir = join(root, "run", "pi-reply-reader");
		mkdirSync(dir, { recursive: true });
		const victim = spawn("/bin/sleep", ["30"]);
		await new Promise((r) => setTimeout(r, 100));
		const st = startTime(victim.pid as number);
		victim.kill("SIGKILL");
		await new Promise((r) => victim.on("exit", r));
		writeFileSync(join(dir, "reading.lock"), `${victim.pid} ${st}`);
		const b = auto("b", ["Uno."]);
		const playerB = await playerOf(b.child);
		const c = start("c", ["read P1.R1"]);
		const playerC = await playerOf(c.child);
		await waitFor(() => !alive(playerB));
		finish(playerC);
		go("go-b");
		await Promise.all([b.exited, c.exited]);
		expect(existsSync(join(dir, "reading.lock"))).toBe(false);
		expect(b.seen().notes).toEqual([["Auto-read on: full replies.", "info"]]);
	});

	it("a reading whose session died does not hold the waiting replies (stale entry)", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const b = auto("b", ["Uno."]);
		await noted(b);
		await wait();
		expect(hasPlayer(b)).toBe(false);
		a.child.kill("SIGKILL");
		await a.exited;
		kill(playerA);
		await playThrough(() => b.seen().statuses.includes(null));
		go("go-b");
		await b.exited;
		expect(b.seen()).toMatchObject({ notes: [["Auto-read on: full replies.", "info"]], statuses: ["Reading P3.R1 on local · Alt+M pauses", null] });
	});

	describe("play order follows /read-queue's list (S16, L135)", () => {
		/** A plays /read with auto-read on; B's reply joins the line, then A's own reply joins after it, while A plays. */
		const lineUp = async () => {
			const a = start("a", ["read-auto on", "read", "await turn-a", "turn Dos.", "await go-a"]);
			const playerA = await playerOf(a.child);
			const b = auto("b", ["Uno."]);
			await noted(b);
			await wait();
			go("turn-a");
			await waitFor(() => a.seen().statuses.some((status) => status?.includes("· 2 waiting ·") ?? false));
			return { a, b, playerA };
		};
		const nulls = (s: Session) => s.seen().statuses.filter((x) => x === null).length;

		it("when a session's reading ends, another session's earlier reply plays before its own next one", async () => {
			const { a, b, playerA } = await lineUp();
			finish(playerA);
			await playThrough(() => nulls(a) === 2 && nulls(b) === 1);
			go("go-a");
			go("go-b");
			await Promise.all([a.exited, b.exited]);
			expect(lines()).toEqual([
				`start ${a.child.pid}`,
				`end ${a.child.pid}`,
				`start ${b.child.pid}`,
				`end ${b.child.pid}`,
				`start ${a.child.pid}`,
				`end ${a.child.pid}`,
			]);
		});

		it("a live session slow to claim keeps its turn: the other session waits for it while it beats, past 1 s", async () => {
			const { a, b, playerA } = await lineUp();
			go("slow-b");
			finish(playerA);
			await new Promise((resolve) => setTimeout(resolve, 2500));
			// B could not start yet, and A did not take B's turn.
			expect(lines()).toEqual([`start ${a.child.pid}`, `end ${a.child.pid}`]);
			rmSync(join(root, "slow-b"));
			await playThrough(() => nulls(a) === 2 && nulls(b) === 1);
			go("go-a");
			go("go-b");
			await Promise.all([a.exited, b.exited]);
			expect(lines()).toEqual([
				`start ${a.child.pid}`,
				`end ${a.child.pid}`,
				`start ${b.child.pid}`,
				`end ${b.child.pid}`,
				`start ${a.child.pid}`,
				`end ${a.child.pid}`,
			]);
		});

		it("a frozen session's earlier reply delays the next reading only until its heartbeat is stale (2 s), then it plays", async () => {
			const { a, b, playerA } = await lineUp();
			b.child.kill("SIGSTOP");
			try {
				const from = Date.now();
				finish(playerA);
				const pidFile = join(root, `play-${a.child.pid}.pid`);
				await waitFor(() => readFileSync(pidFile, "utf8").trim() !== "" && Number(readFileSync(pidFile, "utf8")) !== playerA);
				const delay = Date.now() - from;
				// It yielded until B's last beat (at most 250 ms before the freeze) was 2 s old, checked every 250 ms, and
				// not much longer: a frozen session cannot hold the line.
				expect(delay).toBeGreaterThanOrEqual(1500);
				expect(delay).toBeLessThan(4000);
				expect(hasPlayer(b)).toBe(false);
				finish(Number(readFileSync(pidFile, "utf8")));
			} finally {
				b.child.kill("SIGCONT");
				b.child.kill("SIGKILL");
			}
			go("go-a");
			await a.exited;
		});
	});

	describe("the yield cap counts only free time; asking or ended sessions are not waited for (S16, L138)", () => {
		const lineFiles = () => {
			const dir = join(root, "run", "pi-reply-reader");
			return existsSync(dir) ? readdirSync(dir).filter((name) => /^line-.*\.json$/.test(name)) : [];
		};
		const starts = () => lines().filter((line) => line.startsWith("start"));
		/** x reads; then c, d and b join the line in that order, each seen on the machine before the next joins. */
		const lineUp = async () => {
			const x = start("x", ["read"]);
			const playerX = await playerOf(x.child);
			const joined: Session[] = [];
			for (const name of ["c", "d", "b"]) {
				joined.push(auto(name, ["Uno."]));
				await waitFor(() => existsSync(join(root, "x.json")) && x.seen().statuses.some((s) => s?.includes(`· ${joined.length} waiting ·`) ?? false));
			}
			return { x, playerX, c: joined[0], d: joined[1], b: joined[2] };
		};
		const order = (...sessions: Session[]) => sessions.map((s) => `start ${s.child.pid}`);
		const nulls = (s: Session) => s.seen().statuses.filter((x) => x === null).length;

		it("after a reading longer than the cap, the next waits for its turn: d, slow to claim, still goes before b", { timeout: 60000 }, async () => {
			writeFileSync(join(root, "yield-cap"), "2500");
			const { x, playerX, c, d, b } = await lineUp();
			finish(playerX);
			const playerC = await playerOf(c.child);
			// c plays longer than the cap while d and b wait: that time is not theirs to count.
			await new Promise((resolve) => setTimeout(resolve, 3500));
			go("slow-d");
			finish(playerC);
			await new Promise((resolve) => setTimeout(resolve, 800));
			rmSync(join(root, "slow-d"));
			await playThrough(() => [c, d, b].every((s) => nulls(s) === 1));
			for (const s of [c, d, b]) go(`go-${s.name}`);
			await Promise.all([x, c, d, b].map((s) => s.exited));
			expect(starts()).toEqual(order(x, c, d, b));
		});

		it("with natural timing, x then c (longer than the cap), d and b play in join order, every time", { timeout: 90000 }, async () => {
			writeFileSync(join(root, "yield-cap"), "1500");
			for (let round = 0; round < 3; round++) {
				rmSync(join(root, "log"), { force: true });
				for (const name of ["c", "d", "b"]) rmSync(join(root, `go-${name}`), { force: true });
				const { x, playerX, c, d, b } = await lineUp();
				finish(playerX);
				const playerC = await playerOf(c.child);
				await new Promise((resolve) => setTimeout(resolve, 2500));
				finish(playerC);
				await playThrough(() => [c, d, b].every((s) => nulls(s) === 1));
				for (const s of [c, d, b]) go(`go-${s.name}`);
				await Promise.all([x, c, d, b].map((s) => s.exited));
				expect({ round, starts: starts() }).toEqual({ round, starts: order(x, c, d, b) });
			}
		});

		/** Two outputs, so the first reading of a session asks where it should sound. */
		const twoOutputs = () => {
			mkdirSync(join(root, "config2", "pi-reply-reader"), { recursive: true });
			writeFileSync(join(root, "config2", "pi-reply-reader", "outputs.json"), JSON.stringify({ desk: "tcp:desk:4713" }));
			return { ...env, XDG_CONFIG_HOME: join(root, "config2") };
		};

		it("a session ended while its reading waits on the output question stops beating: no line file is left", async () => {
			go("ask-a");
			const a = start("a", ["read-auto on", "turn Uno.", "await shut-a", "shutdown", "await go-a"], twoOutputs());
			await waitFor(() => existsSync(join(root, "asked-a")) && lineFiles().length === 1);
			go("shut-a");
			await new Promise((resolve) => setTimeout(resolve, 1500));
			expect(lineFiles()).toEqual([]);
			rmSync(join(root, "ask-a"));
			go("go-a");
			await a.exited;
			expect(lineFiles()).toEqual([]);
			expect(hasPlayer(a)).toBe(false);
		});

		it("(L149 PROBE-C) /read-auto off while the reading's start waits on the output question: no line file is left", async () => {
			go("ask-a");
			const a = start("a", ["read-auto on", "turn Uno.", "await off-a", "read-auto off", "await go-a"], twoOutputs());
			await waitFor(() => existsSync(join(root, "asked-a")) && lineFiles().length === 1);
			go("off-a");
			await new Promise((resolve) => setTimeout(resolve, 1500));
			expect(lineFiles()).toEqual([]);
			rmSync(join(root, "ask-a"));
			go("go-a");
			await a.exited;
			expect(lineFiles()).toEqual([]);
			expect(hasPlayer(a)).toBe(false);
		});

		it("a session waiting on a human (the output question) is not waited for: another session's readings start at once", async () => {
			go("ask-a");
			const a = start("a", ["read-auto on", "turn Uno.", "await go-a"], twoOutputs());
			await waitFor(() => existsSync(join(root, "asked-a")) && lineFiles().length === 1);
			const b = auto("b", ["Uno.", "Dos."]);
			// Without the ~10 s yield to a's reading, which waits for its human.
			await waitFor(() => hasPlayer(b), 4000);
			const first = await playerOf(b.child);
			finish(first);
			const pidFile = join(root, `play-${b.child.pid}.pid`);
			await waitFor(() => readFileSync(pidFile, "utf8").trim() !== "" && Number(readFileSync(pidFile, "utf8")) !== first, 4000);
			finish(Number(readFileSync(pidFile, "utf8")));
			await waitFor(() => nulls(b) === 2);
			rmSync(join(root, "ask-a"));
			go("go-a");
			go("go-b");
			await Promise.all([a.exited, b.exited]);
			expect(starts()).toEqual([`start ${b.child.pid}`, `start ${b.child.pid}`]);
		});
	});

	it("(S15, L135 PROBE1) a paused session that is SIGKILLed frees the machine: the other session's waiting reply starts within 1.5 s", async () => {
		const a = start("a", ["read", "await esc-a", "pause-key", "await go-a"]);
		const playerA = await playerOf(a.child);
		const b = auto("b", ["Uno."]);
		await noted(b);
		await wait();
		go("esc-a");
		await waitFor(() => !alive(playerA));
		const file = join(root, "run", "pi-reply-reader", "reading.json");
		await waitFor(() => (JSON.parse(readFileSync(file, "utf8")) as { paused?: boolean }).paused === true);
		expect(hasPlayer(b)).toBe(false);
		await showsPause(b);
		const from = Date.now();
		a.child.kill("SIGKILL");
		await waitFor(() => hasPlayer(b), 1500);
		expect(Date.now() - from).toBeLessThan(1500);
		await playThrough(() => readP3(b));
		go("go-b");
		await b.exited;
		// A pause whose session died is no pause: the footer drops it as the reply starts.
		expect(b.seen().notes).toEqual([["Auto-read on: full replies.", "info"]]);
		expect(b.seen().statuses.filter((status) => status !== null)).toEqual([pausedHere, "Reading P3.R1 on local · Alt+M pauses"]);
		expect(b.seen().statuses.at(-1)).toBe(null);
	});

	it("(S25) a reading paused in one process shows in another process's footer, with the pausing session's label and what waits; its pause key resumes it", async () => {
		const a = start("a", ["name homelab", "read", "await pause-a", "pause-key", "await go-a"]);
		const playerA = await playerOf(a.child);
		const b = start("b", ["name otra", "read-auto on", "turn Uno.", "await resume-b", "pause-key", "await go-b"]);
		await noted(b);
		go("pause-a");
		await waitFor(() => !alive(playerA));
		const shown = "Auto-read on · Paused in homelab · 1 waiting · Alt+M resumes";
		await waitFor(() => ((b.seen() as Seen & { footers?: (string | null)[] }).footers ?? []).includes(shown));
		expect(a.seen().statuses.at(-1)).toBe("Paused P2.R1 · 1 waiting · Alt+M resumes · /read-stop ends");
		expect(hasPlayer(b)).toBe(false);
		go("resume-b");
		const pidFile = join(root, `play-${a.child.pid}.pid`);
		await waitFor(() => readFileSync(pidFile, "utf8").trim() !== "" && Number(readFileSync(pidFile, "utf8")) !== playerA);
		await waitFor(() => (b.seen() as Seen & { footers: (string | null)[] }).footers.at(-1) === "Auto-read on");
		expect(b.seen().notes).toEqual([
			["Auto-read on: full replies.", "info"],
			["esc", null],
			["Reading resumed.", "info"],
		]);
		finish(Number(readFileSync(pidFile, "utf8")));
		// b's own reply plays once a's ends.
		await playThrough(() => {
			const statuses = b.seen().statuses;
			const reading = statuses.indexOf("Reading P3.R1 on local · Alt+M pauses");
			return reading >= 0 && statuses.slice(reading).includes(null);
		});
		go("go-a");
		go("go-b");
		await Promise.all([a.exited, b.exited]);
	});

	it("(S16, L135 PROBE3) /read-next from another session while a reading is paused ends it and the next one waiting starts", async () => {
		const a = start("a", ["read", "await esc-a", "pause-key", "await go-a"]);
		const playerA = await playerOf(a.child);
		const c = auto("c", ["Uno."]);
		await noted(c);
		await wait();
		go("esc-a");
		await waitFor(() => !alive(playerA));
		const file = join(root, "run", "pi-reply-reader", "reading.json");
		await waitFor(() => (JSON.parse(readFileSync(file, "utf8")) as { paused?: boolean }).paused === true);
		await wait();
		expect(hasPlayer(c)).toBe(false);
		await showsPause(c);
		const b = start("b", ["read-next"]);
		expect((await ran(b)).notes).toEqual([["Skipped to the next reading.", "info"]]);
		await playerOf(c.child);
		await playThrough(() => readP3(c));
		// The paused session learns it was ended even when the next reading already ended and released the machine.
		await waitFor(() => a.seen().statuses.at(-1) === null);
		go("go-a");
		go("go-c");
		await Promise.all([a.exited, b.exited, c.exited]);
		expect(lines()).toEqual([`start ${a.child.pid}`, `term ${a.child.pid}`, `start ${c.child.pid}`, `end ${c.child.pid}`]);
		expect(a.seen().notes).toEqual([
			["esc", null],
			["Reading paused.", "info"],
		]);
		expect(c.seen().notes).toEqual([["Auto-read on: full replies.", "info"]]);
		expect(c.seen().statuses.filter((status) => status !== null)).toEqual([pausedHere, "Reading P3.R1 on local · Alt+M pauses"]);
		expect(c.seen().statuses.at(-1)).toBe(null);
	});

	it("with auto-read on, a manual /read still stops another session's reading at once (S1)", async () => {
		const a = start("a", ["read"]);
		const playerA = await playerOf(a.child);
		const b = start("b", ["read-auto on", "read P1.R1"]);
		const playerB = await playerOf(b.child);
		await waitFor(() => !alive(playerA));
		expect(alive(playerB)).toBe(true);
		expect((await ran(b)).notes).toEqual([["Auto-read on: full replies.", "info"]]);
		await a.exited;
		expect(a.seen()).toMatchObject({ notes: [], statuses: ["Reading P2.R1 on local · Alt+M pauses", null] });
	});

	describe("ask before cutting (T33, S8)", () => {
		const QUESTION = ["Something is being read.", "→ Stop it and read now", "Read after it"];

		it("a manual /read in another process while one plays asks; Read after it waits for it, then plays", async () => {
			const a = start("a", ["read"]);
			const playerA = await playerOf(a.child);
			const b = start("b", ["answer after", "read P1.R1", "await go-b"]);
			await waitFor(() => existsSync(join(root, "b.json")) && b.seen().asked.length === 1);
			expect(b.seen().asked).toEqual([QUESTION]);
			await wait();
			expect([alive(playerA), hasPlayer(b)]).toEqual([true, false]);
			finish(playerA);
			await playThrough(() => b.seen().statuses.includes(null));
			go("go-b");
			await Promise.all([a.exited, b.exited]);
			expect(lines()).toEqual([`start ${a.child.pid}`, `end ${a.child.pid}`, `start ${b.child.pid}`, `end ${b.child.pid}`]);
			expect(b.seen()).toMatchObject({ notes: [], statuses: ["Reading P1.R1 on local · Alt+M pauses", null] });
		});

		it("dismissing it in another process changes nothing: the reading plays on, the waiting auto-reads stay, nothing else plays", async () => {
			const a = start("a", ["read"]);
			const playerA = await playerOf(a.child);
			const c = auto("c", ["Uno."]);
			await noted(c);
			const b = start("b", ["answer dismiss", "read P1.R1", "await go-b"]);
			await waitFor(() => existsSync(join(root, "b.json")) && b.seen().asked.length === 1);
			expect(b.seen().asked).toEqual([QUESTION]);
			await wait();
			expect([alive(playerA), hasPlayer(b), hasPlayer(c)]).toEqual([true, false, false]);
			finish(playerA);
			await playThrough(() => c.seen().statuses.includes(null));
			await wait();
			go("go-b");
			go("go-c");
			await Promise.all([a.exited, b.exited, c.exited]);
			expect(lines()).toEqual([`start ${a.child.pid}`, `end ${a.child.pid}`, `start ${c.child.pid}`, `end ${c.child.pid}`]);
			expect(b.seen()).toMatchObject({ notes: [], statuses: [] });
		});

		it("a request waiting after Read after it is dropped by a third session's /read-stop", async () => {
			const a = start("a", ["read"]);
			const playerA = await playerOf(a.child);
			const b = start("b", ["answer after", "read P1.R1", "await go-b"]);
			await waitFor(() => existsSync(join(root, "b.json")) && b.seen().asked.length === 1);
			const c = start("c", ["read-stop"]);
			await c.exited;
			await waitFor(() => !alive(playerA));
			await wait();
			expect(hasPlayer(b)).toBe(false);
			go("go-b");
			await Promise.all([a.exited, b.exited]);
			expect(lines()).toEqual([`start ${a.child.pid}`, `term ${a.child.pid}`]);
			expect(c.seen().notes).toEqual([["Reading stopped.", "info"]]);
			expect([a.seen().asked, c.seen().asked]).toEqual([[], []]);
		});
	});

	it("without a usable XDG_RUNTIME_DIR the queue is per session: another session's reading is not waited for", async () => {
		const own = { ...env };
		delete own.XDG_RUNTIME_DIR;
		const a = start("a", ["read"], own);
		const playerA = await playerOf(a.child);
		const b = start("b", ["read-auto on", "turn Uno.", "await go-b"], own);
		const playerB = await playerOf(b.child);
		expect(alive(playerA)).toBe(true);
		finish(playerB);
		finish(playerA);
		go("go-b");
		await Promise.all([a.exited, b.exited]);
		expect(lines().filter((line) => line.startsWith("term"))).toEqual([]);
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
