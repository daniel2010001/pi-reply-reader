import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Every player we start carries this argument, so a pid can be told apart from an unrelated process. */
export const PLAYER_MARK = "--client-name=pi-reply-reader";

/**
 * The reading playing on this machine, shared by every Pi session and process of this user (S1, T21):
 * `$XDG_RUNTIME_DIR/pi-reply-reader/reading.json`. `token` names one reading; `stopped` marks an entry left by
 * `/read-stop`, which tells the reading it named that it was stopped. Start times come from /proc, so a pid that was
 * reused by a newer process does not count as the one recorded.
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
	/** Makes a new reading the one playing on the machine, stopping the one playing in any other session. */
	claim(): Claim;
	/** Stops the reading playing in another session, if any; true when one was playing. */
	stopOthers(): boolean;
}

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

	/** Written whole, then renamed into place, so a reader never sees half an entry. */
	const write = (entry: Entry): void => {
		const temp = `${file}.${process.pid}.${entry.token}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
			renameSync(temp, file);
		} catch {
			try {
				unlinkSync(temp);
			} catch {}
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
		if (previous.player !== undefined) {
			try {
				process.kill(previous.player, "SIGTERM");
			} catch {}
		}
		return true;
	};

	const self = (): Pick<Entry, "pid" | "pidStart" | "started"> => ({ pid: process.pid, pidStart: startTime(process.pid), started: Date.now() });

	return {
		claim(): Claim {
			const token = randomUUID();
			const mine: Entry = { token, ...self() };
			takeOver(mine, true);
			const lost = (): boolean => {
				const entry = read();
				return entry !== undefined && entry.token !== token;
			};
			return {
				setPlayer(pid) {
					if (lost()) return false;
					write({ ...mine, player: pid, playerStart: startTime(pid) });
					return true;
				},
				lost,
				release() {
					if (read()?.token !== token) return;
					try {
						unlinkSync(file);
					} catch {}
				},
			};
		},
		stopOthers: () => takeOver({ token: randomUUID(), ...self(), stopped: true }, false),
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

/** A live process of this user with that pid, started when recorded (when recorded). */
function sameProcess(pid: number, start: string | undefined): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	return start === undefined || startTime(pid) === start;
}

/** Guards against pid reuse: only a live player we started, of this user, may be signalled. */
function isPlayer(pid: number, start: string | undefined): boolean {
	if (!sameProcess(pid, start)) return false;
	try {
		if (process.getuid && statSync(`/proc/${pid}`).uid !== process.getuid()) return false;
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(PLAYER_MARK);
	} catch {
		return false;
	}
}

/** Field 22 of /proc/<pid>/stat, the process start time; undefined where /proc is missing. */
function startTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}
