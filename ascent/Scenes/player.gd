extends CharacterBody2D
const SPEED = 300.0
const JUMP_VELOCITY = -400.0

@export var coyote_time: float = 0.12
@export var jump_buffer_time: float = 0.12
@export var jump_cut_multiplier: float = 0.7

var coyote_timer: float = 0.0
var jump_buffer_timer: float = 0.0
var fall_start_y: float = 0.0
var was_on_floor_last_frame: bool = false
var visual_node: Node2D
var visual_base_scale := Vector2.ONE
var jump_velocity_multiplier: float = 1.0
var gravity_multiplier: float = 1.0
var jump_boost_timer: Timer
var low_gravity_timer: Timer
var speed_multiplier: float = 1.0
var speed_boost_timer: Timer
var has_shield: bool = false

func _ready() -> void:
	visual_node = _find_visual_node()
	if visual_node:
		visual_base_scale = visual_node.scale
	was_on_floor_last_frame = is_on_floor()
	fall_start_y = global_position.y

func _physics_process(delta: float) -> void:
	var was_on_floor := is_on_floor()

	# Apply gravity.
	if not is_on_floor():
		velocity += get_gravity() * gravity_multiplier * delta

	# Coyote time: stay "jumpable" briefly after leaving the ground.
	if is_on_floor():
		coyote_timer = coyote_time
	else:
		coyote_timer -= delta

	# Jump buffer: remember a jump press briefly before landing.
	if Input.is_action_just_pressed("ui_accept"):
		jump_buffer_timer = jump_buffer_time
	else:
		jump_buffer_timer -= delta

	# Jump — fires on a fresh/buffered press, OR repeatedly while held and grounded.
	var jump_pressed_now := jump_buffer_timer > 0.0 or (Input.is_action_pressed("ui_accept") and is_on_floor())
	if jump_pressed_now and coyote_timer > 0.0:
		velocity.y = JUMP_VELOCITY * jump_velocity_multiplier
		jump_buffer_timer = 0.0
		coyote_timer = 0.0
		_play_squash_stretch(Vector2(0.82, 1.18))

	# Variable jump height: cut ascent short if button released early.
	if Input.is_action_just_released("ui_accept") and velocity.y < 0:
		velocity.y *= jump_cut_multiplier

	# Left/right movement.
	var direction := Input.get_axis("ui_left", "ui_right")
	if direction:
		velocity.x = direction * SPEED * speed_multiplier
	else:
		velocity.x = move_toward(velocity.x, 0, SPEED * speed_multiplier)
	move_and_slide()

	var is_on_floor_now := is_on_floor()
	if was_on_floor and not is_on_floor_now:
		fall_start_y = global_position.y
	if not was_on_floor and is_on_floor_now:
		var fall_distance := global_position.y - fall_start_y
		_play_squash_stretch(Vector2(1.18, 0.82))
		_emit_landing_burst()
		if fall_distance > 200.0:
			_shake_camera(6.0, 0.18)
	was_on_floor_last_frame = is_on_floor_now

func play_death_burst() -> void:
	_emit_particle_burst(global_position, 42, Color(1.0, 0.18, 0.08, 1.0), 180.0)

func apply_powerup(effect_type: String, multiplier: float, duration: float) -> void:
	if effect_type == "jump_boost":
		jump_velocity_multiplier = multiplier 
		jump_boost_timer = _start_powerup_timer(jump_boost_timer, duration, func() -> void:
			jump_velocity_multiplier = 1.0
		)
	elif effect_type == "low_gravity":
		gravity_multiplier = multiplier
		low_gravity_timer = _start_powerup_timer(low_gravity_timer, duration, func() -> void:
			gravity_multiplier = 1.0
		)
	elif effect_type == "speed_boost":
		speed_multiplier = multiplier
		speed_boost_timer = _start_powerup_timer(speed_boost_timer, duration, func() -> void:
			speed_multiplier = 1.0
		)
	elif effect_type == "shield":
		has_shield = true

func _start_powerup_timer(existing_timer: Timer, duration: float, timeout_callback: Callable) -> Timer:
	if existing_timer and is_instance_valid(existing_timer):
		existing_timer.queue_free()
	var timer := Timer.new()
	timer.one_shot = true
	timer.wait_time = duration
	timer.timeout.connect(timeout_callback)
	timer.timeout.connect(timer.queue_free)
	add_child(timer)
	timer.start()
	return timer

func _find_visual_node() -> Node2D:
	for child in get_children():
		if child is Sprite2D or child is AnimatedSprite2D:
			return child
	return null

func _play_squash_stretch(target_scale: Vector2) -> void:
	if not visual_node:
		return
	var tween := create_tween()
	tween.tween_property(visual_node, "scale", visual_base_scale * target_scale, 0.06)
	tween.tween_property(visual_node, "scale", visual_base_scale, 0.06)

func _emit_landing_burst() -> void:
	_emit_particle_burst(global_position + Vector2(0, 12), 12, Color(1.0, 0.86, 0.55, 1.0), 90.0)

func _emit_particle_burst(spawn_position: Vector2, amount: int, color: Color, speed: float) -> void:
	var particles := CPUParticles2D.new()
	particles.one_shot = true
	particles.amount = amount
	particles.lifetime = 0.35
	particles.explosiveness = 1.0
	particles.spread = 180.0
	particles.initial_velocity_min = speed * 0.45
	particles.initial_velocity_max = speed
	particles.gravity = Vector2(0, 720)
	particles.color = color
	particles.global_position = spawn_position
	get_tree().current_scene.add_child(particles)
	particles.emitting = true
	await get_tree().create_timer(particles.lifetime).timeout
	particles.queue_free()

func _shake_camera(amount: float, duration: float) -> void:
	var camera := get_viewport().get_camera_2d()
	if camera and camera.has_method("shake"):
		camera.shake(amount, duration)
