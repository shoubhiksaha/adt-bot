// @vitest-environment node
// The desktop side of the keychain store (electron/secrets.cjs), with a stand-in for Electron's
// safeStorage (the real one needs a running Electron app).
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createVault, sanitize } = require("../../electron/secrets.cjs");
const { STORES } = require("../../electron/features/05-secrets.cjs");

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adt-vault-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** Reversible "encryption" that a test can break by changing the key. */
function fakeSafeStorage({ available = true, backend = "gnome_libsecret", key = 7 } = {}) {
  const shift = (buffer: Buffer, by: number) => Buffer.from(buffer.map((b) => (b + by + 256) % 256));
  const state = { key };
  return {
    state,
    isEncryptionAvailable: () => available,
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (text: string) => Buffer.concat([Buffer.from("v10"), shift(Buffer.from(`ok:${text}`), state.key)]),
    decryptStringAsync: async (buffer: Buffer) => {
      const text = shift(buffer.subarray(3), -state.key).toString();
      if (!text.startsWith("ok:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return { result: text.slice(3), shouldReEncrypt: false };
    },
  };
}

describe("keychain store (main process)", () => {
  it("keeps only ciphertext on disk, readable only by the owner", async () => {
    const dir = tempDir();
    const vault = createVault({ dir, safeStorage: fakeSafeStorage(), platform: "darwin" });
    expect(await vault.set("app", { a: "sk-secret" })).toEqual({ ok: true });
    const file = path.join(dir, "secrets.json");
    expect(fs.readFileSync(file, "utf8")).not.toContain("sk-secret");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await createVault({ dir, safeStorage: fakeSafeStorage(), platform: "darwin" }).get("app")).toEqual({ available: true, value: { a: "sk-secret" } });
    expect((await vault.status()).backend).toBe("keychain");
  });

  it("treats Linux without a keyring as unavailable instead of using its fixed password", async () => {
    const vault = createVault({ dir: tempDir(), safeStorage: fakeSafeStorage({ backend: "basic_text" }), platform: "linux" });
    expect(await vault.status()).toMatchObject({ available: false, reason: "no-keyring", backend: "basic_text" });
    expect(await vault.set("app", { a: "b" })).toEqual({ ok: false, error: "unavailable" });
    expect(await vault.get("app")).toEqual({ available: false, value: null });
  });

  it("reports keys it can't decrypt as locked and never overwrites them", async () => {
    const dir = tempDir();
    const safeStorage = fakeSafeStorage();
    await createVault({ dir, safeStorage, platform: "linux" }).set("updates", { githubToken: "t" });
    safeStorage.state.key = 99; // the keyring's key changed
    const vault = createVault({ dir, safeStorage, platform: "linux" });
    expect(await vault.get("updates")).toEqual({ available: true, value: null, error: "locked" });
    expect(await vault.setValue("updates", "other", "x")).toEqual({ ok: false, error: "locked" });
    safeStorage.state.key = 7;
    expect(await vault.getValue("updates", "githubToken")).toBe("t");
  });

  it("saved keys stay locked while the keyring is unavailable", async () => {
    const dir = tempDir();
    await createVault({ dir, safeStorage: fakeSafeStorage(), platform: "linux" }).set("app", { a: "1" });
    const vault = createVault({ dir, safeStorage: fakeSafeStorage({ available: false }), platform: "linux" });
    expect(await vault.get("app")).toEqual({ available: false, value: null, error: "locked" });
  });

  it("applies writes in order and removes empty stores", async () => {
    const dir = tempDir();
    const vault = createVault({ dir, safeStorage: fakeSafeStorage(), platform: "win32" });
    await Promise.all([vault.set("rooms", { a: "1" }), vault.set("rooms", { a: "2" }), vault.set("rooms", { a: "3" })]);
    expect((await vault.get("rooms")).value).toEqual({ a: "3" });
    await vault.set("rooms", {});
    expect((await vault.status()).stored).toEqual([]);
    await vault.setValue("updates", "githubToken", "x");
    await vault.setValue("updates", "githubToken", "");
    expect((await vault.status()).stored).toEqual([]);
  });

  it("sets a damaged file aside instead of overwriting it", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "secrets.json"), "{not json");
    const vault = createVault({ dir, safeStorage: fakeSafeStorage(), platform: "darwin" });
    expect(await vault.get("app")).toEqual({ available: true, value: null });
    expect(fs.readdirSync(dir).some((f) => f.startsWith("secrets.json.damaged-"))).toBe(true);
  });

  it("accepts only string values within limits", () => {
    expect(sanitize({ a: "x", b: 1, c: "", d: { e: 1 } })).toEqual({ a: "x" });
    expect(sanitize(null)).toEqual({});
    expect(sanitize(["x"])).toEqual({});
  });

  it("the app window can reach only its own stores, not the update token", () => {
    expect([...STORES].sort()).toEqual(["app", "connectors", "rooms"]);
  });
});
