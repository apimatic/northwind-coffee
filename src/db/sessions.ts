import type { Role } from "./users";

export interface SessionUserRow {
  user_id: number;
  email: string;
  role: Role;
}

export async function insertSession(
  db: D1Database,
  session: { tokenHash: string; userId: number; expiresAt: string },
): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)")
    .bind(session.tokenHash, session.userId, session.expiresAt)
    .run();
}

export async function findSessionUser(db: D1Database, tokenHash: string, now: string): Promise<SessionUserRow | null> {
  return db
    .prepare(
      `SELECT u.id AS user_id, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?1 AND s.expires_at > ?2`,
    )
    .bind(tokenHash, now)
    .first<SessionUserRow>();
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(tokenHash).run();
}

export async function deleteExpiredSessions(db: D1Database, userId: number, now: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?1 AND expires_at <= ?2").bind(userId, now).run();
}
