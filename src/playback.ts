import { type ChildProcess, spawn } from "node:child_process";
import type { Output } from "./outputs.ts";
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
 * Speaks `text` with `speaker` on `output`. Supertonic synthesizes one sentence at a time, so the first
 * audio comes after one sentence instead of the whole reply; each sentence loses its own leading and
 * trailing silence and is followed by our pause for its boundary, then goes to `paplay` as raw 16-bit
 * mono PCM, on this machine's default sink or, for a named output, on its PULSE_SERVER. Nothing here
 * throws: every failure ends in `done`, and `stop()` ends the player and settles `done` quietly.
 */
export function startReading(options: {
	voice: Voice;
	speaker: Speaker;
	text: string;
	output: Output;
	env: NodeJS.ProcessEnv;
	loadSherpa?: (voice: Voice) => Promise<SherpaTts>;
}): Reading {
	const { voice, speaker, text, output, env, loadSherpa = loadSherpaTts } = options;
	let player: ChildProcess | undefined;
	let stopped = false;

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

		const playerEnv = output.pulseServer ? { ...env, PULSE_SERVER: output.pulseServer } : env;
		const args = ["--raw", "--format=s16le", `--rate=${tts.sampleRate}`, "--channels=1", "--client-name=pi-reply-reader", "--stream-name=reply"];
		const child = spawn(paplay, args, { env: playerEnv, stdio: ["pipe", "ignore", "pipe"] });
		player = child;
		// A player that quits early closes its stdin; writing to it must not crash Pi.
		child.stdin?.on("error", () => {});
		const playback = finished(child, `Playback on "${output.name}" failed`);
		let playerGone = false;
		const gone = playback.then(
			() => {},
			() => {},
		);
		gone.then(() => (playerGone = true));

		// The pause owed to the last fragment played; none before the first, and the last one's is never written.
		let pause: number | undefined;
		for (const fragment of fragments(text)) {
			if (stopped || playerGone) break;
			let samples: Float32Array;
			try {
				({ samples } = await tts.generateAsync({
					text: fragment.text,
					generationConfig: { sid: speaker.sid, speed: 1, numSteps: 8, extra: { lang: "es", seed: SEED } },
					onProgress: () => !stopped && !playerGone,
				}));
			} catch (error) {
				if (stopped || playerGone) break;
				throw new Error(`Speech synthesis failed: ${(error as Error).message}`);
			}
			if (stopped || playerGone) break;
			const speech = trimSilence(samples, speaker.gain, tts.sampleRate);
			const after = Math.round(PAUSES[fragment.boundary] * tts.sampleRate);
			// A silent fragment is dropped, but a stronger boundary it ends still counts.
			if (!speech) {
				if (pause !== undefined) pause = Math.max(pause, after);
				continue;
			}
			const audio = pause === undefined ? speech : concat(new Float32Array(pause), speech);
			pause = after;
			// Wait until the player takes this sentence, so a slow or stuck player does not buffer the whole reply.
			if (!child.stdin?.write(pcm16(audio, speaker.gain))) {
				await Promise.race([new Promise((resolve) => child.stdin?.once("drain", resolve)), gone]);
			}
		}
		child.stdin?.end();
		await playback;
	};

	const done = run().then(
		() => undefined,
		(error: Error) => {
			player?.kill();
			if (!stopped) throw error;
		},
	);
	return {
		done,
		stop() {
			stopped = true;
			player?.kill();
		},
	};

	/** Resolves when `child` exits cleanly or was stopped; rejects with `prefix` and its last error line. */
	function finished(child: ChildProcess, prefix: string): Promise<void> {
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4096)));
		return new Promise((resolve, reject) => {
			child.on("error", (error) => reject(new Error(`${prefix}: ${error.message}`)));
			// After stop, do not wait for pipes a grandchild may still hold open.
			child.on("exit", () => stopped && resolve());
			child.on("close", (code, signal) => {
				if (code === 0 || stopped) return resolve();
				const last = stderr.trim().split("\n").at(-1)?.trim();
				reject(new Error(`${prefix}: ${last || (signal ? `killed by ${signal}` : `exit code ${code}`)}`));
			});
		});
	}
}

type Boundary = "sentence" | "line" | "paragraph";

/**
 * Seconds of silence after a fragment, by what follows it: a sentence on the same line, a line, a blank line
 * (also after a heading or bold-only line). Longer than the voice's own 0.08-0.26 s at `,`, `;` and `:` (L39).
 */
const PAUSES: Record<Boundary, number> = { sentence: 0.35, line: 0.5, paragraph: 0.75 };

/**
 * Sentences and lines, in order, each with the boundary after it; Supertonic only calls back once per
 * 300 characters, so we split first. Never at ":" or ";", where a pause would sound like a full stop.
 */
function fragments(text: string): { text: string; boundary: Boundary }[] {
	const result: { text: string; boundary: Boundary }[] = [];
	let blank = false;
	for (const line of text.split("\n")) {
		const sentences = line
			.split(/(?<=[.!?…])\s+/)
			.map((sentence) => sentence.trim())
			.filter((sentence) => sentence !== "");
		if (sentences.length === 0) {
			blank = true;
			continue;
		}
		const previous = result.at(-1);
		if (previous) previous.boundary = blank ? "paragraph" : "line";
		blank = false;
		for (const sentence of sentences) result.push({ text: sentence, boundary: "sentence" });
	}
	return result;
}

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
