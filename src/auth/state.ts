import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createState(secret: string): string {
  const nonce = randomBytes(16).toString("base64url");
  const signature = createHmac("sha256", secret).update(nonce).digest("base64url");
  return `${nonce}.${signature}`;
}

export function verifyState(state: string, secret: string): boolean {
  const parts = state.split(".");
  if (parts.length !== 2) return false;
  const [nonce, signature] = parts;
  const expected = createHmac("sha256", secret).update(nonce).digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
}
