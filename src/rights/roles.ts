import { Database } from "bun:sqlite";

export function assignRole(db: Database, userId: string, role: string): void {
  db.query(`INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)`).run(userId, role);
}

export function revokeRole(db: Database, userId: string, role: string): void {
  db.query(`DELETE FROM user_roles WHERE user_id = ? AND role = ?`).run(userId, role);
}

export function getUserRoles(db: Database, userId: string): string[] {
  const rows = db.query(`SELECT role FROM user_roles WHERE user_id = ?`).all(userId) as { role: string }[];
  return rows.map((row) => row.role);
}
