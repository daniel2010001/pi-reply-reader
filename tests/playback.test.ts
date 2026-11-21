import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Output } from "../src/outputs.ts";
import { type SherpaRequest, type SherpaTts, startReading } from "../src/playback.ts";
import { speechText, spokenFragments } from "../src/speech-text.ts";
import { playerTimeout, reapOrphans } from "../src/player.ts";
import { PLAYER_MARK } from "../src/reading-lock.ts";
import { SPEAKERS, type Voice } from "../src/voice.ts";

let root: string;
let env: NodeJS.ProcessEnv;
const local: Output = { name: "local", label: "local (hs-node)" };
const desktop: Output = { name: "desktop", label: "desktop (tcp:192.168.1.50:4713)", pulseServer: "tcp:192.168.1.50:4713" };
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

/** `n` samples at `level`; 0.125 is exact in float32 and stays under the limiter's knee for both speakers. */
const tone = (n: number, level = 0.125) => new Array<number>(n).fill(level);
const zeros = (n: number) => tone(n, 0);
/** What `level` becomes in the PCM stream for `speaker`, below the knee. */
const level16 = (level: number, gain = SPEAKERS.female.gain) => Math.round(level * gain * 32767);

/** What the long reading wrote before T26 (pause in front of the next fragment, synthesis after drain). */
const PREVIOUS_LONG_PCM = { bytes: 590058, sha256: "6a4337fb7873f125e37770c1030da17059d9470551e004d6a826300158fd2e6b" };

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("startReading with Supertonic 3", () => {
	it("synthesizes sentence by sentence, in order, skipping empty segments, never splitting at : or ;", async () => {
		fakePaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array([0]), seen);
		const text = "Hola, mundo. ¿Qué tal?  Bien!\n\nSigue: uno; dos… tres\n \n";
		await startReading({ voice, speaker: male, fragments: spokenFragments(text), output: local, env, loadSherpa }).done;
		expect(seen.map((request) => request.text)).toEqual(["Hola, mundo.", "¿Qué tal?", "Bien!", "Sigue: uno; dos…", "tres"]);
	});

	it("asks for the chosen speaker at the default speed 1.1, 8 steps, Spanish and a fixed seed", async () => {
		fakePaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array([0]), seen);
		await startReading({ voice, speaker: male, fragments: spokenFragments("Uno. Dos."), output: local, env, loadSherpa }).done;
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno."), output: local, env, loadSherpa }).done;
		const config = { speed: 1.1, numSteps: 8, extra: { lang: "es", seed: 42 } };
		expect(seen.map((request) => request.generationConfig)).toEqual([
			{ sid: 6, ...config },
			{ sid: 6, ...config },
			{ sid: 0, ...config },
		]);
	});

	it("passes the given speed to Supertonic for every fragment, and only the voice speed changes, not our pauses", async () => {
		fakePaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array([0.125]), seen);
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno. Dos."), output: local, env, loadSherpa, speed: 1.3 }).done;
		expect(seen.map((request) => request.generationConfig)).toEqual([
			{ sid: 0, speed: 1.3, numSteps: 8, extra: { lang: "es", seed: 42 } },
			{ sid: 0, speed: 1.3, numSteps: 8, extra: { lang: "es", seed: 42 } },
		]);
		const v = level16(0.125);
		expect(pcm("paplay.audio")).toEqual([v, ...zeros(15435), v]);
	});

	it("plays every segment's audio in order as 16-bit PCM at the engine's rate", async () => {
		fakePaplay();
		const quiet: Record<string, number[]> = { "Uno.": [0, 0.1], "Dos.": [-0.2, 0.05] };
		const loadSherpa = fakeSherpa((text) => new Float32Array(quiet[text]));
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno. Dos."), output: local, env, loadSherpa }).done;
		expect(read("paplay.args").trim()).toBe(
			"--raw --format=s16le --rate=44100 --channels=1 --client-name=pi-reply-reader --stream-name=reply",
		);
		// One fixed gain for the whole reading, so quiet and louder sentences keep their balance.
		const g = SPEAKERS.female.gain * 32767;
		const sentencePause = new Array(Math.round(44100 * 0.35)).fill(0);
		expect(pcm("paplay.audio")).toEqual([0, Math.round(0.1 * g), ...sentencePause, Math.round(-0.2 * g), Math.round(0.05 * g)]);
	});

	it("limits loud peaks softly below -1 dBFS, keeping their sign and order", async () => {
		fakePaplay();
		const input = [0.3, 0.45, 0.6, 1, 2, -0.6, -2, -100];
		const loadSherpa = fakeSherpa(() => new Float32Array(input));
		await startReading({ voice, speaker: male, fragments: spokenFragments("a"), output: local, env, loadSherpa }).done;
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

	it("keeps silence silent, inside a fragment and in the pauses", async () => {
		fakePaplay();
		const loadSherpa = fakeSherpa(() => new Float32Array([0.125, ...zeros(100), 0.125]));
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno. Dos."), output: local, env, loadSherpa }).done;
		const v = level16(0.125);
		expect(pcm("paplay.audio")).toEqual([v, ...zeros(100), v, ...zeros(15435), v, ...zeros(100), v]);
	});

	it("trims each fragment's leading and trailing silence, keeping a 40 ms margin for soft edges", async () => {
		fakePaplay();
		// One second of silence, 20 ms of soft breath below the threshold, 100 ms of speech, one second of silence.
		const fragment = [...zeros(44100 - 882), ...tone(882, 0.001), ...tone(4410), ...zeros(44100)];
		const loadSherpa = fakeSherpa(() => new Float32Array(fragment));
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno."), output: local, env, loadSherpa }).done;
		const soft = new Array(882).fill(level16(0.001));
		expect(pcm("paplay.audio")).toEqual([...zeros(1764 - 882), ...soft, ...new Array(4410).fill(level16(0.125)), ...zeros(1764)]);
	});

	it("drops a fragment with no sound above the threshold, with its pause", async () => {
		fakePaplay();
		const quiet: Record<string, number[]> = { "Uno.": tone(441), "Dos.": zeros(1000), "Tres.": tone(4410, 0.001), "Cuatro.": tone(441, -0.125) };
		const loadSherpa = fakeSherpa((text) => new Float32Array(quiet[text]));
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno. Dos. Tres. Cuatro."), output: local, env, loadSherpa }).done;
		const v = level16(0.125);
		expect(pcm("paplay.audio")).toEqual([...new Array(441).fill(v), ...zeros(15435), ...new Array(441).fill(-v)]);
	});

	it("pauses 0.35 s between sentences, 0.5 s at a line break and 0.75 s at a blank line, never before the first or after the last", async () => {
		fakePaplay();
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(441)));
		const text = "Título.\n\nUno. Dos.\nTres.\n \nCuatro.\n";
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments(text), output: local, env, loadSherpa }).done;
		const f = new Array(441).fill(level16(0.125));
		const [sentence, line, paragraph] = [zeros(15435), zeros(22050), zeros(33075)];
		expect(pcm("paplay.audio")).toEqual([...f, ...paragraph, ...f, ...sentence, ...f, ...line, ...f, ...paragraph, ...f]);
	});

	it("(S12) plays the fragments it is given with each one's own boundary, without splitting their text again", async () => {
		fakePaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(441)), seen);
		const fragments = [
			{ text: "Uno. Dos.", role: "paragraph", after: "line" },
			{ text: "Tres.", role: "item", after: "paragraph" },
			{ text: "Cuatro.", role: "heading", after: "sentence" },
		] as const;
		await startReading({ voice, speaker: SPEAKERS.female, fragments, output: local, env, loadSherpa }).done;
		expect(seen.map((request) => request.text)).toEqual(["Uno. Dos.", "Tres.", "Cuatro."]);
		const f = new Array(441).fill(level16(0.125));
		expect(pcm("paplay.audio")).toEqual([...f, ...zeros(22050), ...f, ...zeros(33075), ...f]);
	});

	it("(f3) keeps a cleaned line that names punctuation marks in one fragment", async () => {
		fakePaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array([0]), seen);
		const text = speechText("solo en `.`, `!`, `?` y saltos");
		await startReading({ voice, speaker: male, fragments: spokenFragments(text), output: local, env, loadSherpa }).done;
		expect(seen.map((request) => request.text)).toEqual(["solo en punto, signo de exclamación, signo de pregunta y saltos"]);
	});

	it("leaves PULSE_SERVER alone for local and sets it for a named output", async () => {
		fakePaplay();
		const loadSherpa = fakeSherpa(() => new Float32Array([0]));
		await startReading({ voice, speaker: male, fragments: spokenFragments("a"), output: local, env, loadSherpa }).done;
		expect(read("paplay.server").trim()).toBe("unset");
		await startReading({ voice, speaker: male, fragments: spokenFragments("a"), output: desktop, env, loadSherpa }).done;
		expect(read("paplay.server").trim()).toBe("tcp:192.168.1.50:4713");
	});

	it("(T26) synthesizes the next fragment while the current one is still waiting to play, without waiting for the player to drain", async () => {
		stuckPaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(500_000)), seen);
		const reading = startReading({ voice, speaker: male, fragments: spokenFragments("Uno. Dos. Tres."), output: local, env, loadSherpa });
		try {
			// The player has not read a single byte of "Uno.", yet "Dos." is already being synthesized.
			await waitFor(() => seen.length >= 2, 2000);
			expect(seen.map((request) => request.text)).toEqual(["Uno.", "Dos."]);
		} finally {
			reading.stop();
		}
		await expect(reading.done).resolves.toBeUndefined();
		await waitFor(() => !alive(Number(read("paplay.pid"))));
	});

	it("(T26) keeps at most 2 synthesized fragments waiting for a player that does not take them", async () => {
		stuckPaplay();
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(500_000)), seen);
		const text = "Uno. Dos. Tres. Cuatro. Cinco. Seis.";
		const reading = startReading({ voice, speaker: male, fragments: spokenFragments(text), output: local, env, loadSherpa });
		try {
			await waitFor(() => existsSync(log("paplay.pid")) && seen.length >= 2, 2000);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(seen.map((request) => request.text)).toEqual(["Uno.", "Dos."]);
		} finally {
			reading.stop();
		}
		await expect(reading.done).resolves.toBeUndefined();
		await waitFor(() => !alive(Number(read("paplay.pid"))));
		expect(seen).toHaveLength(2);
	});

	it("(T26) writes each pause right after its own fragment, before the next fragment is synthesized", async () => {
		fakePaplay();
		const arrived: number[] = [];
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 44100,
			async generateAsync(request) {
				if (request.text === "Dos.") {
					// "Uno." (441 samples) and its 0.35 s pause must reach the player while "Dos." is synthesized.
					const size = () => (existsSync(log("paplay.audio")) ? readFileSync(log("paplay.audio")).length : 0);
					await waitFor(() => size() >= (441 + 15435) * 2, 1000).catch(() => {});
					arrived.push(size() / 2);
				}
				return { samples: new Float32Array(tone(441)) };
			},
		});
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno. Dos."), output: local, env, loadSherpa }).done;
		expect(arrived).toEqual([441 + 15435]);
		const f = new Array(441).fill(level16(0.125));
		expect(pcm("paplay.audio")).toEqual([...f, ...zeros(15435), ...f]);
	});

	it("(T26) writes the same PCM as before: samples, pause lengths and order, with silent fragments and a stronger boundary", async () => {
		fakePaplay();
		const a = level16(0.125);
		const b = level16(-0.0625);
		const c = level16(0.03125);
		const sounds: Record<string, number[]> = {
			"Cero.": zeros(500),
			"Uno.": [...tone(441), ...tone(100, -0.0625)],
			"Dos.": tone(4410, 0.001),
			"Tres.": tone(300, 0.03125),
			"Cuatro.": [...tone(200, -0.0625), ...zeros(50), ...tone(200)],
			"Cinco.": tone(441, 0.03125),
		};
		const loadSherpa = fakeSherpa((text) => new Float32Array(sounds[text]));
		// Cero is silent and first (no pause before Uno); Dos is silent and ends a paragraph, so Uno's pause is 0.75 s.
		const text = "Cero.\nUno. Dos.\n\nTres. Cuatro.\nCinco.";
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments(text), output: local, env, loadSherpa }).done;
		const fill = (n: number, v: number) => new Array<number>(n).fill(v);
		expect(pcm("paplay.audio")).toEqual([
			...fill(441, a),
			...fill(100, b),
			...zeros(33075),
			...fill(300, c),
			...zeros(15435),
			...fill(200, b),
			...zeros(50),
			...fill(200, a),
			...zeros(22050),
			...fill(441, c),
		]);
	});

	// The one byte difference T26 accepts: the pause is written before the next fragment is synthesized, so it is
	// already sent when every fragment after it turns out silent (before T26 the reading ended with "Uno.").
	it("(T26) keeps the pause already written when only silent fragments follow", async () => {
		fakePaplay();
		const sounds: Record<string, number[]> = { "Uno.": tone(441), "Dos.": zeros(500) };
		const loadSherpa = fakeSherpa((text) => new Float32Array(sounds[text]));
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno. Dos."), output: local, env, loadSherpa }).done;
		expect(pcm("paplay.audio")).toEqual([...new Array(441).fill(level16(0.125)), ...zeros(15435)]);
	});

	it("(T26) writes the same bytes as before for a long reading with loud peaks (sha256 of the previous output)", async () => {
		fakePaplay();
		const loadSherpa = fakeSherpa((text) => {
			// Deterministic speech-like samples per fragment: silence, a varying wave with peaks over the knee, silence.
			let seed = [...text].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
			const body = Array.from({ length: 3000 + (seed % 2000) }, (_, i) => {
				seed = (seed * 1103515245 + 12345) >>> 0;
				return Math.sin(i / 7) * 0.4 + ((seed / 2 ** 32) - 0.5) * 0.8;
			});
			return new Float32Array(text.includes("silencio") ? zeros(2000) : [...zeros(3000), ...body, ...zeros(3000)]);
		});
		const text = speechText(
			"## Estado\n\nPrimera frase. Segunda frase, con coma; y más.\n- Uno\n- Dos: silencio.\n\n**Nota**\nFin del texto? Sí! Tres… cuatro.\n\nÚltima.",
		);
		await startReading({ voice, speaker: male, fragments: spokenFragments(text), output: local, env, loadSherpa }).done;
		const audio = readFileSync(log("paplay.audio"));
		expect({ bytes: audio.length, sha256: createHash("sha256").update(audio).digest("hex") }).toEqual(PREVIOUS_LONG_PCM);
	});

	it("(T26) stops during lookahead: no write after stop, no further synthesis, the player ends and done settles quietly", async () => {
		// The player ignores SIGTERM and keeps recording, so anything written after stop() would show up.
		fakePaplay(`trap '' TERM; echo > "${log("paplay.ready")}";`);
		const seen: string[] = [];
		const progress: boolean[] = [];
		let reading: ReturnType<typeof startReading>;
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 44100,
			async generateAsync(request) {
				seen.push(request.text);
				if (request.text === "Dos.") {
					await waitFor(() => existsSync(log("paplay.ready")));
					reading.stop();
					progress.push(request.onProgress({ samples: new Float32Array([0]), progress: 0.5 }));
				}
				return { samples: new Float32Array(tone(441)) };
			},
		});
		reading = startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno. Dos. Tres."), output: local, env, loadSherpa });
		await expect(reading.done).resolves.toBeUndefined();
		expect(seen).toEqual(["Uno.", "Dos."]);
		expect(progress).toEqual([false]);
		await waitFor(() => existsSync(log("paplay.pid")) && !alive(Number(read("paplay.pid"))));
		expect(pcm("paplay.audio")).toEqual([...new Array(441).fill(level16(0.125)), ...zeros(15435)]);
	});

	it("(T26) a player that dies during lookahead ends the reading with its error and stops synthesis via onProgress", async () => {
		stuckPaplay();
		const seen: string[] = [];
		const progress: boolean[] = [];
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 44100,
			async generateAsync(request) {
				seen.push(request.text);
				if (request.text === "Dos.") {
					const pid = Number(read("paplay.pid"));
					process.kill(pid);
					await waitFor(() => !alive(pid));
					progress.push(request.onProgress({ samples: new Float32Array([0]), progress: 0.5 }));
				}
				return { samples: new Float32Array(tone(500_000)) };
			},
		});
		const reading = startReading({ voice, speaker: male, fragments: spokenFragments("Uno. Dos. Tres. Cuatro."), output: local, env, loadSherpa });
		try {
			await waitFor(() => existsSync(log("paplay.pid")) && seen.length >= 2, 2000);
		} finally {
			if (seen.length < 2) reading.stop();
		}
		await expect(reading.done).rejects.toThrow('Playback on "local" failed: killed by SIGTERM');
		expect(seen).toEqual(["Uno.", "Dos."]);
		expect(progress).toEqual([false]);
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
		reading = startReading({ voice, speaker: male, fragments: spokenFragments("Uno. Dos. Tres."), output: local, env, loadSherpa });
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
		reading = startReading({ voice, speaker: male, fragments: spokenFragments("Uno."), output: local, env, loadSherpa });
		await expect(reading.done).resolves.toBeUndefined();
		expect(seen).toEqual([true, false]);
	});

	it("reports a voice that cannot be loaded", async () => {
		fakePaplay();
		const loadSherpa = async () => {
			throw new Error("model not found");
		};
		await expect(startReading({ voice, speaker: male, fragments: spokenFragments("a"), output: local, env, loadSherpa }).done).rejects.toThrow(
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
			startReading({ voice, speaker: male, fragments: spokenFragments("Uno. Dos."), output: local, env, loadSherpa }).done,
		).rejects.toThrow("Speech synthesis failed: bad input");
		await waitFor(() => !alive(Number(read("paplay.pid"))));
	});
});

