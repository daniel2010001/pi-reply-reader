import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { configFile } from "./outputs.ts";
import { saveSettings } from "./settings.ts";
import { onPath } from "./voice.ts";

/**
 * Music steps aside while the reader speaks (S22). settings.json `music`: `{ "mode": "off" | "pause" | "duck",
 * "level": 20, "before": "<command>", "after": "<command>" }`; nothing saved means duck to 20 %.
 *
 * Built in: gentle-stream (`gentle-stream ctl status --json`, `ctl volume N`, `ctl pause`, `ctl play`). Hooks: `before`
 * and `after` run at the same moments, whatever the mode, through `/bin/sh -c` as the user (they come from the user's
 * own settings file; nothing from a reply is ever put in them).
 *
 * Once per machine: the state the music was in before it stepped aside is kept in `$XDG_RUNTIME_DIR/pi-reply-reader/
 * music.json` (in memory without XDG_RUNTIME_DIR). Its presence means "the music is aside": a later reading leaves it
 * so (no flapping between queued readings), and whoever finds the machine idle with nothing waiting restores it, a
 * session start included (a reader that died left it aside). Every command runs detached, with a timeout, and is never
 * awaited by speech.
 */
export type MusicMode = "off" | "pause" | "duck";
export interface MusicSettings {
	mode: MusicMode;
	/** The volume, 0-100, that duck lowers the music to (never raising it). */
	level: number;
	before?: string;
	after?: string;
}

export const DEFAULT_MUSIC: MusicSettings = { mode: "duck", level: 20 };
export const MUSIC_MODES: readonly MusicMode[] = ["off", "pause", "duck"];
export const MUSIC_HINT = "Use /read-music off, pause, or duck with a level from 0 to 100.";
export const LEVEL_HINT = "Level must be a whole number from 0 to 100.";
/** How long a gentle-stream call or a hook may take before it is ended. */
export const MUSIC_TIMEOUT_MS = 3000;
/**
 * How long `--serve` keeps the listener's music aside after a reading ends, so the agent host's next reading in its
 * line (a 1.5 s gap plus a new ssh) finds it still aside (S22: no flapping).
 */
export const LISTENER_HOLD_MS = 4000;

const SETTINGS = "settings.json";

/** "Music goes down to 20 % while reading." and the like; `will` for a change. */
export function describeMusic(settings: MusicSettings, will = false): string {
	const what =
		settings.mode === "duck"
			? `${will ? "will go" : "goes"} down to ${settings.level} % while reading.`
			: settings.mode === "pause"
				? `${will ? "will pause" : "pauses"} while reading.`
				: `${will ? "will be" : "is"} left as it is while reading.`;
	return `Music ${what}`;
}

/** The music settings from settings.json; a bad `music` value means the default and a `problem`. Nothing throws. */
export function loadMusic(env: NodeJS.ProcessEnv): { music: MusicSettings; problem?: string } {
	const path = configFile(env, SETTINGS);
	if (!path) return { music: DEFAULT_MUSIC };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// A missing file is the default; an unreadable or invalid one is reported with the speed (S3).
		return { music: DEFAULT_MUSIC };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("music" in parsed)) return { music: DEFAULT_MUSIC };
	const raw = (parsed as { music: unknown }).music;
	const ignored = (reason: string) => ({
		music: DEFAULT_MUSIC,
		problem: `Ignored "music" in ${path}: ${reason}. ${describeMusic(DEFAULT_MUSIC)}`,
	});
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ignored("expected an object");
	const { mode, level, before, after } = raw as Record<string, unknown>;
	if (mode !== undefined && !MUSIC_MODES.includes(mode as MusicMode)) return ignored("mode must be off, pause or duck");
	if (level !== undefined && !validLevel(level)) return ignored("level must be a whole number from 0 to 100");
	for (const hook of [before, after]) if (hook !== undefined && (typeof hook !== "string" || !hook.trim())) return ignored("before and after must be commands");
	return {
		music: {
			mode: (mode as MusicMode | undefined) ?? DEFAULT_MUSIC.mode,
			level: (level as number | undefined) ?? DEFAULT_MUSIC.level,
			...(before ? { before: before as string } : {}),
			...(after ? { after: after as string } : {}),
		},
	};
}

const validLevel = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;

/**
 * `/read-music` arguments: `show` for none; else the mode and level to set, or the warning. A bare level means duck.
 */
