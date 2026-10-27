import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadVoice, findVoice, VOICE_ARCHIVE, type VoiceArchive } from "../src/voice.ts";

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

const voicesDir = () => join(root, "data", "pi-reply-reader", "voices");
const bundleDir = () => join(voicesDir(), "vits-piper-es_MX-claude-high");

function installPiperBinary(): string {
	const bin = join(root, "bin", "piper-tts");
	writeFileSync(bin, "#!/bin/sh\n");
	chmodSync(bin, 0o755);
	return bin;
}

function installPiperModel(): { model: string; config: string } {
	const dir = join(root, "data", "piper-tts", "models");
	mkdirSync(dir, { recursive: true });
	const model = join(dir, "es_MX-claude-high.onnx");
	writeFileSync(model, "onnx");
	writeFileSync(`${model}.json`, "{}");
	return { model, config: `${model}.json` };
}

function installBundle(dir = bundleDir()): void {
	mkdirSync(join(dir, "espeak-ng-data"), { recursive: true });
	writeFileSync(join(dir, "es_MX-claude-high.onnx"), "onnx");
	writeFileSync(join(dir, "tokens.txt"), "_ 0\n");
}

/** Builds a voice archive like the real one, minus whatever `omit` names. */
function buildArchive(omit: string[] = []): Buffer {
	const staging = join(root, "staging");
	installBundle(join(staging, "vits-piper-es_MX-claude-high"));
	for (const name of omit) rmSync(join(staging, "vits-piper-es_MX-claude-high", name), { recursive: true });
	const file = join(root, "voice.tar.bz2");
	execFileSync("tar", ["-cjf", file, "-C", staging, "vits-piper-es_MX-claude-high"]);
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
	it("reuses a local piper-tts with the es_MX-claude-high model and its config", () => {
		const bin = installPiperBinary();
		const { model, config } = installPiperModel();
		expect(findVoice(env)).toEqual({ engine: "piper", bin, model, config });
	});

	it("does not reuse a local model without piper-tts, nor piper-tts without the model", () => {
		installPiperModel();
		expect(findVoice(env)).toBeUndefined();
		rmSync(join(root, "data", "piper-tts"), { recursive: true });
		installPiperBinary();
		expect(findVoice(env)).toBeUndefined();
	});

	it("ignores a binary named piper, which on Arch is the gaming mouse configurator", () => {
		writeFileSync(join(root, "bin", "piper"), "#!/bin/sh\n");
		chmodSync(join(root, "bin", "piper"), 0o755);
		installPiperModel();
		expect(findVoice(env)).toBeUndefined();
	});

	it("uses the downloaded sherpa-onnx voice when there is no local piper", () => {
		installBundle();
		expect(findVoice(env)).toEqual({
			engine: "sherpa",
			model: join(bundleDir(), "es_MX-claude-high.onnx"),
			tokens: join(bundleDir(), "tokens.txt"),
			dataDir: join(bundleDir(), "espeak-ng-data"),
		});
	});

	it("prefers the local piper over the downloaded voice", () => {
		installBundle();
		installPiperBinary();
		installPiperModel();
		expect(findVoice(env)?.engine).toBe("piper");
	});

	it("ignores relative PATH entries", () => {
		installPiperBinary();
		installPiperModel();
		env.PATH = relative(process.cwd(), join(root, "bin"));
		expect(findVoice(env)).toBeUndefined();
	});

	it("ignores a relative XDG_DATA_HOME, as the XDG spec requires", () => {
		installBundle(join(root, "home", ".local", "share", "pi-reply-reader", "voices", "vits-piper-es_MX-claude-high"));
		env.XDG_DATA_HOME = "relative/data";
		expect(findVoice(env)?.engine).toBe("sherpa");
	});

	it("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
		delete env.XDG_DATA_HOME;
		installBundle(join(root, "home", ".local", "share", "pi-reply-reader", "voices", "vits-piper-es_MX-claude-high"));
		expect(findVoice(env)?.engine).toBe("sherpa");
	});
});

describe("downloadVoice", () => {
	it("pins the published sherpa-onnx archive", () => {
		expect(VOICE_ARCHIVE).toEqual({
			url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_MX-claude-high.tar.bz2",
			bytes: 67207890,
			sha256: "ec33fb689c248fe64810aab564cba97babf0f506672cfd404928d46e751a4721",
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
			`Download the Spanish voice es_MX-claude-high (67 MB) from 127.0.0.1 into ${voicesDir()}?`,
		]);
		expect(requests).toBe(0);
		expect(existsSync(join(root, "data"))).toBe(false);
	});

	it("names github.com and 67 MB for the pinned archive", async () => {
		const asked: string[] = [];
		await downloadVoice({ env, confirm: async (message) => (asked.push(message), false) });
		expect(asked).toEqual([
			`Download the Spanish voice es_MX-claude-high (67 MB) from github.com into ${voicesDir()}?`,
		]);
	});

	it("downloads, verifies and installs the voice, leaving nothing else behind", async () => {
		const body = buildArchive();
		const url = await serve(body);
		const voice = await downloadVoice({ env, confirm: accept, archive: archiveFor(url, body) });
		expect(voice).toEqual(findVoice(env));
		expect(voice?.engine).toBe("sherpa");
		expect(readdirSync(voicesDir())).toEqual(["vits-piper-es_MX-claude-high"]);
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
		const body = buildArchive(["tokens.txt"]);
		const url = await serve(body);
		await expect(downloadVoice({ env, confirm: accept, archive: archiveFor(url, body) })).rejects.toThrow(
			"Voice download failed: the archive has no vits-piper-es_MX-claude-high/tokens.txt. Nothing was kept.",
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
		rmSync(join(bundleDir(), "tokens.txt"));
		const body = buildArchive();
		const voice = await downloadVoice({ env, confirm: accept, archive: archiveFor(await serve(body), body) });
		expect(voice?.engine).toBe("sherpa");
		expect(readdirSync(voicesDir())).toEqual(["vits-piper-es_MX-claude-high"]);
	});

	it("installs once when two sessions download at the same time", async () => {
		const body = buildArchive();
		const archive = archiveFor(await serve(body), body);
		const voices = await Promise.all([
			downloadVoice({ env, confirm: accept, archive }),
			downloadVoice({ env, confirm: accept, archive }),
		]);
		expect(voices.map((v) => v?.engine)).toEqual(["sherpa", "sherpa"]);
		expect(readdirSync(voicesDir())).toEqual(["vits-piper-es_MX-claude-high"]);
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
		expect(voice?.engine).toBe("sherpa");
		expect(asked).toEqual([]);
	});
});
