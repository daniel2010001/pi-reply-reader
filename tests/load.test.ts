import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import replyReader, { createReplyReader } from "../extensions/reply-reader.ts";
import { speechText } from "../src/speech-text.ts";

let root: string;
let env: NodeJS.ProcessEnv;
let next = 0;

beforeEach(() => {
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

/** A local piper voice whose engine records the text and a paplay that records each playback. */
function installVoice(piperBody = `cat > "${log("piper.text")}"; printf PCM`): void {
	script("piper-tts", piperBody);
	script(
		"paplay",
		`n=$(ls "${root}" | grep -c '^play-.*\.pid$'); echo "\${PULSE_SERVER-unset}" > "${root}/play-$n.server"; echo $$ > "${root}/play-$n.pid"; cat > "${root}/play-$n.audio"`,
	);
	const models = join(root, "data", "piper-tts", "models");
	mkdirSync(models, { recursive: true });
	writeFileSync(join(models, "es_MX-claude-high.onnx"), "onnx");
	writeFileSync(join(models, "es_MX-claude-high.onnx.json"), JSON.stringify({ audio: { sample_rate: 22050 } }));
}

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
	createReplyReader({ env, hostname: "hs-node" })(pi as never);

	const notes: [string, string | undefined][] = [];
	const selects: [string, string[]][] = [];
	const confirms: string[] = [];
	const statuses: (string | undefined)[] = [];
	let input: ((data: string) => unknown) | undefined;
	const ctx = {
		hasUI: true,
		mode: "tui",
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
		/** Waits until the reading in progress clears its status line. */
		settled: () => waitFor(() => statuses.length > 0 && statuses.at(-1) === undefined),
	};
}

describe("reply-reader extension", () => {
	it("registers /read and /read-output by default", () => {
		const names: string[] = [];
		replyReader({ registerCommand: (name: string) => names.push(name), on: () => {} } as never);
		expect(names).toEqual(["read", "read-output"]);
	});

	it("/read speaks the latest reply, cleaned for speech, and shows then clears its status", async () => {
		installVoice();
		const reader = load();
		await reader.run("read");
		await reader.settled();
		expect(read("piper.text")).toBe(speechText("## Segunda\n\n- `auto_read` listo"));
		expect(read("play-0.audio")).toBe("PCM");
		expect(reader.statuses).toEqual(["Reading P2.R1 on local · Esc stops", undefined]);
		expect(reader.selects).toEqual([]);
	});

	it("/read P1.R1 speaks that reply", async () => {
		installVoice();
		const reader = load();
		await reader.run("read", "p1.r1");
		await reader.settled();
		expect(read("piper.text")).toBe("Primera respuesta.");
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

	it("a new /read stops the one playing", async () => {
		installVoice(`echo $$ > "${log("piper.pid")}"; exec sleep 30`);
		const reader = load();
		await reader.run("read");
		await waitFor(() => existsSync(log("piper.pid")) && existsSync(log("play-0.pid")));
		const first = Number(read("piper.pid"));
		rmSync(log("piper.pid"));
		await reader.run("read", "P1.R1");
		await waitFor(() => !alive(first));
		await waitFor(() => existsSync(log("piper.pid")));
		expect(alive(Number(read("piper.pid")))).toBe(true);
		reader.shutdown();
	});

	it("Esc stops a reading and is consumed only while one plays", async () => {
		installVoice(`echo $$ > "${log("piper.pid")}"; exec sleep 30`);
		const reader = load();
		expect(reader.key("\x1b")).toBeUndefined();
		await reader.run("read");
		await waitFor(() => existsSync(log("piper.pid")));
		expect(reader.key("a")).toBeUndefined();
		expect(reader.key("\x1b")).toEqual({ consume: true });
		await reader.settled();
		await waitFor(() => !alive(Number(read("piper.pid"))));
		expect(reader.key("\x1b")).toBeUndefined();
	});

	it("ending the session stops the reading", async () => {
		installVoice(`echo $$ > "${log("piper.pid")}"; exec sleep 30`);
		const reader = load();
		await reader.run("read");
		await waitFor(() => existsSync(log("piper.pid")));
		reader.shutdown();
		await waitFor(() => !alive(Number(read("piper.pid"))));
	});

	it("offers the download when there is no voice, and reads nothing if declined", async () => {
		script("paplay", "cat > /dev/null");
		const reader = load({ confirm: false });
		await reader.run("read");
		expect(reader.confirms).toEqual([
			`Download the Spanish voice es_MX-claude-high (67 MB) from github.com into ${join(root, "data", "pi-reply-reader", "voices")}?`,
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
