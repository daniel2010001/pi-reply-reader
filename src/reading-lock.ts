import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isPlayer, sameProcess, startTime, terminatePid } from "./player.ts";

export { PLAYER_MARK } from "./player.ts";

/**
 * The reading playing on this machine, shared by every Pi session and process of this user (S1, T21):
 * `$XDG_RUNTIME_DIR/pi-reply-reader/reading.json`. `token` names one reading; `stopped` marks an entry left by
 * `/read-stop`, which tells the reading it named that it was stopped. Start times come from /proc, so a pid that was
 * reused by a newer process does not count as the one recorded. Next to it, `waiting.json` holds the waiting mark of
 * the auto-read queue (S8, T32) and `reading.lock` is a short mutex around each check-and-write.
 */
interface Entry {
	token: string;
	pid: number;
	pidStart?: string;
	player?: number;
	playerStart?: string;
	started: number;
	stopped?: true;
}

/** One reading's hold on the machine. Nothing here throws. */
export interface Claim {
	/** Records the reading's player; false when a newer reading or `/read-stop` took over before it started. */
	setPlayer(pid: number): boolean;
	/** Whether a newer reading or `/read-stop` from any session took over. */
	lost(): boolean;
	/** Drops the entry if it is still this reading's. */
	release(): void;
}

export interface ReadingLock {
	/**
	 * Makes a new reading the one playing on the machine, stopping the one playing in any other session. With
	 * `dropWaiting` (an explicit /read, S8) it also drops every auto-read waiting on the machine at that moment.
	 */
	claim(options?: { dropWaiting?: boolean }): Claim;
	/**
	 * For auto-read (S8 Queue, T32): claims the machine only when no reading plays, and only when no explicit action
	 * dropped the waiting replies since `mark` was taken. Never stops a reading.
	 */
	claimIfFree(mark: string | undefined): Claim | "busy" | "dropped";
	/** Whether a reading plays (or is starting) in any session; stale entries do not count. */
	busy(): boolean;
	/** The current waiting mark; a reply queued now remembers it, and drops itself once it changes. */
	waitingMark(): string | undefined;
	/** Drops every auto-read waiting on the machine (Esc, S8). */
	dropWaiting(): void;
	/** Stops the reading playing in another session, if any, and drops every waiting auto-read; true when one was playing. */
	stopOthers(): boolean;
}

/** How long an explicit action waits for the mutex before acting anyway; an auto-read just tries later. */
const MUTEX_WAIT_MS = 200;
/** A mutex file still empty after this long was left by a process that died while taking it. */
const MUTEX_STALE_MS = 1000;

/**
 * The machine-wide lock under `$XDG_RUNTIME_DIR`, or undefined when it is unset, relative or unusable: then each
 * session only stops its own readings, as before.
 */
