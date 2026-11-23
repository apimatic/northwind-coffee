import { z } from "zod";

/** Credential rules shared by the Worker and the create-user script (no Worker-only types here). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(254));

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

export const roleSchema = z.enum(["customer", "admin"]);
