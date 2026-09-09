extends Node
const BUILD_VERSION := "0.5.0"

# Telemetry now goes to our own ingest API rather than straight into Supabase. The database
# credential that can actually write lives on the server; this client holds only a token that
# means "append a validated sample to your own session".
#
# The token still ships inside the game binary, so it is not a secret — nothing in a shipped
# client is. What changed is its blast radius: it can no longer write arbitrary rows into the
# table the CI performance gate reads.
const INGEST_URL = "https://devinsight-dashboard-delta.vercel.app/api/ingest"
const INGEST_TOKEN = "in 4308jf4 oKLFEN03$*(#J"  # must match the server's INGEST_TOKEN env var exactly

const QUEUE_FILE_PATH := "user://log_queue.json"
const MAX_QUEUE_SIZE := 500
# Cap how much backlog goes out in a single request, so a long outage doesn't produce one
# enormous insert that is likely to time out and then be retried forever. Must not exceed the
# server's MAX_SAMPLES_PER_REQUEST.
const MAX_FLUSH_BATCH := 100
# Bounds memory if the report timer is ever starved: 5s at 240fps is ~1200 frames.
const MAX_FRAME_SAMPLES := 4000

@onready var http_request: HTTPRequest = HTTPRequest.new()
@onready var flush_request: HTTPRequest = HTTPRequest.new()
@onready var timer: Timer = Timer.new()

var is_sending = false
var is_flushing = false

# The offline backlog, stored as a list of batches rather than a flat list of samples:
#
#   [ { "session": {...}, "samples": [ {...}, {...} ] }, ... ]
#
# Each batch remembers the session — and therefore the build — its samples came from. A flat
# list could not: samples queued under 0.4.0 and flushed after upgrading to 0.5.0 would be
# attributed to the running build, quietly filing one build's measurements under another's
# name. Which is precisely the sort of thing the performance gate then treats as a regression.
var queue: Array = []

var in_flight_entry: Dictionary = {}
# How many samples at the FRONT of queue[0].samples are inside the in-flight flush request.
# They stay on disk until the server confirms them, but they are spoken for: nothing else may
# remove them, or the post-flush cleanup would delete the wrong rows.
var in_flight_count: int = 0

# Every frame's duration since the last report, in milliseconds. This is the raw material for
# the tail-latency metrics — a percentile is only meaningful over per-frame data, not over an
# already-averaged frames-per-second reading sampled once every five seconds.
var frame_times_ms: Array = []

# Identifies this run. Every sample carries it, which is what turns a flat stream of numbers
# into "what happened during this particular play session".
var session_id: String = ""
var session_ended_sent := false

func _ready() -> void:
	randomize()
	session_id = _generate_uuid_v4()

	add_child(http_request)
	add_child(flush_request)
	add_child(timer)
	http_request.request_completed.connect(_on_http_request_request_completed)
	flush_request.request_completed.connect(_on_flush_request_completed)

	_load_queue()

	timer.wait_time = 5.0
	timer.autostart = true
	timer.timeout.connect(_on_timer_timeout)
	timer.start()

	print("Telemetry session: ", session_id, " (build ", BUILD_VERSION, ")")

func _process(delta: float) -> void:
	frame_times_ms.append(delta * 1000.0)
	if frame_times_ms.size() > MAX_FRAME_SAMPLES:
		frame_times_ms.pop_front()

# Best-effort "the player closed the game normally" signal. It is deliberately not relied on:
# the server treats a session that simply stops reporting as abandoned, so a crash — which by
# definition never reaches this function — is recorded accurately by the absence of the signal
# rather than by the client's own account of how it died.
func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_PREDELETE:
		_send_session_end()

func _send_session_end() -> void:
	if session_ended_sent or session_id == "":
		return
	# PREDELETE can arrive after the child HTTPRequest nodes have already been torn down, and
	# during shutdown there is nothing left to send with. Losing the "ended cleanly" flag is
	# harmless — the server treats a silent session as abandoned — but calling into a freed
	# node is not.
	if flush_request == null or not is_instance_valid(flush_request):
		return
	session_ended_sent = true
	var payload = {
		"session": _session_dict(true),
		"samples": []
	}
	flush_request.request(INGEST_URL, _headers(), HTTPClient.METHOD_POST, JSON.stringify(payload))

