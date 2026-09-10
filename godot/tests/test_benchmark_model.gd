extends SceneTree

# Headless tests for BenchmarkModel's pure decision logic — the part of the CI benchmark that
# determines the SHAPE of the workload (when obstacles spawn, when they're culled, how fast the
# hazard rises). This must stay bit-identical across runs and across Godot versions for the
# baseline comparison in scripts/benchmark-core.mjs to mean anything; these tests exist to catch
# an accidental change to that shape before it silently invalidates every stored baseline.
#
# Run: godot --headless --path godot --script tests/test_benchmark_model.gd

const BenchmarkModel = preload("res://benchmark/benchmark_model.gd")

var failures := 0
var checks := 0

func _initialize() -> void:
	_run("hazard speed rises linearly then caps", func(): _test_hazard_speed())
	_run("density grows with height and never divides by zero", func(): _test_density())
	_run("culling triggers only once buffer distance has passed", func(): _test_should_cull())
	_run("advance() is a pure step with no side effects", func(): _test_advance())

	print("")
	if failures == 0:
		print("PASS — %d checks" % checks)
	else:
		printerr("FAIL — %d of %d checks failed" % [failures, checks])
	quit(1 if failures > 0 else 0)

func _run(name: String, body: Callable) -> void:
	body.call()
	print("  ok  %s" % name)

func _check(condition: bool, message: String) -> void:
	checks += 1
	if not condition:
		failures += 1
		printerr("  FAIL: %s" % message)

func _test_hazard_speed() -> void:
	var at_zero = BenchmarkModel.hazard_speed(0.0)
	var at_mid = BenchmarkModel.hazard_speed(1000.0)
	var at_high = BenchmarkModel.hazard_speed(1_000_000.0)
	_check(is_equal_approx(at_zero, BenchmarkModel.HAZARD_BASE_SPEED), "at height 0, speed should equal the base speed")
	_check(at_mid > at_zero, "speed should rise with height")
	_check(is_equal_approx(at_high, BenchmarkModel.HAZARD_MAX_SPEED), "speed must cap at HAZARD_MAX_SPEED, not grow unbounded")

func _test_density() -> void:
	var at_zero = BenchmarkModel.density_for_height(0.0)
	var at_high = BenchmarkModel.density_for_height(10000.0)
	_check(is_equal_approx(at_zero, BenchmarkModel.BASE_DENSITY), "density at height 0 should equal the base density")
	_check(at_high > at_zero, "density should grow with height — this is what makes the workload heavier over the run")

	var interval_low = BenchmarkModel.spawn_interval_for_height(0.0)
	var interval_high = BenchmarkModel.spawn_interval_for_height(10000.0)
	_check(interval_high < interval_low, "a higher density should mean a SHORTER spawn interval")
	_check(interval_low > 0.0 and interval_high > 0.0, "spawn interval must never be zero or negative")

	# An extreme, physically implausible height must not produce a division blow-up.
	var extreme = BenchmarkModel.spawn_interval_for_height(1e12)
	_check(is_finite(extreme) and extreme > 0.0, "spawn interval must stay finite and positive even at an extreme height")

func _test_should_cull() -> void:
	_check(not BenchmarkModel.should_cull(100.0, 50.0), "an obstacle well ahead of the hazard should not be culled")
	_check(not BenchmarkModel.should_cull(100.0, 100.0 - BenchmarkModel.CULL_BUFFER + 1.0), "an obstacle just inside the buffer should survive")
	_check(BenchmarkModel.should_cull(100.0, 100.0 + BenchmarkModel.CULL_BUFFER + 1.0), "an obstacle well past the buffer must be culled")

func _test_advance() -> void:
	var state = BenchmarkModel.advance(0.0, 0.0)
	_check(is_equal_approx(state["height"], BenchmarkModel.CLIMB_RATE), "height should advance by exactly CLIMB_RATE per tick")
	_check(state["hazard_height"] > 0.0, "hazard height should advance too")

	# Same inputs must always produce the same outputs — this is the determinism the whole
	# baseline-comparison approach depends on.
	var state_a = BenchmarkModel.advance(500.0, 300.0)
	var state_b = BenchmarkModel.advance(500.0, 300.0)
	_check(state_a["height"] == state_b["height"] and state_a["hazard_height"] == state_b["hazard_height"],
		"advance() must be deterministic: identical inputs produced different outputs")
