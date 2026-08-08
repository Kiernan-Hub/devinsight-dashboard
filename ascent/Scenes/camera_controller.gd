extends Camera2D

@export var target: NodePath
@export var follow_speed: float = 5.0

var target_node: Node2D
var shake_amount: float = 0.0
var shake_duration: float = 0.0
var shake_timer: float = 0.0
var rng := RandomNumberGenerator.new()

func _ready() -> void:
	rng.randomize()
	target_node = get_node(target)

func _process(delta: float) -> void:
	if target_node:
		global_position = global_position.lerp(target_node.global_position, follow_speed * delta)

	if shake_timer > 0.0:
		shake_timer -= delta
		var strength: float = shake_amount * max(shake_timer / shake_duration, 0.0)
		offset = offset.lerp(Vector2(rng.randf_range(-strength, strength), rng.randf_range(-strength, strength)), follow_speed * delta)
	else:
		offset = offset.lerp(Vector2.ZERO, follow_speed * delta)

func shake(amount: float, duration: float) -> void:
	shake_amount = amount
	shake_duration = max(duration, 0.001)
	shake_timer = shake_duration
