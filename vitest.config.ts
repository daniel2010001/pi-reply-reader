import { configDefaults, defineConfig } from "vitest/config";

// Linked worktrees under .worktrees/ hold other branches' copies of the tests; never run them from here (L165).
export default defineConfig({
	test: { exclude: [...configDefaults.exclude, ".worktrees/**"] },
});
