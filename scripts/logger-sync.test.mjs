// Guards the one file that exists twice, and the one constant that exists three times.
//
// `godot/system_logger.gd` is the copy this repository publishes and that reviewers read.
// `ascent/Scenes/system_logger.gd` is the copy the game actually runs — and `ascent/` is
// deliberately gitignored, because the full game lives outside this repo. Nothing structural
// keeps the two in step, so the moment they drift the repo is showing code that did not
// produce the telemetry on the dashboard.
//
// CI cannot check the game copy (it is not in the checkout), so that assertion skips there.
// The manifest check runs everywhere.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED = join(ROOT, "godot", "system_logger.gd");
const IN_GAME = join(ROOT, "ascent", "Scenes", "system_logger.gd");

const exists = path => access(path).then(() => true, () => false);

test("the published logger matches the copy the game runs", async t => {
  if (!(await exists(IN_GAME))) {
    t.skip("ascent/ is not present (expected in CI — the game lives outside this repo)");
    return;
  }
  const [published, inGame] = await Promise.all([
    readFile(PUBLISHED, "utf8"),
    readFile(IN_GAME, "utf8")
  ]);
  assert.equal(
    published,
    inGame,
    "godot/system_logger.gd has drifted from ascent/Scenes/system_logger.gd. " +
    "Copy the authoritative version over the other: cp godot/system_logger.gd ascent/Scenes/system_logger.gd"
  );
});

test("the manifest's build version matches what the logger stamps", async () => {
  const [manifestRaw, logger] = await Promise.all([
    readFile(join(ROOT, "build-manifest.json"), "utf8"),
    readFile(PUBLISHED, "utf8")
  ]);
  const manifest = JSON.parse(manifestRaw);
  const stamped = logger.match(/const\s+BUILD_VERSION\s*:=\s*"([^"]+)"/)?.[1];

  assert.ok(stamped, "BUILD_VERSION not found in godot/system_logger.gd");
  assert.equal(
    stamped,
    manifest.build_version,
    "build-manifest.json and godot/system_logger.gd disagree about the build version. " +
    "The CI gate would wait forever for samples no build will produce."
  );
  assert.notEqual(
    manifest.build_version,
    manifest.baseline_version,
    "a build cannot be its own performance baseline"
  );
});
