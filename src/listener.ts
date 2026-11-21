import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Output } from "./outputs.ts";
import { type Reading, type SherpaTts, startReading } from "./playback.ts";
import { OWNER_VAR, ownerTag, PLAYER_MARK, playerTimeout, playerTimeoutMs, reapOrphans, terminate, track, withDeathSignal } from "./player.ts";
import { createMusic, holdMusic, LISTENER_HOLD_MS, loadMusic } from "./music.ts";
import { type Claim, openReadingLock } from "./reading-lock.ts";
import { MAX_SPEED, MIN_SPEED } from "./settings.ts";
import type { Boundary, Fragment } from "./speech-text.ts";
import { findVoice, onPath, SPEAKERS, type SpeakerName, type Voice } from "./voice.ts";

/**
 * Synthesis on the listener (S20). The agent host runs `ssh … <host> reply-reader --serve --client-name=pi-reply-reader`
 * and the two speak JSON lines, one object per line with a `type`:
 *
 * - agent host → listener: `hello {v, voice}`, `fragments {lead, speed, items: [{text, after}]}` (one or more, each
 *   within the listener's caps; the listener joins their items and takes lead and speed from the first), `end`, `stop`.
 * - listener → agent host: `ready {v, version}`, `missing {what: "voice" | "player"}`, `progress {index}` (the fragment
 *   being heard), `beat` (every BEAT_MS), `done`, `stopped` (a reading of the listener's own took its turn),
 *   `error {message}`.
 *
 * Closing the listener's standard input (ssh ended) stops it at once, as `stop` does.
 */
export const PROTOCOL_VERSION = 1;
/** The longest line the listener accepts, and the most fragments in one `fragments` message. */
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_FRAGMENTS = 5000;
/** Room left in each `fragments` line for its type, lead, speed and brackets. */
const LINE_OVERHEAD_BYTES = 1024;
/** The longest line the agent host accepts from the listener; a longer one ends the reading there (fallback). */
export const MAX_REPLY_LINE_BYTES = 64 * 1024;
/** The most characters of the listener's own text (an error, ssh's stderr) shown in a warning or failure. */
const MAX_SHOWN = 500;
/** How often the listener says it is alive, so the agent host's watchdog (S13) only fires on a silent listener. */
const BEAT_MS = 2000;
/** How often the listener checks the fragment heard, and whether a reading of its own took its turn. */
const CHECK_MS = 250;
/** The command that installs the voice on a listener. */
export const DOWNLOAD_COMMAND = "reply-reader --download-voice";
const BOUNDARIES: readonly Boundary[] = ["sentence", "line", "paragraph"];
/** The longest lead silence the listener plays before the first fragment, in seconds. */
const MAX_LEAD_SECONDS = 10;

/**
 * Text from the listener or ssh, fit to show (R1-001): control characters (C0, DEL, C1) and Unicode line/paragraph
 * separators removed, trimmed, at most MAX_SHOWN characters.
 */
export function shown(text: string): string {
	const bare = text.replace(/[\p{Cc}\u2028\u2029]/gu, "").trim();
	return bare.length > MAX_SHOWN ? `${bare.slice(0, MAX_SHOWN)}…` : bare;
}

type Item = { text: string; after: Boundary };

/**
 * The items split into `fragments` messages that each fit the listener's caps (S20): at most MAX_FRAGMENTS items and
 * MAX_LINE_BYTES per line, JSON included. Undefined when one fragment alone cannot fit a line.
 */
