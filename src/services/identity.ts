import { z } from "zod";
import * as sessionsDb from "../db/sessions";
import * as usersDb from "../db/users";
import type { Role } from "../db/users";
import { emailSchema, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordSchema } from "../lib/credentials";
import { randomToken, sha256Base64Url } from "../lib/encoding";
import { getDummyHash, hashPassword, verifyPassword } from "../lib/password";

export type { Role };

export interface SessionUser {
  id: number;
  email: string;
  role: Role;
}

export { emailSchema, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordSchema };

export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "The passwords don't match.",
  });

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH),
});

export async function createUser(
  db: D1Database,
  input: { email: string; password: string; role?: Role },
): Promise<{ ok: true; user: SessionUser } | { ok: false; reason: "email_taken" }> {
  const email = emailSchema.parse(input.email);
  const password = passwordSchema.parse(input.password);
  const role = input.role ?? "customer";
  const id = await usersDb.insertUser(db, { email, passwordHash: await hashPassword(password), role });
  if (id === null) return { ok: false, reason: "email_taken" };
  return { ok: true, user: { id, email, role } };
}

/** Verifies credentials. Unknown emails cost the same PBKDF2 work as known ones. */
export async function authenticate(db: D1Database, email: string, password: string): Promise<SessionUser | null> {
  const user = await usersDb.findUserByEmail(db, email);
  if (!user) {
    await verifyPassword(password, await getDummyHash());
    return null;
  }
  if (!(await verifyPassword(password, user.password_hash))) return null;
  return { id: user.id, email: user.email, role: user.role };
}

/** Creates a server-side session and returns the token for the cookie (only its hash is stored). */
export async function createSession(db: D1Database, userId: number, now = new Date()): Promise<string> {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await sessionsDb.deleteExpiredSessions(db, userId, now.toISOString());
  await sessionsDb.insertSession(db, { tokenHash: await sha256Base64Url(token), userId, expiresAt });
  return token;
}

export async function resolveSession(db: D1Database, token: string, now = new Date()): Promise<SessionUser | null> {
  if (token.length < 20 || token.length > 100) return null;
  const row = await sessionsDb.findSessionUser(db, await sha256Base64Url(token), now.toISOString());
  return row ? { id: row.user_id, email: row.email, role: row.role } : null;
}

export async function endSession(db: D1Database, token: string): Promise<void> {
  await sessionsDb.deleteSession(db, await sha256Base64Url(token));
}

/** Accepts only same-site relative paths, to avoid open redirects after sign-in. */
export function safeReturnUrl(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || value.length > 500) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}
