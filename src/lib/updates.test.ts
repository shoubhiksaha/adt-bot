// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script
import { checkManifestText, loadOrCreateKey, publicKeyPem, signManifestText } from "../../scripts/sign-update-manifest.mjs";
import { ago, tokenProblem, updateActions, type UpdateState, updateSummary } from "./updates";

const require = createRequire(import.meta.url);
const { FIELD, PUBLIC_KEY, verifyManifest } = require("../../electron/update-signature.cjs");
const updatesFeature = require("../../electron/features/90-updates.cjs")._test;

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// What electron-builder writes for a Mac build.
const MANIFEST = `version: 1.2.0
files:
  - url: ADT-Bot-1.2.0-mac-arm64.zip
    sha512: 2RGsTBmXg9n1J1xH0uB3sT2HcI0z6zqT1y7oVQ1w3E8eYxQW1u0nH5Z0mXc4bGq6kQ==
    size: 131072000
  - url: ADT-Bot-1.2.0-mac-arm64.dmg
    sha512: 9u2Yk8z4bq7JZx3yF1p0Tq6sL2vD5hR8nW3cX1aE7mB0oK4gU9iP2jH6tS5fN8wQ==
    size: 140000000
path: ADT-Bot-1.2.0-mac-arm64.zip
sha512: 2RGsTBmXg9n1J1xH0uB3sT2HcI0z6zqT1y7oVQ1w3E8eYxQW1u0nH5Z0mXc4bGq6kQ==
releaseDate: '2026-10-20T10:00:00.000Z'
`;

const key = crypto.generateKeyPairSync("ed25519").privateKey;
const pub = publicKeyPem(key);

describe("signed update manifests", () => {
  it("a signed manifest passes, as electron-updater will read it", () => {
    const signed = signManifestText(MANIFEST, key);
    expect(signed.startsWith(MANIFEST)).toBe(true);
    expect(checkManifestText(signed, pub)).toEqual({ ok: true });
    // electron-updater parses the file with js-yaml and adds its own fields (GitHub release assets, notes).
    const info = load(signed) as Record<string, unknown>;
    expect(verifyManifest({ ...info, releaseName: "1.2.0", releaseNotes: "<p>hi</p>", assets: [{ name: "x" }] }, pub)).toEqual({ ok: true });
  });

  it("re-signing replaces the old signature", () => {
    const twice = signManifestText(signManifestText(MANIFEST, key), key);
    expect(twice.split(`${FIELD}:`)).toHaveLength(2);
    expect(checkManifestText(twice, pub).ok).toBe(true);
  });

  it("refuses unsigned manifests and any change to what gets installed", () => {
    expect(checkManifestText(MANIFEST, pub)).toEqual({ ok: false, reason: "unsigned" });
    const signed = signManifestText(MANIFEST, key);
    const tampered = [
      signed.replace("version: 1.2.0", "version: 1.2.1"),
      signed.replace("2RGsTBmXg9n1", "3RGsTBmXg9n1"),
      signed.replace("url: ADT-Bot-1.2.0-mac-arm64.zip", "url: evil.zip"),
      signed.replace("size: 131072000", "size: 131072001"),
    ];
    for (const text of tampered) expect(checkManifestText(text, pub)).toEqual({ ok: false, reason: "bad-signature" });
    const info = load(signed) as { files: unknown[] };
    expect(verifyManifest({ ...info, files: [...info.files, { url: "extra.zip", sha512: "x", size: 1 }] }, pub).ok).toBe(false);
    expect(verifyManifest({ ...info, files: [] }, pub)).toEqual({ ok: false, reason: "incomplete" });
  });

  it("a manifest signed with another key is refused by the app's built-in key", () => {
    expect(checkManifestText(signManifestText(MANIFEST, key)).ok).toBe(false);
    expect(PUBLIC_KEY).toMatch(/^-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/);
  });

  it("creates the signing key outside the repo, readable only by its owner", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adt-signkey-"));
    dirs.push(dir);
    const file = path.join(dir, "adt-bot", "update-signing-key");
    const created = loadOrCreateKey(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(publicKeyPem(loadOrCreateKey(file))).toBe(publicKeyPem(created));
    expect(() => loadOrCreateKey(path.join(dir, "missing"), { create: false })).toThrow(/No signing key/);
  });

  it("signs Linux and Windows manifests the same way", () => {
    const linux = MANIFEST.replace(/mac-arm64\.(zip|dmg)/g, "linux-x64.AppImage");
    expect(checkManifestText(signManifestText(linux, key), pub).ok).toBe(true);
  });
});

