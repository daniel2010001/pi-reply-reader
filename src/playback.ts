import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Output } from "./outputs.ts";
import { OWNER_VAR, ownerTag, PLAYER_MARK, playerTimeout, reapOrphans, terminate, track, withDeathSignal } from "./player.ts";
import { DEFAULT_SPEED } from "./settings.ts";
import type { Boundary, Fragment } from "./speech-text.ts";
import { onPath, type Speaker, type Voice } from "./voice.ts";

/** What one segment asks of Supertonic; the real loader wraps `generationConfig` in sherpa's GenerationConfig. */
export interface SherpaRequest {
	text: string;
	generationConfig: { sid: number; speed: number; numSteps: number; extra: { lang: string; seed: number } };
	/**
	 * Called with each synthesized chunk; returning false stops the generation. Always passed: on Bun,
	 * which runs Pi, sherpa's generateAsync without it fails with "Invalid argument".
	 */
	onProgress: (info: { samples: Float32Array; progress: number }) => boolean;
}

/** The slice of sherpa-onnx-node's OfflineTts a reading uses. */
export interface SherpaTts {
	sampleRate: number;
	generateAsync(request: SherpaRequest): Promise<{ samples: Float32Array }>;
}

export interface Reading {
	/** Settles when the audio ends or the reading is stopped; rejects with a message for the user. */
	readonly done: Promise<void>;
	stop(): void;
}

const PAPLAY_MISSING =
	"Cannot play: paplay was not found on PATH (it comes with libpulse on Arch, pulseaudio-utils on Debian and Ubuntu).";

/** Supertonic's default seed is random; a fixed one makes the same text always sound the same. */
const SEED = 42;

/**
 * Speaks `fragments` (from `speechNarration`, or `spokenFragments` for plain text) with `speaker` at `speed` (Supertonic's voice speed, 1.1 by default; our pauses do not
 * change with it) on `output`. Supertonic synthesizes one sentence at a time, so the first
 * audio comes after one sentence instead of the whole reply, and the next sentence is synthesized while the
 * current one plays (at most LOOKAHEAD wait for the player); each sentence loses its own leading and
 * trailing silence and is followed right away by our pause for its boundary, then goes to `paplay` as raw 16-bit
 * mono PCM, on this machine's default sink or, for a named output, on its PULSE_SERVER. Nothing here
 * throws: every failure ends in `done`, and `stop()` ends the player and settles `done` quietly.
 *
 * A player that hangs (S13), such as paplay waiting forever on a Pulse server behind a broken SSH tunnel, is ended:
 * when it takes no audio for the player timeout (REPLY_READER_PLAYER_TIMEOUT seconds in `env`, 15 by default) while
 * audio waits for it, or does not end within the audio's length plus that timeout once it has all of it, it is killed
 * and `done` rejects with `Playback on "<output>" failed: timed out` (a player that had already exited by then is
 * not). Every kill is SIGTERM, then SIGKILL two seconds later; a player left by a reader that died is ended when the
 * next reading starts, and this process's player dies with it (through `setpriv --pdeathsig KILL` when available, so
 * even a reader killed outright takes it along).
 */