describe("startReading without a working player", () => {
	it("explains where paplay comes from when it is missing, before loading the voice", async () => {
		let loads = 0;
		const loadSherpa = async () => (loads++, fakeSherpa(() => new Float32Array([0]))());
		await expect(startReading({ voice, speaker: male, fragments: spokenFragments("a"), output: local, env, loadSherpa }).done).rejects.toThrow(
			"Cannot play: paplay was not found on PATH (it comes with libpulse on Arch, pulseaudio-utils on Debian and Ubuntu).",
		);
		expect(loads).toBe(0);
	});

	it("ignores relative PATH entries when looking for paplay", async () => {
		fakePaplay();
		env.PATH = relative(process.cwd(), join(root, "bin"));
		const loadSherpa = fakeSherpa(() => new Float32Array([0]));
		await expect(startReading({ voice, speaker: male, fragments: spokenFragments("a"), output: local, env, loadSherpa }).done).rejects.toThrow(
			/^Cannot play: paplay was not found on PATH/,
		);
	});

	it("names the output and paplay's last error line when playback fails", async () => {
		script("paplay", 'cat > /dev/null; echo "Connection failure: Connection refused" >&2; exit 1');
		const loadSherpa = fakeSherpa(() => new Float32Array([0]));
		await expect(startReading({ voice, speaker: male, fragments: spokenFragments("a"), output: desktop, env, loadSherpa }).done).rejects.toThrow(
			'Playback on "desktop" failed: Connection failure: Connection refused',
		);
	});

	it("names the output and stops synthesizing when paplay dies before reading any audio", async () => {
		script("paplay", 'echo "Connection refused" >&2; exit 1');
		const seen: SherpaRequest[] = [];
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(500_000)), seen);
		const text = Array.from({ length: 50 }, (_, i) => `Frase ${i}.`).join(" ");
		await expect(startReading({ voice, speaker: male, fragments: spokenFragments(text), output: desktop, env, loadSherpa }).done).rejects.toThrow(
			'Playback on "desktop" failed: Connection refused',
		);
		expect(seen.length).toBeLessThan(50);
	});
});

