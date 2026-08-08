extends Camera2D

@export var target: NodePath
@export var follow_speed: float = 5.0

var target_node: Node2D

func _ready() -> void:
	target_node = get_node(target)

func _process(delta: float) -> void:
	if target_node:
		global_position = global_position.lerp(target_node.global_position, follow_speed * delta)
