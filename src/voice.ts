import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
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
	const data = dataHome(env);
	if (!data) return undefined;
	const bin = onPath("piper-tts", env);
	const model = join(data, "piper-tts", "models", `${VOICE}.onnx`);
	if (bin && isFile(model) && isFile(`${model}.json`)) return { engine: "piper", bin, model, config: `${model}.json` };

	const dir = join(data, "pi-reply-reader", "voices", BUNDLE);
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
	/** Give up when the server sends nothing for this long. */
	idleTimeoutMs?: number;
}): Promise<Voice | undefined> {
	const { env, confirm, archive = VOICE_ARCHIVE, idleTimeoutMs = 30_000 } = options;
	const existing = findVoice(env);
	if (existing) return existing;

	const data = dataHome(env);
	if (!data) {
		throw new Error("Voice download failed: neither XDG_DATA_HOME nor HOME is an absolute path. Nothing was kept.");
	}
	const dir = join(data, "pi-reply-reader", "voices");
	const megabytes = Math.round(archive.bytes / 1_000_000);
	if (!(await confirm(`Download the Spanish voice ${VOICE} (${megabytes} MB) from ${new URL(archive.url).hostname} into ${dir}?`))) {
		return undefined;
	}

	mkdirSync(dir, { recursive: true });
	const work = mkdtempSync(join(dir, ".download-"));
	try {
		const file = join(work, "voice.tar.bz2");
		await fetchVerified(archive, file, idleTimeoutMs);
		await promisify(execFile)("tar", ["-xjf", file, "--no-same-owner", "-C", work]);
		for (const name of BUNDLE_FILES) {
			if (!existsSync(join(work, BUNDLE, name))) throw new Error(`the archive has no ${BUNDLE}/${name}`);
		}
		// An incomplete voice in the way (findVoice already said there is none) goes out with the work dir.
		if (existsSync(join(dir, BUNDLE))) renameSync(join(dir, BUNDLE), join(work, "incomplete"));
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

/** Streams the archive to `file`, failing on HTTP errors, silence, oversize and disk errors alike. */
async function fetchVerified(archive: VoiceArchive, file: string, idleTimeoutMs: number): Promise<void> {
	const idle = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	const wait = () => {
		clearTimeout(timer);
		timer = setTimeout(() => idle.abort(new Error(`no data for ${idleTimeoutMs / 1000} s from ${archive.url}`)), idleTimeoutMs);
	};
	const hash = createHash("sha256");
	let received = 0;
	try {
		wait();
		const response = await fetch(archive.url, { signal: idle.signal });
		if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from ${archive.url}`);
		await pipeline(
			// fetch's body is typed with the DOM stream; at runtime it is Node's web stream.
			Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
			async function* (source: AsyncIterable<Buffer>) {
				for await (const chunk of source) {
					wait();
					received += chunk.length;
					if (received > archive.bytes) throw new Error(`expected ${archive.bytes} bytes, got more`);
					hash.update(chunk);
					yield chunk;
				}
			},
			createWriteStream(file),
			{ signal: idle.signal },
		);
	} catch (error) {
		throw idle.signal.aborted ? (idle.signal.reason as Error) : error;
	} finally {
		clearTimeout(timer);
	}
	if (received !== archive.bytes) throw new Error(`expected ${archive.bytes} bytes, got ${received}`);
	const actual = hash.digest("hex");
	if (actual !== archive.sha256) throw new Error(`sha256 mismatch (expected ${archive.sha256}, got ${actual})`);
}

/** XDG_DATA_HOME, then ~/.local/share; relative values are ignored, as the XDG spec says. */
function dataHome(env: NodeJS.ProcessEnv): string | undefined {
	if (env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME)) return env.XDG_DATA_HOME;
	if (env.HOME && isAbsolute(env.HOME)) return join(env.HOME, ".local", "share");
	return undefined;
}

/** An executable `name` in an absolute PATH entry. */
export function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(dir)) continue;
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
