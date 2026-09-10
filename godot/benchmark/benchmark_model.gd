class_name BenchmarkModel
extends RefCounted

# Pure decision logic for the headless CI benchmark, kept separate from benchmark_scene.gd
# (which owns the actual SceneTree, spawns real nodes, and measures real frame times) for the
# same reason ingest-core.mjs is kept separate from api/ingest.js: the math is what needs to be
# testable in isolation, without a running engine loop or a live scene tree.
#
# This does NOT model Ascent. Ascent's real level generator and lava hazard live outside this
# repository by design, so nothing here is their logic, copied or otherwise — it is original,
# structurally similar code: a climbing position, obstacles spawned ahead of it at a density
# that grows with progress, and a hazard line that rises behind it and culls them. That shape
# (spawn-ahead / cull-behind / density-scales-with-progress) is what a procedural climber's
# performance profile generally looks like, not anything proprietary to one game.

# Fixed, not derived from time or hardware: the WORKLOAD must be bit-identical on every run, so
# that a change in measured frame time reflects a real performance difference and not a
# different amount of work being measured.
const PHYSICS_TICKS := 1800          # 30 simulated seconds at the default 60Hz physics tick
const CLIMB_RATE := 2.4              # height units per physics tick
const BASE_DENSITY := 0.15           # obstacles per unit height, at height 0
const DENSITY_SCALING := 0.00006     # density grows with height
const HAZARD_BASE_SPEED := 1.6
const HAZARD_MAX_SPEED := 3.4
const HAZARD_SCALING := 0.0009
# Wide enough that, combined with the density above, several hundred obstacles are resident at
# once by the back half of the run — enough live nodes that regressing their per-tick cost
# produces a clearly measurable difference, without making a single CI run expensive.
const CULL_BUFFER := 1500.0
const MIN_SPAWN_INTERVAL := 0.05     # guards against a division blow-up at extreme height

# How fast the hazard line rises: a linear increase with a hard cap, the same *shape* as a
# difficulty curve that gets harder with progress but never impossibly so.
static func hazard_speed(height: float) -> float:
	return minf(HAZARD_BASE_SPEED + height * HAZARD_SCALING, HAZARD_MAX_SPEED)

# Obstacles per unit height at the given progress. Growing density is what makes the workload
# heavier the longer the benchmark runs, which is the point: it stresses spawn/cull and node
# bookkeeping under an increasing load, not a flat one.
static func density_for_height(height: float) -> float:
	return BASE_DENSITY + height * DENSITY_SCALING

static func spawn_interval_for_height(height: float) -> float:
	return 1.0 / maxf(density_for_height(height), MIN_SPAWN_INTERVAL)

static func should_cull(obstacle_spawn_height: float, hazard_height: float) -> bool:
	return obstacle_spawn_height < hazard_height - CULL_BUFFER

# One physics tick of pure state advancement: given the current height and hazard height,
# returns the next values. No node, no tree, no side effects — this is what makes the shape of
# the workload testable without booting a scene.
static func advance(height: float, hazard_height: float) -> Dictionary:
	return {
		"height": height + CLIMB_RATE,
		"hazard_height": hazard_height + hazard_speed(height)
	}
