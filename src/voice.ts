import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { promisify } from "node:util";

/** The local engine (S3): Supertonic 3, int8, as sherpa-onnx packages it for its v2 Node binding. */
const VOICE = "Supertonic 3";
const BUNDLE = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11";
/** sherpa-onnx's supertonic config key → file in the bundle. */
const MODEL_FILES = {
	durationPredictor: "duration_predictor.int8.onnx",
	textEncoder: "text_encoder.int8.onnx",
	vectorEstimator: "vector_estimator.int8.onnx",
	vocoder: "vocoder.int8.onnx",
	ttsJson: "tts.json",
	unicodeIndexer: "unicode_indexer.bin",
	voiceStyle: "voice.bin",
} as const;
const BUNDLE_FILES = Object.values(MODEL_FILES);

export interface VoiceArchive {
	url: string;
	bytes: number;
	sha256: string;
}

/** sherpa-onnx's Supertonic 3 bundle; size and digest as published by GitHub for the release asset. */
export const VOICE_ARCHIVE: VoiceArchive = {
	url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${BUNDLE}.tar.bz2`,
	bytes: 128774318,
	sha256: "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427",
};

/** The model files, shaped as sherpa-onnx's `model.supertonic` config. */
export interface Voice {
	supertonic: Record<keyof typeof MODEL_FILES, string>;
}

export interface Speaker {
	/** Speaker ID inside the Supertonic model. */
	sid: number;
	/** Linear gain applied to every sample of a reading. */
	gain: number;
}

/**
 * The two voices the model ships (S3, L20): male is the default, female is selectable. Each gain
 * lifts the voice's speech to about -16 dBFS (L22). Measured on the hs bake-off WAVs, speech RMS was
 * -22.7 dBFS for sid 6 and -23.5 dBFS for sid 0, with peaks at -2.8 and -4.8 dBFS, so the lifted
 * peaks go past full scale and playback limits them (playback.ts).
 */
export const SPEAKERS = {
	male: { sid: 6, gain: 10 ** ((-16 - -22.7) / 20) },
	female: { sid: 0, gain: 10 ** ((-16 - -23.5) / 20) },
} as const satisfies Record<string, Speaker>;

export type SpeakerName = keyof typeof SPEAKERS;

/** The voice this package downloaded, when every model file is in place. */
export function findVoice(env: NodeJS.ProcessEnv): Voice | undefined {
	const data = dataHome(env);
	if (!data) return undefined;
	const dir = join(data, "pi-reply-reader", "voices", BUNDLE);
	if (!BUNDLE_FILES.every((name) => existsSync(join(dir, name)))) return undefined;
	const files = Object.entries(MODEL_FILES).map(([key, name]) => [key, join(dir, name)]);
	return { supertonic: Object.fromEntries(files) as Voice["supertonic"] };
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
	/** Cancels the download (Ctrl+C in the reply-reader command); it then fails with "cancelled" and keeps nothing. */
	signal?: AbortSignal;
}): Promise<Voice | undefined> {
	const { env, confirm, archive = VOICE_ARCHIVE, idleTimeoutMs = 30_000, signal } = options;
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
		await fetchVerified(archive, file, idleTimeoutMs, signal);
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
async function fetchVerified(archive: VoiceArchive, file: string, idleTimeoutMs: number, cancel?: AbortSignal): Promise<void> {
	const idle = new AbortController();
	const signal = cancel ? AbortSignal.any([idle.signal, cancel]) : idle.signal;
	let timer: NodeJS.Timeout | undefined;
	const wait = () => {
		clearTimeout(timer);
		timer = setTimeout(() => idle.abort(new Error(`no data for ${idleTimeoutMs / 1000} s from ${archive.url}`)), idleTimeoutMs);
	};
	const hash = createHash("sha256");
	let received = 0;
	try {
		wait();
		const response = await fetch(archive.url, { signal });
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
			{ signal },
		);
	} catch (error) {
		if (idle.signal.aborted) throw idle.signal.reason as Error;
		throw cancel?.aborted ? new Error("cancelled") : error;
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
