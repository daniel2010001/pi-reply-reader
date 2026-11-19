import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import replyReader, { createReplyReader } from "../extensions/reply-reader.ts";
import type { SherpaRequest, SherpaTts } from "../src/playback.ts";
import { READER_EVENTS } from "../src/reader-events.ts";
import { speechText } from "../src/speech-text.ts";

let root: string;
let env: NodeJS.ProcessEnv;
let next = 0;
/** Every request the fake engine received, in order. */
let synthesized: SherpaRequest[];
/** When set, the fake engine waits for it before answering each fragment. */
let gate: Promise<void> | undefined;

beforeEach(() => {
	synthesized = [];
	gate = undefined;
	root = mkdtempSync(join(tmpdir(), "reply-reader-ext-"));
	mkdirSync(join(root, "bin"));
	env = { PATH: join(root, "bin"), HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const log = (name: string) => join(root, name);
const read = (name: string) => readFileSync(log(name), "utf8");

function script(name: string, body: string): void {
	const path = join(root, "bin", name);
	writeFileSync(path, `#!/bin/sh\nPATH=/usr/bin:/bin\n${body}\n`);
	chmodSync(path, 0o755);
}

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

/**
 * An installed Supertonic model and a paplay that records each playback. The default paplay keeps
 * the reading going until stopped when `paplayBody` makes it sleep.
 */
function installVoice(paplayBody = ""): void {
	script(
		"paplay",
		`n=$(ls "${root}" | grep -c '^play-.*\.pid$'); echo "\${PULSE_SERVER-unset}" > "${root}/play-$n.server"; echo $$ > "${root}/play-$n.pid"; ${paplayBody} cat > "${root}/play-$n.audio"`,
	);
	const dir = join(root, "data", "pi-reply-reader", "voices", BUNDLE);
	mkdirSync(dir, { recursive: true });
	for (const name of MODEL_FILES) writeFileSync(join(dir, name), name);
}

/**
 * The engine: each fragment becomes one audible sample (a silent one would be trimmed away), so paplay receives
 * two bytes per fragment plus the pause between fragments.
 */
const loadSherpa = async (): Promise<SherpaTts> => ({
	sampleRate: 44100,
	async generateAsync(request) {
		synthesized.push(request);
		await gate;
		return { samples: new Float32Array(1).fill(0.125) };
	},
});

const settingsDir = () => join(root, "config", "pi-reply-reader");
const settingsPath = () => join(settingsDir(), "settings.json");

function writeSettings(content: string): void {
	mkdirSync(settingsDir(), { recursive: true });
	writeFileSync(settingsPath(), content);
}

const speeds = () => synthesized.map((request) => request.generationConfig.speed);

function configureOutputs(outputs: Record<string, string>): void {
	mkdirSync(join(root, "config", "pi-reply-reader"), { recursive: true });
	writeFileSync(join(root, "config", "pi-reply-reader", "outputs.json"), JSON.stringify(outputs));
}

const user = (text: string) => ({ type: "message", id: `u${++next}`, timestamp: "t", message: { role: "user", content: text } });
const assistant = (text: string) => ({
	type: "message",
	id: `a${++next}`,
	timestamp: "t",
	message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});
const branch = [user("hola"), assistant("**Primera** respuesta."), user("otra"), assistant("## Segunda\n\n- `auto_read` listo")];

type Handler = (...args: never[]) => unknown;

/**
 * An in-memory stand-in for Pi's shared event bus (`pi.events`), shaped like Pi's own: `emit` calls every handler
 * synchronously (Node's EventEmitter), each wrapped so its errors are caught, and `on` returns an unsubscribe.
 * `emitted` records every emit, in order, by any side.
 */
function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const emitted: [string, unknown][] = [];
	return {
		emitted,
		emit: (channel: string, data: unknown) => {
			emitted.push([channel, data]);
			for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
		},
		on: (channel: string, handler: (data: unknown) => unknown) => {
			const safe = async (data: unknown) => {
				try {
					await handler(data);
				} catch (error) {
					console.error(`Event handler error (${channel}):`, error);
				}
			};
			const set = handlers.get(channel) ?? new Set();
			handlers.set(channel, set);
			set.add(safe);
			return () => void set.delete(safe);
		},
		/** How many handlers listen on `channel` now. */
		listeners: (channel: string) => handlers.get(channel)?.size ?? 0,
	};
}

/** Loads the extension into a recording Pi and returns a driver for its commands, events and UI. */
function load(answers: { select?: string; confirm?: boolean } = {}, start: unknown[] = branch) {
	/** The session branch; a test appends to it to simulate a new turn. */
	const entries = [...start];
	const commands = new Map<string, { handler: Handler; getArgumentCompletions?: Handler }>();
	const events = new Map<string, Handler>();
	const bus = createBus();
	const pi = {
		registerCommand: (name: string, options: { handler: Handler; getArgumentCompletions?: Handler }) => commands.set(name, options),
		on: (event: string, handler: Handler) => events.set(event, handler),
		events: { emit: bus.emit, on: bus.on },
	};
	createReplyReader({ env, hostname: "hs-node", loadSherpa })(pi as never);

	const notes: [string, string | undefined][] = [];
	const selects: [string, string[]][] = [];
	const confirms: string[] = [];
	const statuses: (string | undefined)[] = [];
	let input: ((data: string) => unknown) | undefined;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: join(root, "work"),
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: (message: string, type?: string) => notes.push([message, type]),
			select: async (title: string, options: string[]) => (selects.push([title, options]), answers.select),
			confirm: async (_title: string, message: string) => (confirms.push(message), answers.confirm ?? false),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			onTerminalInput: (handler: (data: string) => unknown) => ((input = handler), () => (input = undefined)),
		},
	};
	(events.get("session_start") as (event: unknown, ctx: unknown) => void)({ reason: "startup" }, ctx);

	return {
		bus,
		commands,
		notes,
		selects,
		confirms,
		statuses,
		run: (name: string, args = "") => (commands.get(name)!.handler as (a: string, c: unknown) => Promise<void>)(args, ctx),
		key: (data: string) => input?.(data),
		shutdown: () => (events.get("session_shutdown") as (event: unknown, ctx: unknown) => void)({}, ctx),
		restart: () => (events.get("session_start") as (event: unknown, ctx: unknown) => void)({ reason: "new" }, ctx),
		entries,
		/** One agent run: it starts, adds `added` to the branch, and settles. */
		turn: (added: unknown[], aborted = false) => {
			(events.get("agent_start") as ((event: unknown, ctx: unknown) => void) | undefined)?.({ type: "agent_start" }, ctx);
			entries.push(...added);
			(events.get("agent_settled") as ((event: unknown, ctx: unknown) => void) | undefined)?.({ type: "agent_settled", aborted }, ctx);
		},
		/** Waits until the reading in progress clears its status line. */
		settled: () => waitFor(() => statuses.length > 0 && statuses.at(-1) === undefined),
	};
}

