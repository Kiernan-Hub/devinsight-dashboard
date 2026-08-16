extends Node
const BUILD_VERSION := "0.3.0"
const SUPABASE_URL = "https://savgtraqvbqkbblhhhxe.supabase.co/rest/v1/system_logs"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhdmd0cmFxdmJxa2JibGhoaHhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4OTE5MjAsImV4cCI6MjEwMTQ2NzkyMH0.t6mC5d1a1P82j_NXGV_nLvrp5g4V3vfFuos37mrnq0w"

const QUEUE_FILE_PATH := "user://log_queue.json"
const MAX_QUEUE_SIZE := 500

@onready var http_request: HTTPRequest = HTTPRequest.new()
@onready var flush_request: HTTPRequest = HTTPRequest.new()
@onready var timer: Timer = Timer.new()

var is_sending = false
var is_flushing = false
var queue: Array = []
var in_flight_entry: Dictionary = {}

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

func _on_timer_timeout() -> void:
	# Live data and the backlog flush use separate HTTPRequest nodes, so a
	# stuck/failing backlog never blocks fresh data from being collected.
	if not is_sending:
		var fps = Engine.get_frames_per_second()
		var mem_bytes = OS.get_static_memory_usage()
		var mem_mb = float(mem_bytes) / 1024.0 / 1024.0
		var data = {
			"app_name": "Ascent",
			"fps_rate": int(fps),
			"memory_used_mb": snapped(mem_mb, 0.01),
			"session_notes": "auto-logged",
			"build_version": BUILD_VERSION
		}
		_send_entry(data)

	if not is_flushing and not queue.is_empty():
		_flush_queue()

func _send_entry(data: Dictionary) -> void:
	is_sending = true
	in_flight_entry = data
	var headers = [
		"Content-Type: application/json",
		"apikey: " + SUPABASE_ANON_KEY,
		"Authorization: Bearer " + SUPABASE_ANON_KEY
	]
	var json_string = JSON.stringify(data)
	var err = http_request.request(SUPABASE_URL, headers, HTTPClient.METHOD_POST, json_string)
	if err != OK:
		is_sending = false
		_enqueue(data)

func _flush_queue() -> void:
	is_flushing = true
	var headers = [
		"Content-Type: application/json",
		"apikey: " + SUPABASE_ANON_KEY,
		"Authorization: Bearer " + SUPABASE_ANON_KEY
	]
	# PostgREST accepts an array body to insert every queued row in one request.
	var json_string = JSON.stringify(queue)
	var err = flush_request.request(SUPABASE_URL, headers, HTTPClient.METHOD_POST, json_string)
	if err != OK:
		is_flushing = false  # network still down; try again next tick

func _on_http_request_request_completed(result, response_code, headers, body) -> void:
	is_sending = false
	print("Supabase response code: ", response_code)

	var success = result == HTTPRequest.RESULT_SUCCESS and response_code >= 200 and response_code < 300
	if not success:
		_enqueue(in_flight_entry)

func _on_flush_request_completed(result, response_code, headers, body) -> void:
	is_flushing = false
	print("Supabase flush response code: ", response_code)

	var success = result == HTTPRequest.RESULT_SUCCESS and response_code >= 200 and response_code < 300
	if success:
		queue.clear()
		_save_queue()
	# on failure, leave the queue intact and retry next tick

func _enqueue(data: Dictionary) -> void:
	queue.append(data)
	if queue.size() > MAX_QUEUE_SIZE:
		queue.pop_front()  # drop oldest to cap disk usage
	_save_queue()

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
				if entry is Dictionary and entry.has("fps_rate"):
					entry["fps_rate"] = int(entry["fps_rate"])
