# How Ascent wires itself into the telemetry logger.
#
# This file is documentation, not a script the game runs. The game itself lives outside this
# repository on purpose, so this is the committed record of what the call sites actually look
# like — the snippets below are copied verbatim from Ascent's own scripts.
#
# The shape of the integration is the point: the logger never imports, references, or knows
# about any game type. It holds one Callable and calls it. Everything specific to Ascent —
# height, platforms, lava — lives in the game, so the logger stays a component that could be
# dropped into a different project unchanged, and a bug in the telemetry can never take the
# game down with it.


# ---------------------------------------------------------------------------
# 1. Continuous context — level_generator.gd
#
# Registered once at startup. The logger calls this every 5 seconds, merges the result into
# the performance sample, and sends them as one row. Because the context lands on the *same*
# row as the frame timings, correlating them later is a plain column comparison rather than a
# join against a separate timeline.
# ---------------------------------------------------------------------------

func _ready() -> void:
	# ... existing level generation setup ...
	SystemLogger.register_context_provider(_telemetry_context)
	SystemLogger.log_event("run_start", 0.0, {"level_seed": level_seed})

func _telemetry_context() -> Dictionary:
	var lava_speed := 0.0
	if is_instance_valid(lava_node) and lava_node.has_method("get_scaled_rise_speed"):
		lava_speed = lava_node.get_scaled_rise_speed()
	return {
		"height": Score.get_current_height(),
		# The suspected cause of any slowdown as the player climbs: platforms are spawned
		# ahead and culled below the lava, so this number is the live balance of the two.
		"platform_count": spawned_platforms.size(),
		"entity_count": get_tree().get_node_count(),
		"lava_speed": lava_speed
	}


# ---------------------------------------------------------------------------
# 2. Discrete events — lava.gd
#
# Deaths are the events that matter most: death_distribution buckets them by height, and a
# death band that lines up with a frame-time cliff in build_perf_by_height is a performance
# problem that is costing players runs, not a difficulty curve.
# ---------------------------------------------------------------------------

func _on_body_entered(body: Node2D) -> void:
	if body.name == "Player" and not player_dead:
		if "has_shield" in body and body.has_shield:
			body.has_shield = false
			# A near-miss: the run continues, but the player was one hit from ending it.
			SystemLogger.log_event("checkpoint", Score.get_current_height(), {"shield_absorbed": true})
			return
		# ... death effects ...
		player_dead = true
		SystemLogger.log_event("death", Score.get_current_height(), {
			"cause": "lava",
			"lava_speed": get_scaled_rise_speed()
		})
		# ... game over UI ...


# ---------------------------------------------------------------------------
# Notes
#
# - log_event's type must be one of the server's known types: run_start, run_end, death,
#   powerup, checkpoint. An unknown type is rejected at the door rather than accumulating in
#   a table no query knows to look at.
# - Events are queued and ride along with the next performance sample, so they inherit the
#   offline queue's durability without needing their own retry machinery.
# - A context provider that throws, returns the wrong type, or references a freed node
#   degrades to "no context for this sample". Telemetry is a bolt-on; it does not get to
#   break the thing it is measuring.
# ---------------------------------------------------------------------------
