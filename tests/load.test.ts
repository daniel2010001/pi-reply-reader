import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import replyReader, { createReplyReader } from "../extensions/reply-reader.ts";
import type { SherpaRequest, SherpaTts } from "../src/playback.ts";
import { speechText } from "../src/speech-text.ts";

let root: string;
let env: NodeJS.ProcessEnv;
let next = 0;
/** Every request the fake engine received, in order. */
let synthesized: SherpaRequest[];

beforeEach(() => {
	synthesized = [];
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
		return { samples: new Float32Array(1).fill(0.125) };
	},
});

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

/** Loads the extension into a recording Pi and returns a driver for its commands, events and UI. */
function load(answers: { select?: string; confirm?: boolean } = {}) {
	const commands = new Map<string, { handler: Handler; getArgumentCompletions?: Handler }>();
	const events = new Map<string, Handler>();
	const pi = {
		registerCommand: (name: string, options: { handler: Handler; getArgumentCompletions?: Handler }) => commands.set(name, options),
		on: (event: string, handler: Handler) => events.set(event, handler),
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
		sessionManager: { getBranch: () => branch },
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
		commands,
		notes,
		selects,
		confirms,
		statuses,
		run: (name: string, args = "") => (commands.get(name)!.handler as (a: string, c: unknown) => Promise<void>)(args, ctx),
		key: (data: string) => input?.(data),
		shutdown: () => (events.get("session_shutdown") as (event: unknown, ctx: unknown) => void)({}, ctx),
		restart: () => (events.get("session_start") as (event: unknown, ctx: unknown) => void)({ reason: "new" }, ctx),
		/** Waits until the reading in progress clears its status line. */
		settled: () => waitFor(() => statuses.length > 0 && statuses.at(-1) === undefined),
	};
}

describe("reply-reader extension", () => {
	it("registers /read and /read-output by default", () => {
		const names: string[] = [];
		replyReader({ registerCommand: (name: string) => names.push(name), on: () => {} } as never);
		expect(names).toEqual(["read", "read-output", "read-voice"]);
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
		configureOutputs({ desktop: "tcp:192.168.1.22:4713" });
		const reader = load({ select: "desktop (tcp:192.168.1.22:4713)" });
		await reader.run("read");
		await reader.settled();
		await reader.run("read");
		await waitFor(() => existsSync(log("play-1.server")));
		expect(reader.selects).toEqual([["Where should readings sound?", ["local (hs-node)", "desktop (tcp:192.168.1.22:4713)"]]]);
		expect(read("play-0.server").trim()).toBe("tcp:192.168.1.22:4713");
		expect(read("play-1.server").trim()).toBe("tcp:192.168.1.22:4713");
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
		writeFileSync(join(root, "config", "pi-reply-reader", "outputs.json"), '{ "desktop": "tcp:192.168.1.22:4713", }');
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
