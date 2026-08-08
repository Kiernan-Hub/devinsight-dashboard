extends Area2D

@export var base_speed: float = 70.0
@export var max_speed: float = 100.0
@export var scaling_factor: float = 0.15
@export var game_over_ui_path: NodePath

var game_over_ui: Node
var player_dead: bool = false

func _ready() -> void:
	body_entered.connect(_on_body_entered)
	game_over_ui = get_node(game_over_ui_path)

func _physics_process(delta: float) -> void:
	if not player_dead:
		position.y -= get_scaled_rise_speed() * delta

func get_scaled_rise_speed() -> float:
	return min(base_speed + Score.get_current_height() * scaling_factor, max_speed)

func _on_body_entered(body: Node2D) -> void:
	if body.name == "Player" and not player_dead:
		if "has_shield" in body and body.has_shield:
			body.has_shield = false
			return
		if body.has_method("play_death_burst"):
			body.play_death_burst()
		var camera := get_viewport().get_camera_2d()
		if camera and camera.has_method("shake"):
			camera.shake(14.0, 0.35)
		player_dead = true
		body.set_physics_process(false)
		await get_tree().create_timer(0.6).timeout
		game_over_ui.show_game_over()
