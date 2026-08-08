extends CanvasLayer

@export var player_path: NodePath
@onready var height_label: Label = $HeightLabel

var player_node: Node2D

func _ready() -> void:
	player_node = get_node(player_path)
	Score.register_start_position(player_node.global_position.y)

func _process(delta: float) -> void:
	Score.update_height(player_node.global_position.y)
	height_label.text = "Height: %d m" % int(Score.current_height)
