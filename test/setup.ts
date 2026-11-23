import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Applies only migrations not yet applied, so this is safe to run for every test file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
