import { createHmac, timingSafeEqual } from "node:crypto";

export type AccessTokenPayload = {
  sub: string;
  exp: number;
};

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signAccessToken(userId: string, secret: string, ttlSeconds = 900): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: AccessTokenPayload = { sub: userId, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadEncoded = base64url(JSON.stringify(payload));
  const signature = sign(`${header}.${payloadEncoded}`, secret);
  return `${header}.${payloadEncoded}.${signature}`;
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expectedSignature = sign(`${header}.${payload}`, secret);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenPayload;
  if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
  return decoded;
}
