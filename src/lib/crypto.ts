/**
 * Credential encryption at rest.
 *
 * Some sources need a username and password for the user's own account. The
 * private predecessor stored that password as plain text in Postgres. For a
 * single self-hosted instance that is merely bad; for software handed to
 * strangers it is indefensible — people reuse passwords, and a database backup,
 * a log dump, or a misconfigured connection string then leaks a live credential.
 *
 * So: AES-256-GCM, with a key supplied by the operator and never stored
 * alongside the data. GCM is authenticated, so tampering fails loudly rather
 * than decrypting to garbage.
 *
 * This raises the cost of a database leak. It does not make storing a password
 * safe — nothing does. Where a source can authenticate without one, prefer that.
 */

const ALGORITHM = "AES-GCM";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32; // AES-256
/** Envelope version, so the algorithm can change without unreadable rows. */
const VERSION = "v1";

export class CryptoError extends Error {}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(s: string) {
  // Copy into a fresh ArrayBuffer rather than wrapping Buffer's pooled memory:
  // WebCrypto's BufferSource requires an ArrayBuffer-backed view, and a pooled
  // Buffer is a window onto a larger shared allocation.
  const buf = Buffer.from(s, "base64");
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

/** Generate a fresh key, base64-encoded. Shown once during setup, then stored by the operator. */
export function generateKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

async function importKey(keyB64: string): Promise<CryptoKey> {
  // Buffer.from silently drops characters it doesn't recognise rather than
  // throwing, so junk input would otherwise decode to a short key and surface
  // as a confusing length error. Check the shape first.
  if (!BASE64_RE.test(keyB64.trim())) {
    throw new CryptoError("encryption key is not valid base64");
  }
  const raw = fromBase64(keyB64.trim());
  if (raw.length !== KEY_BYTES) {
    throw new CryptoError(
      `encryption key must be ${KEY_BYTES} bytes (${Math.ceil((KEY_BYTES * 4) / 3)} base64 chars), got ${raw.length}`
    );
  }
  return crypto.subtle.importKey("raw", raw, ALGORITHM, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt a secret. Output is `v1.<iv>.<ciphertext>`, all base64 — self-describing
 * so a future version can be recognised rather than misparsed.
 */
export async function encryptSecret(plaintext: string, keyB64: string): Promise<string> {
  if (plaintext === "") throw new CryptoError("refusing to encrypt an empty secret");
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, data);
  return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

export async function decryptSecret(envelope: string, keyB64: string): Promise<string> {
  const parts = envelope.split(".");
  if (parts.length !== 3) throw new CryptoError("stored credential is malformed");
  const [version, ivB64, ctB64] = parts;
  if (version !== VERSION) throw new CryptoError(`unsupported credential format "${version}"`);

  // Validate the envelope's base64 as strictly as the key's. Buffer.from
  // silently discards invalid characters, so inserting a `!` into the
  // ciphertext still decrypted successfully — making the envelope-level
  // "the data was altered" guarantee untrue even though AES-GCM protected the
  // decoded bytes.
  for (const [label, part] of [["iv", ivB64], ["ciphertext", ctB64]] as const) {
    if (!BASE64_RE.test(part.trim())) {
      throw new CryptoError(`stored credential's ${label} is not valid base64`);
    }
  }

  const key = await importKey(keyB64);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: fromBase64(ivB64) },
      key,
      fromBase64(ctB64)
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Indistinguishable by design: a wrong key and tampered data both fail the
    // GCM tag check, and saying which would be a hint worth having to an attacker.
    throw new CryptoError(
      "could not decrypt the stored credential — the encryption key has changed, or the data was altered. Re-enter it in Setup."
    );
  }
}

/** Validate an operator-supplied key without touching stored data. */
export async function checkKey(keyB64: string): Promise<string | null> {
  try {
    await importKey(keyB64);
    return null;
  } catch (e) {
    return e instanceof CryptoError ? e.message : String(e);
  }
}

/** Mask a secret for display or logs. Never render a stored credential in full. */
export function mask(secret: string): string {
  if (secret.length <= 4) return "•".repeat(8);
  return `${secret.slice(0, 2)}${"•".repeat(8)}${secret.slice(-2)}`;
}
