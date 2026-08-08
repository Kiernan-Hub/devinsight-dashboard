extends Control

const GAMEPLAY_SCENE := "res://Scenes/main.tscn"

@onready var start_button: Button = $CenterContainer/VBoxContainer/StartButton

func _ready() -> void:
	start_button.pressed.connect(_start_game)
	start_button.grab_focus()

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_accept"):
		_start_game()

func _start_game() -> void:
	get_tree().change_scene_to_file(GAMEPLAY_SCENE)
