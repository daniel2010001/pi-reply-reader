import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Output } from "../src/outputs.ts";
import { type SherpaRequest, type SherpaTts, startReading } from "../src/playback.ts";
import { SPEAKERS, type Voice } from "../src/voice.ts";

let root: string;
let env: NodeJS.ProcessEnv;
const local: Output = { name: "local", label: "local (hs-node)" };
const desktop: Output = { name: "desktop", label: "desktop (tcp:192.168.1.22:4713)", pulseServer: "tcp:192.168.1.22:4713" };
const male = SPEAKERS.male;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reply-reader-playback-"));
	mkdirSync(join(root, "bin"));
	env = { PATH: join(root, "bin"), HOME: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const log = (name: string) => join(root, name);
const read = (name: string) => readFileSync(log(name), "utf8");

function script(name: string, body: string): string {
	const path = join(root, "bin", name);
	// The fake finds cat and sleep itself; the PATH under test holds only the fakes.
	writeFileSync(path, `#!/bin/sh\nPATH=/usr/bin:/bin\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** A paplay that records its arguments, PULSE_SERVER and the audio it receives. */
function fakePaplay(extra = ""): void {
	script(
		"paplay",
		`echo "$@" > "${log("paplay.args")}"; echo "\${PULSE_SERVER-unset}" > "${log("paplay.server")}"; echo $$ > "${log("paplay.pid")}"; ${extra} cat > "${log("paplay.audio")}"`,
	);
}

/** A paplay that never reads its input, like one stuck connecting to a slow server. */
function stuckPaplay(): void {
	script("paplay", `echo $$ > "${log("paplay.pid")}"; exec sleep 30`);
}

const voice: Voice = {
	supertonic: {
		durationPredictor: "/v/duration_predictor.int8.onnx",
		textEncoder: "/v/text_encoder.int8.onnx",
		vectorEstimator: "/v/vector_estimator.int8.onnx",
		vocoder: "/v/vocoder.int8.onnx",
		ttsJson: "/v/tts.json",
		unicodeIndexer: "/v/unicode_indexer.bin",
		voiceStyle: "/v/voice.bin",
	},
};

/** An engine that answers each segment with `samples(text)` and records every request. */
function fakeSherpa(samples: (text: string) => Float32Array, seen: SherpaRequest[] = []): () => Promise<SherpaTts> {
	return async () => ({
		sampleRate: 44100,
		async generateAsync(request) {
			seen.push(request);
			return { samples: samples(request.text) };
		},
	});
}

function pcm(name: string): number[] {
	const audio = readFileSync(log(name));
	return [...new Int16Array(audio.buffer, audio.byteOffset, audio.length / 2)];
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("startReading with Supertonic 3", () => {
	it("synthesizes sentence by sentence, in order, skipping empty segments", async () => {
		fakePaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array([0]), seen);
		const text = "Hola, mundo. ¿Qué tal?  Bien!\n\nSigue: uno; dos… tres\n \n";
		await startReading({ voice, speaker: male, text, output: local, env, loadSherpa }).done;
		expect(seen.map((request) => request.text)).toEqual(["Hola, mundo.", "¿Qué tal?", "Bien!", "Sigue:", "uno;", "dos…", "tres"]);
	});

	it("asks for the chosen speaker at speed 1, 8 steps, Spanish and a fixed seed", async () => {
		fakePaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array([0]), seen);
		await startReading({ voice, speaker: male, text: "Uno. Dos.", output: local, env, loadSherpa }).done;
		await startReading({ voice, speaker: SPEAKERS.female, text: "Uno.", output: local, env, loadSherpa }).done;
		const config = { speed: 1, numSteps: 8, extra: { lang: "es", seed: 42 } };
		expect(seen.map((request) => request.generationConfig)).toEqual([
			{ sid: 6, ...config },
			{ sid: 6, ...config },
			{ sid: 0, ...config },
		]);
	});

	it("plays every segment's audio in order as 16-bit PCM at the engine's rate", async () => {
		fakePaplay();
		const quiet: Record<string, number[]> = { "Uno.": [0, 0.1], "Dos.": [-0.2, 0.05] };
		const loadSherpa = fakeSherpa((text) => new Float32Array(quiet[text]));
		await startReading({ voice, speaker: SPEAKERS.female, text: "Uno. Dos.", output: local, env, loadSherpa }).done;
		expect(read("paplay.args").trim()).toBe(
			"--raw --format=s16le --rate=44100 --channels=1 --client-name=pi-reply-reader --stream-name=reply",
		);
		// One fixed gain for the whole reading, so quiet and louder sentences keep their balance.
		const g = SPEAKERS.female.gain * 32767;
		expect(pcm("paplay.audio")).toEqual([0, Math.round(0.1 * g), Math.round(-0.2 * g), Math.round(0.05 * g)]);
	});

	it("limits loud peaks softly below -1 dBFS, keeping their sign and order", async () => {
		fakePaplay();
		const input = [0.3, 0.45, 0.6, 1, 2, -0.6, -2, -100];
		const loadSherpa = fakeSherpa(() => new Float32Array(input));
		await startReading({ voice, speaker: male, text: "a", output: local, env, loadSherpa }).done;
		const out = pcm("paplay.audio");
		const ceiling = 10 ** (-1 / 20) * 32767;
		for (const sample of out) expect(Math.abs(sample)).toBeLessThanOrEqual(ceiling);
		expect(out.map(Math.sign)).toEqual(input.map(Math.sign));
		const positive = out.slice(0, 5);
		expect(positive).toEqual([...positive].sort((a, b) => a - b));
		expect(new Set(positive).size).toBe(5);
		// Soft, not hard: a sample above the ceiling is not simply cut to it.
		expect(out[3]).toBeLessThan(out[4]);
		expect(out[5]).toBe(-out[2]);
		expect(out[6]).toBeLessThan(out[5]);
	});

	it("keeps silence silent", async () => {
		fakePaplay();
		const loadSherpa = fakeSherpa(() => new Float32Array(100));
		await startReading({ voice, speaker: male, text: "a", output: local, env, loadSherpa }).done;
		expect(pcm("paplay.audio")).toEqual(new Array(100).fill(0));
	});

	it("leaves PULSE_SERVER alone for local and sets it for a named output", async () => {
		fakePaplay();
		const loadSherpa = fakeSherpa(() => new Float32Array([0]));
		await startReading({ voice, speaker: male, text: "a", output: local, env, loadSherpa }).done;
		expect(read("paplay.server").trim()).toBe("unset");
		await startReading({ voice, speaker: male, text: "a", output: desktop, env, loadSherpa }).done;
		expect(read("paplay.server").trim()).toBe("tcp:192.168.1.22:4713");
	});

	it("waits for the player to take the audio before synthesizing the next segment", async () => {
		stuckPaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array(500_000), seen);
		const reading = startReading({ voice, speaker: male, text: "Uno. Dos. Tres. Cuatro.", output: local, env, loadSherpa });
		await waitFor(() => existsSync(log("paplay.pid")) && seen.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(seen).toHaveLength(1);
		reading.stop();
		await expect(reading.done).resolves.toBeUndefined();
		await waitFor(() => !alive(Number(read("paplay.pid"))));
	});

	it("stops between segments, kills the player and settles quietly", async () => {
		fakePaplay("sleep 30;");
		const seen: string[] = [];
		let reading: ReturnType<typeof startReading>;
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 44100,
			async generateAsync(request) {
				seen.push(request.text);
				await waitFor(() => existsSync(log("paplay.pid")));
				reading.stop();
				return { samples: new Float32Array([0]) };
			},
		});
		reading = startReading({ voice, speaker: male, text: "Uno. Dos. Tres.", output: local, env, loadSherpa });
		await expect(reading.done).resolves.toBeUndefined();
		expect(seen).toEqual(["Uno."]);
		await waitFor(() => !alive(Number(read("paplay.pid"))));
	});

	// Pi runs on Bun, where sherpa's generateAsync without a progress callback fails with "Invalid argument".
	it("always passes a progress callback, which asks sherpa to stop once the reading is stopped", async () => {
		fakePaplay("sleep 30;");
		const seen: unknown[] = [];
		let reading: ReturnType<typeof startReading>;
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 44100,
			async generateAsync(request) {
				seen.push(request.onProgress({ samples: new Float32Array([0]), progress: 0.5 }));
				await waitFor(() => existsSync(log("paplay.pid")));
				reading.stop();
				seen.push(request.onProgress({ samples: new Float32Array([0]), progress: 1 }));
				return { samples: new Float32Array([0]) };
			},
		});
		reading = startReading({ voice, speaker: male, text: "Uno.", output: local, env, loadSherpa });
		await expect(reading.done).resolves.toBeUndefined();
		expect(seen).toEqual([true, false]);
	});

	it("reports a voice that cannot be loaded", async () => {
		fakePaplay();
		const loadSherpa = async () => {
			throw new Error("model not found");
		};
		await expect(startReading({ voice, speaker: male, text: "a", output: local, env, loadSherpa }).done).rejects.toThrow(
			"Speech synthesis failed: model not found",
		);
	});

	it("reports a segment that fails to synthesize and stops the player", async () => {
		fakePaplay("sleep 30;");
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 44100,
			async generateAsync(request) {
				if (request.text !== "Dos.") return { samples: new Float32Array([0]) };
				await waitFor(() => existsSync(log("paplay.pid")));
				throw new Error("bad input");
			},
		});
		await expect(
			startReading({ voice, speaker: male, text: "Uno. Dos.", output: local, env, loadSherpa }).done,
		).rejects.toThrow("Speech synthesis failed: bad input");
		await waitFor(() => !alive(Number(read("paplay.pid"))));
	});
});

describe("startReading without a working player", () => {
	it("explains where paplay comes from when it is missing, before loading the voice", async () => {
		let loads = 0;
		const loadSherpa = async () => (loads++, fakeSherpa(() => new Float32Array([0]))());
		await expect(startReading({ voice, speaker: male, text: "a", output: local, env, loadSherpa }).done).rejects.toThrow(
			"Cannot play: paplay was not found on PATH (it comes with libpulse on Arch, pulseaudio-utils on Debian and Ubuntu).",
		);
		expect(loads).toBe(0);
	});

	it("ignores relative PATH entries when looking for paplay", async () => {
		fakePaplay();
		env.PATH = relative(process.cwd(), join(root, "bin"));
		const loadSherpa = fakeSherpa(() => new Float32Array([0]));
		await expect(startReading({ voice, speaker: male, text: "a", output: local, env, loadSherpa }).done).rejects.toThrow(
			/^Cannot play: paplay was not found on PATH/,
		);
	});

	it("names the output and paplay's last error line when playback fails", async () => {
		script("paplay", 'cat > /dev/null; echo "Connection failure: Connection refused" >&2; exit 1');
		const loadSherpa = fakeSherpa(() => new Float32Array([0]));
		await expect(startReading({ voice, speaker: male, text: "a", output: desktop, env, loadSherpa }).done).rejects.toThrow(
			'Playback on "desktop" failed: Connection failure: Connection refused',
		);
	});

	it("names the output and stops synthesizing when paplay dies before reading any audio", async () => {
		script("paplay", 'echo "Connection refused" >&2; exit 1');
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array(500_000), seen);
		const text = Array.from({ length: 50 }, (_, i) => `Frase ${i}.`).join(" ");
		await expect(startReading({ voice, speaker: male, text, output: desktop, env, loadSherpa }).done).rejects.toThrow(
			'Playback on "desktop" failed: Connection refused',
		);
		expect(seen.length).toBeLessThan(50);
	});
});

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