/** A player stuck connecting that ignores SIGTERM, as paplay can while its Pulse handshake hangs (S13). */
function hungPaplay(): void {
	script("paplay", `trap '' TERM; echo $$ > "${log("paplay.pid")}"; exec sleep 600`);
}

/** The kill grace of S13: SIGTERM, then SIGKILL 2 s later. */
const GRACE_MS = 2000;

describe("(S13) a player that hangs is ended", { timeout: 15000 }, () => {
	it("kills a TERM-ignoring player that takes no audio for the timeout, and rejects with the timed-out message", async () => {
		hungPaplay();
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(500_000)));
		const started = Date.now();
		const reading = startReading({ voice, speaker: male, fragments: spokenFragments("Uno. Dos."), output: desktop, env, loadSherpa, timeoutMs: 300 });
		await expect(reading.done).rejects.toThrow(/^Playback on "desktop" failed: timed out$/);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(300 + GRACE_MS - 100);
		expect(elapsed).toBeLessThan(300 + GRACE_MS + 2000);
		expect(alive(Number(read("paplay.pid")))).toBe(false);
	});

	it("kills a player that took a short reading but never ends, after its audio plus the timeout", async () => {
		hungPaplay();
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(441)));
		const reading = startReading({ voice, speaker: male, fragments: spokenFragments("Uno."), output: local, env, loadSherpa, timeoutMs: 300 });
		await expect(reading.done).rejects.toThrow(/^Playback on "local" failed: timed out$/);
		expect(alive(Number(read("paplay.pid")))).toBe(false);
	});

	it("keeps a slow player that keeps taking audio, even past the timeout, and plays every byte", async () => {
		script(
			"paplay",
			`while :; do n=$(dd bs=16384 count=1 2>/dev/null | tee -a "${log("paplay.audio")}" | wc -c); [ "$n" -eq 0 ] && break; sleep 0.05; done`,
		);
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(200_000)));
		const started = Date.now();
		// The timeout leaves room for a loaded machine (each read spawns dd, tee and wc) while the whole reading, about
		// 2.5 s at this rate, still runs well past it.
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno. Dos."), output: local, env, loadSherpa, timeoutMs: 1500 }).done;
		expect(Date.now() - started).toBeGreaterThan(1500);
		const audio = pcm("paplay.audio");
		expect(audio.length).toBe(400_000 + Math.round(0.35 * 44100));
	});

	it("stop() kills a TERM-ignoring player within the grace and settles quietly", async () => {
		hungPaplay();
		let reading: ReturnType<typeof startReading>;
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 44100,
			async generateAsync() {
				await waitFor(() => existsSync(log("paplay.pid")));
				reading.stop();
				return { samples: new Float32Array(tone(441)) };
			},
		});
		reading = startReading({ voice, speaker: male, fragments: spokenFragments("Uno."), output: local, env, loadSherpa });
		const started = Date.now();
		await expect(reading.done).resolves.toBeUndefined();
		expect(Date.now() - started).toBeLessThan(GRACE_MS + 2000);
		expect(alive(Number(read("paplay.pid")))).toBe(false);
	});
});