func _session_dict(ended: bool = false) -> Dictionary:
	var data = {
		"id": session_id,
		"build_version": BUILD_VERSION,
		"platform": OS.get_name()
	}
	if ended:
		data["ended"] = true
		data["ended_cleanly"] = true
	return data

func _on_timer_timeout() -> void:
	# Live data and the backlog flush use separate HTTPRequest nodes, so a
	# stuck/failing backlog never blocks fresh data from being collected.
	if not is_sending:
		var fps = Engine.get_frames_per_second()
		var mem_bytes = OS.get_static_memory_usage()
		var mem_mb = float(mem_bytes) / 1024.0 / 1024.0
		var frames = frame_times_ms.size()
		var data = {
			"app_name": "Ascent",
			"fps_rate": int(fps),
			"memory_used_mb": snapped(mem_mb, 0.01),
			"session_notes": "auto-logged"
		}
		# A window with no frames (game minimised, or the very first tick) has nothing
		# meaningful to report; send nulls rather than a fabricated zero.
		if frames > 0:
			data["frame_time_p95_ms"] = snapped(_percentile(frame_times_ms, 0.95), 0.001)
			data["frame_time_max_ms"] = snapped(frame_times_ms.max(), 0.001)
			data["frames_sampled"] = frames
		frame_times_ms.clear()
		_send_entry(data)

	if not is_flushing and not queue.is_empty():
		_flush_queue()

# Linear-interpolated percentile, matching the definition used by the dashboard's
# percentile() so the two halves of the pipeline agree on what "P95" means.
func _percentile(values: Array, quantile: float) -> float:
	if values.is_empty():
		return 0.0
	var sorted_values = values.duplicate()
	sorted_values.sort()
	var index = float(sorted_values.size() - 1) * quantile
	var lower = int(floor(index))
	var upper = mini(lower + 1, sorted_values.size() - 1)
	return lerp(float(sorted_values[lower]), float(sorted_values[upper]), index - float(lower))

func _send_entry(data: Dictionary) -> void:
	is_sending = true
	in_flight_entry = data
	var payload = {
		"session": _session_dict(),
		"samples": [data]
	}
	var err = http_request.request(INGEST_URL, _headers(), HTTPClient.METHOD_POST, JSON.stringify(payload))
	if err != OK:
		is_sending = false
		_enqueue(data)

func _flush_queue() -> void:
	if queue.is_empty():
		return
	var batch = queue[0]
	var samples = batch.get("samples", [])
	if samples.is_empty():
		queue.pop_front()
		return

	is_flushing = true
	in_flight_count = mini(samples.size(), MAX_FLUSH_BATCH)
	var payload = {
		"session": batch.get("session", _session_dict()),
		"samples": samples.slice(0, in_flight_count)
	}
	var err = flush_request.request(INGEST_URL, _headers(), HTTPClient.METHOD_POST, JSON.stringify(payload))
	if err != OK:
		# Network still down; keep the whole backlog and try again next tick.
		is_flushing = false
		in_flight_count = 0

func _headers() -> Array:
	var headers = [
		"Content-Type: application/json"
	]
	if INGEST_TOKEN != "":
		headers.append("x-ingest-token: " + INGEST_TOKEN)
	return headers

func _on_http_request_request_completed(result, response_code, headers, body) -> void:
	is_sending = false
	print("Ingest response code: ", response_code)

	if _is_success(response_code, result):
		return
	# A 4xx means the server judged this payload malformed, and it will judge it malformed
	# every time. Re-queuing it would retry it forever while pushing good data out of a
	# bounded queue, so a rejected sample is dropped and reported instead.
	if response_code >= 400 and response_code < 500:
		push_warning("Telemetry sample rejected by server (%d); dropping it." % response_code)
		return
	_enqueue(in_flight_entry)

func _on_flush_request_completed(result, response_code, headers, body) -> void:
	print("Ingest flush response code: ", response_code)

	var success = _is_success(response_code, result)
	# A 4xx on the backlog is the poison-pill case: the server will never accept this batch, so
	# retrying it forever would block every sample behind it. Drop exactly the batch that was
	# in flight, never the whole queue.
	var permanently_rejected = response_code >= 400 and response_code < 500

	if success or permanently_rejected:
		if not queue.is_empty():
			var samples = queue[0].get("samples", [])
			for _i in range(mini(in_flight_count, samples.size())):
				samples.pop_front()
			if samples.is_empty():
				queue.pop_front()
		if permanently_rejected:
			push_warning("Telemetry batch rejected by server (%d); dropped." % response_code)
		_save_queue()
	# on a network or 5xx failure, leave the queue intact and retry next tick

	in_flight_count = 0
	is_flushing = false
	_trim_queue()

