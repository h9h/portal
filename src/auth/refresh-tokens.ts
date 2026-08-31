import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

// Changing this only affects refresh tokens issued after the change —
// tokens already stored carry their own already-computed expiresAt.
const REFRESH_TOKEN_TTL_SECONDS = Number(process.env.PORTAL_REFRESH_TOKEN_TTL_SECONDS ?? 60 * 60 * 24 * 30);

export function createRefreshToken(db: Database, userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS;
  db.query(`INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, userId, expiresAt);
  return token;
}

export function verifyAndRotateRefreshToken(db: Database, token: string): { userId: string; newToken: string } | null {
  const row = db
    .query(`SELECT user_id as userId, expires_at as expiresAt FROM refresh_tokens WHERE token = ?`)
    .get(token) as { userId: string; expiresAt: number } | null;
  if (!row) return null;

  db.query(`DELETE FROM refresh_tokens WHERE token = ?`).run(token);
  if (row.expiresAt < Math.floor(Date.now() / 1000)) return null;

  const newToken = createRefreshToken(db, row.userId);
  return { userId: row.userId, newToken };
}

export function revokeRefreshToken(db: Database, token: string): void {
  db.query(`DELETE FROM refresh_tokens WHERE token = ?`).run(token);
}
