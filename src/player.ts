import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";

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

/** How often a player signalled by pid is checked for having ended during its grace. */
const POLL_MS = 50;
/** Players signalled by terminatePid whose grace has not run out, each settling when it ended or was SIGKILLed. */
const signalled = new Set<Promise<void>>();

/**
 * SIGTERM to the player `pid` (started at `start`), then SIGKILL after KILL_GRACE_MS if that same player of ours is
 * still there. Its timer does not keep this process alive: a process about to exit awaits signalledPlayersEnded()
 * first. Never throws.
 */
export function terminatePid(pid: number, start: string | undefined): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	const began = Date.now();
	const ended = new Promise<void>((done) => {
		const timer = setInterval(() => {
			if (isPlayer(pid, start) && Date.now() - began < KILL_GRACE_MS) return;
			clearInterval(timer);
			if (isPlayer(pid, start)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			done();
		}, POLL_MS);
		timer.unref();
	});
	signalled.add(ended);
	ended.then(() => signalled.delete(ended));
}

/**
 * Settles once every player this process signalled with terminatePid (a reaped orphan, a lock takeover) has exited or
 * been SIGKILLed (S13 e), so a command that exits right after never cuts the SIGKILL short.
 */
export async function signalledPlayersEnded(): Promise<void> {
	if (signalled.size === 0) return;
	// The grace timers are unref'd so they never hold Pi; this one holds the event loop while we wait for them.
	const hold = setInterval(() => {}, KILL_GRACE_MS);
	try {
		await Promise.all([...signalled]);
	} finally {
		clearInterval(hold);
	}
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
 * Ends every player whose reader is gone (S13): a process of this user, in this process's PID namespace, whose command
 * line carries PLAYER_MARK and whose OWNER_VAR names a process that no longer runs (a Pi killed with SIGKILL, say). A
 * paplay without both marks, whose reader still runs, or in another PID namespace (or one that cannot be read: an
 * owner pid means something only in its own namespace, so a reader in a sandbox keeps its player), is never touched.
 * A listener's `reply-reader --serve` (S20) carries PLAYER_MARK too, but is never reaped here: an OWNER_VAR it got from
 * the agent host (ssh SendEnv) names a process of another machine; it ends itself when its standard input closes.
 * Returns the pids it signalled; nothing where /proc is missing.
 */
export function reapOrphans(): number[] {
	let names: string[];
	const namespace = pidNamespace("self");
	if (namespace === undefined) return [];
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
			const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			if (!args.includes(PLAYER_MARK) || isListenerServe(args)) continue;
			if (pidNamespace(String(pid)) !== namespace) continue;
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

/**
 * Whether a command line is a listener's `reply-reader --serve` (S20): "--serve" right after the path of the
 * reply-reader script (`…/reply-reader`, `…/reply-reader.ts` or `.js`). The agent host's ssh child, whose remote
 * command is the bare word `reply-reader`, does not match, so an orphaned one is still reaped.
 */
export function isListenerServe(args: readonly string[]): boolean {
	const at = args.indexOf("--serve");
	if (at < 1) return false;
	const script = args[at - 1];
	return script.includes("/") && /^reply-reader(\.[cm]?[jt]s)?$/.test(script.slice(script.lastIndexOf("/") + 1));
}

/** The PID namespace of `/proc/<pid>` ("self" for this process), as `pid:[inode]`; undefined when unreadable. */
function pidNamespace(pid: string): string | undefined {
	try {
		return readlinkSync(`/proc/${pid}/ns/pid`);
	} catch {
		return undefined;
	}
}

/** The player timeout of S13 when REPLY_READER_PLAYER_TIMEOUT is unset or invalid. */
const DEFAULT_TIMEOUT_SECONDS = 15;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 86400;
/** The warning for an invalid REPLY_READER_PLAYER_TIMEOUT (S13 f). */
export const PLAYER_TIMEOUT_HINT = `REPLY_READER_PLAYER_TIMEOUT must be a number of seconds from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}; using ${DEFAULT_TIMEOUT_SECONDS}.`;

/**
 * The player timeout of S13 in milliseconds: REPLY_READER_PLAYER_TIMEOUT, whole or fractional seconds from 5 to 86400,
 * else 15 s; any value set but outside that (empty, `0`, `abc`, `3000000`) also returns the warning.
 */
export function playerTimeout(env: NodeJS.ProcessEnv): { ms: number; problem?: string } {
	const value = env.REPLY_READER_PLAYER_TIMEOUT;
	if (value === undefined) return { ms: DEFAULT_TIMEOUT_SECONDS * 1000 };
	const text = value.trim();
	const seconds = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
	if (seconds >= MIN_TIMEOUT_SECONDS && seconds <= MAX_TIMEOUT_SECONDS) return { ms: Math.round(seconds * 1000) };
	return { ms: DEFAULT_TIMEOUT_SECONDS * 1000, problem: PLAYER_TIMEOUT_HINT };
}

let timeoutWarned = false;

/** playerTimeout's milliseconds, telling `warn` about an invalid value once per process (S13 f). */
export function playerTimeoutMs(env: NodeJS.ProcessEnv, warn: (message: string) => void): number {
	const { ms, problem } = playerTimeout(env);
	if (problem && !timeoutWarned) {
		timeoutWarned = true;
		warn(problem);
	}
	return ms;
}

/** How long the one-time setpriv check may take before it is ended and setpriv is not used. */
const DEATH_SIGNAL_CHECK_MS = 2000;
/** The result of each setpriv path's check, once it ended. */
const deathSignal = new Map<string, boolean>();
const deathSignalChecks = new Map<string, Promise<boolean>>();

/**
 * Whether `setpriv` (a path) runs and supports `--pdeathsig KILL` (S13 h): checked once per path, in the background,
 * by running `setpriv --pdeathsig KILL <setpriv> --version` (setpriv itself as the program: no shell assumed). The
 * check never blocks the JS thread; one that has not ended within 2 s is ended and counts as not supported, as does a
 * setpriv that cannot be run (missing, not executable). Started by withDeathSignal at its first use, or earlier (a Pi
 * session's start), so the first reading may already use it; the CLI and `--serve` await it before their first player
 * (Pi never does). Like a player, the check is SIGKILLed if this process exits while it runs.
 */
export function checkDeathSignal(setpriv: string | undefined): Promise<boolean> {
	if (!setpriv) return Promise.resolve(false);
	let check = deathSignalChecks.get(setpriv);
	if (check) return check;
	check = new Promise<boolean>((done) => {
		let child: ChildProcess;
		try {
			child = spawn(setpriv, ["--pdeathsig", "KILL", setpriv, "--version"], { stdio: "ignore" });
		} catch {
			done(false);
			return;
		}
		// Only the check we started is ever signalled; it keeps this process alive at most that long, and dies with it.
		track(child);
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {}
			done(false);
		}, DEATH_SIGNAL_CHECK_MS);
		timer.unref();
		child.once("error", () => {
			clearTimeout(timer);
			done(false);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			done(code === 0);
		});
	}).then((works) => {
		deathSignal.set(setpriv, works);
		return works;
	});
	deathSignalChecks.set(setpriv, check);
	return check;
}

/**
 * The command and arguments that start `command` so it gets SIGKILL when this process dies (S13 h), however it dies:
 * `setpriv --pdeathsig KILL` once setpriv (`setpriv`, found by the caller on PATH) passed checkDeathSignal, else
 * `command` alone; until the check has passed (it starts here at the first use), players start without it. Checked
 * under Pi's Bun (T37): a player started through it from the JS thread is not cut while its reader runs, and dies
 * when the reader is SIGKILLed.
 */
export function withDeathSignal(setpriv: string | undefined, command: string, args: string[]): [string, string[]] {
	if (!setpriv) return [command, args];
	const works = deathSignal.get(setpriv);
	if (works === undefined) void checkDeathSignal(setpriv);
	return works ? [setpriv, ["--pdeathsig", "KILL", command, ...args]] : [command, args];
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