const PLAYBACK = pathToFileURL(resolve(import.meta.dirname, "..", "src", "playback.ts")).href;

/** A Pi-like process that starts one reading with a fake engine; `exit` makes it exit cleanly once its player started. */
const OWNER = `
const [playback, envJson, mode] = process.argv.slice(2);
const { startReading } = await import(playback);
const voice = { supertonic: {} };
startReading({
	voice, speaker: { sid: 6, gain: 1 }, fragments: [{ text: "Uno.", after: "sentence" }],
	output: { name: "local", label: "local" }, env: JSON.parse(envJson),
	loadSherpa: async () => ({ sampleRate: 44100, generateAsync: async () => ({ samples: new Float32Array(441).fill(0.125) }) }),
	onPlayer: () => { if (mode === "exit") setTimeout(() => process.exit(0), 200); },
}).done.catch(() => {});
setInterval(() => {}, 1000);
`;

describe("(S13) no player outlives its reader", { timeout: 15000 }, () => {
	const others: ChildProcess[] = [];
	afterEach(() => {
		for (const child of others.splice(0)) child.kill("SIGKILL");
	});

	/** A TERM-ignoring player that keeps its marked command line (no exec), started by a separate reader process. */
	function owner(mode: "exit" | "stay"): ChildProcess {
		script("paplay", `trap '' TERM; echo $$ > "${log("paplay.pid")}"; while :; do sleep 0.1; done`);
		writeFileSync(log("owner.mjs"), OWNER);
		const child = spawn(process.execPath, [log("owner.mjs"), PLAYBACK, JSON.stringify(env), mode], { stdio: "ignore" });
		others.push(child);
		return child;
	}

	const killLater = (pid: number) => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	};

	it("kills its player when the reader process exits", async () => {
		const child = owner("exit");
		await waitFor(() => existsSync(log("paplay.pid")) && read("paplay.pid").trim() !== "");
		const player = Number(read("paplay.pid"));
		try {
			await new Promise((done) => child.on("exit", done));
			await waitFor(() => !alive(player), 1000);
		} finally {
			killLater(player);
		}
	});

	it("a new reading ends a player whose reader died uncleanly, and never one that is not ours", async () => {
		const child = owner("stay");
		await waitFor(() => existsSync(log("paplay.pid")) && read("paplay.pid").trim() !== "");
		const orphan = Number(read("paplay.pid"));
		const marked = spawn("/bin/sh", ["-c", "sleep 30; :", "paplay", PLAYER_MARK], { stdio: "ignore" });
		const owned = spawn("/bin/sh", ["-c", "sleep 30; :", "paplay", PLAYER_MARK], {
			stdio: "ignore",
			env: { ...process.env, PI_REPLY_READER_OWNER: `${process.pid}:` },
		});
		others.push(marked, owned);
		try {
			child.kill("SIGKILL");
			await new Promise((done) => child.on("exit", done));
			await new Promise((done) => setTimeout(done, 300));
			expect(alive(orphan)).toBe(true);
			fakePaplay();
			await startReading({ voice, speaker: male, fragments: spokenFragments("Uno."), output: local, env, loadSherpa: fakeSherpa(() => new Float32Array([0])) }).done;
			await waitFor(() => !alive(orphan), GRACE_MS + 2000);
			expect(alive(marked.pid!)).toBe(true);
			expect(alive(owned.pid!)).toBe(true);
		} finally {
			killLater(orphan);
		}
	});
});