export function startReading(options: {
	voice: Voice;
	speaker: Speaker;
	/** Spoken in order, each followed by the pause for its own boundary; their text is never split again. */
	fragments: readonly Fragment[];
	output: Output;
	env: NodeJS.ProcessEnv;
	loadSherpa?: (voice: Voice) => Promise<SherpaTts>;
	speed?: number;
	/** Told the player's pid once it starts, so another session can stop this reading (T21). */
	onPlayer?: (pid: number) => void;
	/**
	 * The player timeout of S13 in milliseconds; REPLY_READER_PLAYER_TIMEOUT in `env` (or 15 s) when not given. Callers
	 * pass playerTimeoutMs(env, warn), which also warns about an invalid value.
	 */
	timeoutMs?: number;
}): Reading {
	const { voice, speaker, fragments: list, output, env, loadSherpa = loadSherpaTts, speed = DEFAULT_SPEED, onPlayer } = options;
	let player: ChildProcess | undefined;
	let stopped = false;
	/** Set by the watchdog (S13): the player took no audio, or did not end, in time. */
	let timedOut = false;
	/** Set when the deadline passed after the player exited (S13 g): it settles on its exit, not on its pipes. */
	let overdue = false;
	/** Settles `done` from the player's exit status once it exited; set by `finished`. */
	let settleExited: (() => void) | undefined;

	const run = async (): Promise<void> => {
		const paplay = onPath("paplay", env);
		if (!paplay) throw new Error(PAPLAY_MISSING);

		let tts: SherpaTts;
		try {
			tts = await loadSherpa(voice);
		} catch (error) {
			throw new Error(`Speech synthesis failed: ${(error as Error).message}`);
		}
		if (stopped) return;

		const playerEnv = { ...env, ...(output.pulseServer ? { PULSE_SERVER: output.pulseServer } : {}), [OWNER_VAR]: ownerTag() };
		const args = ["--raw", "--format=s16le", `--rate=${tts.sampleRate}`, "--channels=1", PLAYER_MARK, "--stream-name=reply"];
		// Players left playing or hung by a reader that died (S13) go before this one starts.
		reapOrphans();
		// Through setpriv, the player gets SIGKILL when this process dies however it dies (S13 h).
		const [command, commandArgs] = withDeathSignal(onPath("setpriv", env), paplay, args);
		const child = spawn(command, commandArgs, { env: playerEnv, stdio: ["pipe", "ignore", "pipe"] });
		player = child;
		track(child);
		// A player that quits early closes its stdin; writing to it must not crash Pi.
		child.stdin?.on("error", () => {});
		const playback = finished(child, `Playback on "${output.name}" failed`);
		if (child.pid !== undefined) onPlayer?.(child.pid);
		let playerGone = false;
		const gone = playback.then(
			() => {},
			() => {},
		);
		gone.then(() => (playerGone = true));
		// A player that exited takes nothing more, even before its pipes close.
		child.once("exit", () => (playerGone = true));

		// The watchdog (S13): armed while a chunk waits for the player, and once all audio is handed over.
		const timeout = options.timeoutMs ?? playerTimeout(env).ms;
		let watchdog: NodeJS.Timeout | undefined;
		const arm = (ms: number): void => {
			clearTimeout(watchdog);
			// setTimeout takes at most 2^31-1 ms (about 24.8 days); a longer wait would fire at once.
			watchdog = setTimeout(() => {
				if (stopped) return;
				// A player that already exited is not hung (S13 g): settle on how it exited, without waiting for pipes a
				// process it left behind may still hold.
				if (exited(child)) {
					overdue = true;
					settleExited?.();
					return;
				}
				timedOut = true;
				playerGone = true;
				terminate(child);
				taken?.();
			}, Math.min(ms, MAX_TIMER_MS));
		};
		gone.then(() => clearTimeout(watchdog));

		// Fragments handed over that the pipe has not taken whole yet. Each fragment goes in CHUNK-byte writes, one at a
		// time, so the watchdog sees a player that keeps taking a long fragment as alive.
		let queued = 0;
		let taken: (() => void) | undefined;
		const backlog: { chunk: Buffer; last: boolean }[] = [];
		let writing = false;
		let ending = false;
		let samplesSent = 0;
		const pump = (): void => {
			if (writing) return;
			if (playerGone) backlog.length = 0;
			const next = backlog.shift();
			if (!next) {
				if (ending) {
					ending = false;
					child.stdin?.end();
					// The player has all the audio: it must end within the audio's length plus the timeout.
					if (!playerGone) arm(Math.round((samplesSent / tts.sampleRate) * 1000) + timeout);
				}
				return;
			}
			writing = true;
			arm(timeout);
			child.stdin?.write(next.chunk, (error) => {
				writing = false;
				clearTimeout(watchdog);
				// A write that fails means the player closed its input: it will take nothing more.
				if (error) playerGone = true;
				if (next.last) {
					queued--;
					taken?.();
				}
				pump();
			});
		};
		const send = (audio: Float32Array): void => {
			queued++;
			samplesSent += audio.length;
			const bytes = pcm16(audio, speaker.gain);
			for (let at = 0; at < bytes.length; at += CHUNK) {
				backlog.push({ chunk: bytes.subarray(at, at + CHUNK), last: at + CHUNK >= bytes.length });
			}
			pump();
		};
		const close = (): void => {
			ending = true;
			pump();
		};

		// Samples of pause already written after the last audible fragment; undefined before the first one.
		let paused: number | undefined;
		for (const [index, fragment] of list.entries()) {
			// Synthesize ahead, but stop while LOOKAHEAD fragments still wait for the player to take them.
			while (queued >= LOOKAHEAD && !stopped && !playerGone) {
				await Promise.race([new Promise<void>((resolve) => (taken = resolve)), gone]);
			}
			if (stopped || playerGone) break;
			let samples: Float32Array;
			try {
				({ samples } = await tts.generateAsync({
					text: fragment.text,
					generationConfig: { sid: speaker.sid, speed, numSteps: 8, extra: { lang: "es", seed: SEED } },
					onProgress: () => !stopped && !playerGone,
				}));
			} catch (error) {
				if (stopped || playerGone) break;
				throw new Error(`Speech synthesis failed: ${(error as Error).message}`);
			}
			if (stopped || playerGone) break;
			const speech = trimSilence(samples, speaker.gain, tts.sampleRate);
			// The last fragment's pause is never written.
			const after = index === list.length - 1 ? 0 : Math.round(PAUSES[fragment.after] * tts.sampleRate);
			// A silent fragment is dropped, but a stronger boundary it ends still counts: top up the pause written.
			if (!speech) {
				if (paused !== undefined && after > paused) {
					send(new Float32Array(after - paused));
					paused = after;
				}
				continue;
			}
			// Each pause goes right after its own fragment, so the next synthesis overlaps it too.
			send(after ? concat(speech, new Float32Array(after)) : speech);
			paused = after;
		}
		close();
		await playback;
	};

	const done = run().then(
		() => undefined,
		(error: Error) => {
			if (player) terminate(player);
			if (!stopped) throw error;
		},
	);
	return {
		done,
		stop() {
			stopped = true;
			if (player) terminate(player);
		},
	};

	/** Resolves when `child` exits cleanly or was stopped; rejects with `prefix` and its last error line. */
	function finished(child: ChildProcess, prefix: string): Promise<void> {
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4096)));
		return new Promise((resolve, reject) => {
			const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
				if (stopped) return resolve();
				if (timedOut) return reject(new Error(`${prefix}: timed out`));
				if (code === 0) return resolve();
				const last = stderr.trim().split("\n").at(-1)?.trim();
				reject(new Error(`${prefix}: ${last || (signal ? `killed by ${signal}` : `exit code ${code}`)}`));
			};
			settleExited = () => {
				if (child.exitCode !== null || child.signalCode !== null) settle(child.exitCode, child.signalCode);
			};
			child.on("error", (error) => reject(new Error(`${prefix}: ${error.message}`)));
			// After stop, a timeout or a passed deadline, do not wait for pipes a grandchild may still hold open.
			child.on("exit", (code, signal) => {
				if (stopped || timedOut || overdue) settle(code, signal);
			});
			child.on("close", settle);
		});
	}
}

