import type { SessionUser } from "./services/identity";

export interface AppVariables {
  /** The signed-in user, or null for anonymous visitors. */
  user: SessionUser | null;
  /** Raw session token from the cookie (only set when it resolved to a user). */
  sessionToken: string | null;
  /** Anonymous visitor id from the cookie (used for the anonymous basket). */
  anonId: string | null;
  /** Basket owner key for the current visitor. */
  buyerId: string;
  /** CSRF token for forms rendered in this request. */
  csrfToken: string;
}

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}
