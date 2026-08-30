import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export type ProviderProfile = {
  providerUserId: string;
  email: string | null;
  displayName: string | null;
};

export type User = {
  id: string;
  provider: string;
  providerUserId: string;
  email: string | null;
  displayName: string | null;
};

export function findOrCreateUser(db: Database, provider: string, profile: ProviderProfile): User {
  const existing = db
    .query(
      `SELECT id, provider, provider_user_id as providerUserId, email, display_name as displayName
       FROM users WHERE provider = ? AND provider_user_id = ?`
    )
    .get(provider, profile.providerUserId) as User | null;
  if (existing) return existing;

  const id = randomUUID();
  db.query(
    `INSERT INTO users (id, provider, provider_user_id, email, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, provider, profile.providerUserId, profile.email, profile.displayName, Math.floor(Date.now() / 1000));

  return { id, provider, providerUserId: profile.providerUserId, email: profile.email, displayName: profile.displayName };
}

export function findUserById(db: Database, id: string): User | null {
  return db
    .query(
      `SELECT id, provider, provider_user_id as providerUserId, email, display_name as displayName
       FROM users WHERE id = ?`
    )
    .get(id) as User | null;
}

export function listUsers(db: Database): User[] {
  return db
    .query(
      `SELECT id, provider, provider_user_id as providerUserId, email, display_name as displayName
       FROM users ORDER BY created_at`
    )
    .all() as User[];
}
