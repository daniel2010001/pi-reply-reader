import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { openReadingLock } from "./reading-lock.ts";

/**
 * A reading's project (S19): the folder name of the Git root its working folder is in, else of the working folder
 * itself. The root is the nearest folder upward holding a `.git`, found without running git. A `.git` file names its
 * gitdir: a linked worktree's holds `commondir`, so it is the same repo and is named by the folder of the main
 * `.git`; a submodule's does not, so it keeps its own folder name.
 */
export function projectOf(cwd: string): string {
	const start = resolve(cwd);
	for (let dir = start; ; dir = dirname(dir)) {
		const git = resolve(dir, ".git");
		if (existsSync(git)) return mainRepo(dir, git) ?? (basename(dir) || dir);
		if (dirname(dir) === dir) return basename(start) || start;
	}
}

/** For a linked worktree (its `.git` a file whose gitdir holds `commondir`), the main repository's folder name. */
function mainRepo(dir: string, git: string): string | undefined {
	try {
		if (!statSync(git).isFile()) return undefined;
		const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(git, "utf8"))?.[1];
		if (!gitdir) return undefined;
		const resolved = resolve(dir, gitdir);
		const common = readFileSync(resolve(resolved, "commondir"), "utf8").trim();
		if (!common) return undefined;
		const main = dirname(resolve(resolved, common));
		return basename(main) || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Records `project` as the machine's last reading's (S19) and says whether it must be announced: it differs from the
 * one remembered, or none was. The memory is shared next to the reading lock by every Pi session and the
 * `reply-reader` command; without a usable XDG_RUNTIME_DIR it is `local`, the caller's own (a process's).
 */
export function projectChanged(env: NodeJS.ProcessEnv, project: string, local: { last?: string }): boolean {
	const lock = openReadingLock(env);
	const previous = lock ? lock.swapProject(project) : local.last;
	if (!lock) local.last = project;
	return previous !== project;
}