function batches(fragments: readonly Fragment[]): Item[][] | undefined {
	const room = MAX_LINE_BYTES - LINE_OVERHEAD_BYTES;
	const all: Item[][] = [];
	let batch: Item[] = [];
	let bytes = 0;
	for (const fragment of fragments) {
		const item = { text: fragment.text, after: fragment.after };
		// Its JSON and the comma before it.
		const size = Buffer.byteLength(JSON.stringify(item)) + 1;
		if (size > room) return undefined;
		if (batch.length === MAX_FRAGMENTS || bytes + size > room) {
			all.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(item);
		bytes += size;
	}
	all.push(batch);
	return all;
}

export type ReadingOptions = Parameters<typeof startReading>[0] & {
	/**
	 * Told why a listener output reads on the agent host through its fallback (S20); the caller warns once per session.
	 * `Output "<name>": <reason>; reading here through its fallback.`
	 */
	onFallback?: (message: string) => void;
	/**
	 * Whether a newer reading or /read-stop elsewhere took this reading's turn (S1); a listener that fails then (its ssh
	 * was ended for it) does not go on through the fallback.
	 */
	lost?: () => boolean;
};

/**
 * A reading on `options.output`: as startReading for a local or PULSE_SERVER output; for a listener (S20), sent over
 * SSH to `reply-reader --serve` there, which synthesizes and plays it. The ssh child carries PLAYER_MARK and
 * OWNER_VAR and is reported through `onPlayer`, so stop, another session's /read-stop or newer reading, and the reaping
 * of orphans (S1, S13) end it like a player. The watchdog (S13) runs from the start and is re-armed by every line the
 * listener sends; when it fires, ssh is ended (SIGTERM, then SIGKILL). When the listener cannot read (ssh fails or
 * hangs, reply-reader, its voice or paplay missing, another protocol version, a failure while reading), the reading
 * goes on here from the fragment last heard through the output's fallback; without one, `done` rejects with
 * `Playback on "<output>" failed: <reason>`. `position()` follows the listener's progress (S15: a pause resumes there).
 */
export function startOutputReading(options: ReadingOptions): Reading {
	const { output } = options;
	if (!output.ssh) return startReading(options);
	return startListenerReading(options, output as Output & { ssh: string });
}

function startListenerReading(options: ReadingOptions, output: Output & { ssh: string }): Reading {
	const { env, fragments, speaker } = options;
	const timeout = options.timeoutMs ?? playerTimeout(env).ms;
	let stopped = false;
	let settled = false;
	/** The fragment the listener last said it was in. */
	let heard = 0;
	let fallback: { reading: Reading; from: number } | undefined;
	let child: ChildProcess | undefined;
	let watchdog: NodeJS.Timeout | undefined;
	const messages = batches(fragments);
	let resolveDone!: () => void;
	let rejectDone!: (error: Error) => void;
	const done = new Promise<void>((resolve, reject) => {
		resolveDone = resolve;
		rejectDone = reject;
	});

	const settle = (error?: Error): void => {
		if (settled) return;
		settled = true;
		clearTimeout(watchdog);
		if (child) terminate(child);
		if (error && !stopped) rejectDone(error);
		else resolveDone();
	};

	/** The listener cannot read: on through the fallback from the fragment last heard, or fail with `reason`. */
	const fail = (reason: string, warning = reason): void => {
		if (settled || stopped || fallback) return;
		clearTimeout(watchdog);
		if (child) terminate(child);
		if (!output.fallback || options.lost?.()) return settle(new Error(`Playback on "${output.name}" failed: ${reason}`));
		options.onFallback?.(`Output "${output.name}": ${warning}; reading here through its fallback.`);
		const from = heard;
		const reading = startReading({
			...options,
			fragments: fragments.slice(from),
			output: { name: output.name, label: output.label, pulseServer: output.fallback },
			leadSilence: from === 0 ? options.leadSilence : undefined,
		});
		fallback = { reading, from };
		reading.done.then(
			() => settle(),
			(error: Error) => settle(error),
		);
	};

	const arm = (): void => {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => fail("timed out", "the listener did not answer"), timeout);
	};

	const send = (message: object): void => {
		child?.stdin?.write(`${JSON.stringify(message)}\n`);
	};

	const handle = (message: Record<string, unknown>): void => {
		switch (message.type) {
			case "ready":
				if (message.v !== PROTOCOL_VERSION) {
					return fail(`the listener's reply-reader speaks protocol ${shown(String(message.v))}, this one ${PROTOCOL_VERSION} (update both)`);
				}
				for (const items of messages ?? []) send({ type: "fragments", lead: options.leadSilence ?? 0, speed: options.speed, items });
				send({ type: "end" });
				return;
			case "missing":
				return fail(message.what === "voice" ? `the listener has no voice (install it there with "${DOWNLOAD_COMMAND}")` : "the listener has no paplay");
			case "progress":
				if (typeof message.index === "number" && Number.isInteger(message.index) && message.index >= 0 && message.index < fragments.length) {
					heard = message.index;
				}
				return;
			case "done":
			case "stopped":
				return settle();
			case "error":
				return fail(`the listener failed (${shown(String(message.message))})`);
		}
	};

	const run = async (): Promise<void> => {
		// After the caller has the reading in hand: onPlayer may compare it with its own.
		await null;
		if (stopped) return settle();
		if (!messages) return fail(`a sentence is too long to send to the listener (over ${MAX_LINE_BYTES} bytes)`);
		const ssh = onPath("ssh", env);
		if (!ssh) return fail("ssh was not found on PATH");
		const args = [
			"-o",
			"BatchMode=yes",
			"-o",
			`ConnectTimeout=${Math.max(1, Math.ceil(timeout / 1000))}`,
			"-o",
			"ServerAliveInterval=5",
			"-o",
			"ServerAliveCountMax=2",
			"--",
			output.ssh,
			"reply-reader",
			"--serve",
			PLAYER_MARK,
		];
		// Players (and ssh children) left by a reader that died (S13) go before this one starts.
		reapOrphans();
		const [command, commandArgs] = withDeathSignal(onPath("setpriv", env), ssh, args);
		const started = spawn(command, commandArgs, { env: { ...env, [OWNER_VAR]: ownerTag() }, stdio: ["pipe", "pipe", "pipe"] });
		child = started;
		track(started);
		started.stdin?.on("error", () => {});
		let stderr = "";
		started.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4096)));
		started.on("error", (error) => fail(`ssh failed (${error.message})`));
		started.on("exit", () => {
			if (stopped) settle();
		});
		started.on("close", (code, signal) => {
			if (stopped) return settle();
			const detail = shown(stderr.trim().split("\n").at(-1) ?? "");
			if (code === 255) return fail(`the listener did not answer (${detail || "ssh exit code 255"})`);
			if (code === 127) return fail("reply-reader is not installed on the listener");
			fail(`the listener stopped (${detail || (signal ? `killed by ${signal}` : `exit code ${code}`)})`);
		});
		if (started.pid !== undefined) options.onPlayer?.(started.pid);
		const lines = new LineSplitter(MAX_REPLY_LINE_BYTES);
		started.stdout?.on("data", (chunk: Buffer) => {
			if (settled || fallback || child !== started) return;
			const got = lines.push(chunk);
			if (got === undefined) return fail(`the listener sent a line longer than ${MAX_REPLY_LINE_BYTES} bytes`);
			for (const line of got) receive(line);
		});
		const receive = (line: string): void => {
			if (settled || fallback || child !== started) return;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				// A login banner or other text a shell printed: not the protocol.
				return;
			}
			if (!message || typeof message !== "object") return;
			arm();
			handle(message as Record<string, unknown>);
		};
		arm();
		const name = (Object.keys(SPEAKERS) as SpeakerName[]).find((key) => SPEAKERS[key].sid === speaker.sid) ?? "male";
		send({ type: "hello", v: PROTOCOL_VERSION, voice: name });
	};
	run().catch((error: Error) => fail(error.message));

	return {
		done,
		stop() {
			if (stopped) return;
			stopped = true;
			clearTimeout(watchdog);
			if (fallback) return fallback.reading.stop();
			if (!child || child.exitCode !== null || child.signalCode !== null) return settle();
			send({ type: "stop" });
			terminate(child);
		},
		position() {
			return fallback ? fallback.from + fallback.reading.position() : heard;
		},
	};
}