export function parseMusicArgs(text: string): "show" | { mode: MusicMode; level?: number } | { problem: string } {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "show";
	const number = (word: string): number | undefined | "bad" => {
		if (!/^[-+]?\d*[.,]?\d+%?$/.test(word)) return undefined;
		const value = Number(word.replace("%", "").replace(",", "."));
		return validLevel(value) && /^\d+%?$/.test(word) ? value : "bad";
	};
	const [first, second] = words;
	const bare = number(first);
	if (bare !== undefined) return words.length === 1 && bare !== "bad" ? { mode: "duck", level: bare } : { problem: bare === "bad" ? LEVEL_HINT : MUSIC_HINT };
	if (!MUSIC_MODES.includes(first as MusicMode)) return { problem: MUSIC_HINT };
	if (words.length === 1) return { mode: first as MusicMode };
	if (first !== "duck" || words.length > 2) return { problem: MUSIC_HINT };
	const level = number(second);
	if (level === undefined) return { problem: MUSIC_HINT };
	if (level === "bad") return { problem: LEVEL_HINT };
	return { mode: "duck", level };
}

/** Saves the mode (and level) in settings.json `music`, keeping its hooks and every other key; throws as saveSettings. */
export function saveMusic(env: NodeJS.ProcessEnv, values: { mode: MusicMode; level?: number }): void {
	let existing: Record<string, unknown> = {};
	const path = configFile(env, SETTINGS);
	try {
		const music = (JSON.parse(readFileSync(path ?? "", "utf8")) as { music?: unknown })?.music;
		if (music && typeof music === "object" && !Array.isArray(music)) existing = music as Record<string, unknown>;
	} catch {}
	saveSettings(env, { music: { ...existing, ...values } });
}

/** What the music was before it stepped aside; written to music.json. */
interface State {
	token: string;
	/** Not yet known while gentle-stream's status is being read. */
	pending?: true;
	/** gentle-stream's music as it was, and the volume the duck set (`set`). */
	music?: { mode: "duck" | "pause"; volume: number; playing: boolean; set?: number };
	/** A hook was configured at the step-aside: `after` runs at the restore. */
	hook?: true;
	/**
	 * The `after` hook as it was at the step-aside ("" for none), run at the restore: a setting changed meanwhile never
	 * unbalances before and after (S22). A state without it (written by 0.2.0) runs the `after` of the settings then.
	 */
	after?: string;
	/** `--serve` keeps it aside until then (ms), for the agent host's next reading (S22). */
	hold?: number;
}

interface Store {
	read(): State | undefined;
	/** Creates the state when none is there; false when one already is. */
	create(state: State): boolean;
	write(state: State): void;
	remove(token: string): void;
	/** Removes a state that is there but broken (empty, not JSON, values out of range); a valid one stays. */
	clear(): void;
}

/** The music state in `$XDG_RUNTIME_DIR/pi-reply-reader/music.json`, else in this process's memory. */
function openStore(env: NodeJS.ProcessEnv): Store {
	const runtime = env.XDG_RUNTIME_DIR;
	let dir: string | undefined;
	if (runtime && isAbsolute(runtime)) {
		try {
			dir = join(runtime, "pi-reply-reader");
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			if (!statSync(dir).isDirectory()) dir = undefined;
		} catch {
			dir = undefined;
		}
	}
	if (!dir) return memory;
	const file = join(dir, "music.json");
	const read = (): State | undefined => {
		try {
			return validState(JSON.parse(readFileSync(file, "utf8")));
		} catch {
			return undefined;
		}
	};
	/** Writes `state` to a temporary file and puts it in place with `put`; false when that failed. */
	const place = (state: State, put: (temp: string) => void): boolean => {
		const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
			put(temp);
			return true;
		} catch {
			return false;
		} finally {
			try {
				unlinkSync(temp);
			} catch {}
		}
	};
	return {
		read,
		create(state) {
			// Linked in place whole: no other process ever reads it half written, and only one creates it.
			if (place(state, (temp) => linkSync(temp, file))) return true;
			// A file that is broken, empty or holds values out of range is no state: it is replaced, atomically.
			if (!existsSync(file) || read()) return false;
			return place(state, (temp) => renameSync(temp, file)) && read()?.token === state.token;
		},
		write(state) {
			place(state, (temp) => renameSync(temp, file));
		},
		remove(token) {
			if (read()?.token !== token) return;
			try {
				unlinkSync(file);
			} catch {}
		},
		clear() {
			// A broken file is removed: the music handling recovers by itself.
			if (!existsSync(file) || read()) return;
			try {
				unlinkSync(file);
			} catch {}
		},
	};
}

const wholeVolume = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;

/**
 * The state as music.json holds it, checked before any of it reaches gentle-stream: a whole volume from 0 to 100,
 * booleans, a known mode. Anything else is no state (undefined).
 */
