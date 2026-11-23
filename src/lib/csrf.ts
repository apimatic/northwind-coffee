import { bytesToBase64Url, timingSafeEqual } from "./encoding";

export const CSRF_FIELD = "_csrf";
export const CSRF_HEADER = "x-csrf-token";

const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    keys.set(secret, key);
  }
  return key;
}

/**
 * The CSRF token is an HMAC of the visitor's session token (signed in) or anonymous id, so it is
 * tied to that cookie and changes when the visitor signs in or out.
 */
export async function csrfTokenFor(secret: string, binding: string): Promise<string> {
  if (secret.length < 32) throw new Error("CSRF_SECRET must be at least 32 characters");
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(`csrf:${binding}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export function csrfTokensMatch(expected: string, received: unknown): boolean {
  return typeof received === "string" && received.length > 0 && timingSafeEqual(expected, received);
}
