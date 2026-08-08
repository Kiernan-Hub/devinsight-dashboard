extends CanvasLayer

@onready var background: ColorRect = $Background
@onready var score_label: Label = $Background/ScoreLabel
@onready var best_label: Label = $Background/BestLabel
@onready var new_best_label: Label = _get_or_create_new_best_label()

var stored_best_at_start: float = 0.0

func _ready() -> void:
	visible = false
	background.modulate.a = 0.0
	new_best_label.visible = false
	stored_best_at_start = Score.best_height

func show_game_over() -> void:
	visible = true
	score_label.text = "Height: %d m" % int(Score.current_height)
	best_label.text = "Best: %d m" % int(Score.best_height)
	new_best_label.visible = Score.current_height > stored_best_at_start
	var tween := create_tween()
	tween.tween_property(background, "modulate:a", 0.7, 0.5)

func _unhandled_input(event: InputEvent) -> void:
	if visible and event.is_action_pressed("ui_accept"):
		get_tree().call_deferred("reload_current_scene")

func _get_or_create_new_best_label() -> Label:
	var label := background.get_node_or_null("NewBestLabel") as Label
	if label:
		return label
	label = Label.new()
	label.name = "NewBestLabel"
	label.text = "New Best!"
	label.offset_left = 535.0
	label.offset_top = 555.0
	label.offset_right = 705.0
	label.offset_bottom = 590.0
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	background.add_child(label)
	return label
