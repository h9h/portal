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

const STATE_COOKIE_NAME = "portal_oauth_state";

// Binds `state` to the browser that requested it, closing a login CSRF: a
// `state`+`code` pair captured from a real login flow and replayed against a
// different browser (which never received this cookie) fails the match check
// in the callback handler, even though `state`'s own signature is valid.
// HttpOnly so no JS (including a mounted SCS's own code) can read or forge
// it; SameSite=Lax because the provider's redirect back to Portal is a
// cross-site top-level navigation, which Strict would not carry the cookie
// on; Path scoped to the one route that ever reads it; a short Max-Age since
// a real login round-trip takes seconds, not minutes.
export function createStateCookie(nonce: string, secure: boolean): string {
  const attributes = [
    `${STATE_COOKIE_NAME}=${nonce}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/auth/callback",
    "Max-Age=600",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function readStateCookie(req: Request): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const pair of header.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) continue;
    const name = pair.slice(0, separatorIndex).trim();
    if (name === STATE_COOKIE_NAME) return pair.slice(separatorIndex + 1).trim();
  }
  return null;
}

// The signed `state`'s own nonce segment, extracted for cookie comparison —
// only meaningful to call AFTER verifyState has already confirmed the
// signature; this function does no verification of its own.
export function stateNonce(state: string): string | null {
  const parts = state.split(".");
  return parts.length === 2 ? parts[0] : null;
}
