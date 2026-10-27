import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Output } from "./outputs.ts";
import { onPath, type Voice } from "./voice.ts";

type SherpaVoice = Extract<Voice, { engine: "sherpa" }>;

/** The slice of sherpa-onnx-node's OfflineTts a reading uses. */
export interface SherpaTts {
	sampleRate: number;
	generateAsync(request: {
		text: string;
		sid: number;
		speed: number;
		/** Receives each synthesized chunk; returning false stops the generation. */
		onProgress: (info: { samples: Float32Array; progress: number }) => boolean;
	}): Promise<unknown>;
}

export interface Reading {
	/** Settles when the audio ends or the reading is stopped; rejects with a message for the user. */
	readonly done: Promise<void>;
	stop(): void;
}

const PAPLAY_MISSING =
	"Cannot play: paplay was not found on PATH (it comes with libpulse on Arch, pulseaudio-utils on Debian and Ubuntu).";

/**
 * Speaks `text` with `voice` on `output`. The voice produces raw 16-bit mono PCM that `paplay` plays on
 * this machine's default sink or, for a named output, on its PULSE_SERVER. Nothing here throws: every
 * failure ends in `done`, and `stop()` ends the processes and settles `done` quietly.
 */
export function startReading(options: {
	voice: Voice;
	text: string;
	output: Output;
	env: NodeJS.ProcessEnv;
	loadSherpa?: (voice: SherpaVoice) => Promise<SherpaTts>;
}): Reading {
	const { voice, text, output, env, loadSherpa = loadSherpaTts } = options;
	const children: ChildProcess[] = [];
	let stopped = false;

	const playerFailed = `Playback on "${output.name}" failed`;
	const startPlayer = (bin: string, rate: number): ChildProcess => {
		const playerEnv = output.pulseServer ? { ...env, PULSE_SERVER: output.pulseServer } : env;
		const args = ["--raw", "--format=s16le", `--rate=${rate}`, "--channels=1", "--client-name=pi-reply-reader", "--stream-name=reply"];
		return track(spawn(bin, args, { env: playerEnv, stdio: ["pipe", "ignore", "pipe"] }));
	};
	const track = (child: ChildProcess): ChildProcess => {
		children.push(child);
		// A player that quits early closes its stdin; writing to it must not crash Pi.
		child.stdin?.on("error", () => {});
		return child;
	};

	const run = async (): Promise<void> => {
		const paplay = onPath("paplay", env);
		if (!paplay) throw new Error(PAPLAY_MISSING);

		if (voice.engine === "piper") {
			const rate = sampleRate(voice.config);
			const piper = track(spawn(voice.bin, ["-m", voice.model, "-c", voice.config, "--output-raw"], { env }));
			const player = startPlayer(paplay, rate);
			piper.stdout?.pipe(player.stdin!);
			piper.stdin?.end(text);
			const [engine, playback] = await Promise.allSettled([finished(piper, "piper-tts failed"), finished(player, playerFailed)]);
			if (playback.status === "rejected") throw playback.reason;
			if (engine.status === "rejected") throw engine.reason;
			return;
		}

		let tts: SherpaTts;
		try {
			tts = await loadSherpa(voice);
		} catch (error) {
			throw new Error(`Speech synthesis failed: ${(error as Error).message}`);
		}
		if (stopped) return;
		const player = startPlayer(paplay, tts.sampleRate);
		const playback = finished(player, playerFailed);
		let playerGone = false;
		playback.catch(() => {}).finally(() => (playerGone = true));
		try {
			await tts.generateAsync({
				text,
				sid: 0,
				speed: 1,
				onProgress: ({ samples }) => {
					if (stopped || playerGone) return false;
					player.stdin?.write(pcm16(samples));
					return true;
				},
			});
		} catch (error) {
			if (!stopped && !playerGone) throw new Error(`Speech synthesis failed: ${(error as Error).message}`);
		}
		player.stdin?.end();
		await playback;
	};

	const done = run().then(
		() => undefined,
		(error: Error) => {
			for (const child of children) child.kill();
			if (!stopped) throw error;
		},
	);
	return {
		done,
		stop() {
			stopped = true;
			for (const child of children) child.kill();
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

function sampleRate(config: string): number {
	const rate = (JSON.parse(readFileSync(config, "utf8")) as { audio?: { sample_rate?: unknown } }).audio?.sample_rate;
	if (typeof rate !== "number") throw new Error(`Cannot read audio.sample_rate from ${config}`);
	return rate;
}

/** Float samples in [-1, 1] to 16-bit little-endian PCM, clipping anything outside. */
function pcm16(samples: Float32Array): Buffer {
	const out = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
	return out;
}

const loaded = new Map<string, Promise<SherpaTts>>();

/** Loads the voice once per model; loading takes about a second and a half. */
function loadSherpaTts(voice: SherpaVoice): Promise<SherpaTts> {
	let tts = loaded.get(voice.model);
	if (!tts) {
		// sherpa-onnx-node is CommonJS with a native addon; 2.x dropped espeak-ng, so it stays on 1.13.x.
		// A plain import, not createRequire: Pi's compiled extension loader resolves only imports.
		tts = import("sherpa-onnx-node").then((module) => {
			const { OfflineTts } = module.default ?? module;
			return OfflineTts.createAsync({
				model: { vits: { model: voice.model, tokens: voice.tokens, dataDir: voice.dataDir }, numThreads: 2, provider: "cpu", debug: 0 },
				maxNumSentences: 1,
			}) as Promise<SherpaTts>;
		});
		tts.catch(() => loaded.delete(voice.model));
		loaded.set(voice.model, tts);
	}
	return tts;
}
