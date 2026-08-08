extends CanvasLayer

@onready var overlay: ColorRect = $Overlay
@onready var resume_button: Button = $CenterContainer/VBoxContainer/ResumeButton
@onready var restart_button: Button = $CenterContainer/VBoxContainer/RestartButton
@onready var quit_button: Button = $CenterContainer/VBoxContainer/QuitButton

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	visible = false
	resume_button.pressed.connect(_resume)
	restart_button.pressed.connect(_restart)
	quit_button.pressed.connect(_quit)

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_cancel"):
		if visible:
			_resume()
		else:
			_pause()

func _pause() -> void:
	visible = true
	get_tree().paused = true
	overlay.modulate.a = 0.0
	var tween := create_tween()
	tween.set_pause_mode(Tween.TWEEN_PAUSE_PROCESS)
	tween.tween_property(overlay, "modulate:a", 0.65, 0.15)
	resume_button.grab_focus()

func _resume() -> void:
	get_tree().paused = false
	visible = false

func _restart() -> void:
	get_tree().paused = false
	get_tree().reload_current_scene()

func _quit() -> void:
	get_tree().paused = false
	get_tree().change_scene_to_file("res://Scenes/MainMenu.tscn")
