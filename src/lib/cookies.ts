import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "nw_session";
export const ANON_COOKIE = "nw_anon";

const base = { path: "/", httpOnly: true, secure: true, sameSite: "Lax" } as const;

export function readCookie(c: Context, name: string): string | undefined {
  return getCookie(c, name);
}

export function writeCookie(c: Context, name: string, value: string, maxAgeSeconds: number): void {
  setCookie(c, name, value, { ...base, maxAge: maxAgeSeconds });
}

export function clearCookie(c: Context, name: string): void {
  deleteCookie(c, name, base);
}
