extends SceneTree

# Headless tests for the offline queue in system_logger.gd.
#
# The queue is the part of the client with real state: it batches by session, survives restarts
# through a JSON file, caps its own size, and must never discard rows the server has not yet
# confirmed. Every bug found in it so far has been silent — data vanishing rather than anything
# crashing — so it is worth testing directly rather than by watching a dashboard.
#
# The logger is instantiated but never added to the scene tree, so _ready never runs and no
# network request is ever made. Only queue behaviour is under test here.
#
# Run: godot --headless --path godot --script tests/test_logger_queue.gd

const LoggerScript = preload("res://system_logger.gd")

var failures := 0
var checks := 0

func _initialize() -> void:
	_run("uuid v4 has the right shape", func(): _test_uuid())
	_run("percentile interpolates like the dashboard's", func(): _test_percentile())
	_run("samples group into one batch per session", func(): _test_batching())
	_run("the queue caps its total sample count", func(): _test_trim_cap())
	_run("an in-flight batch is never trimmed out from under the server", func(): _test_trim_protects_inflight())
	_run("a successful flush removes only the rows it carried", func(): _test_flush_removes_only_sent())
	_run("legacy flat queue files keep their original build version", func(): _test_legacy_migration())
	_run("the context provider decorates each sample", func(): _test_context_provider())
	_run("events queue, cap, and survive a restart", func(): _test_events())

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

func _new_logger() -> Node:
	var logger = LoggerScript.new()
	logger.session_id = logger._generate_uuid_v4()
	return logger

func _sample(fps: int) -> Dictionary:
	return {"app_name": "Ascent", "fps_rate": fps, "memory_used_mb": 90.0}

# ---------------------------------------------------------------------------

