// Generates the credentials for the local Docker stack, on first boot, on this machine.
//
//   node scripts/local-keys.mjs <output-dir>
//
// Supabase's API keys are JWTs: small signed JSON documents saying "the bearer of this acts as
// database role X". PostgREST trusts any JWT signed with its secret, and the ingest function
// writes with one claiming the powerful `service_role`. Locally, both halves have to exist.
//
// The easy route is to commit a fixed "demo" secret and pre-signed keys, as many local setups
// do. This project leaked a credential into its public git history once already (see
// HANDOFF.md), so it does not commit a service-role key at all — not even a harmless-looking
// local one, because a reader cannot tell a harmless key from a real one at a glance. Instead,
// docker-compose.yml runs this script once, before anything else starts: it makes a random
// secret, signs a service-role key with it, and writes both into a Docker volume that only the
// two services that need them can read. Nothing secret is in the repo, the image, or the
// compose file.

import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const base64url = input => Buffer.from(input).toString("base64url");

// HS256 JWT signing, which is all PostgREST needs. Written out rather than pulled from a library
// because the repository has no npm dependencies by design, and this is twelve lines of
// standard-library code against a fixed, tested specification (RFC 7519).
export function signJwt(payload, secret) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

// PostgREST rejects secrets shorter than 32 characters. 48 random bytes is 64 characters of
// base64url, comfortably over.
export function newSecret() {
  return randomBytes(48).toString("base64url");
}

export function serviceRoleClaims(nowSeconds) {
  return {
    role: "service_role",
    iss: "devinsight-local",
    iat: nowSeconds,
    // Long-lived, like Supabase's own project keys: it is only ever valid against this one
    // local database, and the secret behind it is regenerated whenever the volume is reset.
    exp: nowSeconds + 10 * 365 * 24 * 60 * 60
  };
}

function writeSecret(path, contents, owner) {
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  // Readable only by the uid that consumes it. PostgREST's image and the ingest image (Node's
  // `node` user) both run as uid 1000, so one owner covers both readers.
  if (owner) chownSync(path, owner.uid, owner.gid);
}

export function main(outputDir, { owner = null, now = Date.now() } = {}) {
  mkdirSync(outputDir, { recursive: true });
  const secretPath = join(outputDir, "jwt-secret");

  // Keep an existing secret across restarts; otherwise every `docker compose up` would mint a
  // new one and silently invalidate any key copied out of the volume earlier.
  const reused = existsSync(secretPath);
  const secret = reused ? readFileSync(secretPath, "utf8").trim() : newSecret();
  if (!reused) writeSecret(secretPath, secret, owner);

  writeSecret(join(outputDir, "service-role.jwt"), signJwt(serviceRoleClaims(Math.floor(now / 1000)), secret), owner);
  console.info(`local-keys: ${reused ? "reused existing" : "generated new"} signing secret in ${outputDir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [outputDir] = process.argv.slice(2);
  if (!outputDir) {
    console.error("usage: node scripts/local-keys.mjs <output-dir>");
    process.exit(2);
  }
  // KEYS_OWNER="1000:1000" — set by docker-compose.yml. Unset when run by hand, so the files
  // simply belong to whoever ran the script.
  const [uid, gid] = (process.env.KEYS_OWNER || "").split(":").map(Number);
  main(outputDir, { owner: Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null });
}