func _is_success(response_code: int, result) -> bool:
	return result == HTTPRequest.RESULT_SUCCESS and response_code >= 200 and response_code < 300

func _enqueue(data: Dictionary) -> void:
	if data.is_empty():
		return
	# Append to the trailing batch when it belongs to this same session, so a run's samples stay
	# in one request rather than fragmenting into hundreds of single-sample batches.
	if queue.is_empty() or queue[-1].get("session", {}).get("id", "") != session_id:
		queue.append({"session": _session_dict(), "samples": []})
	queue[-1]["samples"].append(data)
	_trim_queue()
	_save_queue()

func _queued_sample_count() -> int:
	var total = 0
	for batch in queue:
		total += batch.get("samples", []).size()
	return total

func _trim_queue() -> void:
	# Drop the oldest sample that is not part of an in-flight flush. Trimming a spoken-for
	# sample would shift the front of the batch and make the post-flush cleanup pop the wrong
	# rows, so the queue is allowed to sit slightly over cap until the flush resolves —
	# bounded by one batch.
	while _queued_sample_count() > MAX_QUEUE_SIZE:
		var floor_index = in_flight_count if is_flushing else 0
		var trimmed = false
		for batch in queue:
			var samples = batch.get("samples", [])
			if samples.size() > floor_index:
				samples.remove_at(floor_index)
				trimmed = true
				break
			# Only the batch currently in flight is protected; later batches trim from the front.
			floor_index = 0
		if not trimmed:
			return
		while not queue.is_empty() and queue[0].get("samples", []).is_empty():
			queue.pop_front()

func _save_queue() -> void:
	var file = FileAccess.open(QUEUE_FILE_PATH, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(queue))
		file.close()

func _load_queue() -> void:
	if not FileAccess.file_exists(QUEUE_FILE_PATH):
		return
	var file = FileAccess.open(QUEUE_FILE_PATH, FileAccess.READ)
	if not file:
		return
	var content = file.get_as_text()
	file.close()

	var parsed = JSON.parse_string(content)
	if not (parsed is Array):
		return

	for item in parsed:
		if not (item is Dictionary):
			continue
		# Pre-0.5.0 queue files hold bare samples rather than session batches. Those samples
		# have no session to belong to, and inventing one would file them under whichever build
		# happens to be running now — so they are adopted into a batch tagged with the build
		# they actually recorded, and given a fresh session id of their own.
		if item.has("samples"):
			queue.append(item)
		else:
			var legacy_build = item.get("build_version", BUILD_VERSION)
			item.erase("build_version")
			if queue.is_empty() or queue[-1].get("session", {}).get("build_version", "") != legacy_build:
				queue.append({
					"session": {
						"id": _generate_uuid_v4(),
						"build_version": legacy_build,
						"platform": OS.get_name()
					},
					"samples": []
				})
			queue[-1]["samples"].append(item)

	# JSON has no int/float distinction, so Godot's parser always hands back floats (fps_rate
	# becomes 60.0). The server's validator requires an integer, so cast it back before any of
	# this is re-sent.
	for batch in queue:
		for entry in batch.get("samples", []):
			if entry is Dictionary:
				if entry.has("fps_rate"):
					entry["fps_rate"] = int(entry["fps_rate"])
				if entry.has("frames_sampled"):
					entry["frames_sampled"] = int(entry["frames_sampled"])

func _generate_uuid_v4() -> String:
	var bytes := PackedByteArray()
	bytes.resize(16)
	for i in 16:
		bytes[i] = randi() % 256
	bytes[6] = (bytes[6] & 0x0f) | 0x40  # version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80  # variant 1
	var hex := ""
	for i in 16:
		hex += "%02x" % bytes[i]
	return "%s-%s-%s-%s-%s" % [
		hex.substr(0, 8), hex.substr(8, 4), hex.substr(12, 4), hex.substr(16, 4), hex.substr(20, 12)
	]