/** The longest delay setTimeout takes; a longer one fires at once with a TimeoutOverflowWarning. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Whether `child` already exited: its exit was seen, or it is a zombie whose exit event has not come yet (the deadline
 * and the exit can land in the same turn of the event loop).
 */
function exited(child: ChildProcess): boolean {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	try {
		const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
	} catch {
		return false;
	}
}

/** Bytes per write to the player: about 0.37 s of audio at 44.1 kHz, well under a Linux pipe's 64 KiB. */
const CHUNK = 32 * 1024;

/**
 * Synthesized fragments that may wait for the player at once (T26): the one playing and the next one, ready.
 * Synthesis is one call at a time and, under load, slower than real time (L70), so a deeper queue would rarely
 * fill; when it is faster, one ready fragment already hides the next synthesis. Two keeps a long reply out of
 * memory (a fragment is about 0.3-1 MB of PCM) and a stuck player stops synthesis after two fragments.
 */
const LOOKAHEAD = 2;

/**
 * Seconds of silence after a fragment, by what follows it: a sentence on the same line, a line, a blank line
 * (also after a heading or bold-only line). Longer than the voice's own 0.08-0.26 s at `,`, `;` and `:` (L39).
 */
const PAUSES: Record<Boundary, number> = { sentence: 0.35, line: 0.5, paragraph: 0.75 };

