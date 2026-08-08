extends Node2D
@export var platform_scene: PackedScene
@export var powerup_scene: PackedScene
@export var level_seed: int = -1
@export var powerup_spawn_chance: float = 0.15
@export var base_min_horizontal_gap: float = 40.0
@export var base_max_horizontal_gap: float = 200.0
@export var max_min_horizontal_gap: float = 80.0
@export var max_max_horizontal_gap: float = 320.0
@export var base_min_vertical_gap: float = 50.0
@export var base_max_vertical_gap: float = 80.0
@export var max_min_vertical_gap: float = 80.0
@export var max_max_vertical_gap: float = 130.0
@export var gap_scaling_factor: float = 0.01
@export var platforms_ahead: int = 5
@export var min_platform_width: float = 80.0
@export var max_platform_width: float = 200.0
@export var min_platform_height: float = 10.0
@export var max_platform_height: float = 24.0
@export var spawn_trigger_distance: float = 300.0
@export var cleanup_buffer: float = 200.0
@export var player_path: NodePath
@export var lava_path: NodePath
var highest_y: float = 0.0
var last_x: float = 0.0
var player_node: Node2D
var lava_node: Node2D
var spawned_platforms: Array[Node2D] = []
var rng := RandomNumberGenerator.new()

func _ready() -> void:
	if level_seed == -1:
		rng.randomize()
		level_seed = rng.randi()
	rng.seed = level_seed
	print("Level seed: %d" % level_seed)
	player_node = get_node(player_path)
	lava_node = get_node(lava_path)
	find_highest_existing_platform()
	for i in platforms_ahead:
		spawn_next_platform()

func _process(_delta: float) -> void:
	spawn_platforms_above_player()
	cleanup_platforms_below_lava()

func find_highest_existing_platform() -> void:
	var parent = get_parent()
	highest_y = INF
	last_x = 0.0
	for child in parent.get_children():
		if child.name.begins_with("Ground"):
			if child.global_position.y < highest_y:
				highest_y = child.global_position.y
				last_x = child.global_position.x

func spawn_next_platform() -> void:
	if not platform_scene:
		push_error("LevelGenerator: platform_scene is not assigned in the Inspector.")
		return
	var new_platform := platform_scene.instantiate() as Node2D
	if not new_platform:
		push_error("LevelGenerator: platform_scene root must be a Node2D.")
		return
	add_child(new_platform)
	randomize_platform(new_platform)
	var x_offset := rng.randf_range(get_min_horizontal_gap(), get_max_horizontal_gap())
	if rng.randf() < 0.5:
		x_offset = -x_offset
	var y_offset := rng.randf_range(get_min_vertical_gap(), get_max_vertical_gap())
	last_x += x_offset
	highest_y -= y_offset
	new_platform.global_position = Vector2(last_x, highest_y)
	spawned_platforms.append(new_platform)
	if rng.randf() < powerup_spawn_chance:
		spawn_powerup_above_platform(new_platform)

func get_difficulty_ratio() -> float:
	return min(Score.get_current_height() * gap_scaling_factor, 1.0)

func get_min_horizontal_gap() -> float:
	return lerpf(base_min_horizontal_gap, max_min_horizontal_gap, get_difficulty_ratio())

func get_max_horizontal_gap() -> float:
	return lerpf(base_max_horizontal_gap, max_max_horizontal_gap, get_difficulty_ratio())

func get_min_vertical_gap() -> float:
	return lerpf(base_min_vertical_gap, max_min_vertical_gap, get_difficulty_ratio())

func get_max_vertical_gap() -> float:
	return lerpf(base_max_vertical_gap, max_max_vertical_gap, get_difficulty_ratio())

func randomize_platform(platform: Node2D) -> void:
	var width := rng.randf_range(min_platform_width, max_platform_width)
	var height := rng.randf_range(min_platform_height, max_platform_height)
	platform.set("platform_size", Vector2(width, height))

	var color_rect := platform.get_node_or_null("ColorRect") as ColorRect
	if color_rect:
		color_rect.color = random_green()
	else:
		platform.modulate = random_green()

func random_green() -> Color:
	var hue := rng.randf_range(90.0 / 360.0, 150.0 / 360.0)
	var saturation := rng.randf_range(0.45, 0.9)
	var value := rng.randf_range(0.45, 0.9)
	return Color.from_hsv(hue, saturation, value)

func spawn_powerup_above_platform(platform: Node2D) -> void:
	if not powerup_scene:
		return
	var powerup := powerup_scene.instantiate() as Node2D
	if not powerup:
		return
	var roll := rng.randf()
	if roll < 0.25:
		powerup.set("effect_type", "jump_boost")
		powerup.set("multiplier", 1.5)
	elif roll < 0.5:
		powerup.set("effect_type", "low_gravity")
		powerup.set("multiplier", 0.6)
	elif roll < 0.75:
		powerup.set("effect_type", "speed_boost")
		powerup.set("multiplier", 1.6)
	else:
		powerup.set("effect_type", "shield")
		powerup.set("multiplier", 1.0)
	add_child(powerup)
	powerup.global_position = platform.global_position + Vector2(0, -32)
	
func spawn_platforms_above_player() -> void:
	while player_node.global_position.y - highest_y <= spawn_trigger_distance:
		spawn_next_platform()

func cleanup_platforms_below_lava() -> void:
	for i in range(spawned_platforms.size() - 1, -1, -1):
		var platform := spawned_platforms[i]
		if not is_instance_valid(platform):
			spawned_platforms.remove_at(i)
		elif platform.global_position.y > lava_node.global_position.y + cleanup_buffer:
			spawned_platforms.remove_at(i)
			platform.queue_free()
