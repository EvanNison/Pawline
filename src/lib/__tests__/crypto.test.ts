import { test } from "node:test";
import assert from "node:assert/strict";
import { checkKey, CryptoError, decryptSecret, encryptSecret, generateKey, mask } from "../crypto";

test("round-trips a secret", async () => {
  const key = generateKey();
  const secret = "correct horse battery staple";
  assert.equal(await decryptSecret(await encryptSecret(secret, key), key), secret);
});

test("generated keys are 32 bytes and never repeat", () => {
  const keys = new Set(Array.from({ length: 50 }, generateKey));
  assert.equal(keys.size, 50);
  assert.equal(Buffer.from(generateKey(), "base64").length, 32);
});

test("the same plaintext encrypts differently every time", async () => {
  const key = generateKey();
  const a = await encryptSecret("hunter2", key);
  const b = await encryptSecret("hunter2", key);
  assert.notEqual(a, b, "a fresh IV must be used per encryption");
  assert.equal(await decryptSecret(a, key), await decryptSecret(b, key));
});

test("ciphertext does not contain the plaintext", async () => {
  const envelope = await encryptSecret("SuperSecret123", generateKey());
  assert.ok(!envelope.includes("SuperSecret123"));
  assert.ok(!Buffer.from(envelope, "utf8").toString("latin1").includes("SuperSecret123"));
});

test("the wrong key fails loudly with an actionable message", async () => {
  const envelope = await encryptSecret("hunter2", generateKey());
  await assert.rejects(
    () => decryptSecret(envelope, generateKey()),
    (e: Error) => e instanceof CryptoError && /Re-enter it in Setup/.test(e.message)
  );
});

test("tampered ciphertext is rejected, not silently decrypted", async () => {
  const key = generateKey();
  const envelope = await encryptSecret("hunter2", key);
  const [v, iv, ct] = envelope.split(".");
  const bytes = Buffer.from(ct, "base64");
  bytes[0] ^= 0xff; // flip a bit
  await assert.rejects(() => decryptSecret(`${v}.${iv}.${bytes.toString("base64")}`, key), CryptoError);
});

test("a tampered IV is rejected", async () => {
  const key = generateKey();
  const [v, , ct] = (await encryptSecret("hunter2", key)).split(".");
  const badIv = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64");
  await assert.rejects(() => decryptSecret(`${v}.${badIv}.${ct}`, key), CryptoError);
});

test("malformed envelopes are rejected with a clear reason", async () => {
  const key = generateKey();
  await assert.rejects(() => decryptSecret("not-an-envelope", key), /malformed/);
  await assert.rejects(() => decryptSecret("a.b", key), /malformed/);
  await assert.rejects(() => decryptSecret("v9.aaaa.bbbb", key), /unsupported credential format "v9"/);
});

test("keys of the wrong size are refused before any data is touched", async () => {
  const short = Buffer.alloc(16).toString("base64");
  await assert.rejects(() => encryptSecret("x", short), /must be 32 bytes/);
  assert.match((await checkKey(short))!, /must be 32 bytes/);
  assert.match((await checkKey("!!!not base64!!!"))!, /32 bytes|base64/);
  assert.equal(await checkKey(generateKey()), null);
});

test("refuses to encrypt an empty secret", async () => {
  await assert.rejects(() => encryptSecret("", generateKey()), /empty secret/);
});

test("unicode and long secrets survive the round trip", async () => {
  const key = generateKey();
  for (const s of ["pässwörd–ü", "🐶🐾", "x".repeat(4096), 'quote"and\\backslash']) {
    assert.equal(await decryptSecret(await encryptSecret(s, key), key), s);
  }
});

test("envelope is a stable, self-describing format", async () => {
  const envelope = await encryptSecret("hunter2", generateKey());
  const parts = envelope.split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "v1");
  assert.equal(Buffer.from(parts[1], "base64").length, 12, "96-bit IV");
});

test("mask never reveals a usable secret", () => {
  assert.equal(mask("abc"), "••••••••");
  const masked = mask("SuperSecret123");
  assert.ok(!masked.includes("uperSecret12"));
  assert.match(masked, /^Su•+23$/);
});

test("a tampered envelope is rejected even when base64 hides the damage", () => {
  // Buffer.from silently DISCARDS invalid base64 characters, so inserting a
  // stray character into the ciphertext text still decoded to the original
  // bytes and decrypted successfully — making the envelope's "the data was
  // altered" guarantee untrue.
  const key = generateKey();
  return encryptSecret("hunter2", key).then(async (envelope) => {
    const [v, iv, ct] = envelope.split(".");
    await assert.rejects(() => decryptSecret(`${v}.${iv}.${ct}!`, key), /not valid base64/);
    await assert.rejects(() => decryptSecret(`${v}.${iv}!.${ct}`, key), /not valid base64/);
    await assert.rejects(() => decryptSecret(`${v}.${iv}.${ct.slice(0, 4)} ${ct.slice(4)}`, key), /not valid base64/);
    // The untampered envelope still works.
    assert.equal(await decryptSecret(envelope, key), "hunter2");
  });
});
