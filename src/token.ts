import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Stateless "sessions": the whole server config travels inside the token, so any serverless instance can rebuild it.
 * With a secret the token is AES-256-GCM encrypted + authenticated (safe to carry credentials); without one it is
 * plain base64url JSON, so callers must not put credentials in it.
 */
export function seal(cfg: object, secret?: string): string {
  const json = Buffer.from(JSON.stringify(cfg));
  if (!secret) return json.toString("base64url");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const enc = Buffer.concat([c.update(json), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

export function open<T = any>(token: string, secret?: string): T {
  const raw = Buffer.from(token, "base64url");
  if (!secret) return JSON.parse(raw.toString());
  const d = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString());
}