export function openReadingLock(env: NodeJS.ProcessEnv): ReadingLock | undefined {
	const runtime = env.XDG_RUNTIME_DIR;
	if (!runtime || !isAbsolute(runtime)) return undefined;
	const dir = join(runtime, "pi-reply-reader");
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (!statSync(dir).isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	const file = join(dir, "reading.json");
	/** `{ mark }`: rewritten by every explicit action, so replies queued before it know they were dropped (S8). */
	const marks = join(dir, "waiting.json");
	/** Held for the few microseconds of a check-and-write, so two sessions never both take a free machine (T32). */
	const mutex = join(dir, "reading.lock");

	const read = (): Entry | undefined => {
		try {
			const entry = JSON.parse(readFileSync(file, "utf8")) as Entry;
			if (typeof entry?.token !== "string" || !Number.isInteger(entry.pid)) return undefined;
			if (entry.player !== undefined && !Number.isInteger(entry.player)) return undefined;
			return entry;
		} catch {
			return undefined;
		}
	};

	/** Written whole, then renamed into place, so a reader never sees half a file. */
	const put = (path: string, token: string, data: unknown): void => {
		const temp = `${path}.${process.pid}.${token}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
			renameSync(temp, path);
		} catch {
			try {
				unlinkSync(temp);
			} catch {}
		}
	};
	const write = (entry: Entry): void => put(file, entry.token, entry);

	const waitingMark = (): string | undefined => {
		try {
			const mark = (JSON.parse(readFileSync(marks, "utf8")) as { mark?: unknown })?.mark;
			return typeof mark === "string" ? mark : undefined;
		} catch {
			return undefined;
		}
	};
	const dropWaiting = (): void => {
		const mark = randomUUID();
		put(marks, mark, { mark });
	};

	/**
	 * Runs `body` holding the machine's mutex. When it cannot be had in time, `timeout` decides: explicit actions act
	 * anyway (as before T32), auto-read tries again later. A mutex left by a dead process is broken.
	 */
	const exclusive = <T>(body: () => T, timeout: () => T): T => {
		const deadline = Date.now() + MUTEX_WAIT_MS;
		for (;;) {
			let fd: number;
			try {
				fd = openSync(mutex, "wx", 0o600);
			} catch (error) {
				// Anything but "held" (a read-only folder, say) means no mutex at all, as before T32.
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return body();
				if (abandoned()) {
					try {
						unlinkSync(mutex);
						continue;
					} catch {
						// Not deletable (a read-only folder, say): it counts as held, so the deadline still bounds the wait.
					}
				}
				if (Date.now() > deadline) return timeout();
				pause(2);
				continue;
			}
			try {
				try {
					writeSync(fd, `${process.pid} ${startTime(process.pid) ?? ""}`);
				} finally {
					closeSync(fd);
				}
				return body();
			} finally {
				try {
					unlinkSync(mutex);
				} catch {}
			}
		}
	};
	/** Whether the mutex was left by a process that is gone (or never wrote its pid). */
	const abandoned = (): boolean => {
		try {
			const [pid, start] = readFileSync(mutex, "utf8").split(" ");
			if (pid && Number.isInteger(Number(pid)) && Number(pid) > 0) return !sameProcess(Number(pid), start || undefined);
			return Date.now() - statSync(mutex).mtimeMs > MUTEX_STALE_MS;
		} catch {
			return false;
		}
	};

	/**
	 * Writes `entry` over the current one (always for a new reading; for `/read-stop` only when a reading plays) and
	 * stops the reading the current one names, if it still plays. The entry is written first, so the stopped
	 * session finds it lost when its player dies.
	 */
	const takeOver = (entry: Entry, always: boolean): boolean => {
		const previous = read();
		const live = previous !== undefined && playing(previous);
		if (always || live) write(entry);
		if (!live) return false;
		// SIGTERM, then SIGKILL if that player ignores it (S13): its own session may be hung or gone.
		if (previous.player !== undefined) terminatePid(previous.player, previous.playerStart);
		return true;
	};

	const self = (): Pick<Entry, "pid" | "pidStart" | "started"> => ({ pid: process.pid, pidStart: startTime(process.pid), started: Date.now() });

	/** The hold of the reading whose entry `mine` was just written. */
	const held = (mine: Entry): Claim => {
		const lost = (): boolean => {
			const entry = read();
			return entry !== undefined && entry.token !== mine.token;
		};
		const setPlayer = (pid: number): boolean => {
			if (lost()) return false;
			write({ ...mine, player: pid, playerStart: startTime(pid) });
			return true;
		};
		const release = (): void => {
			if (read()?.token !== mine.token) return;
			try {
				unlinkSync(file);
			} catch {}
		};
		return {
			setPlayer: (pid) => exclusive(() => setPlayer(pid), () => setPlayer(pid)),
			lost,
			release: () => exclusive(release, release),
		};
	};

	const busy = (): boolean => {
		const entry = read();
		return entry !== undefined && playing(entry);
	};

	return {
		claim(options = {}): Claim {
			const mine: Entry = { token: randomUUID(), ...self() };
			const take = (): void => {
				if (options.dropWaiting) dropWaiting();
				takeOver(mine, true);
			};
			exclusive(take, take);
			return held(mine);
		},
		claimIfFree(mark) {
			return exclusive<Claim | "busy" | "dropped">(
				() => {
					if (waitingMark() !== mark) return "dropped";
					if (busy()) return "busy";
					const mine: Entry = { token: randomUUID(), ...self() };
					write(mine);
					return held(mine);
				},
				() => "busy",
			);
		},
		busy,
		waitingMark,
		dropWaiting: () => exclusive(dropWaiting, dropWaiting),
		stopOthers: () => {
			const stop = (): boolean => {
				dropWaiting();
				return takeOver({ token: randomUUID(), ...self(), stopped: true }, false);
			};
			return exclusive(stop, stop);
		},
	};
}

/**
 * Whether `entry` names a reading that may still play: not a `/read-stop` mark, its process alive, and its player,
 * once started, still that player of ours.
 */
function playing(entry: Entry): boolean {
	if (entry.stopped || !sameProcess(entry.pid, entry.pidStart)) return false;
	return entry.player === undefined || isPlayer(entry.player, entry.playerStart);
}

/** Blocks this thread for `ms`; only ever a few milliseconds, while another process holds the mutex. */
function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
