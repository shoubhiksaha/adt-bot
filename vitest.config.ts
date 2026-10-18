import { configDefaults, defineConfig } from "vitest/config";

// Feature work happens in git worktrees under .claude/; never pick up their copies of the tests.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
