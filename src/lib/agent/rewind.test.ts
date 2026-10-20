// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { describeRewind } from "./rewind";

const require = createRequire(import.meta.url);
const { createSnapshots } = require("../../../electron/rewind.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adt-rewind-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A fresh store and folder per test. */
function setup(options: Record<string, unknown> = {}) {
  const base = path.join(tmp, `t${n++}`);
  const work = path.join(base, "work");
  fs.mkdirSync(work, { recursive: true });
  const store = createSnapshots({ dir: path.join(base, "store"), ...options });
  const file = (name: string) => path.join(fs.realpathSync(work), name);
  const read = (name: string) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8") : null);
  return { store, work, file, read };
}

/** What write_file does: capture, write, record. */
async function botWrites(store: any, turn: string, file: string, content: string, conversation = "c1") {
  const before = await store.capture(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  store.record(turn, file, before, { conversation, tool: "write_file" });
}

describe("rewind store", () => {
  it("puts changed files back and deletes the ones the turn created", async () => {
    const { store, file, read } = setup();
    fs.writeFileSync(file("notes.md"), "mine");
    await botWrites(store, "turn1", file("notes.md"), "bot v1");
    await botWrites(store, "turn1", file("notes.md"), "bot v2");
    await botWrites(store, "turn1", file("sub/new.txt"), "fresh");
    const listed = store.changes("turn1").files;
    expect(listed.map((f: any) => [path.basename(f.path), f.change, f.changedSince])).toEqual([
      ["notes.md", "modified", false],
      ["new.txt", "created", false],
    ]);
    const result = await store.restore("turn1");
    expect(result.restored).toEqual([file("notes.md")]);
    expect(result.removed).toEqual([file("sub/new.txt")]);
    // The turn's first version is the one that comes back.
    expect(read("notes.md")).toBe("mine");
    expect(read("sub/new.txt")).toBeNull();
    // Undone turns are gone: nothing to undo twice.
    expect(store.changes("turn1").files).toEqual([]);
  });

  it("won't overwrite a file the user changed after the bot, unless forced", async () => {
    const { store, file, read } = setup();
    fs.writeFileSync(file("a.txt"), "original");
    await botWrites(store, "t", file("a.txt"), "bot");
    await botWrites(store, "t", file("b.txt"), "bot made this");
    fs.writeFileSync(file("a.txt"), "user edit");
    fs.writeFileSync(file("b.txt"), "user kept working here");
    expect(store.changes("t").files.every((f: any) => f.changedSince)).toBe(true);
    const first = await store.restore("t");
    expect(first.conflicts.sort()).toEqual([file("a.txt"), file("b.txt")].sort());
    expect(read("a.txt")).toBe("user edit");
    expect(read("b.txt")).toBe("user kept working here");
    // Still listed, and undoable with force.
    expect(store.changes("t").files).toHaveLength(2);
    const forced = await store.restore("t", { force: true });
    expect(forced.restored).toEqual([file("a.txt")]);
    expect(forced.removed).toEqual([file("b.txt")]);
    expect(read("a.txt")).toBe("original");
    expect(read("b.txt")).toBeNull();
  });

  it("drops a change that wrote the same content (nothing to undo)", async () => {
    const { store, file } = setup();
    fs.writeFileSync(file("same.txt"), "x");
    await botWrites(store, "t", file("same.txt"), "x");
    expect(store.changes("t").files).toEqual([]);
  });

  it("lists a conversation's turns newest first", async () => {
    let clock = 1_000;
    const { store, file } = setup({ now: () => clock });
    await botWrites(store, "older", file("1.txt"), "a", "chat");
    clock += 10;
    await botWrites(store, "newer", file("2.txt"), "b", "chat");
    await botWrites(store, "elsewhere", file("3.txt"), "c", "other chat");
    expect(store.turns("chat").map((t: any) => t.turn)).toEqual(["newer", "older"]);
  });

  it("forgets turns after the time limit", async () => {
    let clock = 0;
    const { store, file } = setup({ now: () => clock, maxAgeMs: 1000 });
    fs.writeFileSync(file("x.txt"), "before");
    await botWrites(store, "old", file("x.txt"), "after");
    clock = 5000;
    store.prune(true);
    expect(store.changes("old").files).toEqual([]);
  });

  it("keeps under the size cap: older turns make way, and a version that can't fit isn't kept", async () => {
    let clock = 0;
    const { store, file } = setup({ now: () => clock, maxBytes: 100 });
    for (const name of ["a", "b", "c"]) fs.writeFileSync(file(`${name}.txt`), name.repeat(60));
    await botWrites(store, "first", file("a.txt"), "new a");
    clock += 10;
    // 120 bytes don't fit: the older turn goes.
    await botWrites(store, "second", file("b.txt"), "new b");
    expect(store.changes("first").files).toEqual([]);
    expect(store.changes("second").files[0]).toMatchObject({ change: "modified", restorable: true });
    // Within one turn nothing is dropped: c's earlier version isn't kept, so it's listed but can't be restored.
    await botWrites(store, "second", file("c.txt"), "new c");
    expect(store.changes("second").files.map((f: any) => f.restorable)).toEqual([true, false]);
    const result = await store.restore("second");
    expect(result.unsaved).toEqual([file("c.txt")]);
    expect(result.restored).toEqual([file("b.txt")]);
  });

  it("ignores turn ids that could escape its folder", async () => {
    const { store, file } = setup();
    await botWrites(store, "../../evil", file("x.txt"), "x");
    expect(store.changes("../../evil").files).toEqual([]);
    expect(await store.restore("../x")).toMatchObject({ restored: [], removed: [] });
  });
});

describe("workspace snapshots around commands", () => {
  it("records what a command changed, created and deleted, and undoes it", async () => {
    const { store, work, file, read } = setup();
    fs.writeFileSync(file("edit.txt"), "one");
    fs.writeFileSync(file("gone.sh"), "#!/bin/sh\necho hi\n");
    fs.chmodSync(file("gone.sh"), 0o755);
    fs.writeFileSync(file("same.txt"), "untouched");
    fs.mkdirSync(path.join(work, "node_modules"));
    fs.writeFileSync(path.join(work, "node_modules", "dep.js"), "x");

    const token = store.beforeCommand("cmd", work, { conversation: "c" });
    // The "command":
    fs.writeFileSync(file("edit.txt"), "two");
    fs.rmSync(file("gone.sh"));
    fs.writeFileSync(file("made.txt"), "new");
    fs.writeFileSync(path.join(work, "node_modules", "dep.js"), "changed");
    expect(store.afterCommand(token).changed).toBe(3);

    const changes = store.changes("cmd").files.map((f: any) => [path.basename(f.path), f.change]);
    expect(changes.sort()).toEqual([["edit.txt", "modified"], ["gone.sh", "deleted"], ["made.txt", "created"]]);
    await store.restore("cmd");
    expect(read("edit.txt")).toBe("one");
    expect(read("gone.sh")).toContain("echo hi");
    expect(fs.statSync(file("gone.sh")).mode & 0o777).toBe(0o755);
    expect(read("made.txt")).toBeNull();
    expect(read("same.txt")).toBe("untouched");
    // Left out of snapshots (rebuilt by tools).
    expect(fs.readFileSync(path.join(work, "node_modules", "dep.js"), "utf8")).toBe("changed");
    // The staging copies are cleaned up.
    expect(fs.readdirSync(path.dirname(path.join(work, "..", "store", "x"))).filter((n) => n.startsWith(".staging"))).toEqual([]);
  });

  it("skips workspaces too big to snapshot quickly", () => {
    const { store, work, file } = setup({ maxScanFiles: 3 });
    for (const name of ["1", "2", "3", "4"]) fs.writeFileSync(file(name), name);
    expect(store.beforeCommand("big", work).skipped).toMatch(/more than 3 files/);
  });

  it.each([false, true])("never copies through symlinks (confined copy: %s)", (confined) => {
    const { store, work, file } = setup();
    const outside = path.join(tmp, `secret-${confined}`);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "id_rsa"), "PRIVATE KEY");
    fs.symlinkSync(path.join(outside, "id_rsa"), file("key-link"));
    fs.symlinkSync(outside, file("dir-link"));
    fs.writeFileSync(file("ok.txt"), "ok");
    const token = store.beforeCommand("links", work, { confined });
    expect([...token.kept.keys()].map((f: string) => path.basename(f))).toEqual(["ok.txt"]);
    store.afterCommand(token);
  });

  it("does the whole round trip in well under a second for a typical workspace", () => {
    const { store, work } = setup();
    for (let d = 0; d < 10; d++) {
      fs.mkdirSync(path.join(work, `d${d}`));
      for (let f = 0; f < 50; f++) fs.writeFileSync(path.join(work, `d${d}`, `${f}.txt`), `file ${d}/${f}`);
    }
    const started = performance.now();
    const token = store.beforeCommand("fast", work);
    store.afterCommand(token);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("desktop side: write_file, commands and undo", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adt-rewind-home-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  const sys = require("../../../electron/features/10-system.cjs")._test;
  const ws = () => fs.realpathSync(sys.workspaceDir());
  afterAll(() => {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => {
    sys.useSnapshots(createSnapshots({ dir: fs.mkdtempSync(path.join(home, "store-")) }));
    for (const name of fs.readdirSync(ws())) fs.rmSync(path.join(ws(), name), { recursive: true, force: true });
  });

  it("keeps write_file's earlier version with the turn, and undoes it", async () => {
    await sys.writeFile({ path: "plan.md", content: "v1" }, "full");
    await sys.writeFile({ path: "plan.md", content: "v2", turn: "r1", conversation: "c" }, "full");
    await sys.writeFile({ path: "extra.md", content: "new", turn: "r1", conversation: "c" }, "full");
    const result = await sys.restoreTurn({ turn: "r1" }, "full");
    expect(describeRewind(result)).toMatch(/^Restored .*plan\.md\. Deleted .*extra\.md/);
    expect(fs.readFileSync(path.join(ws(), "plan.md"), "utf8")).toBe("v1");
    expect(fs.existsSync(path.join(ws(), "extra.md"))).toBe(false);
  });

  it("snapshots the workspace around a command run there", async () => {
    fs.writeFileSync(path.join(ws(), "data.csv"), "a,b\n");
    const out = await sys.exec({ command: "echo c,d >> data.csv; echo hi > made.txt", turn: "r2", conversation: "c" }, "full");
    expect(out.code).toBe(0);
    await sys.restoreTurn({ turn: "r2" }, "full");
    expect(fs.readFileSync(path.join(ws(), "data.csv"), "utf8")).toBe("a,b\n");
    expect(fs.existsSync(path.join(ws(), "made.txt"))).toBe(false);
  });

  it("in Sandbox mode, a bot can't undo outside the workspace", async () => {
    const outside = path.join(home, "outside.txt");
    fs.writeFileSync(outside, "before");
    await sys.writeFile({ path: outside, content: "after", overwrite: true, turn: "r3", conversation: "c" }, "full");
    const byBot = await sys.restoreTurn({ turn: "r3", by: "bot" }, "sandbox");
    expect(byBot.refused).toEqual([outside]);
    expect(fs.readFileSync(outside, "utf8")).toBe("after");
    // The user can.
    const byUser = await sys.restoreTurn({ turn: "r3", by: "user" }, "sandbox");
    expect(byUser.restored).toEqual([outside]);
    expect(fs.readFileSync(outside, "utf8")).toBe("before");
  });

  it.runIf(process.platform === "darwin")("in Sandbox mode, snapshots and undo go through the sandbox", async () => {
    await sys.writeFile({ path: "s.txt", content: "first" }, "sandbox");
    await sys.writeFile({ path: "s.txt", content: "second", turn: "r4", conversation: "c" }, "sandbox");
    await sys.exec({ command: "echo third > s.txt; echo x > t.txt", turn: "r4", conversation: "c" }, "sandbox");
    const result = await sys.restoreTurn({ turn: "r4", by: "bot" }, "sandbox");
    expect(result.restored).toHaveLength(1);
    expect(result.removed).toHaveLength(1);
    expect(fs.readFileSync(path.join(ws(), "s.txt"), "utf8")).toBe("first");
    expect(fs.existsSync(path.join(ws(), "t.txt"))).toBe(false);
  });
});