function validState(value: unknown): State | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { token, pending, music, hook, after, hold } = value as Record<string, unknown>;
	if (typeof token !== "string" || !token) return undefined;
	if (pending !== undefined && pending !== true) return undefined;
	if (hook !== undefined && hook !== true) return undefined;
	if (after !== undefined && typeof after !== "string") return undefined;
	if (hold !== undefined && (typeof hold !== "number" || !Number.isFinite(hold))) return undefined;
	if (music !== undefined) {
		if (!music || typeof music !== "object" || Array.isArray(music)) return undefined;
		const { mode, volume, playing, set } = music as Record<string, unknown>;
		if (mode !== "duck" && mode !== "pause") return undefined;
		if (!wholeVolume(volume) || typeof playing !== "boolean") return undefined;
		if (set !== undefined && !wholeVolume(set)) return undefined;
	}
	return value as State;
}

let remembered: State | undefined;
const memory: Store = {
	read: () => remembered,
	create(state) {
		if (remembered) return false;
		remembered = state;
		return true;
	},
	write(state) {
		remembered = state;
	},
	remove(token) {
		if (remembered?.token === token) remembered = undefined;
	},
	clear() {},
};

/** gentle-stream's `ctl status --json`, as far as it is read. */
interface Status {
	running: boolean;
	playing: boolean;
	volume?: number;
}

export interface Music {
	/**
	 * The machine's line went idle → reading (or a resume): steps the music aside unless it already is. True when the
	 * music is aside for this reading (stepped aside now, or kept so); false when there was nothing to step aside (mode
	 * off without hooks, no gentle-stream).
	 */
	stepAside(): boolean;
	/**
	 * Restores the music when the machine is idle with nothing waiting (`force`: at once, as for a pause). Once restored,
	 * a later reading steps it aside again.
	 */
	settle(options?: { force?: boolean; holdMs?: number }): void;
	/** Resolves once every command started so far has ended (bounded by their timeouts). */
	idle(): Promise<void>;
}

/**
 * The step-aside of one reader process. `settings()` gives the music settings at each step; `idle()` whether nothing
 * reads or waits on the machine; `warn` is told about a hook or gentle-stream that failed or hung (the caller says it
 * once per session).
 */
