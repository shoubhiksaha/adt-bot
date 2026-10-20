// Keys in a backup file are never written in plain text: "Export with keys" seals them with a password
// you choose (PBKDF2-SHA-256, 600,000 rounds, then AES-256-GCM, all WebCrypto), and importing asks for it.

export type SealedSecrets = {
  format: "adt-bot-sealed-1";
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  data: string;
};

const ITERATIONS = 600_000;
const AAD = new TextEncoder().encode("adt-bot backup keys v1");

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  // Browsers only offer WebCrypto on secure pages (https, localhost, the apps).
  if (!api) throw new Error("Password-protected backups need a secure page: open ADT Bot over https or use the app.");
  return api;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const api = subtle();
  const base = await api.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return api.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** "" when the password can protect a backup, otherwise what's wrong with it. */
export function backupPasswordProblem(password: string, confirm: string): string {
  if (!password) return "Choose a password for the keys.";
  if (password.length < 8) return "Use at least 8 characters.";
  if (password !== confirm) return "The two passwords don't match.";
  return "";
}

export function isSealed(value: unknown): value is SealedSecrets {
  const v = value as SealedSecrets | null;
  return Boolean(v && v.format === "adt-bot-sealed-1" && v.kdf?.salt && v.cipher?.iv && typeof v.data === "string");
}

export async function sealSecrets(value: unknown, password: string, iterations = ITERATIONS): Promise<SealedSecrets> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plain));
  return {
    format: "adt-bot-sealed-1",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(data),
  };
}

export async function openSecrets<T = unknown>(sealed: SealedSecrets, password: string): Promise<T> {
  if (!isSealed(sealed)) throw new Error("The keys in this backup are in a format this version can't read.");
  // A file can't make the import spin for minutes, nor weaken the derivation to almost nothing.
  const iterations = Math.min(Math.max(Number(sealed.kdf.iterations) || 0, 100_000), 5_000_000);
  const key = await deriveKey(password, fromBase64(sealed.kdf.salt), iterations);
  try {
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: fromBase64(sealed.cipher.iv), additionalData: AAD }, key, fromBase64(sealed.data));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new Error("Wrong password (or the file was changed).");
  }
}
