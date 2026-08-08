extends Node
const BUILD_VERSION := "0.3.0"
const SUPABASE_URL = "https://savgtraqvbqkbblhhhxe.supabase.co/rest/v1/system_logs"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhdmd0cmFxdmJxa2JibGhoaHhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4OTE5MjAsImV4cCI6MjEwMTQ2NzkyMH0.t6mC5d1a1P82j_NXGV_nLvrp5g4V3vfFuos37mrnq0w"

@onready var http_request: HTTPRequest = HTTPRequest.new()
@onready var timer: Timer = Timer.new()

var is_sending = false

func _ready() -> void:
	add_child(http_request)
	add_child(timer)
	http_request.request_completed.connect(_on_http_request_request_completed)

	timer.wait_time = 5.0
	timer.autostart = true
	timer.timeout.connect(_on_timer_timeout)
	timer.start()

func _on_timer_timeout() -> void:
	if is_sending:
		return  # skip this tick, previous request still in flight
	is_sending = true
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
	var headers = [
		"Content-Type: application/json",
		"apikey: " + SUPABASE_ANON_KEY,
		"Authorization: Bearer " + SUPABASE_ANON_KEY
	]
	var json_string = JSON.stringify(data)
	http_request.request(SUPABASE_URL, headers, HTTPClient.METHOD_POST, json_string)

func _on_http_request_request_completed(result, response_code, headers, body) -> void:
	is_sending = false
	print("Supabase response code: ", response_code)