/** Windows quieter than this, after the speaker's gain, count as silence (-45 dBFS RMS over 10 ms). */
const SILENCE = 10 ** (-45 / 20);
const WINDOW_SECONDS = 0.01;
/** Kept on each side of the first and last sound, so soft speech edges are not cut. */
const MARGIN_SECONDS = 0.04;

/**
 * Supertonic pads every fragment with about 0.4-0.6 s of silence before and 0.6-0.7 s after (L36);
 * this cuts it to the margin. Undefined when no window is above the threshold.
 */
function trimSilence(samples: Float32Array, gain: number, sampleRate: number): Float32Array | undefined {
	const window = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS));
	let first = -1;
	let last = -1;
	for (let start = 0; start < samples.length; start += window) {
		const end = Math.min(start + window, samples.length);
		let sum = 0;
		for (let i = start; i < end; i++) sum += (samples[i] * gain) ** 2;
		if (Math.sqrt(sum / (end - start)) <= SILENCE) continue;
		if (first < 0) first = start;
		last = end;
	}
	if (first < 0) return undefined;
	const margin = Math.round(sampleRate * MARGIN_SECONDS);
	return samples.subarray(Math.max(0, first - margin), Math.min(samples.length, last + margin));
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
	const out = new Float32Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

/** Samples below this level pass through the limiter unchanged (-6 dBFS). */
const KNEE = 0.5;
/** No sample leaves the limiter above -1 dBFS, rounded down to a whole PCM step so rounding cannot pass it. */
const CEILING = Math.floor(10 ** (-1 / 20) * 32767) / 32767;

/**
 * Float samples to 16-bit little-endian PCM with the speaker's fixed gain. Above the knee a tanh curve
 * bends peaks smoothly toward the ceiling, so they never clip or wrap around.
 */
function pcm16(samples: Float32Array, gain: number): Buffer {
	const out = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) {
		const x = samples[i] * gain;
		const level = Math.abs(x);
		const limited = level <= KNEE ? x : Math.sign(x) * (KNEE + (CEILING - KNEE) * Math.tanh((level - KNEE) / (CEILING - KNEE)));
		out.writeInt16LE(Math.round(limited * 32767), i * 2);
	}
	return out;
}

const loaded = new Map<string, Promise<SherpaTts>>();

/** Loads the model once; loading takes about a second. */
function loadSherpaTts(voice: Voice): Promise<SherpaTts> {
	const key = voice.supertonic.ttsJson;
	let tts = loaded.get(key);
	if (!tts) {
		// sherpa-onnx-node is CommonJS with a native addon.
		// A plain import, not createRequire: Pi's compiled extension loader resolves only imports.
		tts = import("sherpa-onnx-node").then(async (module) => {
			const { OfflineTts, GenerationConfig } = module.default ?? module;
			const engine = await OfflineTts.createAsync({
				model: { supertonic: voice.supertonic, numThreads: 2, provider: "cpu", debug: 0 },
			});
			return {
				sampleRate: engine.sampleRate,
				generateAsync: ({ generationConfig, ...request }: SherpaRequest) =>
					engine.generateAsync({ ...request, generationConfig: new GenerationConfig(generationConfig) }),
			};
		});
		tts.catch(() => loaded.delete(key));
		loaded.set(key, tts);
	}
	return tts;
}