export function createMusic(deps: {
	env: NodeJS.ProcessEnv;
	settings: () => MusicSettings;
	idle: () => boolean;
	warn: (message: string) => void;
}): Music {
	const { env } = deps;
	/** Opened at the first use, so a reader that never steps aside creates nothing. */
	let opened: Store | undefined;
	const store: Store = {
		read: () => (opened ??= openStore(env)).read(),
		create: (state) => (opened ??= openStore(env)).create(state),
		write: (state) => (opened ??= openStore(env)).write(state),
		remove: (token) => (opened ??= openStore(env)).remove(token),
		clear: () => (opened ??= openStore(env)).clear(),
	};
	/** Commands of this process run in order: a restore never overtakes the step-aside it undoes. */
	let chain: Promise<void> = Promise.resolve();
	const later = (task: () => Promise<void>): void => {
		chain = chain.then(task).catch(() => {});
	};

	const hook = (which: "before" | "after", command: string | undefined): void => {
		if (!command) return;
		// Not chained: a slow hook never holds gentle-stream back, nor speech.
		const done = run("/bin/sh", ["-c", command], env).then(({ code, timedOut, error }) => {
			if (timedOut) deps.warn(`Music hook "${which}" timed out after ${MUSIC_TIMEOUT_MS / 1000} s; it was ended.`);
			else if (error) deps.warn(`Music hook "${which}" failed (${error}).`);
			else if (code !== 0) deps.warn(`Music hook "${which}" failed (exit code ${code}).`);
		});
		pendingHooks.add(done);
		void done.finally(() => pendingHooks.delete(done));
	};
	const pendingHooks = new Set<Promise<void>>();

	/** gentle-stream on PATH, run with `args`; undefined when it is not there. A hang or failure other than exit 1 warns. */
	const ctl = async (gentle: string, args: string[]): Promise<{ code: number | null; out: string } | undefined> => {
		const result = await run(gentle, ["ctl", ...args], env, true);
		if (result.timedOut) {
			deps.warn(`gentle-stream did not answer within ${MUSIC_TIMEOUT_MS / 1000} s; the music was left as it is.`);
			return undefined;
		}
		if (result.error) {
			deps.warn(`gentle-stream failed (${result.error}).`);
			return undefined;
		}
		// Exit 1: nothing plays (S22); said by no one.
		if (result.code !== 0 && result.code !== 1) deps.warn(`gentle-stream ctl ${args.join(" ")} failed (exit code ${result.code}).`);
		return { code: result.code, out: result.out };
	};
	const status = async (gentle: string): Promise<Status | undefined> => {
		const result = await ctl(gentle, ["status", "--json"]);
		if (!result) return undefined;
		try {
			const parsed = JSON.parse(result.out) as Record<string, unknown>;
			const volume = typeof parsed.volume === "number" && Number.isFinite(parsed.volume) ? Math.round(parsed.volume) : undefined;
			return { running: parsed.running !== false && parsed.ok !== false, playing: parsed.playing === true, volume };
		} catch {
			return undefined;
		}
	};

	return {
		stepAside() {
			const settings = deps.settings();
			const gentle = settings.mode === "off" ? undefined : onPath("gentle-stream", env);
			const existing = store.read();
			if (existing) {
				// Already aside (an earlier reading of the line, or a reader that died): a newer reading keeps it so.
				if (existing.hold !== undefined) {
					const { hold: _hold, ...rest } = existing;
					store.write(rest);
				}
				return true;
			}
			if (!gentle && !settings.before && !settings.after) return false;
			const state: State = {
				token: randomUUID(),
				pending: true,
				...(settings.before || settings.after ? { hook: true as const, after: settings.after ?? "" } : {}),
			};
			// Another reader created it meanwhile: the music is aside all the same.
			if (!store.create(state)) return true;
			hook("before", settings.before);
			later(async () => {
				let music: State["music"];
				const now = gentle ? await status(gentle) : undefined;
				if (gentle && now?.running && now.playing && now.volume !== undefined) {
					music =
						settings.mode === "pause"
							? { mode: "pause", volume: now.volume, playing: true }
							: { mode: "duck", volume: now.volume, playing: true, set: Math.min(settings.level, now.volume) };
				}
				// Restored (or taken over) while the status was read: nothing to step aside.
				if (store.read()?.token !== state.token) return;
				if (!music && !state.hook) return store.remove(state.token);
				const { pending: _pending, ...known } = store.read() ?? state;
				store.write({ ...known, ...(music ? { music } : {}) });
				if (!gentle || !music) return;
				if (music.mode === "pause") await ctl(gentle, ["pause"]);
				else if (music.set !== undefined && music.set < music.volume) await ctl(gentle, ["volume", String(music.set)]);
			});
			return true;
		},
		settle(options = {}) {
			const state = store.read();
			if (!state) {
				// A broken music.json is no state; once idle it is removed, so the next reading starts afresh.
				if (options.force || deps.idle()) store.clear();
				return;
			}
			if (!options.force) {
				if (!deps.idle()) return;
				if (state.hold !== undefined && Date.now() < state.hold) return;
			}
			store.remove(state.token);
			// The after paired with the before that ran, as recorded at the step-aside.
			if (state.hook) hook("after", state.after !== undefined ? state.after || undefined : deps.settings().after);
			const saved = state.music;
			if (!saved) return;
			later(async () => {
				const gentle = onPath("gentle-stream", env);
				if (!gentle) return;
				const now = await status(gentle);
				if (!now?.running) return;
				if (saved.mode === "duck") {
					// The user set another volume since the duck: theirs stays.
					if (saved.set !== undefined && saved.set !== saved.volume && now.volume === saved.set) await ctl(gentle, ["volume", String(saved.volume)]);
				} else if (!now.playing && now.volume === saved.volume) {
					// Still as the pause left it; a volume the user changed means they took over, and it stays paused.
					await ctl(gentle, ["play"]);
				}
			});
		},
		async idle() {
			for (;;) {
				const before = chain;
				await Promise.all([chain, ...pendingHooks]);
				if (before === chain && pendingHooks.size === 0) return;
			}
		},
	};
}

/**
 * Keeps the music aside for `ms` more (the listener between the agent host's readings, S22); then settle restores it.
 * `ms` 0 ends a hold at once.
 */
export function holdMusic(env: NodeJS.ProcessEnv, ms: number): boolean {
	const store = openStore(env);
	const state = store.read();
	if (!state) return false;
	store.write({ ...state, hold: Date.now() + ms });
	return true;
}

/**
 * Runs `command` detached, in its own process group, ended whole (SIGTERM, then SIGKILL) after MUSIC_TIMEOUT_MS.
 * Only what it started is ever signalled. Its output is read when `capture`.
 */
function run(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	capture = false,
): Promise<{ code: number | null; out: string; timedOut: boolean; error?: string }> {
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(command, args, { env, detached: true, stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"] });
		} catch (error) {
			resolve({ code: null, out: "", timedOut: false, error: (error as Error).message });
			return;
		}
		let out = "";
		let timedOut = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			if (out.length < 65536) out += chunk.toString();
		});
		const group = (signal: NodeJS.Signals): void => {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, signal);
			} catch {}
		};
		let kill: NodeJS.Timeout | undefined;
		const ended = (): void => {
			clearTimeout(timer);
			clearTimeout(kill);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			group("SIGTERM");
			kill = setTimeout(() => group("SIGKILL"), 1000);
			kill.unref?.();
		}, MUSIC_TIMEOUT_MS);
		timer.unref?.();
		child.on("error", (error) => {
			ended();
			resolve({ code: null, out, timedOut: false, error: error.message });
		});
		child.on("close", (code) => {
			ended();
			resolve({ code, out, timedOut });
		});
	});
}
