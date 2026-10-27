import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadVoice, findVoice, SPEAKERS, VOICE_ARCHIVE, type VoiceArchive } from "../src/voice.ts";

let root: string;
let env: NodeJS.ProcessEnv;
let server: Server | undefined;
let requests = 0;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "reply-reader-voice-"));
	mkdirSync(join(root, "bin"));
	env = { HOME: join(root, "home"), XDG_DATA_HOME: join(root, "data"), PATH: join(root, "bin") };
	requests = 0;
});

afterEach(async () => {
	server?.closeAllConnections();
	await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
	server = undefined;
	rmSync(root, { recursive: true, force: true });
});

const BUNDLE = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11";
const FILES = [
	"duration_predictor.int8.onnx",
	"text_encoder.int8.onnx",
	"vector_estimator.int8.onnx",
	"vocoder.int8.onnx",
	"tts.json",
	"unicode_indexer.bin",
	"voice.bin",
];
const voicesDir = () => join(root, "data", "pi-reply-reader", "voices");
const bundleDir = () => join(voicesDir(), BUNDLE);

function installBundle(dir = bundleDir()): void {
	mkdirSync(dir, { recursive: true });
	for (const name of FILES) writeFileSync(join(dir, name), name);
}

/** Builds a voice archive like the real one, minus whatever `omit` names. */
function buildArchive(omit: string[] = []): Buffer {
	const staging = join(root, "staging");
	installBundle(join(staging, BUNDLE));
	for (const name of omit) rmSync(join(staging, BUNDLE, name), { recursive: true });
	const file = join(root, "voice.tar.bz2");
	execFileSync("tar", ["-cjf", file, "-C", staging, BUNDLE]);
	rmSync(staging, { recursive: true });
	return readFileSync(file);
}

