@tool
extends StaticBody2D
@export var platform_size: Vector2 = Vector2(100, 20):
	set(value):
		platform_size = value
		update_size()
@onready var collision_shape: CollisionShape2D = $CollisionShape2D
@onready var color_rect: ColorRect = $ColorRect

func _ready() -> void:
	if collision_shape.shape:
		collision_shape.shape = collision_shape.shape.duplicate()
	update_size()

func update_size() -> void:
	if not is_node_ready():
		return
	var shape := collision_shape.shape as RectangleShape2D
	shape.size = platform_size
	color_rect.size = platform_size
	color_rect.position = -platform_size / 2
