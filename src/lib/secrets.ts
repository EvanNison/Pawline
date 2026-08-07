/**
 * Stored secrets, encrypted at rest.
 *
 * The app holds two things worth protecting: the Tractive account password,
 * and the Gmail app password used to send alerts. Both were kept as plain text
 * in Postgres, so any database backup, log dump, or leaked connection string
 * handed them over intact.
 *
 * Migration is deliberately gentle. Existing plaintext rows keep working and
 * are upgraded the first time they are read with a key present. A missing key
 * must never break collection — losing alerts to protect a password would be
 * the wrong trade — but it is reported on the status page rather than passing
 * silently, because "still plaintext" is exactly the state that goes unnoticed.
 */

import { decryptSecret, encryptSecret, CryptoError } from "./crypto";

/** Marks a stored value as an encryption envelope rather than a raw secret. */
const PREFIX = "enc:";

export function encryptionKey(): string | null {
  return process.env.ENCRYPTION_KEY?.trim() || null;
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/**
 * Encrypt for storage. Returns the value unchanged when no key is configured,
 * so setup keeps working on an install that has not set one yet.
 */
export async function protect(plaintext: string): Promise<string> {
  const key = encryptionKey();
  if (!key || plaintext === "") return plaintext;
  return PREFIX + (await encryptSecret(plaintext, key));
}

export type RevealResult =
  | { ok: true; value: string; wasEncrypted: boolean }
  | { ok: false; reason: string };

/**
 * Read a stored secret back.
 *
 * A value that is not an envelope is legacy plaintext and is returned as-is —
 * refusing it would break collection on every install that predates this.
 */
export async function reveal(stored: string): Promise<RevealResult> {
  if (!isEncrypted(stored)) return { ok: true, value: stored, wasEncrypted: false };

  const key = encryptionKey();
  if (!key) {
    return {
      ok: false,
      reason:
        "This credential is encrypted but ENCRYPTION_KEY is not set, so it cannot be read. Restore the key, or re-enter the credential in Setup.",
    };
  }
  try {
    return { ok: true, value: await decryptSecret(stored.slice(PREFIX.length), key), wasEncrypted: true };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof CryptoError ? e.message : `Could not decrypt: ${String(e)}`,
    };
  }
}

/**
 * Whether a stored credential should be re-saved in encrypted form.
 *
 * True only when a key exists and the value is still plaintext — the upgrade
 * path for credentials saved before encryption was added.
 */
export function needsUpgrade(stored: string): boolean {
  return Boolean(encryptionKey()) && !isEncrypted(stored) && stored !== "";
}

/**
 * Upgrade any still-plaintext stored secrets to encrypted form.
 *
 * Called at the start of every collection rather than relying on the read path.
 * The Tractive password is only read when a *login* happens, and logins are
 * rare — the token is cached and refreshed roughly hourly — so an
 * upgrade-on-read could sit unperformed for days while the status page
 * correctly, and uselessly, reported "still in the clear".
 *
 * Safe to call repeatedly: values already encrypted are left alone.
 */
export async function upgradeStoredSecrets(
  s: import("postgres").Sql
): Promise<{ upgraded: string[] }> {
  if (!encryptionKey()) return { upgraded: [] };
  const upgraded: string[] = [];

  const [cred] = await s`select password from app_credentials where id = 1`;
  if (cred && needsUpgrade(String(cred.password))) {
    await s`update app_credentials set password = ${await protect(String(cred.password))} where id = 1`;
    upgraded.push("tractive_password");
  }

  for (const key of ["gmail_app_password", "resend_api_key"]) {
    const [row] = await s`select value from app_config where key = ${key}`;
    if (row && needsUpgrade(String(row.value))) {
      await s`update app_config set value = ${await protect(String(row.value))}, updated_at = now()
        where key = ${key}`;
      upgraded.push(key);
    }
  }
  return { upgraded };
}
