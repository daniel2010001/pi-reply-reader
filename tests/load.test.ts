import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, Text, TuiMainScreen } from "@earendil-works/pi-tui";
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

/** The keys that pick each answer of the "Something is being read." question (T33): Enter, Down then Enter, Esc. */
const CUT_KEYS = { now: ["\r"], after: ["\x1b[B", "\r"], dismiss: ["\x1b"] } as const;
type CutAnswer = keyof typeof CUT_KEYS;
/** A theme that adds no colour, so a rendered question reads as plain text. */
const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

/**
 * Loads the extension into a recording Pi and returns a driver for its commands, events and UI.
 * `ctx.ui.custom` builds the component the way Pi's TUI does and answers the reader's question with `cut` (default
 * "now", today's behaviour), each key going first through the terminal input listeners as in Pi; "wait" leaves it
 * open until `answer()`.
 */
function load(
	answers: { select?: string; confirm?: boolean; cut?: CutAnswer | "wait"; hasUI?: boolean; mode?: string; ui?: Record<string, unknown> } = {},
	start: unknown[] = branch,
) {
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
	/** Every question shown through ctx.ui.custom, as plain rendered lines, and the options it was shown with. */
	const asked: string[][] = [];
	const overlays: unknown[] = [];
	let open: { handleInput(data: string): void } | undefined;
	const press = (choice: CutAnswer): void => {
		const component = open;
		for (const key of CUT_KEYS[choice]) {
			if ((input?.(key) as { consume?: boolean } | undefined)?.consume) continue;
			component?.handleInput(key);
		}
	};
	const ctx = {
		hasUI: answers.hasUI ?? true,
		mode: answers.mode ?? "tui",
		cwd: join(root, "work"),
		sessionManager: { getBranch: () => entries },
		ui: {
			notify: (message: string, type?: string) => notes.push([message, type]),
			select: async (title: string, options: string[]) => (selects.push([title, options]), answers.select),
			confirm: async (_title: string, message: string) => (confirms.push(message), answers.confirm ?? false),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			onTerminalInput: (handler: (data: string) => unknown) => ((input = handler), () => (input = undefined)),
			custom: (
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => {
					render(width: number): string[];
					handleInput(data: string): void;
				},
				options: unknown,
			) =>
				new Promise((resolve) => {
					const component = factory({ requestRender: () => {} }, PLAIN_THEME, undefined, (result) => {
						if (open === component) open = undefined;
						resolve(result);
					});
					open = component;
					overlays.push(options);
					asked.push(component.render(60).map((line) => line.trimEnd()));
					if (answers.cut !== "wait") press(answers.cut ?? "now");
				}),
			...answers.ui,
		},
	};
	(events.get("session_start") as (event: unknown, ctx: unknown) => void)({ reason: "startup" }, ctx);
	function store(entry: unknown): void {
		const message = (entry as { message?: unknown }).message;
		(events.get("message_end") as ((event: unknown, ctx: unknown) => void) | undefined)?.({ type: "message_end", message }, ctx);
		entries.push(entry);
	}

	return {
		bus,
		commands,
		notes,
		selects,
		asked,
		overlays,
		/** Answers the open question with the keys a person would press. */
		answer: press,
		/** Whether a question is still open. */
		asking: () => open !== undefined,
		confirms,
		statuses,
		run: (name: string, args = "") => (commands.get(name)!.handler as (a: string, c: unknown) => Promise<void>)(args, ctx),
		key: (data: string) => input?.(data),
		shutdown: () => (events.get("session_shutdown") as (event: unknown, ctx: unknown) => void)({}, ctx),
		restart: () => (events.get("session_start") as (event: unknown, ctx: unknown) => void)({ reason: "new" }, ctx),
		entries,
		/** One agent run: it starts, stores each of `added` as Pi does (message_end, then the entry), and settles. */
		turn: async (added: unknown[], aborted = false) => {
			(events.get("agent_start") as ((event: unknown, ctx: unknown) => void) | undefined)?.({ type: "agent_start" }, ctx);
			for (const entry of added) store(entry);
			(events.get("agent_settled") as ((event: unknown, ctx: unknown) => void) | undefined)?.({ type: "agent_settled", aborted }, ctx);
			// The reader looks at the branch on the next turn of the event loop, once Pi stored the entries.
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
		/** Stores one message as Pi does: its message_end handlers run first, then the entry joins the branch. */
		store,
		/** Fires any other Pi event (tool_execution_*, ui_prompt_*) with this session's context. */
		event: (name: string, payload: Record<string, unknown> = {}) =>
			(events.get(name) as ((event: unknown, ctx: unknown) => void) | undefined)?.({ type: name, ...payload }, ctx),
		/** Fires one agent event as Pi does, with this session's context. */
		agent: (name: "agent_start" | "agent_settled", aborted = false) =>
			(events.get(name) as ((event: unknown, ctx: unknown) => void) | undefined)?.({ type: name, aborted }, ctx),
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
			await reader.turn([user("a"), assistant("Uno.")]);
			await pause();
			expect(synthesized).toEqual([]);
			await reader.run("read-auto", "questions");
			await reader.run("read-auto", "yes please");
			await reader.turn([user("b"), assistant(questions)]);
			await reader.settled();
			expect(reader.notes).toEqual([
				["Use /read-auto on, questions or off.", "warning"],
				["Auto-read on: questions only.", "info"],
				["Use /read-auto on, questions or off.", "warning"],
			]);
			expect(texts()).toEqual(["Decisiones pendientes.", "uno: ¿Seguimos?", "dos: ¿Publicamos?"]);
		});

		it("questions mode keeps the whole reply's language for added words (S7)", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "questions");
			await reader.turn([user("a"), assistant("The build is done and the tests pass for the new parser.\n\n## Needs your decision\n\n1. Run `/reload`?")]);
			await reader.settled();
			expect(texts()).toEqual(["Needs your decision.", "one: Run the command reload?"]);
		});

		it("bare /read-auto toggles: off to on in full, and any on to off", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto");
			await reader.turn([user("a"), assistant(questions)]);
			await reader.settled();
			expect(texts()).toEqual(["Hecho.", "Decisiones pendientes.", "uno: ¿Seguimos?", "dos: ¿Publicamos?"]);
			await reader.run("read-auto");
			await reader.run("read-auto", "questions");
			await reader.run("read-auto");
			await reader.turn([user("b"), assistant("Dos.")]);
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
			await reader.turn([user("a"), assistant("Uno.")]);
			await pause();
			await reader.run("read-auto", "on");
			reader.restart();
			await reader.turn([user("b"), assistant("Dos.")]);
			await pause();
			expect(synthesized).toEqual([]);
			expect(reader.statuses).toEqual([]);
			expect(existsSync(log("play-0.pid"))).toBe(false);
		});

		it("on: a turn that ends with a reply reads it in full, like /read, with its footer", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "on");
			await reader.turn([user("tercera"), assistant("## Tercera\n\nHecho **ya**.")]);
			await reader.settled();
			expect(texts()).toEqual(["Tercera.", "Hecho ya."]);
			expect(reader.statuses).toEqual(["Reading P3.R1 on local · Esc stops", undefined]);
			expect(existsSync(log("play-0.audio"))).toBe(true);
		});

		it("questions: reads only the closing Needs your decision section, heading or bold-only line", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "questions");
			await reader.turn([user("a"), assistant(questions)]);
			await reader.settled();
			await reader.turn([user("b"), assistant("Listo.\n\n**Needs your decision:**\n- ¿A o B?")]);
			await waitFor(() => reader.statuses.filter((status) => status === undefined).length === 2);
			expect(texts()).toEqual(["Decisiones pendientes.", "uno: ¿Seguimos?", "dos: ¿Publicamos?", "Decisiones pendientes.", "¿A o B?"]);
			expect(reader.statuses.filter(Boolean)).toEqual(["Reading P3.R1 on local · Esc stops", "Reading P4.R1 on local · Esc stops"]);
		});

		it("questions: a reply without that section reads nothing and says nothing", async () => {
			installVoice();
			const reader = load({ confirm: true });
			await reader.run("read-auto", "questions");
			await reader.turn([user("a"), assistant("## Hecho\n\nTodo listo.")]);
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
			await reader.turn([user("a")]);
			await pause();
			await reader.turn([user("b"), { ...assistant("A medias"), message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "A medias" }] } }], true);
			await pause();
			expect(synthesized).toEqual([]);
			expect(reader.statuses).toEqual([]);
			expect(reader.notes).toEqual([["Auto-read on: full replies.", "info"]]);
		});

		describe("each final reply as soon as it is stored, in order, once (T42, S8 Timing)", () => {
			const ended = (reader: ReturnType<typeof load>, n: number) => waitFor(() => reader.statuses.filter((status) => status === undefined).length === n);
			const wake = "[System-generated Gentle Agents notification, not written by the user] job done";
			const spoken = () => texts().filter((text) => !/^(Respuesta|Reply) /.test(text));
			const names = (reader: ReturnType<typeof load>) =>
				reader.statuses.filter(Boolean).map((status) => status?.replace(/ · \d+ waiting/, ""));

			it("a reply is queued once it is stored, while the run goes on, before any agent_settled", async () => {
				installVoice();
				const reader = load();
				await reader.run("read-auto", "on");
				reader.agent("agent_start");
				reader.store(user("a"));
				reader.store(assistant("Uno."));
				await reader.settled();
				expect(spoken()).toEqual(["Uno."]);
				expect(names(reader)).toEqual(["Reading P3.R1 on local · Esc stops"]);
			});

			it("a reply followed by an injected turn, then the later reply: A then B, each once", async () => {
				installVoice();
				const reader = load();
				await reader.run("read-auto", "on");
				reader.agent("agent_start");
				reader.store(user("a"));
				reader.store(assistant("Uno."));
				reader.agent("agent_start");
				reader.store(user(wake));
				reader.store(assistant("Dos."));
				reader.agent("agent_settled");
				await ended(reader, 2);
				await new Promise((resolve) => setTimeout(resolve, 700));
				expect(spoken()).toEqual(["Uno.", "Dos."]);
				expect(names(reader)).toEqual(["Reading P3.R1 on local · Esc stops", "Reading P3.R2 on local · Esc stops"]);
				expect(existsSync(log("play-2.pid"))).toBe(false);
			});

			it("questions: each new reply's questions section, in order, skipping a reply without one", async () => {
				installVoice();
				const reader = load();
				await reader.run("read-auto", "questions");
				await reader.turn([user("a"), assistant(questions), user(wake), assistant("Sin preguntas."), user("b"), assistant("Listo.\n\n**Needs your decision:**\n- ¿A o B?")]);
				await ended(reader, 2);
				await pause();
				expect(spoken()).toEqual(["Decisiones pendientes.", "uno: ¿Seguimos?", "dos: ¿Publicamos?", "Decisiones pendientes.", "¿A o B?"]);
				expect(names(reader)).toEqual(["Reading P3.R1 on local · Esc stops", "Reading P4.R1 on local · Esc stops"]);
			});

			it("turning auto-read on never reads the replies already on the branch, nor those stored while it was off", async () => {
				installVoice();
				const reader = load();
				await reader.turn([user("a"), assistant("Uno.")]);
				await pause();
				await reader.run("read-auto", "on");
				reader.store(user("b"));
				await pause();
				reader.store(assistant("Dos."));
				await reader.settled();
				await pause();
				expect(texts()).toEqual(["Dos."]);
				await reader.run("read-auto", "off");
				await reader.turn([user("c"), assistant("Tres.")]);
				await pause();
				await reader.run("read-auto", "on");
				await reader.turn([user("d"), assistant("Cuatro.")]);
				await ended(reader, 2);
				await pause();
				expect(texts()).toEqual(["Dos.", "Cuatro."]);
			});

			it("(preserved) a run with one final reply queues exactly one; a tool-use message is no reply", async () => {
				installVoice();
				const reader = load();
				await reader.run("read-auto", "on");
				const toolUse = { ...assistant("Voy a mirar."), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Voy a mirar." }] } };
				await reader.turn([user("a"), toolUse, assistant("Uno.")]);
				await reader.settled();
				await pause();
				expect(texts()).toEqual(["Uno."]);
				expect(reader.statuses).toEqual(["Reading P3.R1 on local · Esc stops", undefined]);
				expect(existsSync(log("play-1.pid"))).toBe(false);
			});
		});

		it("reuses /read's output question on first use, voice, speed, and the download confirm", async () => {
			script("paplay", "cat > /dev/null");
			const declined = load({ confirm: false });
			await declined.run("read-auto", "on");
			await declined.turn([user("a"), assistant("Uno.")]);
			await waitFor(() => declined.notes.length === 2);
			expect(declined.confirms).toHaveLength(1);
			expect(declined.notes[1]).toEqual(["Reading cancelled: the voice was not downloaded.", "info"]);

			installVoice();
			configureOutputs({ desktop: "tcp:x" });
			const reader = load({ select: "desktop (tcp:x)" });
			await reader.run("read-auto", "on");
			await reader.run("read-voice", "female");
			await reader.run("read-speed", "1.3");
			await reader.turn([user("a"), assistant("Uno.")]);
			await reader.settled();
			await reader.turn([user("b"), assistant("Dos.")]);
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
			await reader.turn([user("a"), assistant("Uno.")]);
			await waitFor(() => existsSync(log("play-0.pid")));
			expect(reader.key("\x1b")).toEqual({ consume: true });
			await waitFor(() => !alive(Number(read("play-0.pid"))));
			await reader.turn([user("b"), assistant("Dos.")]);
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
				await reader.turn([user("a"), assistant("Uno.")]);
				await reader.turn([user("b"), assistant("Dos.")]);
				await wait();
				expect(alive(pid(0))).toBe(true);
				expect(existsSync(log("play-1.pid"))).toBe(false);
				rmSync(log("hold"));
				await ended(reader, 3);
				// S14 (T38): each waited, so each starts by saying which reply it is.
				expect(texts().slice(-4)).toEqual(["Respuesta P tres, R uno.", "Uno.", "Respuesta P cuatro, R uno.", "Dos."]);
				expect([played(0), played(1), played(2)]).toEqual([true, true, true]);
				expect(reader.statuses).toEqual([
					"Reading P2.R1 on local · Esc stops",
					"Reading P2.R1 on local · 1 waiting · Esc stops",
					"Reading P2.R1 on local · 2 waiting · Esc stops",
					undefined,
					"Reading P3.R1 on local · 1 waiting · Esc stops",
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
				await reader.turn([user("a"), assistant(questions)]);
				await waitFor(() => existsSync(log("play-0.pid")));
				await reader.turn([user("b"), assistant("Listo.\n\n**Needs your decision:**\n- ¿A o B?")]);
				await wait();
				expect(alive(pid(0))).toBe(true);
				expect(existsSync(log("play-1.pid"))).toBe(false);
				rmSync(log("hold"));
				await ended(reader, 2);
				expect([played(0), played(1)]).toEqual([true, true]);
				expect(reader.statuses.filter(Boolean)).toEqual([
					"Reading P3.R1 on local · Esc stops",
					"Reading P3.R1 on local · 1 waiting · Esc stops",
					"Reading P4.R1 on local · Esc stops",
				]);
			});

			it("a manual /read stops the reading and drops the waiting replies; a later reply is read", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				await reader.turn([user("a"), assistant("Uno.")]);
				await reader.turn([user("b"), assistant("Dos.")]);
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
				await reader.turn([user("c"), assistant("Tres.")]);
				await ended(reader, 3);
				expect(texts().at(-1)).toBe("Tres.");
				expect(reader.statuses).toEqual([
					"Reading P2.R1 on local · Esc stops",
					"Reading P2.R1 on local · 1 waiting · Esc stops",
					"Reading P2.R1 on local · 2 waiting · Esc stops",
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
				await reader.turn([user("a"), assistant("Uno.")]);
				await wait();
				reader.bus.emit(READER_EVENTS.read, { v: 1, id: "P9.R1", text: "Nueve." });
				await waitFor(() => !alive(pid(0)));
				await waitFor(() => existsSync(log("play-1.pid")));
				rmSync(log("hold"));
				await ended(reader, 2);
				await wait();
				expect(existsSync(log("play-2.pid"))).toBe(false);
				expect(texts()).not.toContain("Uno.");
				expect(reader.statuses.filter(Boolean)).toEqual([
					"Reading P2.R1 on local · Esc stops",
					"Reading P2.R1 on local · 1 waiting · Esc stops",
					"Reading P9.R1 on local · Esc stops",
				]);
			});

			it("/read-stop and Esc stop the reading and drop the waiting replies", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				await reader.turn([user("a"), assistant("Uno.")]);
				await wait();
				await reader.run("read-stop");
				await waitFor(() => !alive(pid(0)));
				await wait();
				expect(existsSync(log("play-1.pid"))).toBe(false);
				await reader.run("read", "P2.R1");
				await waitFor(() => existsSync(log("play-1.pid")));
				await reader.turn([user("b"), assistant("Dos.")]);
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
				expect(reader.statuses).toEqual([
					"Reading P2.R1 on local · Esc stops",
					"Reading P2.R1 on local · 1 waiting · Esc stops",
					undefined,
					"Reading P2.R1 on local · Esc stops",
					"Reading P2.R1 on local · 1 waiting · Esc stops",
					undefined,
				]);
			});

			it("/read-auto off and the session's end drop this session's waiting replies", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				await reader.turn([user("a"), assistant("Uno.")]);
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
				await reader.turn([user("b"), assistant("Dos.")]);
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

		describe("between queued readings: a gap and an announcement (T38, S14)", { timeout: 20000 }, () => {
			const holding = () => {
				writeFileSync(log("hold"), "");
				installVoice(`while [ -e "${root}/hold" ]; do sleep 0.02; done;`);
			};
			const ended = (reader: ReturnType<typeof load>, n: number) => waitFor(() => reader.statuses.filter((status) => status === undefined).length === n);
			const audio = (n: number) => readFileSync(log(`play-${n}.audio`));
			/** 1.5 s of silence at the fake engine's 44.1 kHz, as 16-bit samples. */
			const GAP_BYTES = Math.round(1.5 * 44100) * 2;
			/** One fragment of the fake engine (one sample) plus a section break's 0.75 s pause. */
			const ANNOUNCED_BYTES = 2 + Math.round(0.75 * 44100) * 2;
			const wake = "[System-generated Gentle Agents notification, not written by the user] job done";
			/** One run where an injected user-role message chains a second turn (T42). */
			const chained = (reader: ReturnType<typeof load>, first: unknown[], second: unknown[]) => {
				reader.agent("agent_start");
				for (const entry of first) reader.store(entry);
				reader.agent("agent_start");
				for (const entry of second) reader.store(entry);
				reader.agent("agent_settled");
			};

			it("a reading that waited starts after 1.5 s of silence, saying which reply it is; the first starts as today", async () => {
				installVoice();
				const reader = load();
				await reader.run("read-auto", "on");
				chained(reader, [user("a"), assistant("Uno.")], [user(wake), assistant("Dos.")]);
				await ended(reader, 2);
				expect(texts()).toEqual(["Uno.", "Respuesta P tres, R dos.", "Dos."]);
				// The first: its own sample only. The second: the gap, the announcement and its section pause, then the reply.
				expect(audio(0).length).toBe(2);
				const second = audio(1);
				expect(second.length).toBe(GAP_BYTES + ANNOUNCED_BYTES + 2);
				expect(second.subarray(0, GAP_BYTES).every((byte) => byte === 0)).toBe(true);
				expect(second.readInt16LE(GAP_BYTES)).not.toBe(0);
				expect(second.subarray(GAP_BYTES + 2, GAP_BYTES + ANNOUNCED_BYTES).every((byte) => byte === 0)).toBe(true);
				expect(second.readInt16LE(GAP_BYTES + ANNOUNCED_BYTES)).not.toBe(0);
			});

			it("the announcement is in the reading's own language: Reply in English", async () => {
				installVoice();
				const reader = load();
				await reader.run("read-auto", "on");
				const english = "The build is done and the tests pass for the new parser.";
				chained(reader, [user("a"), assistant(english)], [user(wake), assistant(`${english} Then it was pushed.`)]);
				await ended(reader, 2);
				expect(texts()).toEqual([english, "Reply P three, R two.", english, "Then it was pushed."]);
			});

			it("a file waiting after Read after it says its name, in its own language", async () => {
				holding();
				mkdirSync(join(root, "work"), { recursive: true });
				writeFileSync(join(root, "work", "notas.md"), "Hola.");
				writeFileSync(join(root, "work", "notes.md"), "The build is done and the tests pass for the new parser.");
				const reader = load({ cut: "after" });
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				await reader.run("read", "notas.md");
				await reader.run("read", "notes.md");
				rmSync(log("hold"));
				await ended(reader, 3);
				expect(texts().slice(-4)).toEqual([
					"Archivo notas punto md.",
					"Hola.",
					"File notes dot md.",
					"The build is done and the tests pass for the new parser.",
				]);
				expect(audio(1).subarray(0, GAP_BYTES).every((byte) => byte === 0)).toBe(true);
			});

			it("the footer adds the count while readings wait, and drops it when none does", async () => {
				holding();
				const reader = load();
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => existsSync(log("play-0.pid")));
				chained(reader, [user("a"), assistant("Uno.")], [user(wake), assistant("Dos.")]);
				await waitFor(() => reader.statuses.length === 3);
				expect(reader.statuses).toEqual([
					"Reading P2.R1 on local · Esc stops",
					"Reading P2.R1 on local · 1 waiting · Esc stops",
					"Reading P2.R1 on local · 2 waiting · Esc stops",
				]);
				rmSync(log("hold"));
				await ended(reader, 3);
				expect(reader.statuses.slice(3)).toEqual([
					undefined,
					"Reading P3.R1 on local · 1 waiting · Esc stops",
					undefined,
					"Reading P3.R2 on local · Esc stops",
					undefined,
				]);
			});
		});

		describe("ask before cutting (T33, S8, S10)", { timeout: 20000 }, () => {
			const holding = () => {
				writeFileSync(log("hold"), "");
				installVoice(`while [ -e "${root}/hold" ]; do sleep 0.02; done;`);
			};
			const pid = (n: number) => Number(read(`play-${n}.pid`));
			const has = (n: number) => existsSync(log(`play-${n}.pid`));
			const wait = () => new Promise((resolve) => setTimeout(resolve, 700));
			const ended = (reader: ReturnType<typeof load>, n: number) => waitFor(() => reader.statuses.filter((status) => status === undefined).length === n);
			const shared = () => {
				env.XDG_RUNTIME_DIR = join(root, "run");
				mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
			};
			/** The question as the user sees it: the title, the two choices with the first one selected, and the keys. */
			const QUESTION = ["Something is being read.", "→ Stop it and read now", "Read after it"];
			const shown = (lines: string[]) => lines.map((line) => line.trim()).filter((line) => line && !/^─+$/.test(line));

			it("a manual /read while this session reads asks first, in a small overlay of its own, and stops nothing while it is open", async () => {
				holding();
				const reader = load({ cut: "wait" });
				await reader.run("read");
				await waitFor(() => has(0));
				void reader.run("read", "P1.R1");
				await waitFor(reader.asking);
				const [title, first, second, hint] = shown(reader.asked[0]);
				expect([title, first, second]).toEqual(QUESTION);
				expect(hint).toMatch(/select.*cancel/);
				expect(reader.asked).toHaveLength(1);
				expect(reader.overlays).toEqual([{ overlay: true, overlayOptions: { anchor: "center", width: 48 } }]);
				expect(reader.selects).toEqual([]);
				await wait();
				expect(alive(pid(0))).toBe(true);
				expect(has(1)).toBe(false);
				reader.answer("dismiss");
				rmSync(log("hold"));
				await ended(reader, 1);
			});

			it("in Pi's TUI the question is painted above a capturing overlay (Alt+R), takes its keys, and gives them back on closing", async () => {
				holding();
				const terminal = {
					...Object.fromEntries(
						["start", "stop", "write", "moveBy", "hideCursor", "showCursor", "clearLine", "clearFromCursor", "clearScreen", "setTitle", "setProgress", "setProgramStatus"].map(
							(name) => [name, () => {}],
						),
					),
					drainInput: async () => {},
					columns: 80,
					rows: 24,
					kittyProtocolActive: false,
				};
				const tui = new TuiMainScreen(terminal as never);
				tui.addChild(new Text("the editor", 0, 0));
				/** pi-reply-thread's Alt+R view: a capturing overlay with the same options, filled with V. */
				const viewKeys: string[] = [];
				const view = { render: (width: number) => Array.from({ length: 20 }, () => "V".repeat(width)), handleInput: (data: string) => void viewKeys.push(data), invalidate() {} };
				tui.showOverlay(view, { width: "90%", maxHeight: "90%", anchor: "center" });
				// What Pi's showExtensionCustom does for { overlay: true }: build the component, show it, hide it on done.
				const custom = (
					factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => never,
					options: { overlayOptions?: never },
				) =>
					new Promise((resolve) => {
						let handle: { hide(): void } | undefined;
						const component = factory(tui, PLAIN_THEME, undefined, (result) => {
							handle?.hide();
							resolve(result);
						});
						handle = tui.showOverlay(component, options.overlayOptions);
					});
				const reader = load({ ui: { custom, onTerminalInput: (handler: never) => tui.addInputListener(handler) } });
				const type = (data: string) => (tui as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput(data);
				const screen = () =>
					(tui as unknown as { compositeOverlays(lines: string[], width: number, height: number): string[] })
						.compositeOverlays(tui.render(80), 80, 24)
						.map((line) => stripTerminalSequences(line));
				await reader.run("read");
				await waitFor(() => has(0));
				type("j");
				reader.bus.emit(READER_EVENTS.read, { v: 1, id: "P9.R1", text: "Nueve." });
				await waitFor(() => screen().some((line) => line.includes("Something is being read.")));
				const rows = screen();
				const title = rows.findIndex((line) => line.includes("Something is being read."));
				// The view's V's on both sides of the question: it is drawn over the view, not under it.
				expect(rows[title]).toMatch(/^ *V+.*Something is being read\..*V+ *$/);
				expect(rows.slice(title, title + 4).join("\n")).toMatch(/Stop it and read now[\s\S]*Read after it/);
				// Small: only the question's own rows cover the middle of the view.
				const covered = rows.filter((line) => line.slice(4, 10) === "VVVVVV" && line[40] !== "V").length;
				expect(covered).toBeGreaterThanOrEqual(4);
				expect(covered).toBeLessThanOrEqual(8);
				type("x");
				expect(viewKeys).toEqual(["j"]);
				// Esc closes the question (changing nothing, the reading here keeps playing), and the view has the keys again.
				type("\x1b");
				await waitFor(() => !screen().some((line) => line.includes("Something is being read.")));
				expect(tui.getFocusedComponent()).toBe(view);
				type("k");
				expect(viewKeys).toEqual(["j", "k"]);
				await wait();
				expect([alive(pid(0)), has(1)]).toEqual([true, false]);
				expect(reader.notes).toEqual([]);
				rmSync(log("hold"));
				await ended(reader, 1);
			});

			it("a manual /read while another session reads (S1's lock) asks too", async () => {
				shared();
				holding();
				const a = load();
				const b = load({ cut: "wait" });
				await a.run("read");
				await waitFor(() => has(0));
				void b.run("read", "P1.R1");
				await waitFor(b.asking);
				expect(shown(b.asked[0]).slice(0, 2)).toEqual(QUESTION.slice(0, 2));
				expect(alive(pid(0))).toBe(true);
				b.answer("dismiss");
				rmSync(log("hold"));
				await ended(a, 1);
			});

			it("Stop it and read now does what /read did: stops the reading, drops every waiting auto-read on the machine, reads", async () => {
				shared();
				holding();
				const a = load();
				const c = load();
				const b = load({ cut: "now" });
				await a.run("read");
				await waitFor(() => has(0));
				await c.run("read-auto", "on");
				await c.turn([user("a"), assistant("Uno.")]);
				await wait();
				await b.run("read", "P1.R1");
				expect(b.asked).toHaveLength(1);
				await waitFor(() => !alive(pid(0)));
				await waitFor(() => has(1));
				rmSync(log("hold"));
				await ended(b, 1);
				await wait();
				expect(has(2)).toBe(false);
				expect(texts()).not.toContain("Uno.");
				expect(b.statuses).toEqual(["Reading P1.R1 on local · Esc stops", undefined]);
				expect([a.notes, b.notes]).toEqual([[], []]);
			});

			it("Read after it waits like an auto-read, after this session's waiting replies, then plays; nothing is cut", async () => {
				holding();
				const reader = load({ cut: "after" });
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => has(0));
				await reader.turn([user("a"), assistant("Uno.")]);
				await reader.run("read", "P1.R1");
				await wait();
				expect(alive(pid(0))).toBe(true);
				expect(has(1)).toBe(false);
				rmSync(log("hold"));
				await ended(reader, 3);
				expect(texts().slice(-4)).toEqual(["Respuesta P tres, R uno.", "Uno.", "Respuesta P uno, R uno.", "Primera respuesta."]);
				expect([0, 1, 2].map((n) => existsSync(log(`play-${n}.audio`)))).toEqual([true, true, true]);
				expect(reader.statuses.filter(Boolean)).toEqual([
					"Reading P2.R1 on local · Esc stops",
					"Reading P2.R1 on local · 1 waiting · Esc stops",
					"Reading P2.R1 on local · 2 waiting · Esc stops",
					"Reading P3.R1 on local · 1 waiting · Esc stops",
					"Reading P1.R1 on local · Esc stops",
				]);
				expect(reader.notes).toEqual([["Auto-read on: full replies.", "info"]]);
			});

			it("Read after it waits for another session's reading and plays when the machine is free", async () => {
				shared();
				holding();
				const a = load();
				const b = load({ cut: "after" });
				await a.run("read");
				await waitFor(() => has(0));
				await b.run("read", "P1.R1");
				await wait();
				expect([alive(pid(0)), has(1)]).toEqual([true, false]);
				rmSync(log("hold"));
				await ended(b, 1);
				expect(b.statuses).toEqual(["Reading P1.R1 on local · Esc stops", undefined]);
				expect(existsSync(log("play-0.audio"))).toBe(true);
				expect([a.notes, b.notes]).toEqual([[], []]);
			});

			for (const how of ["/read-stop", "Esc", "another manual /read", "another session's /read-stop"] as const) {
				it(`a request waiting after Read after it is dropped by ${how}`, async () => {
					shared();
					holding();
					const reader = load({ cut: "wait" });
					const other = load();
					await reader.run("read");
					await waitFor(() => has(0));
					const asked = reader.run("read", "P1.R1");
					await waitFor(reader.asking);
					reader.answer("after");
					await asked;
					await wait();
					expect([alive(pid(0)), has(1)]).toEqual([true, false]);
					if (how === "/read-stop") await reader.run("read-stop");
					if (how === "Esc") expect(reader.key("\x1b")).toEqual({ consume: true });
					if (how === "another session's /read-stop") await other.run("read-stop");
					if (how === "another manual /read") {
						reader.bus.emit(READER_EVENTS.read, { v: 1, id: "P9.R1", text: "Nueve." });
						await waitFor(() => reader.asked.length === 2);
						reader.answer("now");
					}
					await waitFor(() => !alive(pid(0)));
					rmSync(log("hold"));
					await wait();
					expect(texts()).not.toContain("Primera respuesta.");
					expect(reader.statuses.filter(Boolean)).toEqual(
						how === "another manual /read"
							? ["Reading P2.R1 on local · Esc stops", "Reading P2.R1 on local · 1 waiting · Esc stops", "Reading P9.R1 on local · Esc stops"]
							: ["Reading P2.R1 on local · Esc stops", "Reading P2.R1 on local · 1 waiting · Esc stops"],
					);
				});
			}

			it("/read-auto off keeps a request waiting after Read after it: it is no auto-read (worker's call)", async () => {
				holding();
				const reader = load({ cut: "after" });
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => has(0));
				await reader.turn([user("a"), assistant("Uno.")]);
				await reader.run("read", "P1.R1");
				await reader.run("read-auto", "off");
				rmSync(log("hold"));
				await ended(reader, 2);
				expect(texts()).not.toContain("Uno.");
				expect(texts().at(-1)).toBe("Primera respuesta.");
			});

			it("dismissing the question (Esc, even while this session reads) changes nothing: nothing stops, nothing plays, no message", async () => {
				holding();
				const reader = load({ cut: "dismiss" });
				await reader.run("read-auto", "on");
				await reader.run("read");
				await waitFor(() => has(0));
				await reader.turn([user("a"), assistant("Uno.")]);
				await reader.run("read", "P1.R1");
				reader.bus.emit(READER_EVENTS.read, { v: 1, id: "P9.R1", text: "Nueve." });
				await waitFor(() => reader.asked.length === 2 && !reader.asking());
				await wait();
				expect(alive(pid(0))).toBe(true);
				expect(has(1)).toBe(false);
				expect(reader.notes).toEqual([["Auto-read on: full replies.", "info"]]);
				expect(reader.statuses).toEqual(["Reading P2.R1 on local · Esc stops", "Reading P2.R1 on local · 1 waiting · Esc stops"]);
				// The waiting auto-read was not dropped; the dismissed requests never play.
				rmSync(log("hold"));
				await ended(reader, 2);
				await wait();
				expect(texts().slice(-1)).toEqual(["Uno."]);
				expect(texts()).not.toContain("Primera respuesta.");
				expect(texts()).not.toContain("Nueve.");
				expect(has(2)).toBe(false);
			});

			it("with nothing playing, or without a UI, /read and a read request read at once without asking", async () => {
				holding();
				const idle = load({ cut: "wait" });
				await idle.run("read", "P1.R1");
				await waitFor(() => has(0));
				idle.shutdown();
				await waitFor(() => !alive(pid(0)));
				const event = load({ cut: "wait" });
				event.bus.emit(READER_EVENTS.read, { v: 1, id: "P9.R1", text: "Nueve." });
				await waitFor(() => has(1));
				event.shutdown();
				await waitFor(() => !alive(pid(1)));
				expect([idle.asked, event.asked]).toEqual([[], []]);

				const headless = load({ hasUI: false, cut: "wait" });
				await headless.run("read");
				await waitFor(() => has(2));
				await headless.run("read", "P1.R1");
				await waitFor(() => !alive(pid(2)));
				await waitFor(() => has(3));
				headless.bus.emit(READER_EVENTS.read, { v: 1, id: "P9.R1", text: "Nueve." });
				await waitFor(() => !alive(pid(3)));
				await waitFor(() => has(4));
				expect(headless.asked).toEqual([]);
				expect(headless.selects).toEqual([]);
				headless.shutdown();
				await waitFor(() => !alive(pid(4)));
			});

			it("a read request (Alt+R s) while a reading plays asks the same question; each answer works as for /read", async () => {
				holding();
				const reader = load({ cut: "wait" });
				await reader.run("read");
				await waitFor(() => has(0));
				reader.bus.emit(READER_EVENTS.read, { v: 1, id: "P9.R1", text: "Nueve." });
				await waitFor(reader.asking);
				expect([shown(reader.asked[0])[0], shown(reader.asked[0])[1]]).toEqual(QUESTION.slice(0, 2));
				reader.answer("after");
				await wait();
				expect([alive(pid(0)), has(1)]).toEqual([true, false]);
				reader.bus.emit(READER_EVENTS.read, { v: 1, id: "P8.R1", text: "Ocho." });
				await waitFor(() => reader.asked.length === 2);
				reader.answer("now");
				await waitFor(() => !alive(pid(0)));
				await waitFor(() => has(1));
				rmSync(log("hold"));
				await ended(reader, 2);
				await wait();
				// "Ocho" was an explicit reading: it dropped the request waiting after the first answer.
				expect(texts()).not.toContain("Nueve.");
				expect(reader.statuses.filter(Boolean)).toEqual([
					"Reading P2.R1 on local · Esc stops",
					"Reading P2.R1 on local · 1 waiting · Esc stops",
					"Reading P8.R1 on local · Esc stops",
				]);
				expect(reader.notes).toEqual([]);
			});

			it("/read-stop and Esc never ask; /read-auto and /read-stop say what they said before", async () => {
				shared();
				holding();
				const a = load({ cut: "wait" });
				const b = load({ cut: "wait" });
				await a.run("read");
				await waitFor(() => has(0));
				await b.run("read-auto", "on");
				await b.run("read-auto", "questions");
				await b.run("read-auto", "maybe");
				await b.run("read-stop");
				await waitFor(() => !alive(pid(0)));
				await b.run("read-stop");
				await b.run("read-auto", "off");
				await ended(a, 1);
				await a.run("read");
				await waitFor(() => has(1));
				expect(a.key("\x1b")).toEqual({ consume: true });
				await waitFor(() => !alive(pid(1)));
				expect([a.asked, b.asked]).toEqual([[], []]);
				expect(b.notes).toEqual([
					["Auto-read on: full replies.", "info"],
					["Auto-read on: questions only.", "info"],
					["Use /read-auto on, questions or off.", "warning"],
					["Reading stopped.", "info"],
					["Nothing is being read.", "info"],
					["Auto-read off.", "info"],
				]);
				expect(a.notes).toEqual([]);
			});

			it("outside the TUI (RPC) the question goes through ctx.ui.select, with the same title and choices", async () => {
				holding();
				const reader = load({ mode: "rpc", select: "Read after it", cut: "wait" });
				await reader.run("read");
				await waitFor(() => has(0));
				await reader.run("read", "P1.R1");
				expect(reader.selects).toEqual([["Something is being read.", ["Stop it and read now", "Read after it"]]]);
				expect(reader.asked).toEqual([]);
				await wait();
				expect([alive(pid(0)), has(1)]).toEqual([true, false]);
				rmSync(log("hold"));
				await ended(reader, 2);
				expect(texts().at(-1)).toBe("Primera respuesta.");
			});

			it("a question still open when the reading ends: Read after it then plays at once, and Stop it and read now reads", async () => {
				holding();
				const reader = load({ cut: "wait" });
				await reader.run("read");
				await waitFor(() => has(0));
				const asked = reader.run("read", "P1.R1");
				await waitFor(reader.asking);
				rmSync(log("hold"));
				await ended(reader, 1);
				reader.answer("after");
				await asked;
				await ended(reader, 2);
				expect(texts().at(-1)).toBe("Primera respuesta.");
				expect(reader.notes).toEqual([]);
			});

			for (const answer of ["after", "now"] as const) {
				for (const how of ["ends", "restarts"] as const) {
					it(`a question still open when the session ${how} is dropped when answered ${answer}: nothing plays, no message`, async () => {
						holding();
						const reader = load({ cut: "wait" });
						await reader.run("read");
						await waitFor(() => has(0));
						const asked = reader.run("read", "P1.R1");
						await waitFor(reader.asking);
						reader.shutdown();
						await waitFor(() => !alive(pid(0)));
						if (how === "restarts") reader.restart();
						rmSync(log("hold"));
						reader.answer(answer);
						await asked;
						await wait();
						expect(has(1)).toBe(false);
						expect(texts()).not.toContain("Primera respuesta.");
						expect(reader.statuses).toEqual(["Reading P2.R1 on local · Esc stops", undefined]);
						expect(reader.notes).toEqual([]);
					});
				}
			}

			it("Read after it waits behind two waiting auto-replies; a later reply waits behind it (S8 c)", async () => {
				holding();
				const r = load({ cut: "after" });
				await r.run("read-auto", "on");
				await r.run("read");
				await waitFor(() => has(0));
				await r.turn([user("a"), assistant("Uno.")]);
				await r.turn([user("b"), assistant("Dos.")]);
				await r.run("read", "P1.R1");
				await r.turn([user("c"), assistant("Tres.")]);
				await wait();
				expect(has(1)).toBe(false);
				rmSync(log("hold"));
				await ended(r, 5);
				// S14 (T38): the footer counts what waits, which drops by one as each starts.
				expect(r.statuses.filter(Boolean)).toEqual(
					[
						["P2.R1", 0],
						["P2.R1", 1],
						["P2.R1", 2],
						["P2.R1", 3],
						["P2.R1", 4],
						["P3.R1", 3],
						["P4.R1", 2],
						["P1.R1", 1],
						["P5.R1", 0],
					].map(([id, waiting]) => `Reading ${id} on local · ${waiting ? `${waiting} waiting · ` : ""}Esc stops`),
				);
			});

			it("Read after it is dropped by the session's end and by Esc in another session (S8 c)", async () => {
				shared();
				holding();
				const a = load();
				const b = load({ cut: "after" });
				await a.run("read");
				await waitFor(() => has(0));
				await b.run("read", "P1.R1");
				await wait();
				expect(a.key("\x1b")).toEqual({ consume: true });
				await waitFor(() => !alive(pid(0)));
				rmSync(log("hold"));
				await wait();
				await wait();
				expect([has(1), b.statuses]).toEqual([false, []]);
			});

			it("Esc while the question is open is not consumed; once closed, Esc stops again (S8 f)", async () => {
				holding();
				const r = load({ cut: "wait" });
				await r.run("read");
				await waitFor(() => has(0));
				void r.run("read", "P1.R1");
				await waitFor(r.asking);
				expect(r.key("\x1b")).toBeUndefined();
				await wait();
				expect(alive(pid(0))).toBe(true);
				r.answer("dismiss");
				await waitFor(() => !r.asking());
				expect(r.key("\x1b")).toEqual({ consume: true });
				await waitFor(() => !alive(pid(0)));
				rmSync(log("hold"));
			});

			it("another session claims while the question is open: after waits for it (S8 h)", async () => {
				shared();
				holding();
				const a = load();
				const c = load();
				const b = load({ cut: "wait" });
				await a.run("read");
				await waitFor(() => has(0));
				await c.run("read-auto", "on");
				await c.turn([user("a"), assistant("Uno.")]);
				const asked = b.run("read", "P1.R1");
				await waitFor(b.asking);
				process.kill(pid(0), "SIGTERM");
				await waitFor(() => has(1));
				b.answer("after");
				await asked;
				await wait();
				expect([alive(pid(1)), has(2)]).toEqual([true, false]);
				rmSync(log("hold"));
				await ended(b, 1);
				expect(b.statuses.filter(Boolean)).toEqual(["Reading P1.R1 on local · Esc stops"]);
			});

			it("the waiting mark is taken at answer time: an explicit read elsewhere while the question is open does not drop it (S8 h)", async () => {
				shared();
				holding();
				const a = load();
				const d = load({ cut: "now" });
				const b = load({ cut: "wait" });
				await a.run("read");
				await waitFor(() => has(0));
				const asked = b.run("read", "P1.R1");
				await waitFor(b.asking);
				await d.run("read", "P1.R1");
				await waitFor(() => has(1));
				b.answer("after");
				await asked;
				rmSync(log("hold"));
				await ended(b, 1);
				expect(b.statuses.filter(Boolean)).toEqual(["Reading P1.R1 on local · Esc stops"]);
			});
		});

		it("/read-auto completes on, questions and off", () => {
			const reader = load();
			const complete = reader.commands.get("read-auto")!.getArgumentCompletions as (prefix: string) => { value: string }[];
			expect(complete("").map((item) => item.value)).toEqual(["on", "questions", "off"]);
			expect(complete("o").map((item) => item.value)).toEqual(["on", "off"]);
		});
	});

	describe("blocking prompts are read aloud (T43, S18)", { timeout: 20000 }, () => {
		const texts = () => synthesized.map((request) => request.text);
		const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
		/** Longer than two of the reader's 250 ms checks. */
		const wait = () => new Promise((resolve) => setTimeout(resolve, 700));
		const ended = (reader: ReturnType<typeof load>, n: number) => waitFor(() => reader.statuses.filter((status) => status === undefined).length === n);
		/** Each player plays while `hold`, or its own `hold-<n>`, exists. */
		const holding = () => {
			writeFileSync(log("hold"), "");
			installVoice(`while [ -e "${root}/hold" ] || [ -e "${root}/hold-$n" ]; do sleep 0.02; done;`);
		};
		const pid = (n: number) => Number(read(`play-${n}.pid`));
		const english = "The build is done and the tests pass for the new parser.";
		const twoQuestions = {
			questions: [
				{
					header: "Voz",
					question: "¿Cómo suena?",
					options: [
						{ label: "Bien", description: "se oye claro" },
						{ label: "Mal", description: "se corta" },
					],
				},
				{ header: "Plan", question: "¿Seguimos?", multiSelect: false, options: [{ label: "Sí" }, { label: "No" }] },
			],
		};
		const ask = (reader: ReturnType<typeof load>, toolCallId: string, toolName: string, args: unknown) =>
			reader.event("tool_execution_start", { toolCallId, toolName, args });
		const prompt = (reader: ReturnType<typeof load>, kind: string, title?: string) =>
			reader.event("ui_prompt_start", { reason: "ui_prompt", kind, ...(title === undefined ? {} : { title }) });

		it("ask_user_question reads each question with its option labels only, in Spanish, never descriptions", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "on");
			ask(reader, "c1", "ask_user_question", twoQuestions);
			await reader.settled();
			expect(texts()).toEqual([
				"Pregunta uno de dos: ¿Cómo suena?",
				"Opciones: uno, Bien; dos, Mal.",
				"Pregunta dos de dos: ¿Seguimos?",
				"Opciones: uno, Sí; dos, No.",
			]);
			expect(texts().join(" ")).not.toMatch(/claro|corta|Voz|Plan/);
			expect(reader.statuses).toEqual(["Reading question on local · Esc stops", undefined]);
			expect(reader.notes).toEqual([["Auto-read on: full replies.", "info"]]);
		});

		it("ask_user_choice reads its single question as Pregunta:, labels only (never values or descriptions); English reads Question", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "on");
			ask(reader, "c1", "ask_user_choice", {
				question: "¿Publicamos?",
				options: [
					{ label: "Sí", value: "publish-now", description: "sube la versión" },
					{ label: "Todavía no", value: "wait" },
				],
			});
			await reader.settled();
			reader.event("tool_execution_end", { toolCallId: "c1", toolName: "ask_user_choice", result: {}, isError: false });
			ask(reader, "c2", "ask_user_question", {
				questions: [
					{ header: "Sound", question: "How does it sound?", options: [{ label: "Good" }, { label: "Bad" }] },
					{ header: "Plan", question: "Should we go on with the plan?", options: [{ label: "Yes" }, { label: "No" }] },
				],
			});
			await ended(reader, 2);
			expect(texts()).toEqual([
				"Pregunta: ¿Publicamos?",
				"Opciones: uno, Sí; dos, Todavía no.",
				"Question one of two: How does it sound?",
				"Options: one, Good; two, Bad.",
				"Question two of two: Should we go on with the plan?",
				"Options: one, Yes; two, No.",
			]);
			expect(texts().join(" ")).not.toMatch(/publish|wait|sube/);
		});

		it("a malformed ask_user_* call reads nothing and says nothing; other tools read nothing", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "on");
			ask(reader, "c1", "ask_user_question", { questions: "¿Qué?" });
			ask(reader, "c2", "ask_user_question", { questions: [] });
			ask(reader, "c3", "ask_user_question", { questions: [{ question: "¿Qué?", options: [{ description: "sin etiqueta" }] }] });
			ask(reader, "c4", "ask_user_choice", { question: 3, options: [{ label: "A" }] });
			ask(reader, "c5", "ask_user_choice", undefined);
			ask(reader, "c6", "read", { path: "README.md" });
			await pause();
			expect(synthesized).toEqual([]);
			expect(reader.statuses).toEqual([]);
			expect(reader.notes).toEqual([["Auto-read on: full replies.", "info"]]);
		});

		it("a confirm while a bash call is pending reads Confirmación de comando and the program only, never its arguments", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "on");
			ask(reader, "b1", "bash", { command: "TOKEN=abc123 sudo git push --force origin secreto" });
			prompt(reader, "confirm", "Allow force push?");
			await reader.settled();
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			reader.event("tool_execution_end", { toolCallId: "b1", toolName: "bash", result: {}, isError: false });
			ask(reader, "b2", "bash", { command: "/usr/bin/npm publish --otp 123456" });
			prompt(reader, "confirm", "Allow publish?");
			await ended(reader, 2);
			expect(texts()).toEqual(["Confirmación de comando: git.", "Confirmación de comando: npm."]);
			expect(texts().join(" ")).not.toMatch(/push|force|secreto|TOKEN|abc|sudo|publish|otp|Allow/);
			expect(reader.statuses.filter(Boolean)).toEqual(["Reading command confirmation on local · Esc stops", "Reading command confirmation on local · Esc stops"]);
		});

		it("the command confirmation is in the conversation's language: Command confirmation after an English reply", async () => {
			installVoice();
			const reader = load({}, [user("a"), assistant(english)]);
			await reader.run("read-auto", "on");
			ask(reader, "b1", "bash", { command: "git status" });
			prompt(reader, "confirm", "Run it?");
			await reader.settled();
			expect(texts()).toEqual(["Command confirmation: git."]);
		});

		it("any other dialog reads only its title; none without a title; a confirm with no bash pending is such a dialog", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "on");
			prompt(reader, "select", "¿Revisar con RDD antes de seguir?");
			await reader.settled();
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			prompt(reader, "custom");
			await pause();
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			ask(reader, "b1", "bash", { command: "ls -la" });
			reader.event("tool_execution_end", { toolCallId: "b1", toolName: "bash", result: {}, isError: false });
			prompt(reader, "confirm", "¿Borrar la sesión?");
			await ended(reader, 2);
			expect(texts()).toEqual(["¿Revisar con RDD antes de seguir?", "¿Borrar la sesión?"]);
			expect(reader.statuses.filter(Boolean)).toEqual(["Reading dialog on local · Esc stops", "Reading dialog on local · Esc stops"]);
		});

		it("an ask_user_* call that also raises ui_prompt_start is read once (deduped by its pending call)", async () => {
			installVoice();
			const reader = load();
			await reader.run("read-auto", "on");
			ask(reader, "c1", "ask_user_choice", { question: "¿Publicamos?", options: [{ label: "Sí" }, { label: "No" }] });
			prompt(reader, "select", "¿Publicamos?");
			await reader.settled();
			await wait();
			expect(texts()).toEqual(["Pregunta: ¿Publicamos?", "Opciones: uno, Sí; dos, No."]);
		});

		it("the reader's own questions (output, voice) are never read as dialogs", async () => {
			installVoice();
			configureOutputs({ desktop: "tcp:x" });
			let fire: (title: string) => void = () => {};
			const reader = load({
				ui: {
					select: async (title: string, options: string[]) => {
						fire(title);
						return options.at(-1);
					},
				},
			});
			fire = (title) => prompt(reader, "select", title);
			await reader.run("read-auto", "on");
			await reader.run("read-voice");
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			await reader.run("read");
			await reader.settled();
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			await wait();
			expect(texts().join(" ")).not.toMatch(/Which voice|Where should/);
			expect(reader.statuses.filter(Boolean)).toEqual(["Reading P2.R1 on desktop · Esc stops"]);
		});

		it("answered prompts are dropped: one waiting (ui_prompt_end, tool end) never plays, one playing stops; other waiting readings stay", async () => {
			holding();
			const reader = load();
			await reader.run("read-auto", "on");
			await reader.run("read");
			await waitFor(() => existsSync(log("play-0.pid")));
			await reader.turn([user("a"), assistant("Uno.")]);
			ask(reader, "c1", "ask_user_choice", { question: "¿Publicamos?", options: [{ label: "Sí" }] });
			prompt(reader, "select", "¿Publicamos?");
			ask(reader, "b1", "bash", { command: "git push" });
			await reader.turn([user("b"), assistant("Dos.")]);
			await wait();
			expect(reader.statuses.at(-1)).toBe("Reading P2.R1 on local · 3 waiting · Esc stops");
			// The ask_user_choice dialog is answered: its question, still waiting, is dropped.
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			reader.event("tool_execution_end", { toolCallId: "c1", toolName: "ask_user_choice", result: {}, isError: false });
			expect(reader.statuses.at(-1)).toBe("Reading P2.R1 on local · 2 waiting · Esc stops");
			// A command confirmation joins the line and is answered before its turn.
			prompt(reader, "confirm", "Allow push?");
			expect(reader.statuses.at(-1)).toBe("Reading P2.R1 on local · 3 waiting · Esc stops");
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			expect(reader.statuses.at(-1)).toBe("Reading P2.R1 on local · 2 waiting · Esc stops");
			rmSync(log("hold"));
			await ended(reader, 3);
			await wait();
			expect(texts().join(" ")).not.toMatch(/Publicamos|Confirmación/);
			expect(texts().slice(-4)).toEqual(["Respuesta P tres, R uno.", "Uno.", "Respuesta P cuatro, R uno.", "Dos."]);

			// One playing is stopped when answered, by ui_prompt_end or by its tool's end; the next waiting one then plays.
			writeFileSync(log("hold-3"), "");
			writeFileSync(log("hold-5"), "");
			ask(reader, "c2", "ask_user_question", twoQuestions);
			await waitFor(() => existsSync(log("play-3.pid")));
			await reader.turn([user("c"), assistant("Tres.")]);
			reader.event("tool_execution_end", { toolCallId: "c2", toolName: "ask_user_question", result: {}, isError: false });
			await waitFor(() => !alive(pid(3)));
			await waitFor(() => existsSync(log("play-4.audio")));
			ask(reader, "b2", "bash", { command: "git push" });
			prompt(reader, "confirm", "Allow push?");
			await waitFor(() => existsSync(log("play-5.pid")) && texts().at(-1) === "Confirmación de comando: git.");
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			await waitFor(() => !alive(pid(5)));
			await ended(reader, 6);
			await wait();
			expect(texts()).toContain("Tres.");
			expect(existsSync(log("play-3.audio"))).toBe(false);
			expect(existsSync(log("play-5.audio"))).toBe(false);
			expect(existsSync(log("play-6.pid"))).toBe(false);
			expect(reader.notes).toEqual([["Auto-read on: full replies.", "info"]]);
		});

		it("with auto-read off nothing of this plays; questions mode reads prompts too", async () => {
			installVoice();
			const reader = load();
			ask(reader, "c1", "ask_user_choice", { question: "¿Publicamos?", options: [{ label: "Sí" }] });
			prompt(reader, "select", "¿Publicamos?");
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			reader.event("tool_execution_end", { toolCallId: "c1", toolName: "ask_user_choice", result: {}, isError: false });
			ask(reader, "b1", "bash", { command: "git push" });
			prompt(reader, "confirm", "Allow push?");
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			prompt(reader, "select", "¿Revisar con RDD?");
			reader.event("ui_prompt_end", { reason: "ui_prompt" });
			await pause();
			expect(synthesized).toEqual([]);
			expect(reader.statuses).toEqual([]);

			await reader.run("read-auto", "questions");
			ask(reader, "c2", "ask_user_choice", { question: "¿Publicamos?", options: [{ label: "Sí" }] });
			await reader.settled();
			expect(texts()).toEqual(["Pregunta: ¿Publicamos?", "Opciones: uno, Sí."]);
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
			expect(texts()).toEqual(["uno: Instalación.", "Paso uno.", "Detalle.", "Sub."]);
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
			const rest = ["uno: Instalación.", "Paso uno.", "Uso del lector.", "Paso dos."];
			expect(texts()).toEqual([...rest, ...rest, "uno: Instalación.", "Paso uno."]);
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

	it("(S13) the session's end kills a player that ignores SIGTERM", { timeout: 10000 }, async () => {
		installVoice("trap '' TERM; exec sleep 600;");
		const reader = load();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-0.pid")) && read("play-0.pid").trim() !== "");
		const player = Number(read("play-0.pid"));
		reader.shutdown();
		try {
			await waitFor(() => !alive(player), 4000);
		} finally {
			try {
				process.kill(player, "SIGKILL");
			} catch {}
		}
		expect(reader.notes).toEqual([]);
	});

	it("(S13) a hung player is ended after the timeout, with the timed-out error", { timeout: 15000 }, async () => {
		installVoice("trap '' TERM; exec sleep 600;");
		env.REPLY_READER_PLAYER_TIMEOUT = "5";
		const reader = load();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-0.pid")) && read("play-0.pid").trim() !== "");
		const player = Number(read("play-0.pid"));
		try {
			await waitFor(() => reader.notes.length > 0, 10000);
			expect(alive(player)).toBe(false);
		} finally {
			try {
				process.kill(player, "SIGKILL");
			} catch {}
		}
		expect(reader.notes).toEqual([['Playback on "local" failed: timed out', "error"]]);
	});

	for (const how of ["Esc", "/read-stop"] as const) {
		it(`(S13 b) ${how} kills a player that ignores SIGTERM, 2 s after the SIGTERM`, { timeout: 10000 }, async () => {
			installVoice("trap '' TERM; exec sleep 600;");
			const reader = load();
			await reader.run("read");
			await waitFor(() => existsSync(log("play-0.pid")) && read("play-0.pid").trim() !== "");
			const player = Number(read("play-0.pid"));
			try {
				if (how === "Esc") expect(reader.key("\x1b")).toEqual({ consume: true });
				else await reader.run("read-stop");
				await new Promise((done) => setTimeout(done, 1500));
				expect(alive(player)).toBe(true);
				await waitFor(() => !alive(player), 2000);
			} finally {
				try {
					process.kill(player, "SIGKILL");
				} catch {}
			}
		});
	}

	it("(S13 h) a session start ends a player whose reader is gone, without any reading", { timeout: 10000 }, async () => {
		const gone = execFileSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).trim();
		const orphan = spawn("/bin/sh", ["-c", "while :; do sleep 0.1; done", "paplay", "--client-name=pi-reply-reader"], {
			stdio: "ignore",
			env: { PATH: "/usr/bin:/bin", PI_REPLY_READER_OWNER: `${gone}:` },
		});
		const ended = new Promise((done) => orphan.on("exit", (_code, signal) => done(signal)));
		try {
			await new Promise((done) => setTimeout(done, 200));
			const reader = load();
			expect(await Promise.race([ended, new Promise((done) => setTimeout(() => done("still running"), 1000))])).toBe("SIGTERM");
			expect(reader.notes).toEqual([]);
		} finally {
			orphan.kill("SIGKILL");
		}
	});

	it("(S13 f) an invalid REPLY_READER_PLAYER_TIMEOUT warns once per process and readings still play", async () => {
		installVoice();
		env.REPLY_READER_PLAYER_TIMEOUT = "abc";
		const reader = load();
		await reader.run("read");
		await reader.settled();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-1.audio")));
		await reader.settled();
		const again = load();
		await again.run("read");
		await waitFor(() => existsSync(log("play-2.audio")));
		await again.settled();
		expect(reader.notes).toEqual([["REPLY_READER_PLAYER_TIMEOUT must be a number of seconds from 5 to 86400; using 15.", "warning"]]);
		expect(again.notes).toEqual([]);
		expect(read("play-0.audio").length).toBeGreaterThan(0);
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
