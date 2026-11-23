import { base64UrlToBytes, bytesToBase64Url, timingSafeEqual } from "./encoding";

/**
 * PBKDF2-SHA256 password hashing with WebCrypto (works in Workers and in Node).
 * Stored format: pbkdf2_sha256$<iterations>$<salt>$<hash> (base64url).
 */
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BITS);
  return bytesToBase64Url(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationsText, saltText, expected] = stored.split("$");
  const iterations = Number(iterationsText);
  if (scheme !== "pbkdf2_sha256" || !Number.isSafeInteger(iterations) || !saltText || !expected) {
    return false;
  }
  const actual = await derive(password, base64UrlToBytes(saltText), iterations);
  return timingSafeEqual(actual, expected);
}

/** A valid hash of a random password, used to keep sign-in timing equal for unknown emails. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomUUID());
  return dummyHash;
}
