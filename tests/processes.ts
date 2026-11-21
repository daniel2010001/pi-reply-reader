import { readdirSync, readFileSync } from "node:fs";

/**
 * Test hygiene (L138): every process a test started, found through `mark` (the test's own mkdtemp folder, a path no
 * other process names) and, for `groups`, the process groups of the sessions it spawned detached. Nothing else is
 * ever signalled: a group counts only while one of its members still names `mark` (so the group id was not reused),
 * and descendants are found through their parent while it still runs.
 */
export function processesOf(mark: string, groups: readonly number[] = []): number[] {
	const all = new Map<number, { state: string; ppid: number; pgrp: number; cmdline: string }>();
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = readFileSync(`/proc/${name}/stat`, "utf8");
			const [state, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			all.set(Number(name), { state, ppid: Number(ppid), pgrp: Number(pgrp), cmdline: readFileSync(`/proc/${name}/cmdline`, "utf8") });
		} catch {}
	}
	const ours = new Set<number>();
	for (const [pid, proc] of all) if (pid !== process.pid && proc.state !== "Z" && proc.cmdline.includes(mark)) ours.add(pid);
	const live = new Set(groups.filter((group) => [...ours].some((pid) => all.get(pid)?.pgrp === group)));
	for (const [pid, proc] of all) if (pid !== process.pid && proc.state !== "Z" && live.has(proc.pgrp)) ours.add(pid);
	// Descendants of ours are ours too (a player's `sleep`), whatever their command line.
	for (let grew = true; grew; ) {
		grew = false;
		for (const [pid, proc] of all) {
			if (pid === process.pid || proc.state === "Z" || ours.has(pid) || !ours.has(proc.ppid)) continue;
			ours.add(pid);
			grew = true;
		}
	}
	return [...ours];
}

/** SIGKILLs every process `processesOf` finds and waits (up to `ms`) until none is left; returns what it found first. */
export async function endProcessesOf(mark: string, groups: readonly number[] = [], ms = 3000): Promise<number[]> {
	const found = processesOf(mark, groups);
	const end = Date.now() + ms;
	for (let left = found; left.length > 0 && Date.now() < end; left = processesOf(mark, groups)) {
		for (const pid of left) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return found;
}