describe("updater (main process)", () => {
  const { unsupportedReason, explain, TOKEN_PATTERN } = updatesFeature;
  const base = { packaged: true, platform: "darwin", env: {}, execPath: "/Applications/ADT Bot.app/Contents/MacOS/ADT Bot", resourcesPath: "/x" };

  it("knows when a copy can't update itself", () => {
    expect(unsupportedReason(base)).toBeNull();
    expect(unsupportedReason({ ...base, packaged: false })).toBe("dev");
    expect(unsupportedReason({ ...base, packaged: false, env: { ADT_UPDATE_FEED: "http://localhost:8000" } })).toBeNull();
    expect(unsupportedReason({ ...base, platform: "win32", env: { PORTABLE_EXECUTABLE_DIR: "C:\\x" } })).toBe("portable");
    expect(unsupportedReason({ ...base, platform: "linux", exists: () => false })).toBe("linux-package");
    expect(unsupportedReason({ ...base, platform: "linux", env: { APPIMAGE: "/a.AppImage" } })).toBeNull();
    expect(unsupportedReason({ ...base, platform: "linux", exists: () => true })).toBeNull();
    expect(unsupportedReason({ ...base, execPath: "/Volumes/ADT Bot/ADT Bot.app/Contents/MacOS/ADT Bot" })).toBe("disk-image");
    expect(unsupportedReason({ ...base, execPath: "/private/var/folders/x/AppTranslocation/y/ADT Bot.app/Contents/MacOS/ADT Bot" })).toBe("translocated");
  });

  it("explains failures in plain words and never repeats the token", () => {
    const token = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz";
    expect(explain(new Error(`HttpError: 404 Not Found ${token}`), {})).toMatch(/add a GitHub token/);
    expect(explain(new Error("HttpError: 404"), { token })).toMatch(/with that token/);
    expect(explain(new Error("HttpError: 401 Bad credentials"), { token })).toMatch(/didn't accept the token/);
    expect(explain(new Error("net::ERR_INTERNET_DISCONNECTED"), {})).toMatch(/internet connection/);
    expect(explain(new Error("sha512 checksum mismatch, expected x, got y"), {})).toMatch(/didn't match the signed release/);
    expect(explain(new Error(`weird failure for ${token}`), { token })).not.toContain(token);
    expect(TOKEN_PATTERN.test(token)).toBe(true);
    expect(TOKEN_PATTERN.test("ghp_" + "a".repeat(36))).toBe(true);
    expect(TOKEN_PATTERN.test("not a token")).toBe(false);
  });
});

describe("Settings → About", () => {
  const state = (patch: Partial<UpdateState>): UpdateState => ({
    appVersion: "1.2.0",
    unsupported: null,
    source: "github",
    status: "idle",
    version: "",
    percent: 0,
    error: "",
    checkedAt: 0,
    autoCheck: true,
    token: null,
    keychain: true,
    ...patch,
  });
  const now = Date.parse("2026-10-20T12:00:00Z");

  it("says where things stand", () => {
    expect(updateSummary(state({}), now)).toBe("Not checked yet.");
    expect(updateSummary(state({ status: "current", checkedAt: now - 5 * 60_000 }), now)).toBe("You're up to date (checked 5 minutes ago).");
    expect(updateSummary(state({ status: "available", version: "1.3.0" }), now)).toBe("Version 1.3.0 is available.");
    expect(updateSummary(state({ status: "downloading", version: "1.3.0", percent: 42 }), now)).toBe("Downloading version 1.3.0… 42%");
    expect(updateSummary(state({ status: "error", error: "Nope." }), now)).toBe("Nope.");
    expect(updateSummary(state({ unsupported: "portable" }), now)).toMatch(/portable version/);
    expect(ago(now - 26 * 3600_000, now)).toBe("yesterday");
  });

  it("offers only the buttons that make sense", () => {
    expect(updateActions(state({}))).toEqual({ check: true, install: false });
    expect(updateActions(state({ status: "available", version: "1.3.0" }))).toEqual({ check: true, install: true });
    expect(updateActions(state({ status: "downloading" }))).toEqual({ check: false, install: false });
    expect(updateActions(state({ unsupported: "dev" }))).toEqual({ check: false, install: false });
  });

  it("checks a token's shape before saving it", () => {
    expect(tokenProblem("")).toBe("");
    expect(tokenProblem("github_pat_" + "A1".repeat(20))).toBe("");
    expect(tokenProblem("hello there")).toMatch(/doesn't look like/);
  });
});

describe("dependencies", () => {
  it("electron-updater is pinned and its HTTP layer has the redirect fix (CVE-2026-54673)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    expect(pkg.dependencies["electron-updater"]).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package-lock.json"), "utf8"));
    const runtime = lock.packages["node_modules/builder-util-runtime"].version.split(".").map(Number);
    expect(runtime[0] > 9 || (runtime[0] === 9 && runtime[1] >= 7)).toBe(true);
    expect(lock.packages["node_modules/electron-updater/node_modules/builder-util-runtime"]).toBeUndefined();
  });

  it("electron-builder writes update files for GitHub Releases, with names that match the uploads", () => {
    const { build } = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    expect(build.publish[0]).toMatchObject({ provider: "github", owner: "shoubhiksaha", repo: "adt-bot" });
    expect(build.mac.target).toContain("zip");
    for (const name of [build.mac.artifactName, build.nsis.artifactName, build.portable.artifactName, build.appImage.artifactName]) expect(name).not.toMatch(/\s/);
  });
});
