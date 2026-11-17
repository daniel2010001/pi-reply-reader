import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile } from "./outputs.ts";

/** Supertonic's voice speed when none is saved (S3, L46). */
export const DEFAULT_SPEED = 1.1;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
/** What `/read-speed` offers without a number. */
export const SPEED_CHOICES = ["0.8", "0.9", "1.0", "1.1", "1.2", "1.3", "1.5"];
export const SPEED_HINT = "Speed must be a number from 0.5 to 2.0.";

const SETTINGS = "settings.json";
/** Digits with an optional decimal part after a period or a comma, or only the decimal part (".9", ",9"). */
const NUMBER = /^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/;

const inRange = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= MIN_SPEED && value <= MAX_SPEED;

/** A speed typed by the user ("1.15", "1,15" or ".9"), or undefined when it is not one from 0.5 to 2.0. */
export function parseSpeed(text: string): number | undefined {
	const trimmed = text.trim();
	if (!NUMBER.test(trimmed)) return undefined;
	const value = Number(trimmed.replace(",", "."));
	return inRange(value) ? value : undefined;
}

/** "1.15", and whole numbers with one decimal ("1.0", "2.0") as the selector shows them. */
export function formatSpeed(speed: number): string {
	return Number.isInteger(speed) ? speed.toFixed(1) : String(speed);
}

/**
 * The saved speed from `$XDG_CONFIG_HOME/pi-reply-reader/settings.json`. A missing file, folder or key means
 * the default with no problem; an unreadable or invalid file, or a speed out of range, means the default and
 * a `problem` for the user. Nothing throws.
 */
export function loadSpeed(env: NodeJS.ProcessEnv): { speed: number; problem?: string } {
	const path = configFile(env, SETTINGS);
	if (!path) return { speed: DEFAULT_SPEED };
	const ignored = (reason: string) => ({ speed: DEFAULT_SPEED, problem: `Ignored ${path}: ${reason}. Readings use speed ${formatSpeed(DEFAULT_SPEED)}.` });

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { speed: DEFAULT_SPEED };
		return ignored(`cannot be read (${(error as Error).message})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return ignored(`not valid JSON (${(error as Error).message})`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ignored("expected an object");
	if (!("speed" in parsed)) return { speed: DEFAULT_SPEED };
	const { speed } = parsed as { speed: unknown };
	return inRange(speed) ? { speed } : ignored("speed must be a number from 0.5 to 2.0");
}

/**
 * Saves `speed` in settings.json, keeping every other key. Throws an Error naming the file and why when it
 * cannot; an existing file that is not a JSON object is left as it is rather than overwritten.
 */
export function saveSpeed(env: NodeJS.ProcessEnv, speed: number): void {
	const path = configFile(env, SETTINGS);
	if (!path) throw new Error(`it was not saved: no config folder (set XDG_CONFIG_HOME or HOME to an absolute path)`);
	const fail = (reason: string) => new Error(`it was not saved to ${path}: ${reason}`);

	let settings: Record<string, unknown> = {};
	let raw: string | undefined;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fail((error as Error).message);
	}
	if (raw !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw fail("it is not valid JSON");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail("it is not a JSON object");
		settings = parsed as Record<string, unknown>;
	}
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ ...settings, speed }, null, 2)}\n`);
	} catch (error) {
		throw fail((error as Error).message);
	}
}
