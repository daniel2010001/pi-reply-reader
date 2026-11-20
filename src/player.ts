import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";

/** Every player we start carries this argument, so a pid can be told apart from an unrelated process. */
export const PLAYER_MARK = "--client-name=pi-reply-reader";

/**
 * Set in each player's environment to `<pid>:<start time>` of the process that started it (S13), so a later reading
 * can tell a player whose reader is gone from one that still has a reader, and from a paplay that is not ours.
 */
export const OWNER_VAR = "PI_REPLY_READER_OWNER";

/** How long a player gets to end after SIGTERM before SIGKILL (S13): paplay stuck connecting may ignore SIGTERM. */
export const KILL_GRACE_MS = 2000;

/** The value of OWNER_VAR for players started by this process. */
export function ownerTag(): string {
	return `${process.pid}:${startTime(process.pid) ?? ""}`;
}

const ending = new WeakSet<ChildProcess>();

/** SIGTERM to a player we started, then SIGKILL after KILL_GRACE_MS if it has not exited. Never throws. */
export function terminate(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {}
	if (ending.has(child)) return;
	ending.add(child);
	const timer = setTimeout(() => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			child.kill("SIGKILL");
		} catch {}
	}, KILL_GRACE_MS);
	child.once("exit", () => clearTimeout(timer));
}

/**
 * SIGTERM to the player `pid` (started at `start`), then SIGKILL after KILL_GRACE_MS if that same player of ours is
 * still there. The timer does not keep this process alive. Never throws.
 */
export function terminatePid(pid: number, start: string | undefined): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	setTimeout(() => {
		if (!isPlayer(pid, start)) return;
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}, KILL_GRACE_MS).unref();
}

const live = new Set<ChildProcess>();
let exitHooked = false;

/**
 * Keeps `child` until it exits; if this process exits first (Pi quitting without session_shutdown, the CLI's
 * process.exit), the player is killed with it instead of playing or hanging on, orphaned (S13).
 */
export function track(child: ChildProcess): void {
	live.add(child);
	child.once("exit", () => live.delete(child));
	if (exitHooked) return;
	exitHooked = true;
	process.on("exit", () => {
		for (const player of live) {
			try {
				player.kill("SIGKILL");
			} catch {}
		}
	});
}

/**
 * Ends every player whose reader is gone (S13): a process of this user whose command line carries PLAYER_MARK and
 * whose OWNER_VAR names a process that no longer runs (a Pi killed with SIGKILL, say). A paplay without both marks,
 * or whose reader still runs, is never touched. Returns the pids it signalled; nothing where /proc is missing.
 */
export function reapOrphans(): number[] {
	let names: string[];
	try {
		names = readdirSync("/proc");
	} catch {
		return [];
	}
	const uid = process.getuid?.();
	const reaped: number[] = [];
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		if (pid === process.pid) continue;
		try {
			if (uid !== undefined && statSync(`/proc/${pid}`).uid !== uid) continue;
			if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(PLAYER_MARK)) continue;
			const tag = readFileSync(`/proc/${pid}/environ`, "utf8")
				.split("\0")
				.find((entry) => entry.startsWith(`${OWNER_VAR}=`));
			if (!tag) continue;
			const [owner, start] = tag.slice(OWNER_VAR.length + 1).split(":");
			const ownerPid = Number(owner);
			if (!Number.isInteger(ownerPid) || ownerPid <= 0) continue;
			if (sameProcess(ownerPid, start || undefined)) continue;
			terminatePid(pid, startTime(pid));
			reaped.push(pid);
		} catch {}
	}
	return reaped;
}

/** A live process of this user with that pid, started when recorded (when recorded). */
export function sameProcess(pid: number, start: string | undefined): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	return start === undefined || startTime(pid) === start;
}

/** Guards against pid reuse: only a live player we started, of this user, may be signalled. */
export function isPlayer(pid: number, start: string | undefined): boolean {
	if (!sameProcess(pid, start)) return false;
	try {
		if (process.getuid && statSync(`/proc/${pid}`).uid !== process.getuid()) return false;
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(PLAYER_MARK);
	} catch {
		return false;
	}
}

/** Field 22 of /proc/<pid>/stat, the process start time; undefined where /proc is missing. */
export function startTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}
