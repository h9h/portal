import { createHmac, timingSafeEqual } from "node:crypto";

export type InternalTokenPayload = {
  sub: string;
  roles: string[];
  exp: number;
};

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function signInternalToken(userId: string, roles: string[], secret: string, ttlSeconds = 60): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: InternalTokenPayload = {
    sub: userId,
    roles,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadEncoded = base64url(JSON.stringify(payload));
  const signature = sign(`${header}.${payloadEncoded}`, secret);
  return `${header}.${payloadEncoded}.${signature}`;
}

export function verifyInternalToken(token: string, secret: string): InternalTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expectedSignature = sign(`${header}.${payload}`, secret);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof decoded !== "object" || decoded === null) return null;
  const obj = decoded as Record<string, unknown>;

  if (
    typeof obj.sub !== "string" ||
    typeof obj.exp !== "number" ||
    !Array.isArray(obj.roles) ||
    !obj.roles.every((role) => typeof role === "string")
  ) {
    return null;
  }

  const payloadObj = decoded as InternalTokenPayload;
  if (payloadObj.exp < Math.floor(Date.now() / 1000)) return null;
  return payloadObj;
}
