// @vitest-environment node
// The server's sync storage: only ciphertext, a vault per sync code (token stored hashed), no lost
// updates (If-Match), quotas and size limits; and the app's own client against it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer } from "./index.mjs";

vi.mock("../src/lib/transport", () => ({ providerFetch: (url, init) => fetch(url, init), detectEnv: async () => ({ platform: "web", proxy: false }) }));
const { pull, push, seal, syncKeys, unseal } = await import("../src/lib/sync");

const dir = mkdtempSync(join(tmpdir(), "adt-sync-"));
let server;
let base;
beforeAll(async () => {
  ({ server, url: base } = await startServer({ port: 0, distDir: "/nonexistent", sync: { dir, maxBytes: 4096, maxVaults: 2 } }));
});
afterAll(() => new Promise((r) => server.close(r)));

const vault = (n) => n.toString(16).padStart(32, "0");
const token = (c) => c.repeat(64);
const call = (v, { method = "GET", tok = token("a"), body, headers = {} } = {}) =>
  fetch(`${base}/api/sync/${v}`, { method, body, headers: { ...(tok ? { "x-adtbot-sync-token": tok } : {}), ...headers } });
const box = JSON.stringify({ v: 1, iv: "aaaa", data: "bbbb" });

describe("sync storage", () => {
  it("creates a vault once, then needs the same token and the latest ETag", async () => {
    expect((await call(vault(1), { tok: "" })).status).toBe(401);
    expect((await call(vault(1))).status).toBe(404);
    const created = await call(vault(1), { method: "PUT", body: box, headers: { "if-match": "none" } });
    expect(created.status).toBe(200);
    const etag = created.headers.get("etag");
    expect(etag).toMatch(/^".+"$/);
    const got = await call(vault(1));
    expect(got.headers.get("etag")).toBe(etag);
    expect(await got.text()).toBe(box);
    expect((await call(vault(1), { headers: { "if-none-match": etag } })).status).toBe(304);
    // Another code can't read or overwrite it.
    expect((await call(vault(1), { tok: token("b") })).status).toBe(403);
    expect((await call(vault(1), { method: "PUT", tok: token("b"), body: box, headers: { "if-match": etag } })).status).toBe(403);
    // A device that missed an update must merge first.
    expect((await call(vault(1), { method: "PUT", body: box, headers: { "if-match": '"old"' } })).status).toBe(412);
    expect((await call(vault(1), { method: "PUT", body: box, headers: { "if-match": "none" } })).status).toBe(412);
    expect((await call(vault(1), { method: "PUT", body: box, headers: { "if-match": etag } })).status).toBe(200);
  });

  it("stores only encrypted copies, within the size and vault limits", async () => {
    expect((await call(vault(2), { method: "PUT", body: '{"bots":["plain text"]}', headers: { "if-match": "none" } })).status).toBe(400);
    expect((await call(vault(2), { method: "PUT", body: JSON.stringify({ v: 1, iv: "a", data: "x".repeat(5000) }), headers: { "if-match": "none" } })).status).toBe(413);
    expect((await call(vault(2), { method: "PUT", body: box, headers: { "if-match": "none" } })).status).toBe(200);
    expect((await call(vault(3), { method: "PUT", body: box, headers: { "if-match": "none" } })).status).toBe(507);
    expect((await call(vault(2), { method: "DELETE" })).status).toBe(204);
    expect((await call(vault(2))).status).toBe(404);
    const pre = await fetch(`${base}/api/sync/${vault(1)}`, { method: "OPTIONS" });
    expect(pre.headers.get("access-control-allow-headers")).toContain("x-adtbot-sync-token");
  });

  it("works with the app's sync client end to end", async () => {
    const keys = await syncKeys("ABCDEFGHJKLMNPQRSTUV", 1000);
    const snapshot = { v: 1, at: 1, device: "Mac", providers: [], bots: [{ id: "a", name: "ADT", memory: [] }], conversations: [], skills: [], profile: { userName: "", about: "", customInstructions: "", sharedMemory: [], updatedAt: 0 }, tombstones: {} };
    expect(await pull(base, keys, false)).toBeNull();
    const etag = await push(base, keys, await seal(snapshot, keys), false, "");
    expect(etag).toMatch(/^"/);
    expect(await pull(base, keys, false, etag)).toBe("unchanged");
    const remote = await pull(base, keys, false);
    expect((await unseal(remote.body, keys)).bots[0].name).toBe("ADT");
    expect(await push(base, keys, await seal(snapshot, keys), false, '"stale"')).toBe("conflict");
  });
});
