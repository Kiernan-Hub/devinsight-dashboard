extends Node

var start_y: float = 0.0
var current_height: float = 0.0
var best_height: float = 0.0

func get_current_height() -> float:
	return current_height

func register_start_position(y: float) -> void:
	start_y = y
	current_height = 0.0

func update_height(current_y: float) -> void:
	current_height = (start_y - current_y) / 10.0
	if current_height > best_height:
		best_height = current_height
