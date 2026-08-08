extends Area2D
@export var effect_type: String = "jump_boost"
@export var multiplier: float = 1.5
@export var duration: float = 5.0
@onready var color_rect: ColorRect = $ColorRect

func _ready() -> void:
	body_entered.connect(_on_body_entered)
	_update_visual()

func _on_body_entered(body: Node2D) -> void:
	if body.has_method("apply_powerup"):
		body.apply_powerup(effect_type, multiplier, duration)
		queue_free()

func _update_visual() -> void:
	match effect_type:
		"low_gravity":
			color_rect.color = Color(0.55, 0.22, 1.0, 1.0)
		"speed_boost":
			color_rect.color = Color(0.1, 0.7, 1.0, 1.0)
		"shield":
			color_rect.color = Color(1.0, 1.0, 1.0, 1.0)
		_: # jump_boost
			color_rect.color = Color(1.0, 0.9, 0.12, 1.0)