/** This package's version, for the listener's `ready`; "unknown" when package.json cannot be read. */
function packageVersion(): string {
	for (const up of ["..", join("..", "..")]) {
		try {
			const pkg = JSON.parse(readFileSync(join(import.meta.dirname, up, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
			if (pkg.name === "pi-reply-reader" && typeof pkg.version === "string") return pkg.version;
		} catch {}
	}
	return "unknown";
}

/** Splits chunks into lines; `push` gives undefined once a line grows past `max` bytes without its newline. */
class LineSplitter {
	private pending = Buffer.alloc(0);
	private readonly max: number;
	constructor(max: number) {
		this.max = max;
	}
	push(chunk: Buffer): string[] | undefined {
		this.pending = Buffer.concat([this.pending, chunk]);
		const got: string[] = [];
		for (let at = this.pending.indexOf(10); at !== -1; at = this.pending.indexOf(10)) {
			if (at > this.max) return undefined;
			got.push(this.pending.subarray(0, at).toString("utf8"));
			this.pending = this.pending.subarray(at + 1);
		}
		return this.pending.length > this.max ? undefined : got;
	}
}

/** Splits `input` into lines; throws when one grows past MAX_LINE_BYTES without its newline. */
async function* lines(input: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
	let pending = Buffer.alloc(0);
	for await (const chunk of input) {
		pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
		for (let at = pending.indexOf(10); at !== -1; at = pending.indexOf(10)) {
			if (at > MAX_LINE_BYTES) throw new Error(`a line is longer than ${MAX_LINE_BYTES} bytes`);
			yield pending.subarray(0, at).toString("utf8");
			pending = pending.subarray(at + 1);
		}
		if (pending.length > MAX_LINE_BYTES) throw new Error(`a line is longer than ${MAX_LINE_BYTES} bytes`);
	}
	if (pending.length > 0) yield pending.toString("utf8");
}

class ProtocolError extends Error {}

/**
 * `reply-reader --serve` (S20), on the listener: reads the agent host's lines on `stdin` and answers on `write`. It
 * never downloads (no terminal): without the voice it answers `missing`. It takes this machine's reading turn (S1) the
 * way an auto-read does, waiting while a reading of its own plays, and gives it up when a reading of its own takes it
 * (`stopped`); a remote reading still waiting for its turn is dropped (`stopped`) by an explicit drop of the machine's
 * waiting readings (/read-stop or /read there, S8). Its player is under S13 like any other (startReading); the agent
 * host's OWNER_VAR is never passed on. Standard input closing, `stop` or `signal` (Ctrl+C, the agent host gone) ends
 * the reading at once. Writes no file besides the reading lock. Resolves with the exit code; nothing throws.
 */
export async function serve(deps: {
	env: NodeJS.ProcessEnv;
	stdin: AsyncIterable<Buffer | string>;
	write: (text: string) => void;
	warn: (message: string) => void;
	loadSherpa?: (voice: Voice) => Promise<SherpaTts>;
	signal?: AbortSignal;
}): Promise<number> {
	const env = { ...deps.env };
	// An agent host's owner (ssh SendEnv) means nothing here; this machine's readings set their own (S13).
	delete env[OWNER_VAR];
	const send = (message: object): void => deps.write(`${JSON.stringify(message)}\n`);
	const input = lines(deps.stdin)[Symbol.asyncIterator]();
	// Interrupted (Ctrl+C, the agent host gone): no more input is awaited and the reading, if any, stops.
	let quit = false;
	let reading: Reading | undefined;
	let wake!: () => void;
	const interrupted = new Promise<{ done: true; value: undefined }>((resolve) => (wake = () => resolve({ done: true, value: undefined })));
	const ended = (): void => {
		quit = true;
		wake();
		reading?.stop();
	};
	if (deps.signal?.aborted) ended();
	else deps.signal?.addEventListener("abort", ended, { once: true });
	/** The next message; undefined at the end of input, on `stop`, or once interrupted. */
	const next = async (): Promise<Record<string, unknown> | undefined> => {
		for (;;) {
			if (quit) return undefined;
			const { value, done } = await Promise.race([input.next(), interrupted]);
			if (done) return undefined;
			if (value.trim() === "") continue;
			let message: unknown;
			try {
				message = JSON.parse(value);
			} catch {
				throw new ProtocolError("a line is not JSON");
			}
			if (!message || typeof message !== "object" || Array.isArray(message)) throw new ProtocolError("a line is not a JSON object");
			const typed = message as Record<string, unknown>;
			return typed.type === "stop" ? undefined : typed;
		}
	};
	// The listener's music steps aside while it reads what the agent host sent (S22), with the listener's own settings.
	const lock = openReadingLock(env);
	let musicWarned = false;
	const music = createMusic({
		env,
		settings: () => loadMusic(env).music,
		idle: () => (lock ? !lock.busy() && lock.waitingList().length === 0 : true),
		warn: (message) => {
			if (musicWarned) return;
			musicWarned = true;
			deps.warn(message);
		},
	});
	/** Whether the reading played to its end (`done`): the agent host's next one may follow, so the music stays aside a while. */
	let finished = false;
	/** Whether the music was aside for this reading (this --serve stepped it aside, or kept it so). */
	let aside = false;
	const code = await serveReading();
	// What gentle-stream said is known first: music that turned out not to be playing is no music aside.
	await music.idle();
	// After a reading that ended with the music aside, it stays aside LISTENER_HOLD_MS for the agent host's next one in
	// its line (its input closing, as ssh ends after `done`, does not end the hold); a newer --serve that steps it aside
	// meanwhile keeps it so. Stopped, or nothing aside, it comes back (or the process ends) at once. Interrupted
	// (SIGTERM, SIGINT) during the hold, the hold ends and the music comes back before this process exits.
	if (finished && aside && !deps.signal?.aborted && holdMusic(env, LISTENER_HOLD_MS)) {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, LISTENER_HOLD_MS);
			deps.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
		if (deps.signal?.aborted) holdMusic(env, 0);
	}
	music.settle();
	await music.idle();
	return code;

	async function serveReading(): Promise<number> {
		const beat = setInterval(() => send({ type: "beat" }), BEAT_MS);
		let claim: Claim | undefined;
		let check: NodeJS.Timeout | undefined;
		try {
			const hello = await next();
			if (!hello) return 0;
			if (hello.type !== "hello") throw new ProtocolError(`expected hello, got ${String(hello.type)}`);
			if (!Object.hasOwn(SPEAKERS, String(hello.voice))) throw new ProtocolError(`no voice named "${String(hello.voice)}"`);
			const speaker = SPEAKERS[hello.voice as SpeakerName];
			const voice = findVoice(env);
			if (!voice) {
				send({ type: "missing", what: "voice" });
				return 1;
			}
			if (!onPath("paplay", env)) {
				send({ type: "missing", what: "player" });
				return 1;
			}
			send({ type: "ready", v: PROTOCOL_VERSION, version: packageVersion() });

			// One or more `fragments` messages, each within the caps, then `end`; lead and speed come from the first.
			const first = await next();
			if (!first) return 0;
			const fragments: Fragment[] = [];
			for (let batch: Record<string, unknown> | undefined = first; batch?.type !== "end"; batch = await next()) {
				if (!batch) return 0;
				if (batch.type !== "fragments" || !Array.isArray(batch.items)) {
					throw new ProtocolError(batch === first ? "expected fragments" : `expected fragments or end, got ${String(batch.type)}`);
				}
				if (batch.items.length > MAX_FRAGMENTS) throw new ProtocolError(`more than ${MAX_FRAGMENTS} fragments`);
				for (const item of batch.items as unknown[]) {
					const { text, after } = (item ?? {}) as Record<string, unknown>;
					if (typeof text !== "string" || !BOUNDARIES.includes(after as Boundary)) throw new ProtocolError("a fragment needs text and after");
					fragments.push({ text, role: "paragraph", after: after as Boundary });
				}
			}
			const speed = typeof first.speed === "number" && first.speed >= MIN_SPEED && first.speed <= MAX_SPEED ? first.speed : undefined;
			const lead = typeof first.lead === "number" && first.lead >= 0 ? Math.min(first.lead, MAX_LEAD_SECONDS) : 0;

			// From here, the end of input or `stop` (or this process being interrupted) ends the reading at once.
			void (async () => {
				try {
					while (await next());
				} catch {}
				ended();
			})();

			// This machine's own turn (S1): wait while a reading of its own plays; never stop it. The waiting mark is taken
			// once, so an explicit drop of what waits here (/read-stop, /read, S8) drops this reading too (A6, L157).
			const mark = lock?.waitingMark();
			while (lock && !quit) {
				const taken = lock.claimIfFree(mark);
				if (typeof taken === "object") {
					claim = taken;
					break;
				}
				if (taken === "dropped") {
					send({ type: "stopped" });
					return 0;
				}
				await new Promise((resolve) => setTimeout(resolve, CHECK_MS));
			}
			if (quit) return 0;
			aside = music.stepAside();

			let lost = false;
			const current = startReading({
				voice,
				speaker,
				fragments,
				output: { name: "listener", label: "listener" },
				env,
				loadSherpa: deps.loadSherpa,
				speed,
				leadSilence: lead,
				timeoutMs: playerTimeoutMs(env, deps.warn),
				onPlayer: (pid) => {
					if (claim && !claim.setPlayer(pid)) {
						lost = true;
						current.stop();
					}
				},
			});
			reading = current;
			let told = -1;
			const progress = (): void => {
				const index = current.position();
				if (index !== told) send({ type: "progress", index });
				told = index;
			};
			progress();
			check = setInterval(() => {
				if (claim?.lost()) {
					lost = true;
					current.stop();
				}
				progress();
			}, CHECK_MS);
			try {
				await current.done;
			} catch (error) {
				if (!lost && !claim?.lost() && !quit) throw error;
			}
			if (quit) return 0;
			if (lost || claim?.lost()) {
				send({ type: "stopped" });
				return 0;
			}
			progress();
			send({ type: "done" });
			finished = true;
			return 0;
		} catch (error) {
			send({ type: "error", message: (error as Error).message });
			return 1;
		} finally {
			clearInterval(beat);
			clearInterval(check);
			claim?.release();
		}
	}
}
