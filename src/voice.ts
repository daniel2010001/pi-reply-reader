import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

/** The voice is fixed (S3): es_MX-claude-high, through a local piper or a pinned sherpa-onnx download. */
const VOICE = "es_MX-claude-high";
const BUNDLE = `vits-piper-${VOICE}`;
const BUNDLE_FILES = [`${VOICE}.onnx`, "tokens.txt", "espeak-ng-data"];

export interface VoiceArchive {
	url: string;
	bytes: number;
	sha256: string;
}

/** sherpa-onnx's converted Piper voice; size and digest as published by GitHub for the release asset. */
export const VOICE_ARCHIVE: VoiceArchive = {
	url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${BUNDLE}.tar.bz2`,
	bytes: 67207890,
	sha256: "ec33fb689c248fe64810aab564cba97babf0f506672cfd404928d46e751a4721",
};

export type Voice =
	| { engine: "piper"; bin: string; model: string; config: string }
	| { engine: "sherpa"; model: string; tokens: string; dataDir: string };

/**
 * A local `piper-tts` with the voice wins (L5); otherwise the voice this package downloaded.
 * Only `piper-tts` counts: on Arch, `piper` is a gaming mouse configurator.
 */
export function findVoice(env: NodeJS.ProcessEnv): Voice | undefined {
	const bin = onPath("piper-tts", env);
	const model = join(dataHome(env), "piper-tts", "models", `${VOICE}.onnx`);
	if (bin && isFile(model) && isFile(`${model}.json`)) return { engine: "piper", bin, model, config: `${model}.json` };

	const dir = join(voicesDir(env), BUNDLE);
	if (BUNDLE_FILES.every((name) => existsSync(join(dir, name)))) {
		return {
			engine: "sherpa",
			model: join(dir, `${VOICE}.onnx`),
			tokens: join(dir, "tokens.txt"),
			dataDir: join(dir, "espeak-ng-data"),
		};
	}
	return undefined;
}

/**
 * Downloads the pinned voice after `confirm` agrees. The archive is checked for size and sha256
 * before extraction, extracted beside its destination and moved into place whole, so a failure
 * leaves nothing behind and a half-written voice is never found.
 */
export async function downloadVoice(options: {
	env: NodeJS.ProcessEnv;
	confirm: (message: string) => Promise<boolean>;
	archive?: VoiceArchive;
}): Promise<Voice | undefined> {
	const { env, confirm, archive = VOICE_ARCHIVE } = options;
	const existing = findVoice(env);
	if (existing) return existing;

	const dir = voicesDir(env);
	const megabytes = Math.round(archive.bytes / 1_000_000);
	if (!(await confirm(`Download the Spanish voice ${VOICE} (${megabytes} MB) from ${new URL(archive.url).hostname} into ${dir}?`))) {
		return undefined;
	}

	mkdirSync(dir, { recursive: true });
	const work = mkdtempSync(join(dir, ".download-"));
	try {
		const file = join(work, "voice.tar.bz2");
		await fetchVerified(archive, file);
		await promisify(execFile)("tar", ["-xjf", file, "--no-same-owner", "-C", work]);
		for (const name of BUNDLE_FILES) {
			if (!existsSync(join(work, BUNDLE, name))) throw new Error(`the archive has no ${BUNDLE}/${name}`);
		}
		try {
			renameSync(join(work, BUNDLE), join(dir, BUNDLE));
		} catch (error) {
			// Another session finished the same download first; its copy is as good as ours.
			if (!findVoice(env)) throw error;
		}
		return findVoice(env);
	} catch (error) {
		throw new Error(`Voice download failed: ${(error as Error).message}. Nothing was kept.`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function fetchVerified(archive: VoiceArchive, file: string): Promise<void> {
	const response = await fetch(archive.url);
	if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from ${archive.url}`);

	const hash = createHash("sha256");
	const out = createWriteStream(file);
	let received = 0;
	try {
		for await (const chunk of response.body) {
			received += chunk.length;
			if (received > archive.bytes) throw new Error(`expected ${archive.bytes} bytes, got more`);
			hash.update(chunk);
			if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
		}
	} finally {
		await new Promise((resolve) => out.end(resolve));
	}
	if (received !== archive.bytes) throw new Error(`expected ${archive.bytes} bytes, got ${received}`);
	const actual = hash.digest("hex");
	if (actual !== archive.sha256) throw new Error(`sha256 mismatch (expected ${archive.sha256}, got ${actual})`);
}

function dataHome(env: NodeJS.ProcessEnv): string {
	return env.XDG_DATA_HOME || join(env.HOME ?? "", ".local", "share");
}

function voicesDir(env: NodeJS.ProcessEnv): string {
	return join(dataHome(env), "pi-reply-reader", "voices");
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (isFile(candidate)) return candidate;
		} catch {
			// not here, keep looking
		}
	}
	return undefined;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