describe("reply-reader extension", () => {
	it("registers /read and /read-output by default", () => {
		const names: string[] = [];
		replyReader({ registerCommand: (name: string) => names.push(name), on: () => {} } as never);
		expect(names).toEqual(["read", "read-stop", "read-output", "read-voice", "read-speed", "read-auto"]);
	});

	describe("/read-auto (S8)", () => {
		const texts = () => synthesized.map((request) => request.text);
		/** Lets an auto-reading that would start get as far as the engine. */
		const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
		const questions = "Hecho.\n\n## Needs your decision\n\n1. ¿Seguimos?\n2. ¿Publicamos?";

		it("/read-auto on, questions and off say so, each as an info", async () => {
			const reader = load();
			await reader.run("read-auto", "on");
			await reader.run("read-auto", "questions");
			await reader.run("read-auto", "off");
			expect(reader.notes).toEqual([
				["Auto-read on: full replies.", "info"],
				["Auto-read on: questions only.", "info"],
				["Auto-read off.", "info"],
			]);
		});

		it("/read-auto with anything else warns and changes nothing, whether off or on", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "full");
			reader.turn([user("a"), assistant("Uno.")]);
			await pause();
			expect(synthesized).toEqual([]);
			await reader.run("read-auto", "questions");
			await reader.run("read-auto", "yes please");
			reader.turn([user("b"), assistant(questions)]);
			await reader.settled();
			expect(reader.notes).toEqual([
				["Use /read-auto on, questions or off.", "warning"],
				["Auto-read on: questions only.", "info"],
				["Use /read-auto on, questions or off.", "warning"],
			]);
			expect(texts()).toEqual(["Decisiones pendientes.", "1: ¿Seguimos?", "2: ¿Publicamos?"]);
		});

		it("questions mode keeps the whole reply's language for added words (S7)", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "questions");
			reader.turn([user("a"), assistant("The build is done and the tests pass for the new parser.\n\n## Needs your decision\n\n1. Run `/reload`?")]);
			await reader.settled();
			expect(texts()).toEqual(["Needs your decision.", "1: Run the command reload?"]);
		});

		it("bare /read-auto toggles: off to on in full, and any on to off", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto");
			reader.turn([user("a"), assistant(questions)]);
			await reader.settled();
			expect(texts()).toEqual(["Hecho.", "Decisiones pendientes.", "1: ¿Seguimos?", "2: ¿Publicamos?"]);
			await reader.run("read-auto");
			await reader.run("read-auto", "questions");
			await reader.run("read-auto");
			reader.turn([user("b"), assistant("Dos.")]);
			await pause();
			expect(reader.notes).toEqual([
				["Auto-read on: full replies.", "info"],
				["Auto-read off.", "info"],
				["Auto-read on: questions only.", "info"],
				["Auto-read off.", "info"],
			]);
			expect(synthesized).toHaveLength(4);
		});

		it("is off by default and again at each session start", async () => {
			installVoice();
			const reader = load();
			reader.turn([user("a"), assistant("Uno.")]);
			await pause();
			await reader.run("read-auto", "on");
			reader.restart();
			reader.turn([user("b"), assistant("Dos.")]);
			await pause();
			expect(synthesized).toEqual([]);
			expect(reader.statuses).toEqual([]);
			expect(existsSync(log("play-0.pid"))).toBe(false);
		});

		it("on: a turn that ends with a reply reads it in full, like /read, with its footer", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "on");
			reader.turn([user("tercera"), assistant("## Tercera\n\nHecho **ya**.")]);
			await reader.settled();
			expect(texts()).toEqual(["Tercera.", "Hecho ya."]);
			expect(reader.statuses).toEqual(["Reading P3.R1 on local · Esc stops", undefined]);
			expect(existsSync(log("play-0.audio"))).toBe(true);
		});

		it("questions: reads only the closing Needs your decision section, heading or bold-only line", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "questions");
			reader.turn([user("a"), assistant(questions)]);
			await reader.settled();
			reader.turn([user("b"), assistant("Listo.\n\n**Needs your decision:**\n- ¿A o B?")]);
			await waitFor(() => reader.statuses.filter((status) => status === undefined).length === 2);
			expect(texts()).toEqual(["Decisiones pendientes.", "1: ¿Seguimos?", "2: ¿Publicamos?", "Decisiones pendientes.", "¿A o B?"]);
			expect(reader.statuses.filter(Boolean)).toEqual(["Reading P3.R1 on local · Esc stops", "Reading P4.R1 on local · Esc stops"]);
		});

		it("questions: a reply without that section reads nothing and says nothing", async () => {
			installVoice();
			const reader = load({ confirm: true });
			await reader.run("read-auto", "questions");
			reader.turn([user("a"), assistant("## Hecho\n\nTodo listo.")]);
			await pause();
			expect(synthesized).toEqual([]);
			expect(reader.notes).toEqual([["Auto-read on: questions only.", "info"]]);
			expect(reader.statuses).toEqual([]);
			expect(reader.confirms).toEqual([]);
			expect(existsSync(log("play-0.pid"))).toBe(false);
		});

		it("never reads earlier replies: not on switching on, nor after a turn with no new reply or an aborted one", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "on");
			await pause();
			reader.turn([user("a")]);
			await pause();
			reader.turn([user("b"), { ...assistant("A medias"), message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "A medias" }] } }], true);
			await pause();
			expect(synthesized).toEqual([]);
			expect(reader.statuses).toEqual([]);
			expect(reader.notes).toEqual([["Auto-read on: full replies.", "info"]]);
		});

		it("reuses /read's output question on first use, voice, speed, and the download confirm", async () => {
			script("paplay", "cat > /dev/null");
			const declined = load({ confirm: false });
			await declined.run("read-auto", "on");
			declined.turn([user("a"), assistant("Uno.")]);
			await waitFor(() => declined.notes.length === 2);
			expect(declined.confirms).toHaveLength(1);
			expect(declined.notes[1]).toEqual(["Reading cancelled: the voice was not downloaded.", "info"]);

			installVoice();
			configureOutputs({ desktop: "tcp:x" });
			const reader = load({ select: "desktop (tcp:x)" });
			await reader.run("read-auto", "on");
			await reader.run("read-voice", "female");
			await reader.run("read-speed", "1.3");
			reader.turn([user("a"), assistant("Uno.")]);
			await reader.settled();
			reader.turn([user("b"), assistant("Dos.")]);
			await waitFor(() => reader.statuses.filter((status) => status === undefined).length === 2);
			expect(reader.selects).toEqual([["Where should readings sound?", ["local (hs-node)", "desktop (tcp:x)"]]]);
			expect(read("play-0.server").trim()).toBe("tcp:x");
			expect(read("play-1.server").trim()).toBe("tcp:x");
			expect(synthesized.map((request) => [request.text, request.generationConfig.sid, request.generationConfig.speed])).toEqual([
				["Uno.", 0, 1.3],
				["Dos.", 0, 1.3],
			]);
			expect(reader.statuses.filter(Boolean)).toEqual(["Reading P3.R1 on desktop · Esc stops", "Reading P4.R1 on desktop · Esc stops"]);
		});

		it("Esc and /read-stop stop an auto-reading", async () => {
			installVoice("sleep 30;");
			const reader = load();
			await reader.run("read-auto", "on");
			reader.turn([user("a"), assistant("Uno.")]);
			await waitFor(() => existsSync(log("play-0.pid")));
			expect(reader.key("\x1b")).toEqual({ consume: true });
			await waitFor(() => !alive(Number(read("play-0.pid"))));
			reader.turn([user("b"), assistant("Dos.")]);
			await waitFor(() => existsSync(log("play-1.pid")));
			await reader.run("read-stop");
			await waitFor(() => !alive(Number(read("play-1.pid"))));
			expect(reader.notes).toEqual([
				["Auto-read on: full replies.", "info"],
				["Reading stopped.", "info"],
			]);
			expect(reader.statuses).toEqual(["Reading P3.R1 on local · Esc stops", undefined, "Reading P4.R1 on local · Esc stops", undefined]);
		});

		describe("queue: auto-read never interrupts (T32)", () => {
			/** A player that plays until `hold` is removed; one that played through leaves its .audio file. */
			const holding = () => {
				writeFileSync(log("hold"), "");
				installVoice(`while [ -e "${root}/hold" ]; do sleep 0.02; done;`);
			};
			const pid = (n: number) => Number(read(`play-${n}.pid`));
			const played = (n: number) => existsSync(log(`play-${n}.audio`));
			/** Longer than two of the reader's 250 ms checks. */
			const wait = () => new Promise((resolve) => setTimeout(resolve, 700));
			const ended = (reader: ReturnType<typeof load>, n: number) => waitFor(() => reader.statuses.filter((status) => status === undefined).length === n);

			it("a reply due while this session reads waits, then the waiting replies are read in order, none cut", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				reader.turn([user("a"), assistant("Uno.")]);
				reader.turn([user("b"), assistant("Dos.")]);
				await wait();
				expect(alive(pid(0))).toBe(true);
				expect(existsSync(log("play-1.pid"))).toBe(false);
				rmSync(log("hold"));
				await ended(reader, 3);
				expect(texts().slice(-2)).toEqual(["Uno.", "Dos."]);
				expect([played(0), played(1), played(2)]).toEqual([true, true, true]);
				expect(reader.statuses).toEqual([
					"Reading P2.R1 on local · Esc stops",
					undefined,
					"Reading P3.R1 on local · Esc stops",
					undefined,
					"Reading P4.R1 on local · Esc stops",
					undefined,
				]);
				expect(reader.notes).toEqual([["Auto-read on: full replies.", "info"]]);
			});

			it("a reply due while an auto-reading plays waits for it too", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "questions");
				reader.turn([user("a"), assistant(questions)]);
				await waitFor(() => existsSync(log("play-0.pid")));
				reader.turn([user("b"), assistant("Listo.\n\n**Needs your decision:**\n- ¿A o B?")]);
				await wait();
				expect(alive(pid(0))).toBe(true);
				expect(existsSync(log("play-1.pid"))).toBe(false);
				rmSync(log("hold"));
				await ended(reader, 2);
				expect([played(0), played(1)]).toEqual([true, true]);
				expect(reader.statuses.filter(Boolean)).toEqual(["Reading P3.R1 on local · Esc stops", "Reading P4.R1 on local · Esc stops"]);
			});

			it("a manual /read stops the reading and drops the waiting replies; a later reply is read", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				reader.turn([user("a"), assistant("Uno.")]);
				reader.turn([user("b"), assistant("Dos.")]);
				await wait();
				await reader.run("read", "P1.R1");
				await waitFor(() => !alive(pid(0)));
				await waitFor(() => existsSync(log("play-1.pid")));
				rmSync(log("hold"));
				await ended(reader, 2);
				await wait();
				expect(existsSync(log("play-2.pid"))).toBe(false);
				expect(texts()).not.toContain("Uno.");
				expect(texts()).not.toContain("Dos.");
				reader.turn([user("c"), assistant("Tres.")]);
				await ended(reader, 3);
				expect(texts().at(-1)).toBe("Tres.");
				expect(reader.statuses).toEqual([
					"Reading P2.R1 on local · Esc stops",
					undefined,
					"Reading P1.R1 on local · Esc stops",
					undefined,
					"Reading P5.R1 on local · Esc stops",
					undefined,
				]);
				expect(reader.notes).toEqual([["Auto-read on: full replies.", "info"]]);
			});

			it("a read request from another extension is manual too: it drops the waiting replies", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				reader.turn([user("a"), assistant("Uno.")]);
				await wait();
				reader.bus.emit(READER_EVENTS.read, { v: 1, id: "P9.R1", text: "Nueve." });
				await waitFor(() => !alive(pid(0)));
				await waitFor(() => existsSync(log("play-1.pid")));
				rmSync(log("hold"));
				await ended(reader, 2);
				await wait();
				expect(existsSync(log("play-2.pid"))).toBe(false);
				expect(texts()).not.toContain("Uno.");
				expect(reader.statuses.filter(Boolean)).toEqual(["Reading P2.R1 on local · Esc stops", "Reading P9.R1 on local · Esc stops"]);
			});

			it("/read-stop and Esc stop the reading and drop the waiting replies", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				reader.turn([user("a"), assistant("Uno.")]);
				await wait();
				await reader.run("read-stop");
				await waitFor(() => !alive(pid(0)));
				await wait();
				expect(existsSync(log("play-1.pid"))).toBe(false);
				await reader.run("read", "P2.R1");
				await waitFor(() => existsSync(log("play-1.pid")));
				reader.turn([user("b"), assistant("Dos.")]);
				await wait();
				expect(reader.key("\x1b")).toEqual({ consume: true });
				await waitFor(() => !alive(pid(1)));
				rmSync(log("hold"));
				await wait();
				expect(existsSync(log("play-2.pid"))).toBe(false);
				expect(texts()).not.toContain("Uno.");
				expect(texts()).not.toContain("Dos.");
				expect(reader.notes).toEqual([
					["Auto-read on: full replies.", "info"],
					["Reading stopped.", "info"],
				]);
				expect(reader.statuses).toEqual(["Reading P2.R1 on local · Esc stops", undefined, "Reading P2.R1 on local · Esc stops", undefined]);
			});

			it("/read-auto off and the session's end drop this session's waiting replies", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				reader.turn([user("a"), assistant("Uno.")]);
				await wait();
				await reader.run("read-auto", "off");
				rmSync(log("hold"));
				await ended(reader, 1);
				await wait();
				expect(existsSync(log("play-1.pid"))).toBe(false);
				expect(played(0)).toBe(true);

				writeFileSync(log("hold"), "");
				await reader.run("read-auto", "on");
				await reader.run("read", "P2.R1");
				await waitFor(() => existsSync(log("play-1.pid")));
				reader.turn([user("b"), assistant("Dos.")]);
				await wait();
				reader.shutdown();
				await waitFor(() => !alive(pid(1)));
				reader.restart();
				rmSync(log("hold"));
				await wait();
				expect(existsSync(log("play-2.pid"))).toBe(false);
				expect(texts()).not.toContain("Uno.");
				expect(texts()).not.toContain("Dos.");
				expect(reader.notes).toEqual([
					["Auto-read on: full replies.", "info"],
					["Auto-read off.", "info"],
					["Auto-read on: full replies.", "info"],
				]);
			});
		});

		it("/read-auto completes on, questions and off", () => {
			const reader = load();
			const complete = reader.commands.get("read-auto")!.getArgumentCompletions as (prefix: string) => { value: string }[];
			expect(complete("").map((item) => item.value)).toEqual(["on", "questions", "off"]);
			expect(complete("o").map((item) => item.value)).toEqual(["on", "off"]);
		});
	});

	describe("event contract v1 for other extensions (S10)", () => {
		const { ping, ready, read: readEvent } = READER_EVENTS;
		const texts = () => synthesized.map((request) => request.text);
		/** Lets a reading that would start get as far as the engine. */
		const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
		/** Counts every ready the reader sends, as pi-reply-thread's view would listen for it. */
		const listen = (reader: ReturnType<typeof load>) => {
			const seen = { ready: 0 };
			reader.bus.on(ready, () => void seen.ready++);
			return seen;
		};

		it("emits ready { v: 1 } at every session start", () => {
			const reader = load();
			expect(reader.bus.emitted).toEqual([[ready, { v: 1 }]]);
			reader.restart();
			expect(reader.bus.emitted).toEqual([
				[ready, { v: 1 }],
				[ready, { v: 1 }],
			]);
		});

		it("answers a v1 ping with ready { v: 1 } before emit returns, and ignores any other ping", () => {
			const reader = load();
			const seen = listen(reader);
			reader.bus.emit(ping, { v: 1 });
			expect(seen.ready).toBe(1);
			for (const data of [undefined, null, 1, "v1", [1], {}, { v: 2 }, { v: "1" }]) reader.bus.emit(ping, data);
			expect(seen.ready).toBe(1);
			expect(reader.bus.emitted.filter(([channel]) => channel === ready)).toEqual([
				[ready, { v: 1 }],
				[ready, { v: 1 }],
			]);
			expect(reader.notes).toEqual([]);
		});

		it("a valid read request reads its text like /read, naming its id in the footer, in the text's own language", async () => {
			installVoice();
			const reader = load();
			reader.bus.emit(readEvent, { v: 1, id: "P3.R1.Q2", text: "## Hola\n\nHecho **ya**." });
			await reader.settled();
			reader.bus.emit(readEvent, { v: 1, id: "P4.R1", text: "The build is done and the tests pass for the new parser.\n\n```sh\npnpm test\n```" });
			await waitFor(() => reader.statuses.filter((status) => status === undefined).length === 2);
			expect(texts()).toEqual(["Hola.", "Hecho ya.", "The build is done and the tests pass for the new parser.", "Code block."]);
			expect(reader.statuses).toEqual(["Reading P3.R1.Q2 on local · Esc stops", undefined, "Reading P4.R1 on local · Esc stops", undefined]);
			expect(existsSync(log("play-1.audio"))).toBe(true);
			expect(reader.notes).toEqual([]);
		});

		it("a request with nothing to read says so naming its id, and downloads nothing", async () => {
			const reader = load({ confirm: true });
			reader.bus.emit(readEvent, { v: 1, id: "P5.R1.Q1", text: "  \n" });
			await pause();
			expect(reader.notes).toEqual([["P5.R1.Q1 has nothing to read.", "info"]]);
			expect(reader.confirms).toEqual([]);
			expect(reader.statuses).toEqual([]);
		});

		it("ignores every invalid read payload silently, with nothing played, asked or said", async () => {
			const reader = load({ confirm: false });
			const invalid = [
				undefined,
				null,
				"Hola.",
				1,
				[{ v: 1, id: "a", text: "Hola." }],
				{},
				{ id: "a", text: "Hola." },
				{ v: 2, id: "a", text: "Hola." },
				{ v: "1", id: "a", text: "Hola." },
				{ v: 1, text: "Hola." },
				{ v: 1, id: "a" },
				{ v: 1, id: "", text: "Hola." },
				{ v: 1, id: "a", text: "" },
				{ v: 1, id: 7, text: "Hola." },
				{ v: 1, id: "a", text: ["Hola."] },
			];
			for (const data of invalid) reader.bus.emit(readEvent, data);
			await pause();
			expect(reader.confirms).toEqual([]);
			expect(reader.notes).toEqual([]);
			expect(reader.statuses).toEqual([]);
			expect(synthesized).toEqual([]);
			// A valid request on the same bus does reach the reader: here it offers the voice download, declined.
			reader.bus.emit(readEvent, { v: 1, id: "a", text: "Hola." });
			await waitFor(() => reader.notes.length === 1);
			expect(reader.confirms).toHaveLength(1);
			expect(reader.notes).toEqual([["Reading cancelled: the voice was not downloaded.", "info"]]);
		});

		it("without a session (after session_shutdown) ignores read and ping, and a new session answers again", async () => {
			installVoice();
			const reader = load();
			const seen = listen(reader);
			reader.shutdown();
			reader.bus.emit(ping, { v: 1 });
			reader.bus.emit(readEvent, { v: 1, id: "P1.R1", text: "Hola." });
			await pause();
			expect(seen.ready).toBe(0);
			expect(synthesized).toEqual([]);
			expect(reader.statuses).toEqual([]);
			expect(reader.notes).toEqual([]);
			expect(existsSync(log("play-0.pid"))).toBe(false);
			reader.restart();
			reader.bus.emit(readEvent, { v: 1, id: "P1.R1", text: "Hola." });
			await reader.settled();
			expect(texts()).toEqual(["Hola."]);
		});

		it("a reading started by an event is stopped by Esc, /read-stop, a newer /read or event, and the session's end", async () => {
			installVoice("sleep 30;");
			const reader = load();
			const pid = (n: number) => Number(read(`play-${n}.pid`));
			reader.bus.emit(readEvent, { v: 1, id: "P1.R1", text: "Uno." });
			await waitFor(() => existsSync(log("play-0.pid")));
			expect(reader.key("\x1b")).toEqual({ consume: true });
			await waitFor(() => !alive(pid(0)));
			reader.bus.emit(readEvent, { v: 1, id: "P1.R1.Q1", text: "Dos." });
			await waitFor(() => existsSync(log("play-1.pid")));
			await reader.run("read-stop");
			await waitFor(() => !alive(pid(1)));
			reader.bus.emit(readEvent, { v: 1, id: "P1.R1.Q2", text: "Tres." });
			await waitFor(() => existsSync(log("play-2.pid")));
			await reader.run("read");
			await waitFor(() => !alive(pid(2)));
			await waitFor(() => existsSync(log("play-3.pid")));
			reader.bus.emit(readEvent, { v: 1, id: "P1.R1.Q3", text: "Cuatro." });
			await waitFor(() => !alive(pid(3)));
			await waitFor(() => existsSync(log("play-4.pid")));
			expect(alive(pid(4))).toBe(true);
			reader.shutdown();
			await waitFor(() => !alive(pid(4)));
			expect(reader.notes).toEqual([["Reading stopped.", "info"]]);
			expect(reader.statuses).toEqual([
				"Reading P1.R1 on local · Esc stops",
				undefined,
				"Reading P1.R1.Q1 on local · Esc stops",
				undefined,
				"Reading P1.R1.Q2 on local · Esc stops",
				undefined,
				"Reading P2.R1 on local · Esc stops",
				undefined,
				"Reading P1.R1.Q3 on local · Esc stops",
				undefined,
			]);
		});

		it("keeps one handler per channel across session restarts, and none after session_shutdown", async () => {
			installVoice();
			const reader = load();
			reader.restart();
			reader.restart();
			expect([reader.bus.listeners(ping), reader.bus.listeners(readEvent)]).toEqual([1, 1]);
			reader.shutdown();
			expect([reader.bus.listeners(ping), reader.bus.listeners(readEvent)]).toEqual([0, 0]);
			reader.restart();
			expect([reader.bus.listeners(ping), reader.bus.listeners(readEvent)]).toEqual([1, 1]);
			const seen = listen(reader);
			reader.bus.emit(ping, { v: 1 });
			expect(seen.ready).toBe(1);
			reader.bus.emit(readEvent, { v: 1, id: "P1.R1", text: "Hola." });
			await reader.settled();
			await pause();
			expect(texts()).toEqual(["Hola."]);
			expect(existsSync(log("play-1.pid"))).toBe(false);
			expect(reader.statuses).toEqual(["Reading P1.R1 on local · Esc stops", undefined]);
		});
	});

	describe("/read <target>#<section> (S9)", () => {
		it("a section of an English file keeps the file's language for added words (S7)", async () => {
			installVoice();
			mkdirSync(join(root, "work"));
			writeFileSync(join(root, "work", "tool.md"), "# Tool\n\nThis is the tool and it reads the files that you give it.\n\n## Develop\n\n```sh\npnpm test\n```\n");
			const reader = load();
			await reader.run("read", "tool.md#develop");
			await reader.settled();
			expect(texts()).toEqual(["Develop.", "Code block."]);
		});

		const texts = () => synthesized.map((request) => request.text);
		const guide = "Intro.\n\n## 1. Instalación\n\nPaso uno.\n\n## Uso del lector\n\nPaso dos.";
		const withGuide = [user("hola"), assistant(guide), user("otra"), assistant("## Segunda\n\nFin.\n\n## Otra cosa\n\nMás.")];

		it("/read FILE.md#section reads only that section of the file, with its subsections, and names the file", async () => {
			installVoice();
			mkdirSync(join(root, "work"));
			writeFileSync(join(root, "work", "notes.md"), "# Notas\n\n" + guide.replace("Paso uno.", "Paso uno.\n\n### Detalle\n\nSub."));
			const reader = load();
			await reader.run("read", "notes.md#instalacion");
			await reader.settled();
			expect(texts()).toEqual(["1: Instalación.", "Paso uno.", "Detalle.", "Sub."]);
			expect(reader.statuses).toEqual(["Reading notes.md on local · Esc stops", undefined]);
			expect(reader.notes).toEqual([]);
		});

		it("adding rest reads from the heading to the end, for a file and for the latest reply", async () => {
			installVoice();
			mkdirSync(join(root, "work"));
			writeFileSync(join(root, "work", "notes.md"), "# Notas\n\n" + guide);
			const reader = load({}, [user("a"), assistant(guide)]);
			await reader.run("read", "notes.md#instalacion rest");
			await reader.settled();
			await reader.run("read", "#instalación rest");
			await reader.settled();
			await reader.run("read", "#instalacion");
			await reader.settled();
			const rest = ["1: Instalación.", "Paso uno.", "Uso del lector.", "Paso dos."];
			expect(texts()).toEqual([...rest, ...rest, "1: Instalación.", "Paso uno."]);
			expect(reader.statuses.filter(Boolean)).toEqual([
				"Reading notes.md on local · Esc stops",
				"Reading P1.R1 on local · Esc stops",
				"Reading P1.R1 on local · Esc stops",
			]);
			expect(reader.notes).toEqual([]);
		});

		it("/read #section reads the latest reply from there, and /read ID#section that reply", async () => {
			installVoice();
			const reader = load({}, withGuide);
			await reader.run("read", "#otra-cosa");
			await reader.settled();
			await reader.run("read", "P1.R1#USO");
			await reader.settled();
			expect(texts()).toEqual(["Otra cosa.", "Más.", "Uso del lector.", "Paso dos."]);
			expect(reader.statuses.filter(Boolean)).toEqual(["Reading P2.R1 on local · Esc stops", "Reading P1.R1 on local · Esc stops"]);
			expect(reader.notes).toEqual([]);
		});

		it("an exact heading wins over a prefix, and a unique prefix is accepted", async () => {
			installVoice();
			const reader = load({}, [user("a"), assistant("## Uso avanzado\n\nA.\n\n## Uso\n\nB.\n\n## Notas finales\n\nC.")]);
			await reader.run("read", "#uso");
			await reader.settled();
			await reader.run("read", "#notas");
			await reader.settled();
			expect(texts()).toEqual(["Uso.", "B.", "Notas finales.", "C."]);
		});

		it("no match, or an ambiguous prefix, warns naming the section and the source, and plays and downloads nothing", async () => {
			script("paplay", `echo $$ > "${root}/play-0.pid"; cat > /dev/null`);
			mkdirSync(join(root, "work"));
			writeFileSync(join(root, "work", "notes.md"), guide);
			const reader = load({ confirm: true }, [user("a"), assistant("## Uso avanzado\n\nA.\n\n## Uso simple\n\nB.")]);
			await reader.run("read", "notes.md#Nada aquí");
			await reader.run("read", "#uso");
			await reader.run("read", "P1.R1#zzz");
			await reader.run("read", "#zzz rest");
			expect(reader.notes).toEqual([
				['No section "Nada aquí" in notes.md.', "warning"],
				['No section "uso" in P1.R1.', "warning"],
				['No section "zzz" in P1.R1.', "warning"],
				['No section "zzz" in P1.R1.', "warning"],
			]);
			expect(reader.confirms).toEqual([]);
			expect(reader.statuses).toEqual([]);
			expect(synthesized).toEqual([]);
			expect(existsSync(log("play-0.pid"))).toBe(false);
		});

		it("a missing file or an unknown reply with a section warns as before", async () => {
			installVoice();
			const reader = load();
			await reader.run("read", "missing.md#uso");
			await reader.run("read", "P9.R9#uso");
			expect(reader.notes).toEqual([
				['Cannot read "missing.md": file not found.', "warning"],
				['No reply matches "P9.R9".', "warning"],
			]);
			expect(synthesized).toEqual([]);
		});

		it("without # nothing changes: /read, /read P1.R1, /read FILE.md (even with # in its name), /read-speed, Esc and /read-stop", async () => {
			installVoice("sleep 30;");
			mkdirSync(join(root, "work"));
			writeFileSync(join(root, "work", "notes.md"), "# Notas");
			writeFileSync(join(root, "work", "a#b.md"), "Archivo.");
			const reader = load();
			await reader.run("read-speed", "1.2");
			await reader.run("read");
			await waitFor(() => existsSync(log("play-0.pid")) && synthesized.length === 2);
			expect(reader.key("\x1b")).toEqual({ consume: true });
			await reader.run("read", "P1.R1");
			await waitFor(() => existsSync(log("play-1.pid")) && synthesized.length === 3);
			await reader.run("read", "notes.md");
			await waitFor(() => existsSync(log("play-2.pid")) && synthesized.length === 4);
			await reader.run("read", "a#b.md");
			await waitFor(() => existsSync(log("play-3.pid")) && synthesized.length === 5);
			await reader.run("read-stop");
			await reader.run("read-stop");
			await waitFor(() => !alive(Number(read("play-3.pid"))));
			expect(texts()).toEqual(["Segunda.", "auto read listo.", "Primera respuesta.", "Notas.", "Archivo."]);
			expect(speeds()).toEqual([1.2, 1.2, 1.2, 1.2, 1.2]);
			expect(reader.notes).toEqual([
				["Readings will use speed 1.2.", "info"],
				["Reading stopped.", "info"],
				["Nothing is being read.", "info"],
			]);
			expect(reader.statuses).toEqual([
				"Reading P2.R1 on local · Esc stops",
				undefined,
				"Reading P1.R1 on local · Esc stops",
				undefined,
				"Reading notes.md on local · Esc stops",
				undefined,
				"Reading a#b.md on local · Esc stops",
				undefined,
			]);
		});
	});

	it("/read speaks the latest reply, cleaned for speech, and shows then clears its status", async () => {
		installVoice();
		const reader = load();
		await reader.run("read");
		await reader.settled();
		expect(speechText("## Segunda\n\n- `auto_read` listo")).toBe("Segunda.\n\nauto read listo.");
		expect(synthesized.map((request) => request.text)).toEqual(["Segunda.", "auto read listo."]);
		// Two one-sample fragments with the 0.75 s paragraph pause (33,075 samples at 44.1 kHz) between them.
		expect(readFileSync(log("play-0.audio"))).toHaveLength((1 + 33075 + 1) * 2);
		expect(reader.statuses).toEqual(["Reading P2.R1 on local · Esc stops", undefined]);
		expect(reader.selects).toEqual([]);
	});

	it("/read P1.R1 speaks that reply", async () => {
		installVoice();
		const reader = load();
		await reader.run("read", "p1.r1");
		await reader.settled();
		expect(synthesized.map((request) => request.text)).toEqual(["Primera respuesta."]);
	});

	it("/read FILE.md reads that Markdown file, cleaned for speech, and names it in the status", async () => {
		installVoice();
		mkdirSync(join(root, "work"));
		writeFileSync(join(root, "work", "notes.md"), "# Notas\n\nHola **mundo**.");
		const reader = load();
		await reader.run("read", "notes.md");
		await reader.settled();
		expect(synthesized.map((request) => request.text)).toEqual(["Notas.", "Hola mundo."]);
		expect(existsSync(log("play-0.audio"))).toBe(true);
		expect(reader.statuses).toEqual(["Reading notes.md on local · Esc stops", undefined]);
		expect(reader.notes).toEqual([]);
	});

	it("/read resolves a Markdown path against the session's cwd (any case), or as absolute or ~/", async () => {
		installVoice();
		mkdirSync(join(root, "work", "docs"), { recursive: true });
		mkdirSync(join(root, "home"));
		writeFileSync(join(root, "work", "docs", "guide.MARKDOWN"), "Guía.");
		writeFileSync(join(root, "elsewhere.Md"), "Afuera.");
		writeFileSync(join(root, "home", "home.md"), "Casa.");
		const reader = load();
		for (const path of ["docs/guide.MARKDOWN", "../elsewhere.Md", join(root, "home", "home.md"), "~/home.md"]) {
			await reader.run("read", path);
			await reader.settled();
		}
		expect(synthesized.map((request) => request.text)).toEqual(["Guía.", "Afuera.", "Casa.", "Casa."]);
		expect(reader.statuses.filter(Boolean)).toEqual([
			"Reading guide.MARKDOWN on local · Esc stops",
			"Reading elsewhere.Md on local · Esc stops",
			"Reading home.md on local · Esc stops",
			"Reading home.md on local · Esc stops",
		]);
		expect(reader.notes).toEqual([]);
	});

	it("/read of a missing or unreadable Markdown file warns once, naming it, and plays and downloads nothing", async () => {
		script("paplay", `echo $$ > "${root}/play-0.pid"; cat > /dev/null`);
		mkdirSync(join(root, "work", "folder.md"), { recursive: true });
		const reader = load({ confirm: true });
		await reader.run("read", "missing.md");
		await reader.run("read", "folder.md");
		expect(reader.notes).toEqual([
			['Cannot read "missing.md": file not found.', "warning"],
			['Cannot read "folder.md": it is a folder.', "warning"],
		]);
		expect(reader.confirms).toEqual([]);
		expect(reader.statuses).toEqual([]);
		expect(synthesized).toEqual([]);
		expect(existsSync(log("play-0.pid"))).toBe(false);
	});

	it("/read of a Markdown file with nothing to read says so, like an empty reply, and downloads nothing", async () => {
		mkdirSync(join(root, "work"));
		writeFileSync(join(root, "work", "empty.md"), "  \n\n");
		const reader = load({ confirm: true });
		await reader.run("read", "empty.md");
		expect(reader.notes).toEqual([["empty.md has nothing to read.", "info"]]);
		expect(reader.confirms).toEqual([]);
		expect(reader.statuses).toEqual([]);
		expect(synthesized).toEqual([]);
	});

	it("/read with a reply ID or an entry ID still reads that reply, not a file", async () => {
		installVoice();
		mkdirSync(join(root, "work"));
		writeFileSync(join(root, "work", "P1.R1"), "Archivo.");
		const reader = load();
		await reader.run("read", "P1.R1");
		await reader.settled();
		await reader.run("read", branch[3].id);
		await reader.settled();
		expect(synthesized.map((request) => request.text)).toEqual(["Primera respuesta.", "Segunda.", "auto read listo."]);
		expect(reader.statuses.filter(Boolean)).toEqual(["Reading P1.R1 on local · Esc stops", "Reading P2.R1 on local · Esc stops"]);
		expect(reader.notes).toEqual([]);
	});

	it("/read with an unknown ID says so and plays nothing", async () => {
		installVoice();
		const reader = load();
		await reader.run("read", "P9.R9");
		expect(reader.notes).toEqual([['No reply matches "P9.R9".', "warning"]]);
		expect(existsSync(log("play-0.pid"))).toBe(false);
	});

	it("asks where to sound on the first /read only, and uses that output's PULSE_SERVER", async () => {
		installVoice();
		configureOutputs({ desktop: "tcp:192.168.1.50:4713" });
		const reader = load({ select: "desktop (tcp:192.168.1.50:4713)" });
		await reader.run("read");
		await reader.settled();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-1.server")));
		expect(reader.selects).toEqual([["Where should readings sound?", ["local (hs-node)", "desktop (tcp:192.168.1.50:4713)"]]]);
		expect(read("play-0.server").trim()).toBe("tcp:192.168.1.50:4713");
		expect(read("play-1.server").trim()).toBe("tcp:192.168.1.50:4713");
	});

	it("cancels the reading when no output is chosen", async () => {
		installVoice();
		configureOutputs({ desktop: "tcp:x" });
		const reader = load({ select: undefined });
		await reader.run("read");
		expect(reader.notes).toEqual([["Reading cancelled: no output chosen.", "info"]]);
		expect(existsSync(log("play-0.pid"))).toBe(false);
	});

	it("/read-output NAME picks the output without asking, and rejects unknown names", async () => {
		installVoice();
		configureOutputs({ desktop: "tcp:x" });
		const reader = load();
		await reader.run("read-output", "nope");
		await reader.run("read-output", "local");
		await reader.run("read");
		await reader.settled();
		expect(reader.notes).toEqual([
			['No output named "nope". Outputs: local, desktop.', "warning"],
			["Readings will sound on local (hs-node).", "info"],
		]);
		expect(reader.selects).toEqual([]);
		expect(read("play-0.server").trim()).toBe("unset");
	});

	it("/read-output without a name asks, and completes output names", async () => {
		configureOutputs({ desktop: "tcp:x", den: "tcp:y" });
		const reader = load({ select: "desktop (tcp:x)" });
		await reader.run("read-output");
		expect(reader.selects).toEqual([["Where should readings sound?", ["local (hs-node)", "desktop (tcp:x)", "den (tcp:y)"]]]);
		expect(reader.notes).toEqual([["Readings will sound on desktop (tcp:x).", "info"]]);
		const complete = reader.commands.get("read-output")!.getArgumentCompletions as (prefix: string) => unknown;
		expect(complete("de")).toEqual([
			{ value: "desktop", label: "desktop", description: "tcp:x" },
			{ value: "den", label: "den", description: "tcp:y" },
		]);
	});

	it("reports problems in outputs.json when it lists the outputs", async () => {
		configureOutputs({ local: "tcp:x" });
		const reader = load({ select: "local (hs-node)" });
		await reader.run("read-output");
		expect(reader.notes[0]).toEqual([
			`Ignored output "local" in ${join(root, "config", "pi-reply-reader", "outputs.json")}: that name is built in.`,
			"warning",
		]);
	});

	it("warns once per session on /read about a broken outputs.json, even when only local is left", async () => {
		installVoice();
		mkdirSync(join(root, "config", "pi-reply-reader"), { recursive: true });
		writeFileSync(join(root, "config", "pi-reply-reader", "outputs.json"), '{ "desktop": "tcp:192.168.1.50:4713", }');
		const reader = load();
		await reader.run("read");
		await reader.settled();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-1.pid")));
		expect(reader.notes).toHaveLength(1);
		expect(reader.notes[0][1]).toBe("warning");
		expect(reader.notes[0][0]).toMatch(/^Ignored .*outputs\.json: not valid JSON/);
	});

	it("clears the status and shows the error when paplay dies before reading", async () => {
		installVoice();
		script("paplay", 'echo "Connection refused" >&2; exit 1');
		const reader = load();
		await reader.run("read");
		await reader.settled();
		expect(reader.notes).toEqual([['Playback on "local" failed: Connection refused', "error"]]);
	});

	it("a new /read stops the one playing", async () => {
		installVoice("sleep 30;");
		const reader = load();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-0.pid")));
		await reader.run("read", "P1.R1");
		await waitFor(() => !alive(Number(read("play-0.pid"))));
		await waitFor(() => existsSync(log("play-1.pid")));
		expect(alive(Number(read("play-1.pid")))).toBe(true);
		reader.shutdown();
		await waitFor(() => !alive(Number(read("play-1.pid"))));
	});

	it("Esc stops a reading and is consumed only while one plays", async () => {
		installVoice("sleep 30;");
		const reader = load();
		expect(reader.key("\x1b")).toBeUndefined();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-0.pid")));
		expect(reader.key("a")).toBeUndefined();
		expect(reader.key("\x1b")).toEqual({ consume: true });
		await reader.settled();
		await waitFor(() => !alive(Number(read("play-0.pid"))));
		expect(reader.key("\x1b")).toBeUndefined();
	});

	it("/read-stop stops the reading playing, says so and clears the status", async () => {
		installVoice("sleep 30;");
		const reader = load();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-0.pid")));
		await reader.run("read-stop");
		expect(reader.notes).toEqual([["Reading stopped.", "info"]]);
		expect(reader.statuses).toEqual(["Reading P2.R1 on local · Esc stops", undefined]);
		await waitFor(() => !alive(Number(read("play-0.pid"))));
		expect(reader.key("\x1b")).toBeUndefined();
	});

	it("/read-stop with nothing playing says so and changes nothing", async () => {
		installVoice();
		const reader = load();
		await reader.run("read-stop");
		expect(reader.notes).toEqual([["Nothing is being read.", "info"]]);
		expect(reader.statuses).toEqual([]);
		await reader.run("read");
		await reader.settled();
		const played = synthesized.length;
		await reader.run("read-stop");
		expect(reader.notes).toEqual([
			["Nothing is being read.", "info"],
			["Nothing is being read.", "info"],
		]);
		expect(reader.statuses).toEqual(["Reading P2.R1 on local · Esc stops", undefined]);
		expect(synthesized).toHaveLength(played);
		expect(existsSync(log("play-1.pid"))).toBe(false);
	});

	it("Esc and a new /read still stop a reading, alongside /read-stop", async () => {
		installVoice("sleep 30;");
		const reader = load();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-0.pid")));
		expect(reader.key("\x1b")).toEqual({ consume: true });
		await waitFor(() => !alive(Number(read("play-0.pid"))));
		await reader.run("read-stop");
		await reader.run("read");
		await waitFor(() => existsSync(log("play-1.pid")));
		await reader.run("read", "P1.R1");
		await waitFor(() => !alive(Number(read("play-1.pid"))));
		await waitFor(() => existsSync(log("play-2.pid")));
		expect(alive(Number(read("play-2.pid")))).toBe(true);
		expect(reader.notes).toEqual([["Nothing is being read.", "info"]]);
		reader.shutdown();
		await waitFor(() => !alive(Number(read("play-2.pid"))));
	});

	it("with a shared XDG_RUNTIME_DIR, Esc, a new /read, /read-stop and the settings commands behave as before", async () => {
		env.XDG_RUNTIME_DIR = join(root, "run");
		mkdirSync(env.XDG_RUNTIME_DIR);
		installVoice("sleep 30;");
		const reader = load();
		await reader.run("read-stop");
		await reader.run("read");
		await waitFor(() => existsSync(log("play-0.pid")));
		expect(reader.key("\x1b")).toEqual({ consume: true });
		await waitFor(() => !alive(Number(read("play-0.pid"))));
		expect(reader.key("\x1b")).toBeUndefined();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-1.pid")));
		await reader.run("read", "P1.R1");
		await waitFor(() => !alive(Number(read("play-1.pid"))));
		await waitFor(() => existsSync(log("play-2.pid")));
		// The reading that replaced this session's own one keeps playing past the lock's checks.
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(alive(Number(read("play-2.pid")))).toBe(true);
		await reader.run("read-stop");
		await waitFor(() => !alive(Number(read("play-2.pid"))));
		await reader.run("read-stop");
		await reader.run("read-output", "local");
		await reader.run("read-voice", "female");
		await reader.run("read-speed", "1.2");
		expect(reader.notes).toEqual([
			["Nothing is being read.", "info"],
			["Reading stopped.", "info"],
			["Nothing is being read.", "info"],
			["Readings will sound on local (hs-node).", "info"],
			["Readings will use the female voice.", "info"],
			["Readings will use speed 1.2.", "info"],
		]);
		expect(reader.statuses).toEqual([
			"Reading P2.R1 on local · Esc stops",
			undefined,
			"Reading P2.R1 on local · Esc stops",
			undefined,
			"Reading P1.R1 on local · Esc stops",
			undefined,
		]);
	});

	it("with a shared XDG_RUNTIME_DIR, a player that fails on its own still shows its error", async () => {
		env.XDG_RUNTIME_DIR = join(root, "run");
		mkdirSync(env.XDG_RUNTIME_DIR);
		installVoice();
		script("paplay", 'cat > /dev/null; echo "Connection refused" >&2; exit 1');
		const reader = load();
		await reader.run("read");
		await reader.settled();
		expect(reader.notes).toEqual([['Playback on "local" failed: Connection refused', "error"]]);
	});

	it("ending the session stops the reading", async () => {
		installVoice("sleep 30;");
		const reader = load();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-0.pid")));
		reader.shutdown();
		await waitFor(() => !alive(Number(read("play-0.pid"))));
	});

	it("reads with the male voice by default", async () => {
		installVoice();
		const reader = load();
		await reader.run("read");
		await reader.settled();
		expect(synthesized.map((request) => request.generationConfig.sid)).toEqual([6, 6]);
	});

	it("/read-voice female switches the next reading to sid 0 and confirms", async () => {
		installVoice();
		const reader = load();
		await reader.run("read-voice", "female");
		await reader.run("read");
		await reader.settled();
		expect(reader.notes).toEqual([["Readings will use the female voice.", "info"]]);
		expect(reader.selects).toEqual([]);
		expect(synthesized.map((request) => request.generationConfig.sid)).toEqual([0, 0]);
	});

	it("/read-voice rejects an unknown name, listing both, and keeps the voice", async () => {
		installVoice();
		const reader = load();
		await reader.run("read-voice", "robot");
		await reader.run("read");
		await reader.settled();
		expect(reader.notes).toEqual([['No voice named "robot". Voices: male, female.', "warning"]]);
		expect(synthesized.map((request) => request.generationConfig.sid)).toEqual([6, 6]);
	});

	it("/read-voice without a name asks, and completes voice names", async () => {
		const reader = load({ select: "female" });
		await reader.run("read-voice");
		expect(reader.selects).toEqual([["Which voice should read?", ["male", "female"]]]);
		expect(reader.notes).toEqual([["Readings will use the female voice.", "info"]]);
		const complete = reader.commands.get("read-voice")!.getArgumentCompletions as (prefix: string) => unknown;
		expect(complete("")).toEqual([
			{ value: "male", label: "male", description: "Supertonic 3, speaker 6" },
			{ value: "female", label: "female", description: "Supertonic 3, speaker 0" },
		]);
		expect(complete("fe")).toEqual([{ value: "female", label: "female", description: "Supertonic 3, speaker 0" }]);
	});

	it("/read-voice keeps the voice when the question is dismissed", async () => {
		installVoice();
		const reader = load({ select: undefined });
		await reader.run("read-voice");
		await reader.run("read");
		await reader.settled();
		expect(reader.notes).toEqual([]);
		expect(synthesized.map((request) => request.generationConfig.sid)).toEqual([6, 6]);
	});

	it("a voice change leaves the reading in progress alone and applies to the next one", async () => {
		installVoice("sleep 30;");
		const reader = load();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-0.pid")));
		await reader.run("read-voice", "female");
		expect(alive(Number(read("play-0.pid")))).toBe(true);
		await reader.run("read");
		await waitFor(() => existsSync(log("play-1.pid")) && synthesized.length === 4);
		expect(synthesized.map((request) => request.generationConfig.sid)).toEqual([6, 6, 0, 0]);
		reader.shutdown();
	});

	it("a new session goes back to the male voice", async () => {
		installVoice();
		const reader = load();
		await reader.run("read-voice", "female");
		reader.restart();
		await reader.run("read");
		await reader.settled();
		expect(synthesized.map((request) => request.generationConfig.sid)).toEqual([6, 6]);
	});

	it("reads at speed 1.1 when there is no settings file, without warning", async () => {
		installVoice();
		const reader = load();
		await reader.run("read");
		await reader.settled();
		expect(speeds()).toEqual([1.1, 1.1]);
		expect(reader.notes).toEqual([]);
		expect(existsSync(settingsPath())).toBe(false);
	});

	it("/read-speed N (comma decimal too) confirms, saves { speed } and applies to the next readings and sessions", async () => {
		installVoice();
		const reader = load();
		await reader.run("read-speed", "1,15");
		expect(reader.notes).toEqual([["Readings will use speed 1.15.", "info"]]);
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ speed: 1.15 });
		await reader.run("read");
		await reader.settled();
		reader.restart();
		await reader.run("read", "P1.R1");
		await reader.settled();
		const other = load();
		await other.run("read", "P1.R1");
		await other.settled();
		expect(speeds()).toEqual([1.15, 1.15, 1.15, 1.15]);
		expect(other.notes).toEqual([]);
	});

	it("/read-speed accepts 0.5 and 2.0, the ends of the range", async () => {
		const reader = load();
		await reader.run("read-speed", "0.5");
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ speed: 0.5 });
		await reader.run("read-speed", "2.0");
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ speed: 2 });
		expect(reader.notes).toEqual([
			["Readings will use speed 0.5.", "info"],
			["Readings will use speed 2.0.", "info"],
		]);
	});

	it("/read-speed accepts a decimal without a leading zero, with a period or a comma", async () => {
		const reader = load();
		await reader.run("read-speed", ".9");
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ speed: 0.9 });
		await reader.run("read-speed", ",75");
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ speed: 0.75 });
		expect(reader.notes).toEqual([
			["Readings will use speed 0.9.", "info"],
			["Readings will use speed 0.75.", "info"],
		]);
	});

	it("/read-speed keeps the other keys of settings.json", async () => {
		writeSettings('{ "other": { "a": [1, 2] }, "speed": 1.2 }');
		const reader = load();
		await reader.run("read-speed", "0.7");
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ other: { a: [1, 2] }, speed: 0.7 });
	});

	it("/read-speed with anything else warns, changes nothing and leaves the file absent or byte-identical", async () => {
		installVoice();
		const bad = ["abc", "0.4", "2.1", "0", "-1", "1.2.3", "1,2,3", "1.", "1.2x", "NaN", "Infinity", "1e0", ".", ",", ".4", ",3", "..9", ".9.1"];
		const reader = load();
		for (const value of bad) await reader.run("read-speed", value);
		expect(existsSync(settingsPath())).toBe(false);
		const original = '{"speed":1.3,  "x": 1}\n';
		writeSettings(original);
		for (const value of bad) await reader.run("read-speed", value);
		expect(readFileSync(settingsPath(), "utf8")).toBe(original);
		expect(reader.notes).toEqual(new Array(bad.length * 2).fill(["Speed must be a number from 0.5 to 2.0.", "warning"]));
		await reader.run("read");
		await reader.settled();
		expect(speeds()).toEqual([1.3, 1.3]);
	});

	it("/read-speed without a number offers the speeds, saves the pick, and completes them", async () => {
		const reader = load({ select: "1.3" });
		await reader.run("read-speed");
		expect(reader.selects).toEqual([["Which speed should readings use?", ["0.8", "0.9", "1.0", "1.1", "1.2", "1.3", "1.5"]]]);
		expect(reader.notes).toEqual([["Readings will use speed 1.3.", "info"]]);
		expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({ speed: 1.3 });
		const complete = reader.commands.get("read-speed")!.getArgumentCompletions as (prefix: string) => { value: string }[];
		expect(complete("1.").map((item) => item.value)).toEqual(["1.0", "1.1", "1.2", "1.3", "1.5"]);
	});

	it("/read-speed keeps the speed and the file when the selector is dismissed", async () => {
		const reader = load({ select: undefined });
		await reader.run("read-speed");
		expect(reader.notes).toEqual([]);
		expect(existsSync(settingsPath())).toBe(false);
	});

	it("saves under ~/.config when XDG_CONFIG_HOME is unset", async () => {
		delete env.XDG_CONFIG_HOME;
		const reader = load();
		await reader.run("read-speed", "0.9");
		expect(JSON.parse(readFileSync(join(root, "home", ".config", "pi-reply-reader", "settings.json"), "utf8"))).toEqual({ speed: 0.9 });
		expect(existsSync(settingsPath())).toBe(false);
	});

	it("an invalid settings.json warns once per session and reads at 1.1", async () => {
		installVoice();
		writeSettings('{ "speed": 1.2, }');
		const reader = load();
		await reader.run("read");
		await reader.settled();
		await reader.run("read", "P1.R1");
		await reader.settled();
		expect(reader.notes).toHaveLength(1);
		expect(reader.notes[0][1]).toBe("warning");
		expect(reader.notes[0][0]).toMatch(
			new RegExp(`^Ignored ${settingsPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: not valid JSON \\(.+\\)\\. Readings use speed 1\\.1\\.$`),
		);
		reader.restart();
		await reader.run("read", "P1.R1");
		await reader.settled();
		expect(reader.notes).toHaveLength(2);
		expect(speeds()).toEqual([1.1, 1.1, 1.1, 1.1]);
	});

	it("a stored speed out of range, or not a number, or a file that is not an object, warns and reads at 1.1", async () => {
		installVoice();
		const cases: [string, string][] = [
			['{ "speed": 3 }', "speed must be a number from 0.5 to 2.0"],
			['{ "speed": "1.2" }', "speed must be a number from 0.5 to 2.0"],
			["[1.2]", "expected an object"],
		];
		for (const [content, reason] of cases) {
			writeSettings(content);
			const reader = load();
			await reader.run("read", "P1.R1");
			await reader.settled();
			expect(reader.notes).toEqual([[`Ignored ${settingsPath()}: ${reason}. Readings use speed 1.1.`, "warning"]]);
		}
		expect(speeds()).toEqual([1.1, 1.1, 1.1]);
	});

	it("a settings file without a speed reads at 1.1 without warning", async () => {
		installVoice();
		writeSettings('{ "other": true }');
		const reader = load();
		await reader.run("read", "P1.R1");
		await reader.settled();
		expect(reader.notes).toEqual([]);
		expect(speeds()).toEqual([1.1]);
	});

	it("when saving fails, the speed applies to this session and a warning says it was not saved", async () => {
		installVoice();
		// A file where the folder should be: the folder cannot be created.
		mkdirSync(join(root, "config"), { recursive: true });
		writeFileSync(settingsDir(), "not a folder");
		const reader = load();
		await reader.run("read-speed", "1.4");
		expect(reader.notes).toHaveLength(1);
		expect(reader.notes[0][1]).toBe("warning");
		expect(reader.notes[0][0]).toMatch(/^Readings will use speed 1\.4 in this session, but it was not saved to .*settings\.json: .+\.$/);
		expect(readFileSync(settingsDir(), "utf8")).toBe("not a folder");
		await reader.run("read");
		await reader.settled();
		expect(speeds()).toEqual([1.4, 1.4]);
		expect(reader.notes).toHaveLength(1);
	});

	it("refuses to overwrite an invalid settings.json: the speed applies to this session, the file stays", async () => {
		installVoice();
		const original = '{ "speed": 1.2, }';
		writeSettings(original);
		const reader = load();
		await reader.run("read-speed", "0.8");
		expect(reader.notes).toEqual([
			[`Readings will use speed 0.8 in this session, but it was not saved to ${settingsPath()}: it is not valid JSON.`, "warning"],
		]);
		expect(readFileSync(settingsPath(), "utf8")).toBe(original);
		await reader.run("read", "P1.R1");
		await reader.settled();
		expect(speeds()).toEqual([0.8]);
	});

	it("a speed change leaves the reading in progress at its speed and applies to the next one", async () => {
		installVoice();
		let release = () => {};
		gate = new Promise((resolve) => (release = resolve));
		const reader = load();
		await reader.run("read");
		await waitFor(() => synthesized.length === 1);
		await reader.run("read-speed", "1.3");
		release();
		await reader.settled();
		gate = undefined;
		await reader.run("read");
		await waitFor(() => reader.statuses.filter((status) => status === undefined).length === 2);
		expect(speeds()).toEqual([1.1, 1.1, 1.3, 1.3]);
	});

	it("a different speed keeps our pauses: the same audio length at 1.5 as at 1.1", async () => {
		installVoice();
		const reader = load();
		await reader.run("read-speed", "1.5");
		await reader.run("read");
		await reader.settled();
		expect(speeds()).toEqual([1.5, 1.5]);
		expect(readFileSync(log("play-0.audio"))).toHaveLength((1 + 33075 + 1) * 2);
	});

	it("/read-output, /read-voice and /read of a reply and a file behave as before, now at the saved speed", async () => {
		installVoice();
		configureOutputs({ desktop: "tcp:x" });
		mkdirSync(join(root, "work"));
		writeFileSync(join(root, "work", "notes.md"), "# Notas");
		const reader = load();
		await reader.run("read-output", "desktop");
		await reader.run("read-voice", "female");
		await reader.run("read", "P1.R1");
		await reader.settled();
		await reader.run("read", "notes.md");
		await reader.settled();
		expect(reader.notes).toEqual([
			["Readings will sound on desktop (tcp:x).", "info"],
			["Readings will use the female voice.", "info"],
		]);
		expect(reader.statuses.filter(Boolean)).toEqual(["Reading P1.R1 on desktop · Esc stops", "Reading notes.md on desktop · Esc stops"]);
		expect(read("play-0.server").trim()).toBe("tcp:x");
		expect(synthesized.map((request) => [request.text, request.generationConfig])).toEqual([
			["Primera respuesta.", { sid: 0, speed: 1.1, numSteps: 8, extra: { lang: "es", seed: 42 } }],
			["Notas.", { sid: 0, speed: 1.1, numSteps: 8, extra: { lang: "es", seed: 42 } }],
		]);
	});

	it("offers the download when there is no voice, and reads nothing if declined", async () => {
		script("paplay", "cat > /dev/null");
		const reader = load({ confirm: false });
		await reader.run("read");
		expect(reader.confirms).toEqual([
			`Download the Spanish voice Supertonic 3 (129 MB) from github.com into ${join(root, "data", "pi-reply-reader", "voices")}?`,
		]);
		expect(reader.notes).toEqual([["Reading cancelled: the voice was not downloaded.", "info"]]);
		expect(reader.statuses).toEqual([]);
	});

	it("shows a playback failure as an error and clears the status", async () => {
		installVoice();
		script("paplay", 'cat > /dev/null; echo "Connection refused" >&2; exit 1');
		const reader = load();
		await reader.run("read");
		await reader.settled();
		expect(reader.notes).toEqual([['Playback on "local" failed: Connection refused', "error"]]);
	});
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