func _test_uuid() -> void:
	var logger = _new_logger()
	var id = logger._generate_uuid_v4()
	var re = RegEx.new()
	re.compile("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
	_check(re.search(id) != null, "uuid '%s' does not match the v4 shape the server validates" % id)
	_check(id != logger._generate_uuid_v4(), "two generated uuids collided")
	logger.free()

func _test_percentile() -> void:
	var logger = _new_logger()
	# Same definition as dashboard-core.mjs: linear interpolation between neighbours.
	_check(abs(logger._percentile([10.0, 20.0, 30.0], 0.5) - 20.0) < 0.001, "p50 of [10,20,30] should be 20")
	_check(abs(logger._percentile([10.0, 20.0], 0.5) - 15.0) < 0.001, "p50 of [10,20] should interpolate to 15")
	_check(logger._percentile([], 0.95) == 0.0, "empty percentile should be 0")
	logger.free()

func _test_batching() -> void:
	var logger = _new_logger()
	logger._enqueue(_sample(60))
	logger._enqueue(_sample(59))
	_check(logger.queue.size() == 1, "same-session samples should share one batch, got %d" % logger.queue.size())
	_check(logger.queue[0]["samples"].size() == 2, "batch should hold both samples")
	_check(logger.queue[0]["session"]["build_version"] == logger.BUILD_VERSION, "batch should record the build")

	# A new session (a restart) must start its own batch so its build is recorded separately.
	logger.session_id = logger._generate_uuid_v4()
	logger._enqueue(_sample(58))
	_check(logger.queue.size() == 2, "a new session should open a new batch, got %d" % logger.queue.size())
	logger.free()

func _test_trim_cap() -> void:
	var logger = _new_logger()
	for i in logger.MAX_QUEUE_SIZE + 25:
		logger._enqueue(_sample(60))
	_check(logger._queued_sample_count() == logger.MAX_QUEUE_SIZE,
		"queue should cap at %d, held %d" % [logger.MAX_QUEUE_SIZE, logger._queued_sample_count()])
	# Trimming drops the OLDEST, so the newest sample must still be present.
	var last_batch = logger.queue[-1]["samples"]
	_check(last_batch.size() > 0, "newest samples should survive trimming")
	logger.free()

func _test_trim_protects_inflight() -> void:
	var logger = _new_logger()
	# Three distinctively-marked samples stand in for the rows inside an in-flight request.
	for marker in [11, 12, 13]:
		logger._enqueue(_sample(marker))
	logger.is_flushing = true
	logger.in_flight_count = 3

	# Overflow the queue well past its cap so trimming is forced to run many times.
	for i in logger.MAX_QUEUE_SIZE + 20:
		logger._enqueue(_sample(60))

	_check(logger._queued_sample_count() == logger.MAX_QUEUE_SIZE,
		"queue should still cap at %d, held %d" % [logger.MAX_QUEUE_SIZE, logger._queued_sample_count()])

	var remaining = logger.queue[0]["samples"]
	for i in 3:
		var marker = 11 + i
		_check(remaining.size() > i and remaining[i]["fps_rate"] == marker,
			"in-flight sample %d was trimmed away; the flush cleanup would then pop the wrong rows" % marker)
	logger.free()

func _test_flush_removes_only_sent() -> void:
	var logger = _new_logger()
	for i in 5:
		logger._enqueue(_sample(60 + i))

	# A flush carrying the first 2 samples is in the air...
	logger.is_flushing = true
	logger.in_flight_count = 2
	# ...and a live send fails meanwhile, appending a 6th sample to the same batch.
	logger._enqueue(_sample(99))
	_check(logger._queued_sample_count() == 6, "the late sample should have joined the queue")

	# The flush now succeeds. Only the 2 rows it actually carried may be removed.
	logger._on_flush_request_completed(HTTPRequest.RESULT_SUCCESS, 201, [], PackedByteArray())

	_check(logger._queued_sample_count() == 4,
		"expected 4 samples left after a 2-row flush, found %d — rows that were never sent were deleted"
			% logger._queued_sample_count())
	var fps_left = []
	for batch in logger.queue:
		for entry in batch["samples"]:
			fps_left.append(entry["fps_rate"])
	_check(fps_left.has(99), "the sample queued during the flush must survive it")
	_check(not fps_left.has(60), "the first flushed sample should have been removed")
	logger.free()

func _test_legacy_migration() -> void:
	var logger = _new_logger()
	# A pre-0.5.0 queue file: a flat array of samples that carry their own build_version.
	var legacy = [
		{"app_name": "Ascent", "fps_rate": 58.0, "memory_used_mb": 90.0, "build_version": "0.4.0"},
		{"app_name": "Ascent", "fps_rate": 57.0, "memory_used_mb": 91.0, "build_version": "0.4.0"}
	]
	var file = FileAccess.open(logger.QUEUE_FILE_PATH, FileAccess.WRITE)
	file.store_string(JSON.stringify(legacy))
	file.close()

	var fresh = LoggerScript.new()
	fresh.session_id = fresh._generate_uuid_v4()
	fresh._load_queue()

	_check(fresh.queue.size() == 1, "legacy samples should be adopted into one batch")
	_check(fresh.queue[0]["session"]["build_version"] == "0.4.0",
		"legacy samples must keep the build they recorded, not the build running now")
	_check(fresh.queue[0]["samples"].size() == 2, "both legacy samples should survive")
	# JSON round-tripping turns 58 into 58.0; Postgres's integer column rejects that.
	_check(typeof(fresh.queue[0]["samples"][0]["fps_rate"]) == TYPE_INT,
		"fps_rate should be cast back to an int on load")
	_check(not fresh.queue[0]["samples"][0].has("build_version"),
		"per-sample build_version should move up to the session")

	DirAccess.remove_absolute(ProjectSettings.globalize_path(logger.QUEUE_FILE_PATH))
	logger.free()
	fresh.free()


func _test_context_provider() -> void:
	var logger = _new_logger()
	_check(logger._gameplay_context().is_empty(), "no provider registered should yield no context")

	logger.register_context_provider(func(): return {"height": 4210.5, "platform_count": 182})
	var context = logger._gameplay_context()
	_check(context.get("height") == 4210.5, "provider height should reach the sample")
	_check(context.get("platform_count") == 182, "provider platform_count should reach the sample")

	# A provider that returns the wrong type must not take the logger down with it — telemetry
	# is a bolt-on, and a bug in it should never break the game it is measuring.
	logger.register_context_provider(func(): return "not a dictionary")
	_check(logger._gameplay_context().is_empty(), "a malformed provider result should degrade to no context")
	logger.free()

func _test_events() -> void:
	var logger = _new_logger()
	logger.log_event("death", 4210.0, {"cause": "lava"})
	logger.log_event("powerup", 900.0)
	_check(logger.pending_events.size() == 2, "both events should be pending")
	_check(logger.pending_events[0]["event_type"] == "death", "event type should round-trip")
	_check(logger.pending_events[0]["height"] == 4210.0, "event height should round-trip")
	_check(logger.pending_events[0]["detail"]["cause"] == "lava", "event detail should round-trip")
	_check(not logger.pending_events[1].has("detail"), "an empty detail should be omitted entirely")

	# Overflow the event backlog; the two in flight must be protected exactly like samples.
	logger.in_flight_event_count = 2
	for i in logger.MAX_EVENT_QUEUE + 10:
		logger.log_event("death", float(i))
	_check(logger.pending_events.size() == logger.MAX_EVENT_QUEUE,
		"event queue should cap at %d, held %d" % [logger.MAX_EVENT_QUEUE, logger.pending_events.size()])
	_check(logger.pending_events[0]["event_type"] == "death" and logger.pending_events[0]["height"] == 4210.0,
		"an in-flight event was trimmed away")

	# A successful send clears only the events that were actually in the request.
	logger.in_flight_event_count = 2
	var before = logger.pending_events.size()
	logger._on_http_request_request_completed(HTTPRequest.RESULT_SUCCESS, 200, [], PackedByteArray())
	_check(logger.pending_events.size() == before - 2,
		"expected 2 events cleared, went from %d to %d" % [before, logger.pending_events.size()])

	# Events must survive a restart alongside the sample backlog.
	logger._enqueue(_sample(60))
	logger._save_queue()
	var fresh = LoggerScript.new()
	fresh.session_id = fresh._generate_uuid_v4()
	fresh._load_queue()
	_check(fresh.pending_events.size() == logger.pending_events.size(),
		"events should persist across a restart: saved %d, loaded %d"
			% [logger.pending_events.size(), fresh.pending_events.size()])
	_check(fresh.queue.size() > 0, "the sample backlog should still load from the new file format")

	DirAccess.remove_absolute(ProjectSettings.globalize_path(logger.QUEUE_FILE_PATH))
	logger.free()
	fresh.free()
