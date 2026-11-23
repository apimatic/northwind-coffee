/**
 * Starts `wrangler dev` against a fresh local D1 database for the end-to-end tests:
 * wipes the e2e state directory, applies migrations, creates the admin user, then serves.
 * Run by Playwright's webServer; requires a .dev.vars file (see .dev.vars.example).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_PORT, E2E_STATE_DIR } from "./constants";

const root = join(import.meta.dirname, "..");
const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");

if (!existsSync(join(root, ".dev.vars"))) {
  console.error("e2e: .dev.vars is missing. Copy .dev.vars.example to .dev.vars and set CSRF_SECRET.");
  process.exit(1);
}

function run(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(join(root, E2E_STATE_DIR), { recursive: true, force: true });
run([wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", E2E_STATE_DIR]);
run(
  [
    join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    "scripts/create-user.ts",
    "--email",
    E2E_ADMIN_EMAIL,
    "--role",
    "admin",
    "--local",
    "--persist-to",
    E2E_STATE_DIR,
  ],
  { ...process.env, NW_PASSWORD: E2E_ADMIN_PASSWORD },
);

const dev = spawn(
  process.execPath,
  [wrangler, "dev", "--port", String(E2E_PORT), "--persist-to", E2E_STATE_DIR, "--show-interactive-dev-session=false"],
  { cwd: root, stdio: "inherit" },
);
const stop = () => dev.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
dev.on("exit", (code) => process.exit(code ?? 0));
