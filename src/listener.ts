import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Output } from "./outputs.ts";
import { type Reading, type SherpaTts, startReading } from "./playback.ts";
import { OWNER_VAR, ownerTag, PLAYER_MARK, playerTimeout, playerTimeoutMs, reapOrphans, terminate, track, withDeathSignal } from "./player.ts";
import { type Claim, openReadingLock } from "./reading-lock.ts";
import { MAX_SPEED, MIN_SPEED } from "./settings.ts";
import type { Boundary, Fragment } from "./speech-text.ts";
import { findVoice, onPath, SPEAKERS, type SpeakerName, type Voice } from "./voice.ts";

/**
 * Synthesis on the listener (S20). The agent host runs `ssh … <host> reply-reader --serve --client-name=pi-reply-reader`
 * and the two speak JSON lines, one object per line with a `type`:
 *
 * - agent host → listener: `hello {v, voice}`, `fragments {lead, speed, items: [{text, after}]}`, `end`, `stop`.
 * - listener → agent host: `ready {v, version}`, `missing {what: "voice" | "player"}`, `progress {index}` (the fragment
 *   being heard), `beat` (every BEAT_MS), `done`, `stopped` (a reading of the listener's own took its turn),
 *   `error {message}`.
 *
 * Closing the listener's standard input (ssh ended) stops it at once, as `stop` does.
 */
export const PROTOCOL_VERSION = 1;
/** The longest line the listener accepts, and the most fragments in one reading. */
export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_FRAGMENTS = 5000;
/** How often the listener says it is alive, so the agent host's watchdog (S13) only fires on a silent listener. */
const BEAT_MS = 2000;
/** How often the listener checks the fragment heard, and whether a reading of its own took its turn. */
const CHECK_MS = 250;
/** The command that installs the voice on a listener. */
export const DOWNLOAD_COMMAND = "reply-reader --download-voice";
const BOUNDARIES: readonly Boundary[] = ["sentence", "line", "paragraph"];
/** The longest lead silence the listener plays before the first fragment, in seconds. */
const MAX_LEAD_SECONDS = 10;

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
					return fail(`the listener's reply-reader speaks protocol ${String(message.v)}, this one ${PROTOCOL_VERSION} (update both)`);
				}
				send({
					type: "fragments",
					lead: options.leadSilence ?? 0,
					speed: options.speed,
					items: fragments.map((fragment) => ({ text: fragment.text, after: fragment.after })),
				});
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
				return fail(`the listener failed (${String(message.message)})`);
		}
	};

	const run = async (): Promise<void> => {
		// After the caller has the reading in hand: onPlayer may compare it with its own.
		await null;
		if (stopped) return settle();
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
			const detail = stderr.trim().split("\n").at(-1)?.trim();
			if (code === 255) return fail(`the listener did not answer (${detail || "ssh exit code 255"})`);
			if (code === 127) return fail("reply-reader is not installed on the listener");
			fail(`the listener stopped (${detail || (signal ? `killed by ${signal}` : `exit code ${code}`)})`);
		});
		if (started.pid !== undefined) options.onPlayer?.(started.pid);
		createInterface({ input: started.stdout! }).on("line", (line) => {
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
		});
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
 * (`stopped`). Its player is under S13 like any other (startReading). Standard input closing or `stop` ends the
 * reading at once. Writes no file besides the reading lock. Resolves with the exit code; nothing throws.
 */
export async function serve(deps: {
	env: NodeJS.ProcessEnv;
	stdin: AsyncIterable<Buffer | string>;
	write: (text: string) => void;
	warn: (message: string) => void;
	loadSherpa?: (voice: Voice) => Promise<SherpaTts>;
	signal?: AbortSignal;
}): Promise<number> {
	const { env } = deps;
	const send = (message: object): void => deps.write(`${JSON.stringify(message)}\n`);
	const input = lines(deps.stdin)[Symbol.asyncIterator]();
	/** The next message; undefined at the end of input or on `stop`. */
	const next = async (): Promise<Record<string, unknown> | undefined> => {
		for (;;) {
			const { value, done } = await input.next();
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

		const batch = await next();
		if (!batch) return 0;
		if (batch.type !== "fragments" || !Array.isArray(batch.items)) throw new ProtocolError("expected fragments");
		if (batch.items.length > MAX_FRAGMENTS) throw new ProtocolError(`more than ${MAX_FRAGMENTS} fragments`);
		const fragments: Fragment[] = batch.items.map((item: unknown) => {
			const { text, after } = (item ?? {}) as Record<string, unknown>;
			if (typeof text !== "string" || !BOUNDARIES.includes(after as Boundary)) throw new ProtocolError("a fragment needs text and after");
			return { text, role: "paragraph", after: after as Boundary };
		});
		const speed = typeof batch.speed === "number" && batch.speed >= MIN_SPEED && batch.speed <= MAX_SPEED ? batch.speed : undefined;
		const lead = typeof batch.lead === "number" && batch.lead >= 0 ? Math.min(batch.lead, MAX_LEAD_SECONDS) : 0;
		const end = await next();
		if (!end) return 0;
		if (end.type !== "end") throw new ProtocolError(`expected end, got ${String(end.type)}`);

		// From here, the end of input or `stop` (or this process being interrupted) ends the reading at once.
		let quit = false;
		let reading: Reading | undefined;
		const ended = (): void => {
			quit = true;
			reading?.stop();
		};
		deps.signal?.addEventListener("abort", ended, { once: true });
		void (async () => {
			try {
				while (await next());
			} catch {}
			ended();
		})();

		// This machine's own turn (S1): wait while a reading of its own plays; never stop it.
		const lock = openReadingLock(env);
		while (lock && !quit) {
			const taken = lock.claimIfFree(lock.waitingMark());
			if (typeof taken === "object") {
				claim = taken;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, CHECK_MS));
		}
		if (quit) return 0;

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
