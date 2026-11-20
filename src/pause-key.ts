import { readFileSync } from "node:fs";
import { configFile } from "./outputs.ts";

/**
 * The key that pauses and resumes readings (S15, L147): Alt+M unless settings.json says otherwise. Esc is never the
 * reader's: it belongs to Pi (it interrupts the agent, closes dialogs).
 *
 * Alt+M is free on every platform: it is not a default in Pi's keybindings (docs/keybindings.md, Windows and WSL
 * included), not a gentle-pi shortcut, and not pi-reply-thread's Alt+R; terminals send it as Esc followed by "m".
 */
export const DEFAULT_PAUSE_KEY = "alt+m";

const SETTINGS = "settings.json";
const MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;
/**
 * A letter, a digit or F1 to F12. With ctrl or alt (and maybe shift), terminals send these, with two exceptions
 * `parsePauseKey` rejects: ctrl with a digit and any super key, which only terminals speaking the Kitty keyboard
 * protocol deliver.
 */
const KEY = /^(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/;
/** Why a key only the Kitty keyboard protocol delivers cannot be the pause key. */
const KITTY_ONLY = "terminals without the Kitty keyboard protocol never send it";

/** Pi's default keybindings with a modifier, every platform (docs/keybindings.md), normalized. */
const PI_KEYS = [
	"alt+b", "alt+backspace", "alt+d", "alt+delete", "alt+down", "alt+enter", "alt+f", "alt+left", "alt+p", "alt+q",
	"alt+right", "alt+up", "alt+v", "alt+y", "alt+z", "ctrl+-", "ctrl+]", "ctrl+a", "ctrl+alt+]", "ctrl+b",
	"ctrl+backspace", "ctrl+c", "ctrl+d", "ctrl+down", "ctrl+e", "ctrl+end", "ctrl+f", "ctrl+g", "ctrl+home", "ctrl+j",
	"ctrl+k", "ctrl+l", "ctrl+left", "ctrl+n", "ctrl+o", "ctrl+p", "ctrl+pagedown", "ctrl+pageup", "ctrl+q", "ctrl+r",
	"ctrl+right", "ctrl+s", "ctrl+shift+down", "ctrl+shift+f", "ctrl+shift+g", "ctrl+shift+up", "ctrl+t", "ctrl+u",
	"ctrl+up", "ctrl+v", "ctrl+w", "ctrl+x", "ctrl+y", "ctrl+z", "ctrl+shift+o", "ctrl+shift+p", "shift+enter",
	"shift+l", "shift+t", "shift+tab",
];
/** gentle-pi's default shortcuts (lib/keymaps.ts, history, todo). */
const GENTLE_KEYS = [
	"alt+k", "alt+g", "alt+u", "alt+l", "alt+a", "alt+s", "ctrl+shift+a", "ctrl+shift+j", "ctrl+shift+t", "ctrl+shift+r",
	"alt+shift+up", "alt+shift+down",
];
/** Keys a terminal keeps for itself (flow control, suspend) or cannot tell apart from another key. */
const TERMINAL_KEYS = ["ctrl+s", "ctrl+q", "ctrl+z", "ctrl+c", "ctrl+d", "ctrl+h", "ctrl+i", "ctrl+m"];

/** Puts the modifiers of `key` in one order, so "shift+ctrl+p" and "ctrl+shift+p" compare equal. */
function normalize(key: string): string {
	const parts = key.toLowerCase().split("+");
	const last = parts.pop() ?? "";
	const mods = MODIFIERS.filter((mod) => parts.includes(mod));
	return [...mods, last].join("+");
}

const TAKEN = new Map<string, string>();
for (const [owner, keys] of [
	["the terminal", TERMINAL_KEYS],
	["pi-reply-thread", ["alt+r"]],
	["gentle-pi", GENTLE_KEYS],
	["Pi", PI_KEYS],
] as const) {
	// The first owner listed wins: the terminal takes ctrl+s before Pi could see it.
	for (const key of keys) if (!TAKEN.has(normalize(key))) TAKEN.set(normalize(key), owner);
}

/** Why `text` cannot be the pause key, or its normalized form. */
export function parsePauseKey(text: string): { key: string } | { problem: string } {
	const parts = text.trim().toLowerCase().split("+");
	const last = parts.pop() ?? "";
	const known = parts.every((part) => (MODIFIERS as readonly string[]).includes(part)) && new Set(parts).size === parts.length;
	if (!known || !KEY.test(last) || !parts.some((part) => part !== "shift")) {
		return { problem: "it is not a key the reader can use (ctrl or alt, maybe with shift, plus a letter, digit or F1-F12, as alt+m)" };
	}
	if (parts.includes("super") || (parts.includes("ctrl") && /^[0-9]$/.test(last))) return { problem: KITTY_ONLY };
	const key = normalize(text.trim());
	const owner = TAKEN.get(key);
	return owner ? { problem: `${owner} already uses it` } : { key };
}

/** "alt+m" as people read it: "Alt+M". */
export function keyName(key: string): string {
	return key
		.split("+")
		.map((part) => (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
		.join("+");
}

/**
 * The pause key from `pauseKey` in `$XDG_CONFIG_HOME/pi-reply-reader/settings.json`, else Alt+M. An invalid or taken
 * key means Alt+M and a `problem` for the user. A missing, unreadable or invalid file means Alt+M without one (the
 * speed already reports a broken file). Nothing throws.
 */
export function loadPauseKey(env: NodeJS.ProcessEnv): { key: string; problem?: string } {
	const path = configFile(env, SETTINGS);
	if (!path) return { key: DEFAULT_PAUSE_KEY };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { key: DEFAULT_PAUSE_KEY };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("pauseKey" in parsed)) return { key: DEFAULT_PAUSE_KEY };
	const { pauseKey } = parsed as { pauseKey: unknown };
	const result = typeof pauseKey === "string" ? parsePauseKey(pauseKey) : { problem: "it must be a string, as \"alt+m\"" };
	if ("key" in result) return result;
	return {
		key: DEFAULT_PAUSE_KEY,
		problem: `Ignored pauseKey ${JSON.stringify(pauseKey)} in ${path}: ${result.problem}. ${keyName(DEFAULT_PAUSE_KEY)} pauses and resumes readings.`,
	};
}
