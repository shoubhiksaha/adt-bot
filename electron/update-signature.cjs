// Update manifests (latest-mac.yml, latest.yml, latest-linux*.yml) carry an Ed25519 signature made
// with ADT Bot's release key (scripts/sign-update-manifest.mjs; the private key never leaves the
// release machine). The updater installs nothing whose manifest isn't signed by that key. The manifest
// lists each download's SHA-512, which electron-updater checks after downloading, so a tampered release
// page or feed can't swap in a different build.
const crypto = require("node:crypto");

/** Public half of the release key. The private half lives in ~/.config/adt-bot/update-signing-key. */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMOYDhuw6YeT9Kd7zJjuqKk++T2rMnzPS699bwzkDMTU=
-----END PUBLIC KEY-----
`;

/** Manifest field that holds the signature (base64). electron-updater ignores fields it doesn't know. */
const FIELD = "adtSignature";

const text = (value) => (value == null ? null : String(value));

/**
 * The parts of a manifest that decide what gets installed, in a fixed shape: the version and every
 * file's name, SHA-512 and size. Fields that electron-updater adds after reading the manifest
 * (release notes, GitHub asset lists) aren't part of it.
 */
function signedPayload(info) {
  const files = (Array.isArray(info?.files) ? info.files : []).map((file) => [text(file?.url), text(file?.sha512), Number(file?.size ?? 0)]);
  return JSON.stringify({ v: 1, version: text(info?.version), path: text(info?.path), sha512: text(info?.sha512), files });
}

/** { ok: true } or { ok: false, reason: "unsigned" | "incomplete" | "bad-signature" }. */
function verifyManifest(info, publicKey = PUBLIC_KEY) {
  const signature = info?.[FIELD];
  if (typeof signature !== "string" || !signature) return { ok: false, reason: "unsigned" };
  const files = Array.isArray(info.files) ? info.files : [];
  if (!info.version || !files.length || files.some((file) => !file?.url || !file?.sha512)) return { ok: false, reason: "incomplete" };
  try {
    const ok = crypto.verify(null, Buffer.from(signedPayload(info)), publicKey, Buffer.from(signature, "base64"));
    return ok ? { ok: true } : { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
}

function signManifest(info, privateKey) {
  return crypto.sign(null, Buffer.from(signedPayload(info)), privateKey).toString("base64");
}

module.exports = { PUBLIC_KEY, FIELD, signedPayload, verifyManifest, signManifest };
