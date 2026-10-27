import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Output } from "../src/outputs.ts";
import { type SherpaTts, startReading } from "../src/playback.ts";
import type { Voice } from "../src/voice.ts";

let root: string;
let env: NodeJS.ProcessEnv;
const local: Output = { name: "local", label: "local (hs-node)" };
const desktop: Output = { name: "desktop", label: "desktop (tcp:192.168.1.22:4713)", pulseServer: "tcp:192.168.1.22:4713" };

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

function piperVoice(body = `echo "$@" > "${log("piper.args")}"; cat > "${log("piper.text")}"; printf PCMDATA`): Voice {
	const bin = script("piper-tts", body);
	const model = join(root, "voice.onnx");
	writeFileSync(model, "onnx");
	writeFileSync(`${model}.json`, JSON.stringify({ audio: { sample_rate: 22050 } }));
	return { engine: "piper", bin, model, config: `${model}.json` };
}

const sherpaVoice: Voice = { engine: "sherpa", model: "/v/m.onnx", tokens: "/v/tokens.txt", dataDir: "/v/espeak-ng-data" };

function fakeSherpa(chunks: Float32Array[], seen: unknown[] = []): () => Promise<SherpaTts> {
	return async () => ({
		sampleRate: 16000,
		async generateAsync(request) {
			for (const samples of chunks) seen.push(request.onProgress({ samples, progress: 0 }));
			return {};
		},
	});
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("startReading with a local piper-tts", () => {
	it("pipes piper's raw audio into paplay at the voice's sample rate", async () => {
		fakePaplay();
		const voice = piperVoice();
		await startReading({ voice, text: "Hola, mundo.", output: local, env }).done;
		expect(read("piper.args").trim()).toBe(`-m ${join(root, "voice.onnx")} -c ${join(root, "voice.onnx.json")} --output-raw`);
		expect(read("piper.text")).toBe("Hola, mundo.");
		expect(read("paplay.args").trim()).toBe(
			"--raw --format=s16le --rate=22050 --channels=1 --client-name=pi-reply-reader --stream-name=reply",
		);
		expect(read("paplay.audio")).toBe("PCMDATA");
	});

	it("leaves PULSE_SERVER alone for local and sets it for a named output", async () => {
		fakePaplay();
		await startReading({ voice: piperVoice(), text: "a", output: local, env }).done;
		expect(read("paplay.server").trim()).toBe("unset");
		await startReading({ voice: piperVoice(), text: "a", output: desktop, env }).done;
		expect(read("paplay.server").trim()).toBe("tcp:192.168.1.22:4713");
	});

	it("reports piper's last error line when it fails", async () => {
		fakePaplay();
		const voice = piperVoice('echo "loading" >&2; echo "bad model file" >&2; exit 2');
		await expect(startReading({ voice, text: "a", output: local, env }).done).rejects.toThrow(
			"piper-tts failed: bad model file",
		);
	});

	it("stops both processes and settles quietly", async () => {
		fakePaplay();
		const voice = piperVoice(`echo $$ > "${log("piper.pid")}"; exec sleep 30`);
		const reading = startReading({ voice, text: "a", output: local, env });
		await waitFor(() => existsSync(log("piper.pid")) && existsSync(log("paplay.pid")));
		reading.stop();
		await expect(reading.done).resolves.toBeUndefined();
		await waitFor(() => !alive(Number(read("piper.pid"))) && !alive(Number(read("paplay.pid"))));
	});
});

describe("startReading with the downloaded sherpa-onnx voice", () => {
	it("streams each chunk to paplay as 16-bit little-endian PCM", async () => {
		fakePaplay();
		const loadSherpa = fakeSherpa([new Float32Array([0, 0.5]), new Float32Array([-1, 2])]);
		await startReading({ voice: sherpaVoice, text: "a", output: local, env, loadSherpa }).done;
		expect(read("paplay.args")).toContain("--rate=16000");
		const audio = readFileSync(log("paplay.audio"));
		expect([...new Int16Array(audio.buffer, audio.byteOffset, audio.length / 2)]).toEqual([0, 16384, -32767, 32767]);
	});

	it("asks sherpa to stop generating once the reading is stopped", async () => {
		fakePaplay("sleep 30;");
		const seen: unknown[] = [];
		let reading: ReturnType<typeof startReading>;
		const loadSherpa = async (): Promise<SherpaTts> => ({
			sampleRate: 16000,
			async generateAsync(request) {
				seen.push(request.onProgress({ samples: new Float32Array([0]), progress: 0 }));
				await waitFor(() => existsSync(log("paplay.pid")));
				reading.stop();
				seen.push(request.onProgress({ samples: new Float32Array([0]), progress: 0 }));
				return {};
			},
		});
		reading = startReading({ voice: sherpaVoice, text: "a", output: local, env, loadSherpa });
		await expect(reading.done).resolves.toBeUndefined();
		expect(seen).toEqual([true, false]);
	});

	it("reports a voice that cannot be loaded", async () => {
		fakePaplay();
		const loadSherpa = async () => {
			throw new Error("model not found");
		};
		await expect(startReading({ voice: sherpaVoice, text: "a", output: local, env, loadSherpa }).done).rejects.toThrow(
			"Speech synthesis failed: model not found",
		);
	});
});

describe("startReading without a working player", () => {
	it("explains where paplay comes from when it is missing, before starting the voice", async () => {
		const voice = piperVoice();
		await expect(startReading({ voice, text: "a", output: local, env }).done).rejects.toThrow(
			"Cannot play: paplay was not found on PATH (it comes with libpulse on Arch, pulseaudio-utils on Debian and Ubuntu).",
		);
		expect(existsSync(log("piper.args"))).toBe(false);
	});

	it("names the output and paplay's last error line when playback fails", async () => {
		script("paplay", 'cat > /dev/null; echo "Connection failure: Connection refused" >&2; exit 1');
		await expect(startReading({ voice: piperVoice(), text: "a", output: desktop, env }).done).rejects.toThrow(
			'Playback on "desktop" failed: Connection failure: Connection refused',
		);
	});

	it("stops piper and reports the output when paplay dies while piper is still writing", async () => {
		script("paplay", 'echo "Connection refused" >&2; exit 1');
		const voice = piperVoice(`echo $$ > "${log("piper.pid")}"; cat > /dev/null; exec head -c 2000000 /dev/zero`);
		await expect(startReading({ voice, text: "a", output: desktop, env }).done).rejects.toThrow(
			'Playback on "desktop" failed: Connection refused',
		);
		expect(alive(Number(read("piper.pid")))).toBe(false);
	});

	it("names the output when paplay dies before reading any audio", async () => {
		script("paplay", 'echo "Connection refused" >&2; exit 1');
		const loadSherpa = fakeSherpa(Array.from({ length: 50 }, () => new Float32Array(50_000)));
		await expect(startReading({ voice: sherpaVoice, text: "a", output: desktop, env, loadSherpa }).done).rejects.toThrow(
			'Playback on "desktop" failed: Connection refused',
		);
	});
});

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
