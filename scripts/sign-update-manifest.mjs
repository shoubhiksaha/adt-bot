#!/usr/bin/env node
// Signs the update manifests electron-builder writes (release/latest-mac.yml, latest.yml,
// latest-linux*.yml) with ADT Bot's release key, so installed apps accept the update
// (electron/update-signature.cjs). Run it after building and before uploading to GitHub Releases:
//
//   node scripts/sign-update-manifest.mjs              sign release/latest*.yml
//   node scripts/sign-update-manifest.mjs --check      only check the signatures
//   node scripts/sign-update-manifest.mjs --public-key print the public key the app should embed
//   options: --dir <folder> (default release), --key <file>
//
// The private key is ~/.config/adt-bot/update-signing-key (or $ADT_UPDATE_SIGNING_KEY) and is created on
// first use. Never commit it, and keep a backup somewhere safe: without it, installed apps can't accept
// new updates (people would have to download the next version by hand); with it, anyone could sign one.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "js-yaml";

const require = createRequire(import.meta.url);
const { FIELD, PUBLIC_KEY, signManifest, verifyManifest } = require("../electron/update-signature.cjs");

export const DEFAULT_KEY = process.env.ADT_UPDATE_SIGNING_KEY || path.join(os.homedir(), ".config", "adt-bot", "update-signing-key");

/** The release key (a PKCS#8 PEM file). Created, readable only by you, when it doesn't exist yet. */
export function loadOrCreateKey(file = DEFAULT_KEY, { create = true } = {}) {
  if (!fs.existsSync(file)) {
    if (!create) throw new Error(`No signing key at ${file}`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    console.log(`Created a new update signing key: ${file}\nBack it up somewhere safe and never commit it.`);
  }
  const key = crypto.createPrivateKey(fs.readFileSync(file));
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${file} is not an Ed25519 key`);
  return key;
}

export const publicKeyPem = (privateKey) => crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();

const withoutSignature = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(`${FIELD}:`))
    .join("\n")
    .replace(/\n*$/, "\n");

/** The manifest with a fresh signature line at the end (an older one is replaced). */
export function signManifestText(text, privateKey) {
  const body = withoutSignature(text);
  const info = load(body);
  if (!info || typeof info !== "object" || !info.version || !Array.isArray(info.files) || !info.files.length) {
    throw new Error("not an electron-builder update manifest");
  }
  return `${body}${FIELD}: '${signManifest(info, privateKey)}'\n`;
}

/** { ok, reason? } for a manifest's text, as the app will judge it. */
export const checkManifestText = (text, publicKey = PUBLIC_KEY) => verifyManifest(load(text), publicKey);

export const manifestFiles = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => /^latest.*\.yml$/.test(name))
        .map((name) => path.join(dir, name))
    : [];

function main(argv) {
  const option = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  const dir = path.resolve(option("--dir", "release"));
  const keyFile = option("--key", DEFAULT_KEY);

  if (argv.includes("--public-key")) {
    process.stdout.write(publicKeyPem(loadOrCreateKey(keyFile)));
    return 0;
  }

  const files = manifestFiles(dir);
  if (!files.length) {
    console.error(`No latest*.yml in ${dir}. Build the desktop apps first (npm run dist:mac / dist:win / dist:linux).`);
    return 1;
  }

  if (argv.includes("--check")) {
    let failed = 0;
    for (const file of files) {
      const result = checkManifestText(fs.readFileSync(file, "utf8"));
      console.log(`${result.ok ? "ok    " : "FAILED"} ${path.basename(file)}${result.ok ? "" : ` (${result.reason})`}`);
      if (!result.ok) failed++;
    }
    return failed ? 1 : 0;
  }

  const key = loadOrCreateKey(keyFile);
  const pem = publicKeyPem(key);
  if (pem.trim() !== PUBLIC_KEY.trim()) {
    console.error(
      `This key doesn't match the public key built into the app (electron/update-signature.cjs), so installed apps would refuse these updates.\nIts public key is:\n${pem}`,
    );
    return 1;
  }
  for (const file of files) {
    const signed = signManifestText(fs.readFileSync(file, "utf8"), key);
    if (!checkManifestText(signed).ok) throw new Error(`Signing ${file} didn't verify`);
    fs.writeFileSync(file, signed);
    console.log(`signed ${path.basename(file)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
