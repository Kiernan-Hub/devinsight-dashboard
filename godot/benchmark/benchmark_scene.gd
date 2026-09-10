extends SceneTree

# Deterministic, self-contained headless performance benchmark for CI.
#
# What this validates: the CI pipeline's ability to generate genuine per-tick timing data
# headlessly, on every push or PR, without waiting for a human to play a build — plus real
# engine and CI-runner performance under a workload shaped like a procedural climber (obstacles
# spawned ahead at growing density, culled by a rising hazard line from behind).
#
# What this does NOT validate: performance of Ascent itself. The real level generator, player
# controller, and renderer live outside this repository by design (see CLAUDE.md), so a
# regression introduced there will not show up here — only a regression in this benchmark's own
# logic, or in Godot/the CI runner itself, will. See BenchmarkModel's header for why the
# workload is original code rather than a copy of anything proprietary.
#
# Headless mode does no real GPU rendering, so this measures CPU-side cost only. A regression
# that is purely GPU-bound would not be caught by any headless benchmark, of the real game or
# otherwise.
#
# Measurement approach: rather than reading the interval between engine callback invocations
# (that interval turned out to be governed by an internal idle-loop pace in --headless mode —
# a stable ~145Hz regardless of workload, on every machine this was tested on, that Engine.
# max_fps, OS.low_processor_usage_mode, and project vsync settings all failed to move), this
# times the workload itself: how many wall-clock microseconds one physics tick's spawn/cull/
# update work actually took. That number is the thing a performance regression would change,
# it needs no assumption about how any given platform paces its main loop, and it is exactly
# the quantity system_logger.gd measures in the real game — the cost of one unit of work, not
# the cadence of an outer loop that isn't ours to control.
#
# Run: godot --headless --path godot --script benchmark/benchmark_scene.gd
# Output: one line to stdout prefixed "BENCHMARK_RESULT:" followed by a JSON object, and the
# same JSON written to res://benchmark/last_run.json.

# Explicit preload rather than relying on class_name global resolution: a fresh CI checkout has
# no .godot cache yet, and this must work correctly on the very first run in a clean clone.
const BenchmarkModel = preload("res://benchmark/benchmark_model.gd")

const RESULT_PATH := "res://benchmark/last_run.json"
const RESULT_PREFIX := "BENCHMARK_RESULT:"
# Wall-clock safety valve, independent of tick count: a run stuck for this long means the CI
# runner is pathologically overloaded or something hung — end with a flagged, unusable result
# rather than hang a CI job indefinitely.
const MAX_WALL_SECONDS := 180.0

var world: Node
var height := 0.0
var hazard_height := 0.0
var tick := 0
var next_obstacle_at := 0.0
var obstacles: Array[Node2D] = []
# One measured duration per physics tick — exactly PHYSICS_TICKS samples on a normal run,
# fixed and reproducible, unlike sampling however many render callbacks a paced idle loop
# happens to produce in some wall-clock window.
var tick_times_ms: Array = []
var max_obstacle_count := 0
var start_time_usec := 0
var timed_out := false

func _initialize() -> void:
	world = Node.new()
	get_root().add_child(world)
	start_time_usec = Time.get_ticks_usec()

func _physics_process(_delta: float) -> bool:
	var tick_start_usec = Time.get_ticks_usec()

	tick += 1
	var next_state = BenchmarkModel.advance(height, hazard_height)
	height = next_state["height"]
	hazard_height = next_state["hazard_height"]

	_spawn_obstacles()
	_cull_obstacles()
	_update_obstacles()

	tick_times_ms.append((Time.get_ticks_usec() - tick_start_usec) / 1000.0)

	var wall_seconds = (Time.get_ticks_usec() - start_time_usec) / 1_000_000.0
	if wall_seconds > MAX_WALL_SECONDS:
		timed_out = true
		_finish()
		return true

	if tick >= BenchmarkModel.PHYSICS_TICKS:
		_finish()
		return true
	return false

func _spawn_obstacles() -> void:
	while next_obstacle_at <= height:
		var obstacle := StaticBody2D.new()
		obstacle.position = Vector2(0, -next_obstacle_at)
		var shape := CollisionShape2D.new()
		var rect := RectangleShape2D.new()
		rect.size = Vector2(64, 16)
		shape.shape = rect
		obstacle.add_child(shape)
		obstacle.set_meta("spawn_height", next_obstacle_at)
		world.add_child(obstacle)
		obstacles.append(obstacle)
		max_obstacle_count = maxi(max_obstacle_count, obstacles.size())
		next_obstacle_at += BenchmarkModel.spawn_interval_for_height(height)

func _cull_obstacles() -> void:
	for i in range(obstacles.size() - 1, -1, -1):
		var obstacle = obstacles[i]
		if BenchmarkModel.should_cull(obstacle.get_meta("spawn_height"), hazard_height):
			obstacles.remove_at(i)
			obstacle.queue_free()

# O(live obstacle count) work performed every tick, standing in for the kind of per-entity
# per-frame check a real game does (distance to player, on-screen test, and so on). Without
# this, obstacles cost almost nothing once spawned — existing in the tree and physics server is
# comparatively cheap in Godot — and the benchmark would mostly measure fixed per-tick overhead
# rather than anything that scales with how many objects are alive.
func _update_obstacles() -> void:
	for obstacle in obstacles:
		var distance_to_hazard = obstacle.position.y - (-hazard_height)
		obstacle.set_meta("distance_to_hazard", distance_to_hazard)

func _percentile(values: Array, quantile: float) -> float:
	if values.is_empty():
		return 0.0
	var sorted_values = values.duplicate()
	sorted_values.sort()
	var index = float(sorted_values.size() - 1) * quantile
	var lower = int(floor(index))
	var upper = mini(lower + 1, sorted_values.size() - 1)
	return lerp(float(sorted_values[lower]), float(sorted_values[upper]), index - float(lower))

func _finish() -> void:
	var wall_seconds = (Time.get_ticks_usec() - start_time_usec) / 1_000_000.0
	var avg_tick_ms = 0.0
	if not tick_times_ms.is_empty():
		var total = 0.0
		for value in tick_times_ms:
			total += value
		avg_tick_ms = total / tick_times_ms.size()

	var avg_fps = 1000.0 / avg_tick_ms if avg_tick_ms > 0.0 else 0.0
	var max_tick_ms = tick_times_ms.max() if not tick_times_ms.is_empty() else 0.0

	var result = {
		"schema_version": 2,
		"ticks": tick,
		"expected_ticks": BenchmarkModel.PHYSICS_TICKS,
		"timed_out": timed_out,
		"final_height": snapped(height, 0.01),
		"max_obstacle_count": max_obstacle_count,
		"frames_sampled": tick_times_ms.size(),
		"avg_fps": snapped(avg_fps, 0.01),
		"p95_frame_time_ms": snapped(_percentile(tick_times_ms, 0.95), 0.001),
		"max_frame_time_ms": snapped(max_tick_ms, 0.001),
		"godot_version": Engine.get_version_info().get("string", "unknown"),
		"duration_wall_seconds": snapped(wall_seconds, 0.001)
	}

	print(RESULT_PREFIX + JSON.stringify(result))

	var file = FileAccess.open(RESULT_PATH, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(result, "  "))
		file.close()