describe("(S13) review additions (T37)", { timeout: 20000 }, () => {
	const others: ChildProcess[] = [];
	const strays: number[] = [];
	afterEach(() => {
		for (const child of others.splice(0)) child.kill("SIGKILL");
		for (const pid of strays.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	});

	it("(b) stop() sends SIGTERM first: a player that honours it ends on it, before any SIGKILL", async () => {
		script("paplay", `trap 'echo term > "${log("paplay.signal")}"; exit 0' TERM; echo $$ > "${log("paplay.pid")}"; while :; do sleep 0.05; done`);
		let reading: ReturnType<typeof startReading>;
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 44100,
			async generateAsync() {
				await waitFor(() => existsSync(log("paplay.pid")));
				reading.stop();
				return { samples: new Float32Array(tone(441)) };
			},
		});
		const started = Date.now();
		reading = startReading({ voice, speaker: male, fragments: spokenFragments("Uno."), output: local, env, loadSherpa });
		await expect(reading.done).resolves.toBeUndefined();
		const pid = Number(read("paplay.pid"));
		await waitFor(() => !alive(pid), 1000);
		expect(Date.now() - started).toBeLessThan(GRACE_MS);
		expect(read("paplay.signal").trim()).toBe("term");
	});

	it("(b) a failed reading kills a TERM-ignoring player with SIGKILL after the grace", async () => {
		hungPaplay();
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 44100,
			async generateAsync() {
				await waitFor(() => existsSync(log("paplay.pid")) && read("paplay.pid").trim() !== "");
				throw new Error("bad input");
			},
		});
		await expect(
			startReading({ voice, speaker: male, fragments: spokenFragments("Uno."), output: local, env, loadSherpa }).done,
		).rejects.toThrow("Speech synthesis failed: bad input");
		const pid = Number(read("paplay.pid"));
		strays.push(pid);
		await new Promise((done) => setTimeout(done, GRACE_MS - 500));
		expect(alive(pid)).toBe(true);
		await waitFor(() => !alive(pid), 2000);
	});

	it("(f) a player taking audio at real time is never cut at the smallest timeout, and gets every byte", async () => {
		// 8820 bytes every 0.1 s is 44.1 kHz 16-bit mono at real time; about 4 s of audio with a 5 s timeout.
		script(
			"paplay",
			`while :; do n=$(dd bs=8820 count=1 iflag=fullblock 2>/dev/null | tee -a "${log("paplay.audio")}" | wc -c); [ "$n" -eq 0 ] && break; sleep 0.1; done`,
		);
		env.REPLY_READER_PLAYER_TIMEOUT = "5";
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(88_200)));
		await startReading({ voice, speaker: SPEAKERS.female, fragments: spokenFragments("Uno. Dos."), output: local, env, loadSherpa }).done;
		expect(pcm("paplay.audio").length).toBe(176_400 + Math.round(0.35 * 44100));
	});

	it("(f) REPLY_READER_PLAYER_TIMEOUT accepts 5 to 86400 seconds; anything else falls back to 15 with the warning", () => {
		const hint = "REPLY_READER_PLAYER_TIMEOUT must be a number of seconds from 5 to 86400; using 15.";
		expect(playerTimeout({})).toEqual({ ms: 15_000 });
		for (const [value, ms] of [["5", 5000], ["7.5", 7500], [" 15 ", 15_000], ["86400", 86_400_000]] as const) {
			expect(playerTimeout({ REPLY_READER_PLAYER_TIMEOUT: value })).toEqual({ ms });
		}
		for (const value of ["", "0", "-5", "abc", "3000000", "4.9", "86400.5", "1e3", "Infinity"]) {
			expect(playerTimeout({ REPLY_READER_PLAYER_TIMEOUT: value })).toEqual({ ms: 15_000, problem: hint });
		}
	});

	it("(g) a player that already exited when the deadline passes is not reported as timed out", async () => {
		// It takes everything and exits 0 at once, but a process it left behind holds its stderr for 3 s.
		script("paplay", `cat > "${log("paplay.audio")}"; sleep 3 & exit 0`);
		const loadSherpa = fakeSherpa(() => new Float32Array(tone(441)));
		const started = Date.now();
		const reading = startReading({ voice, speaker: male, fragments: spokenFragments("Uno."), output: local, env, loadSherpa, timeoutMs: 300 });
		await expect(reading.done).resolves.toBeUndefined();
		expect(Date.now() - started).toBeLessThan(2500);
		expect(pcm("paplay.audio").length).toBe(441);
	});

	it("(d) the reaper never signals a player whose reader runs in another PID namespace", async (context) => {
		try {
			execFileSync("unshare", ["-Urpf", "--mount-proc", "true"], { stdio: "ignore" });
		} catch {
			context.skip();
		}
		script("paplay", `trap '' TERM; while :; do sleep 0.1; done`);
		writeFileSync(log("owner.mjs"), OWNER);
		const tag = `ns-${process.pid}-${Date.now()}`;
		const reader = spawn(
			"unshare",
			["-Urpf", "--mount-proc", "--kill-child", process.execPath, log("owner.mjs"), PLAYBACK, JSON.stringify({ ...env, REPLY_READER_TEST: tag }), "stay"],
			{ stdio: "ignore" },
		);
		others.push(reader);
		let player: number | undefined;
		await waitFor(() => (player = playersTagged(tag)[0]) !== undefined);
		strays.push(player!);
		expect(reapOrphans()).not.toContain(player);
		await new Promise((done) => setTimeout(done, GRACE_MS + 300));
		expect(alive(player!)).toBe(true);
	});

	it("(h) with setpriv on PATH, a player dies with its reader even when the reader is killed outright", async () => {
		const setpriv = ["/usr/bin/setpriv", "/bin/setpriv"].find((path) => existsSync(path));
		if (!setpriv) return;
		symlinkSync(setpriv, join(root, "bin", "setpriv"));
		script("paplay", `trap '' TERM; echo $$ > "${log("paplay.pid")}"; while :; do sleep 0.1; done`);
		writeFileSync(log("owner.mjs"), OWNER);
		const reader = spawn(process.execPath, [log("owner.mjs"), PLAYBACK, JSON.stringify(env), "stay"], { stdio: "ignore" });
		others.push(reader);
		await waitFor(() => existsSync(log("paplay.pid")) && read("paplay.pid").trim() !== "");
		const player = Number(read("paplay.pid"));
		strays.push(player);
		reader.kill("SIGKILL");
		await new Promise((done) => reader.on("exit", done));
		await waitFor(() => !alive(player), 1000);
	});
});

/** Pids of marked players whose environment carries REPLY_READER_TEST=<tag>, as this process sees them in /proc. */
function playersTagged(tag: string): number[] {
	return readdirSync("/proc")
		.filter((name) => /^\d+$/.test(name))
		.map(Number)
		.filter((pid) => {
			try {
				return (
					readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(PLAYER_MARK) &&
					readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`REPLY_READER_TEST=${tag}`)
				);
			} catch {
				return false;
			}
		});
}

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