async function serve(body: Buffer, status = 200): Promise<string> {
	server = createServer((_req, res) => {
		requests++;
		res.writeHead(status).end(body);
	});
	await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
	return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/voice.tar.bz2`;
}

function archiveFor(url: string, body: Buffer): VoiceArchive {
	return { ...VOICE_ARCHIVE, url, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
}

const accept = async () => true;

describe("findVoice", () => {
	it("uses the downloaded Supertonic 3 model, one path per file sherpa-onnx loads", () => {
		installBundle();
		const dir = bundleDir();
		expect(findVoice(env)).toEqual({
			supertonic: {
				durationPredictor: join(dir, "duration_predictor.int8.onnx"),
				textEncoder: join(dir, "text_encoder.int8.onnx"),
				vectorEstimator: join(dir, "vector_estimator.int8.onnx"),
				vocoder: join(dir, "vocoder.int8.onnx"),
				ttsJson: join(dir, "tts.json"),
				unicodeIndexer: join(dir, "unicode_indexer.bin"),
				voiceStyle: join(dir, "voice.bin"),
			},
		});
	});

	it("finds nothing while any model file is missing", () => {
		for (const name of FILES) {
			installBundle();
			rmSync(join(bundleDir(), name));
			expect(findVoice(env)).toBeUndefined();
		}
	});

	it("does not reuse a local piper-tts voice any more", () => {
		writeFileSync(join(root, "bin", "piper-tts"), "#!/bin/sh\n");
		chmodSync(join(root, "bin", "piper-tts"), 0o755);
		const models = join(root, "data", "piper-tts", "models");
		mkdirSync(models, { recursive: true });
		writeFileSync(join(models, "es_MX-claude-high.onnx"), "onnx");
		writeFileSync(join(models, "es_MX-claude-high.onnx.json"), "{}");
		expect(findVoice(env)).toBeUndefined();
	});

	it("ignores a relative XDG_DATA_HOME, as the XDG spec requires", () => {
		installBundle(join(root, "home", ".local", "share", "pi-reply-reader", "voices", BUNDLE));
		env.XDG_DATA_HOME = "relative/data";
		expect(findVoice(env)?.supertonic.ttsJson).toBe(join(root, "home", ".local", "share", "pi-reply-reader", "voices", BUNDLE, "tts.json"));
	});

	it("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
		delete env.XDG_DATA_HOME;
		installBundle(join(root, "home", ".local", "share", "pi-reply-reader", "voices", BUNDLE));
		expect(findVoice(env)).toBeDefined();
	});
});

describe("SPEAKERS", () => {
	it("offers the male voice (sid 6) and the female voice (sid 0), male first", () => {
		expect(Object.keys(SPEAKERS)).toEqual(["male", "female"]);
		expect(SPEAKERS.male.sid).toBe(6);
		expect(SPEAKERS.female.sid).toBe(0);
	});

	it("lifts each voice's measured speech level to about -16 dBFS", () => {
		// Bake-off speech RMS: -22.7 dBFS for sid 6, -23.5 dBFS for sid 0.
		expect(20 * Math.log10(SPEAKERS.male.gain)).toBeCloseTo(6.7, 1);
		expect(20 * Math.log10(SPEAKERS.female.gain)).toBeCloseTo(7.5, 1);
	});
});

describe("downloadVoice", () => {
	it("pins the published sherpa-onnx archive", () => {
		expect(VOICE_ARCHIVE).toEqual({
			url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${BUNDLE}.tar.bz2`,
			bytes: 128774318,
			sha256: "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427",
		});
	});

	it("asks first and, when declined, touches neither the network nor the disk", async () => {
		const url = await serve(Buffer.from("x"));
		const asked: string[] = [];
		const voice = await downloadVoice({
			env,
			archive: { ...VOICE_ARCHIVE, url },
			confirm: async (message) => (asked.push(message), false),
		});
		expect(voice).toBeUndefined();
		expect(asked).toEqual([
			`Download the Spanish voice Supertonic 3 (129 MB) from 127.0.0.1 into ${voicesDir()}?`,
		]);
		expect(requests).toBe(0);
		expect(existsSync(join(root, "data"))).toBe(false);
	});

	it("names github.com and 129 MB for the pinned archive", async () => {
		const asked: string[] = [];
		await downloadVoice({ env, confirm: async (message) => (asked.push(message), false) });
		expect(asked).toEqual([
			`Download the Spanish voice Supertonic 3 (129 MB) from github.com into ${voicesDir()}?`,
		]);
	});

	it("downloads, verifies and installs the voice, leaving nothing else behind", async () => {
		const body = buildArchive();
		const url = await serve(body);
		const voice = await downloadVoice({ env, confirm: accept, archive: archiveFor(url, body) });
		expect(voice).toBeDefined();
		expect(voice).toEqual(findVoice(env));
		expect(readdirSync(voicesDir())).toEqual([BUNDLE]);
		expect(requests).toBe(1);
	});

	it("rejects a sha256 mismatch and keeps nothing", async () => {
		const body = buildArchive();
		const url = await serve(body);
		const archive = { ...archiveFor(url, body), sha256: "0".repeat(64) };
		const actual = createHash("sha256").update(body).digest("hex");
		await expect(downloadVoice({ env, confirm: accept, archive })).rejects.toThrow(
			`Voice download failed: sha256 mismatch (expected ${"0".repeat(64)}, got ${actual}). Nothing was kept.`,
		);
		expect(readdirSync(voicesDir())).toEqual([]);
		expect(findVoice(env)).toBeUndefined();
	});

	it("rejects a size mismatch and keeps nothing", async () => {
		const body = buildArchive();
		const url = await serve(body);
		const archive = { ...archiveFor(url, body), bytes: body.length - 1 };
		await expect(downloadVoice({ env, confirm: accept, archive })).rejects.toThrow(
			`Voice download failed: expected ${body.length - 1} bytes, got more. Nothing was kept.`,
		);
		expect(readdirSync(voicesDir())).toEqual([]);
	});

	it("rejects an HTTP error and keeps nothing", async () => {
		const url = await serve(Buffer.from("gone"), 404);
		await expect(downloadVoice({ env, confirm: accept, archive: { ...VOICE_ARCHIVE, url } })).rejects.toThrow(
			`Voice download failed: HTTP 404 from ${url}. Nothing was kept.`,
		);
		expect(readdirSync(voicesDir())).toEqual([]);
	});

	it("rejects an archive without the expected files and keeps nothing", async () => {
		const body = buildArchive(["vocoder.int8.onnx"]);
		const url = await serve(body);
		await expect(downloadVoice({ env, confirm: accept, archive: archiveFor(url, body) })).rejects.toThrow(
			`Voice download failed: the archive has no ${BUNDLE}/vocoder.int8.onnx. Nothing was kept.`,
		);
		expect(readdirSync(voicesDir())).toEqual([]);
	});

	it("rejects a short download and keeps nothing", async () => {
		const body = buildArchive();
		const url = await serve(body.subarray(0, 100));
		await expect(downloadVoice({ env, confirm: accept, archive: archiveFor(url, body) })).rejects.toThrow(
			`Voice download failed: expected ${body.length} bytes, got 100. Nothing was kept.`,
		);
		expect(readdirSync(voicesDir())).toEqual([]);
	});

	it("keeps nothing when tar cannot extract a digest-matching archive", async () => {
		const body = randomBytes(5000);
		const url = await serve(body);
		await expect(downloadVoice({ env, confirm: accept, archive: archiveFor(url, body) })).rejects.toThrow(
			/^Voice download failed: Command failed: tar /,
		);
		expect(readdirSync(voicesDir())).toEqual([]);
		expect(findVoice(env)).toBeUndefined();
	});

	it("gives up on a server that stops sending, and keeps nothing", async () => {
		server = createServer((_req, res) => {
			requests++;
			res.writeHead(200).write("x");
		});
		await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v`;
		await expect(
			downloadVoice({ env, confirm: accept, archive: { ...VOICE_ARCHIVE, url }, idleTimeoutMs: 200 }),
		).rejects.toThrow(`Voice download failed: no data for 0.2 s from ${url}. Nothing was kept.`);
		expect(readdirSync(voicesDir())).toEqual([]);
	});

	it("replaces an incomplete voice left in place", async () => {
		installBundle();
		rmSync(join(bundleDir(), "voice.bin"));
		const body = buildArchive();
		const voice = await downloadVoice({ env, confirm: accept, archive: archiveFor(await serve(body), body) });
		expect(voice).toEqual(findVoice(env));
		expect(readFileSync(join(bundleDir(), "voice.bin"), "utf8")).toBe("voice.bin");
		expect(readdirSync(voicesDir())).toEqual([BUNDLE]);
	});

	it("installs once when two sessions download at the same time", async () => {
		const body = buildArchive();
		const archive = archiveFor(await serve(body), body);
		const voices = await Promise.all([
			downloadVoice({ env, confirm: accept, archive }),
			downloadVoice({ env, confirm: accept, archive }),
		]);
		expect(voices).toEqual([findVoice(env), findVoice(env)]);
		expect(voices[0]).toBeDefined();
		expect(readdirSync(voicesDir())).toEqual([BUNDLE]);
	});

	it("refuses to store the voice when no data directory is absolute, without asking", async () => {
		const asked: string[] = [];
		await expect(
			downloadVoice({ env: { PATH: env.PATH, XDG_DATA_HOME: "rel" }, confirm: async (m) => (asked.push(m), true) }),
		).rejects.toThrow("Voice download failed: neither XDG_DATA_HOME nor HOME is an absolute path. Nothing was kept.");
		expect(asked).toEqual([]);
	});

	// A disk write error (here the file size limit) must reject, not crash the Pi process.
	it("rejects a disk write error and keeps nothing", () => {
		const script = join(root, "efbig.mts");
		writeFileSync(
			script,
			`import { createHash } from "node:crypto"; import { createServer } from "node:http";
			const { downloadVoice } = await import(${JSON.stringify(join(process.cwd(), "src/voice.ts"))});
			const body = Buffer.alloc(4 << 20, 1); const s = createServer((_q, r) => r.end(body));
			await new Promise((d) => s.listen(0, "127.0.0.1", d));
			const archive = { url: \`http://127.0.0.1:\${s.address().port}/v\`, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
			try { await downloadVoice({ env: ${JSON.stringify(env)}, confirm: async () => true, archive }); } catch (e) { console.log(e.message); }
			process.exit(0);`,
		);
		const run = spawnSync("bash", ["-c", 'ulimit -f 1024; exec node "$0"', script], { encoding: "utf8" });
		expect(run.status).toBe(0);
		expect(run.stdout).toMatch(/^Voice download failed: EFBIG: .*Nothing was kept\.\n$/);
		expect(readdirSync(voicesDir())).toEqual([]);
	});

	it("returns the installed voice without asking when it is already there", async () => {
		installBundle();
		const asked: string[] = [];
		const voice = await downloadVoice({ env, confirm: async (m) => (asked.push(m), true) });
		expect(voice).toEqual(findVoice(env));
		expect(voice).toBeDefined();
		expect(asked).toEqual([]);
	});
});
