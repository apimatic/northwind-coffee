export type Role = "customer" | "admin";

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: Role;
  created_at: string;
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT id, email, password_hash, role, created_at FROM users WHERE email = ?1")
    .bind(email)
    .first<UserRow>();
}

/** Inserts a user and returns its id, or null when the email is already registered. */
export async function insertUser(
  db: D1Database,
  user: { email: string; passwordHash: string; role: Role },
): Promise<number | null> {
  const row = await db
    .prepare(
      "INSERT INTO users (email, password_hash, role) VALUES (?1, ?2, ?3) ON CONFLICT (email) DO NOTHING RETURNING id",
    )
    .bind(user.email, user.passwordHash, user.role)
    .first<{ id: number }>();
  return row?.id ?? null;
}
