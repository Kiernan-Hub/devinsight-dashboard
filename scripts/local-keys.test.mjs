// Tests for scripts/local-keys.mjs, the local Docker stack's credential generator.
//
// The signer is checked against an externally published token rather than against itself: a
// test that signs and then verifies with the same code would pass even if both halves shared
// the same bug, and PostgREST — which does not share our code — would then reject every key.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, newSecret, serviceRoleClaims, signJwt } from "./local-keys.mjs";

test("signJwt reproduces the reference HS256 token from jwt.io byte for byte", () => {
  // The example token every JWT library is checked against: https://jwt.io, secret
  // "your-256-bit-secret".
  const expected =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ." +
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.equal(signJwt({ sub: "1234567890", name: "John Doe", iat: 1516239022 }, "your-256-bit-secret"), expected);
});

test("generated secrets are long enough for PostgREST and never repeat", () => {
  const a = newSecret();
  assert.ok(a.length >= 32, "PostgREST refuses JWT secrets under 32 characters");
  assert.notEqual(a, newSecret());
});

test("the service-role key claims service_role and has not already expired", () => {
  const now = 1_800_000_000;
  const claims = serviceRoleClaims(now);
  assert.equal(claims.role, "service_role");
  assert.ok(claims.exp > now + 365 * 24 * 60 * 60);
});

test("main writes a key signed by the secret it wrote, readable by the owner only", () => {
  const dir = mkdtempSync(join(tmpdir(), "local-keys-"));
  main(dir, { now: 1_800_000_000_000 });

  const secret = readFileSync(join(dir, "jwt-secret"), "utf8").trim();
  const token = readFileSync(join(dir, "service-role.jwt"), "utf8").trim();
  const [header, payload, signature] = token.split(".");
  assert.equal(createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url"), signature);
  assert.equal(JSON.parse(Buffer.from(payload, "base64url")).role, "service_role");

  for (const file of ["jwt-secret", "service-role.jwt"]) {
    assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600, `${file} must not be group/world readable`);
  }
});

test("main keeps an existing secret, so restarts do not invalidate issued keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "local-keys-"));
  main(dir);
  const first = readFileSync(join(dir, "jwt-secret"), "utf8");
  main(dir);
  assert.equal(readFileSync(join(dir, "jwt-secret"), "utf8"), first);
});
