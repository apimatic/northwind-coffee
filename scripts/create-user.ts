/**
 * Creates (or with --update, re-passwords) a user in the D1 database.
 *
 *   NW_PASSWORD='...' npx tsx scripts/create-user.ts --email admin@example.com --role admin --local
 *   NW_PASSWORD='...' npx tsx scripts/create-user.ts --email admin@example.com --role admin --remote
 *
 * The password is read from the NW_PASSWORD environment variable, never from the command line.
 * Options:
 *   --email <email>        required
 *   --role customer|admin  default: customer
 *   --local | --remote     which database (default: --local)
 *   --persist-to <dir>     local state directory (passed through to wrangler)
 *   --update               if the email exists, replace its password and role
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { emailSchema, passwordSchema, roleSchema } from "../src/lib/credentials";
import { hashPassword } from "../src/lib/password";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    role: { type: "string", default: "customer" },
    local: { type: "boolean", default: false },
    remote: { type: "boolean", default: false },
    "persist-to": { type: "string" },
    update: { type: "boolean", default: false },
  },
  strict: true,
});

function fail(message: string): never {
  console.error(`create-user: ${message}`);
  process.exit(1);
}

if (values.local && values.remote) fail("use either --local or --remote, not both");
const email = emailSchema.safeParse(values.email ?? "");
if (!email.success) fail("--email must be a valid email address");
const role = roleSchema.safeParse(values.role);
if (!role.success) fail("--role must be customer or admin");
const password = passwordSchema.safeParse(process.env.NW_PASSWORD ?? "");
if (!password.success) fail("set NW_PASSWORD to a password of 8 to 128 characters");

const hash = await hashPassword(password.data);
// Values are validated above (email format, fixed role, base64url hash), so quoting is safe;
// single quotes are still escaped as defence in depth.
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
const conflict = values.update
  ? "ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role"
  : "ON CONFLICT (email) DO NOTHING";
const sql = `INSERT INTO users (email, password_hash, role) VALUES (${sqlString(email.data)}, ${sqlString(hash)}, ${sqlString(role.data)}) ${conflict} RETURNING id, email, role;`;

const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);
const args = [wranglerBin, "d1", "execute", "DB", values.remote ? "--remote" : "--local", "--json", "--command", sql];
if (values["persist-to"]) args.push("--persist-to", values["persist-to"]);

const result = spawnSync(process.execPath, args, { encoding: "utf8" });
if (result.status !== 0) {
  // Print wrangler's error but never the SQL (it contains the password hash).
  fail(`wrangler d1 execute failed:\n${(result.stderr || result.stdout).replaceAll(hash, "<hash>")}`);
}
// --json prints one entry per statement; RETURNING yields a row only if the user was written.
const output = JSON.parse(result.stdout) as { results: { id: number; email: string; role: string }[] }[];
const row = output[0]?.results[0];
if (!row) {
  console.log(`User ${email.data} already exists; nothing changed. Use --update to reset its password and role.`);
} else {
  console.log(`${values.update ? "Saved" : "Created"} user ${row.email} (id ${row.id}) with role ${row.role}.`);
}
