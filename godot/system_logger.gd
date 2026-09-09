extends Node
const BUILD_VERSION := "0.4.0"
const SUPABASE_URL = "https://savgtraqvbqkbblhhhxe.supabase.co/rest/v1/system_logs"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhdmd0cmFxdmJxa2JibGhoaHhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4OTE5MjAsImV4cCI6MjEwMTQ2NzkyMH0.t6mC5d1a1P82j_NXGV_nLvrp5g4V3vfFuos37mrnq0w"

const QUEUE_FILE_PATH := "user://log_queue.json"
const MAX_QUEUE_SIZE := 500
# Cap how much backlog goes out in a single request, so a long outage doesn't produce one
# enormous insert that is likely to time out and then be retried forever.
const MAX_FLUSH_BATCH := 100
# Bounds memory if the report timer is ever starved: 5s at 240fps is ~1200 frames.
const MAX_FRAME_SAMPLES := 4000

@onready var http_request: HTTPRequest = HTTPRequest.new()
@onready var flush_request: HTTPRequest = HTTPRequest.new()
@onready var timer: Timer = Timer.new()

var is_sending = false
var is_flushing = false
var queue: Array = []
var in_flight_entry: Dictionary = {}
# How many entries at the FRONT of `queue` are currently inside the in-flight flush request.
# Those entries stay on disk until the server confirms them, but they are spoken for: nothing
# else may remove them, or the post-flush cleanup would delete the wrong rows.
var in_flight_count: int = 0

# Every frame's duration since the last report, in milliseconds. This is the raw material for
# the tail-latency metrics — a percentile is only meaningful over per-frame data, not over an
# already-averaged frames-per-second reading sampled once every five seconds.
var frame_times_ms: Array = []

func _ready() -> void:
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

func _process(delta: float) -> void:
	frame_times_ms.append(delta * 1000.0)
	if frame_times_ms.size() > MAX_FRAME_SAMPLES:
		frame_times_ms.pop_front()

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
			"session_notes": "auto-logged",
			"build_version": BUILD_VERSION
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
	var json_string = JSON.stringify(data)
	var err = http_request.request(SUPABASE_URL, _headers(), HTTPClient.METHOD_POST, json_string)
	if err != OK:
		is_sending = false
		_enqueue(data)

func _flush_queue() -> void:
	var batch = queue.slice(0, MAX_FLUSH_BATCH)
	if batch.is_empty():
		return
	is_flushing = true
	in_flight_count = batch.size()
	# PostgREST accepts an array body to insert every queued row in one request.
	var json_string = JSON.stringify(batch)
	var err = flush_request.request(SUPABASE_URL, _headers(), HTTPClient.METHOD_POST, json_string)
	if err != OK:
		# Network still down; keep the whole backlog and try again next tick.
		is_flushing = false
		in_flight_count = 0

func _headers() -> Array:
	return [
		"Content-Type: application/json",
		"apikey: " + SUPABASE_ANON_KEY,
		"Authorization: Bearer " + SUPABASE_ANON_KEY
	]

func _on_http_request_request_completed(result, response_code, headers, body) -> void:
	is_sending = false
	print("Supabase response code: ", response_code)

	var success = result == HTTPRequest.RESULT_SUCCESS and response_code >= 200 and response_code < 300
	if not success:
		_enqueue(in_flight_entry)

func _on_flush_request_completed(result, response_code, headers, body) -> void:
	print("Supabase flush response code: ", response_code)

	var success = result == HTTPRequest.RESULT_SUCCESS and response_code >= 200 and response_code < 300
	if success:
		# Remove ONLY the rows this request actually carried. A live send that failed while
		# the flush was in flight appended new entries to the same queue; clearing the whole
		# queue here would delete rows that were never transmitted — silently losing exactly
		# the data the offline queue exists to protect.
		for _i in range(mini(in_flight_count, queue.size())):
			queue.pop_front()
		_save_queue()
	# on failure, leave the queue intact and retry next tick
	in_flight_count = 0
	is_flushing = false
	_trim_queue()

func _enqueue(data: Dictionary) -> void:
	if data.is_empty():
		return
	queue.append(data)
	_trim_queue()
	_save_queue()

func _trim_queue() -> void:
	# Drop the oldest entry that is not part of an in-flight flush. Trimming a spoken-for
	# entry would shift the front of the queue and make the post-flush cleanup pop the wrong
	# rows, so the queue is allowed to sit slightly over cap until the flush resolves —
	# bounded by one batch.
	var floor_index = in_flight_count if is_flushing else 0
	while queue.size() > MAX_QUEUE_SIZE and queue.size() > floor_index:
		queue.remove_at(floor_index)

func _save_queue() -> void:
	var file = FileAccess.open(QUEUE_FILE_PATH, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify(queue))
		file.close()

func _load_queue() -> void:
	if not FileAccess.file_exists(QUEUE_FILE_PATH):
		return
	var file = FileAccess.open(QUEUE_FILE_PATH, FileAccess.READ)
	if file:
		var content = file.get_as_text()
		file.close()
		var parsed = JSON.parse_string(content)
		if parsed is Array:
			queue = parsed
			# JSON has no int/float distinction, so Godot's parser always hands back
			# floats (fps_rate becomes 60.0). Postgres's integer column rejects that
			# decimal notation, so cast it back before it's ever re-sent.
			for entry in queue:
				if entry is Dictionary:
					if entry.has("fps_rate"):
						entry["fps_rate"] = int(entry["fps_rate"])
					if entry.has("frames_sampled"):
						entry["frames_sampled"] = int(entry["frames_sampled"])
