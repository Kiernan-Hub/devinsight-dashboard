# Project Context

## Overview

**Ascent** is a compact Godot 4.7 2D climbing game. The player jumps upward across platforms while a rising lava hazard follows from below. Height climbed is tracked as the score, with the best height preserved in an autoload singleton for the lifetime of the app session.

The project is intentionally small and scene-driven:

- `project.godot` defines the app configuration, the main scene, and the `Score` autoload.
- `Scenes/main.tscn` is the full game composition.
- `Scenes/player.tscn` and `Scenes/Platform.tscn` are reusable scene assets.
- Scripts in `Scenes/*.gd` implement movement, procedural platform spawning, camera follow, lava, HUD, game-over UI, and score state.

## Project Configuration

### `project.godot`

- Project name: `Ascent`
- Main scene: `Scenes/main.tscn`
- Godot feature target: `4.7`, `Forward Plus`
- Window stretch:
  - Mode: `canvas_items`
  - Aspect: `expand`
- Autoload:
  - `Score` points to `Scenes/score.gd`
- Physics:
  - 3D physics engine is set to Jolt, though the gameplay currently uses 2D nodes.

## Scene Architecture

### `Scenes/main.tscn`

`main.tscn` is the root gameplay scene. Its root node is:

- `Main` (`Node2D`)

Important children:

- `Player`
  - Instance of `Scenes/player.tscn`
  - Has `Scenes/player.gd` attached in the main scene.
  - Initial position: `(350, 100)`
  - Main scene adds a capsule collision shape and a red `ColorRect` visual.
- `Ground`, `Ground2`, `Ground3`
  - Instances of `Scenes/Platform.tscn`
  - Hand-placed starting platforms.
  - Sizes are overridden per instance.
- `Level Generator`
  - `Node2D` with `Scenes/level_generator.gd`
  - Receives `Scenes/Platform.tscn` as `platform_scene`.
  - Spawns additional platforms above the starting layout.
- `Camera2D`
  - Uses `Scenes/camera_2d.gd`
  - Follows `../Player`.
- `Lava`
  - `Area2D` with `Scenes/lava.gd`
  - Starts at `(500, 800)`.
  - Contains a wide rectangular collision shape and visible red/pink `ColorRect`.
  - Points to `../GameOverUI`.
- `GameOverUI`
  - `CanvasLayer` with `Scenes/game_over_ui.gd`
  - Contains a full-screen background, game-over label, score label, and best label.
- `HUD`
  - `CanvasLayer` with `Scenes/hud.gd`
  - Points to `../Player`.
  - Displays current height.

### `Scenes/player.tscn`

Reusable player scene:

- Root: `Player` (`CharacterBody2D`)
- Children:
  - `Sprite2D`
  - `CollisionShape2D` using a `RectangleShape2D`

Note: `main.tscn` currently attaches `player.gd` and adds alternate collision/visual children on its `Player` instance. The base player scene itself does not declare the script in `player.tscn`.

### `Scenes/Platform.tscn`

Reusable platform scene:

- Root: `Ground` (`StaticBody2D`)
- Script: `Scenes/platform.gd`
- Children:
  - `CollisionShape2D` using a `RectangleShape2D`
  - `ColorRect` used as the platform visual

The platform exposes `platform_size`, so hand-placed and generated instances can resize both collision and visuals.

## Scripts

### `Scenes/player.gd`

Controls player movement.

Node type:

- Extends `CharacterBody2D`

Core constants:

- `SPEED = 300.0`
- `JUMP_VELOCITY = -400.0`

Exported tuning values:

- `coyote_time = 0.12`
- `jump_buffer_time = 0.12`
- `jump_cut_multiplier = 0.7`

Gameplay behavior:

- Applies gravity whenever the player is not on the floor.
- Supports coyote time, allowing a jump briefly after leaving a platform.
- Supports jump buffering, allowing a jump input shortly before landing.
- Allows a fresh or buffered jump when `coyote_timer > 0.0`.
- Cuts upward velocity when jump is released early, creating variable jump height.
- Reads horizontal input with `Input.get_axis("ui_left", "ui_right")`.
- Uses `move_and_slide()` for CharacterBody2D movement.

Relevant input actions:

- `ui_accept` for jump and restart.
- `ui_left` and `ui_right` for movement.

### `Scenes/platform.gd`

Keeps platform collision and visual size in sync.

Node type:

- Extends `StaticBody2D`
- Marked `@tool`, so sizing updates can run in the editor.

Exported tuning values:

- `platform_size = Vector2(100, 20)`

Important nodes:

- `$CollisionShape2D`
- `$ColorRect`

Behavior:

- Duplicates the collision shape in `_ready()` so instances do not mutate a shared shape resource.
- `update_size()` casts the collision shape to `RectangleShape2D` and sets its size.
- Also updates the `ColorRect` size and positions it around the platform center.

### `Scenes/level_generator.gd`

Creates additional platforms above the existing starting platforms.

Node type:

- Extends `Node2D`

Exported tuning values:

- `platform_scene: PackedScene`
- `min_horizontal_gap = 40.0`
- `max_horizontal_gap = 200`
- `min_vertical_gap = 50.0`
- `max_vertical_gap = 80`
- `platforms_ahead = 5`

State:

- `highest_y`
- `last_x`

Startup flow:

1. `_ready()` calls `find_highest_existing_platform()`.
2. It then spawns `platforms_ahead` platforms.

Platform discovery:

- Searches the parent node's children.
- Considers nodes whose names begin with `"Ground"`.
- Tracks the highest starting platform by the smallest global `y` position.
- Uses that platform's `x` position as the initial `last_x`.

Spawn behavior:

- Instantiates `platform_scene`.
- Adds the new platform as a child of `Level Generator`.
- Chooses a random horizontal offset between min and max gap.
- Randomly flips the horizontal direction.
- Chooses a random vertical offset between min and max gap.
- Updates `last_x` and `highest_y`.
- Places the new platform at `Vector2(last_x, highest_y)`.

Current limitation:

- Platforms are generated only once during `_ready()`.
- There is no recycling, cleanup, or continuous generation tied to player progress yet.

### `Scenes/camera_2d.gd`

Smoothly follows a target node.

Node type:

- Extends `Camera2D`

Exported tuning values:

- `target: NodePath`
- `follow_speed = 5.0`

Behavior:

- Resolves `target_node` in `_ready()`.
- Each `_process()` frame lerps the camera global position toward the target's global position.

### `Scenes/lava.gd`

Implements the rising lava hazard and death trigger.

Node type:

- Extends `Area2D`

Exported tuning values:

- `rise_speed = 20.0`
- `game_over_ui_path: NodePath`

State:

- `game_over_ui`
- `player_dead = false`

Behavior:

- Connects `body_entered` to `_on_body_entered()` in `_ready()`.
- Resolves the game-over UI using `game_over_ui_path`.
- Moves upward every physics frame by subtracting `rise_speed * delta` from `position.y`.
- Stops rising once `player_dead` is true.
- On collision with a body named `"Player"`:
  - Sets `player_dead = true`.
  - Disables the player's physics processing.
  - Waits `0.6` seconds.
  - Calls `game_over_ui.show_game_over()`.

### `Scenes/game_over_ui.gd`

Displays the game-over overlay and handles restart.

Node type:

- Extends `CanvasLayer`

Important nodes:

- `$Background`
- `$Background/ScoreLabel`
- `$Background/BestLabel`

Startup behavior:

- Sets the UI invisible.
- Sets `background.modulate.a = 0.0`.

Game-over behavior:

- `show_game_over()` makes the layer visible.
- Updates labels from the `Score` autoload:
  - Current height: `Score.current_height`
  - Best height: `Score.best_height`
- Tweens the background alpha to `0.7` over `0.5` seconds.

Restart behavior:

- `_unhandled_input()` reloads the current scene when the overlay is visible and `ui_accept` is pressed.

### `Scenes/hud.gd`

Tracks and displays the player's current height.

Node type:

- Extends `CanvasLayer`

Exported tuning values:

- `player_path: NodePath`

Important nodes:

- `$HeightLabel`

Behavior:

- Resolves the player in `_ready()`.
- Registers the starting player `y` position with `Score.register_start_position()`.
- Every `_process()` frame:
  - Calls `Score.update_height(player_node.global_position.y)`.
  - Displays `Score.current_height` as `"Height: %d m"`.

### `Scenes/score.gd`

Autoload singleton for score state.

Node type:

- Extends `Node`

State:

- `start_y = 0.0`
- `current_height = 0.0`
- `best_height = 0.0`

Behavior:

- `register_start_position(y)` stores the starting `y` value and resets `current_height`.
- `update_height(current_y)` computes height as `(start_y - current_y) / 10.0`.
- Updates `best_height` whenever current height exceeds the existing best.

Persistence note:

- `best_height` persists across scene reloads because `Score` is an autoload.
- It is not saved to disk, so it resets when the app exits.

## Gameplay Systems

### Player Movement

The movement system is implemented entirely in `player.gd` using Godot's `CharacterBody2D`.

The feel is more forgiving than a bare jump controller because it includes:

- Coyote time after leaving ground.
- Jump buffering before landing.
- Variable jump height through early release.
- Horizontal acceleration is immediate while input is held.
- Horizontal deceleration uses `move_toward()` back to zero.

### Platform Sizing

Platforms are `StaticBody2D` nodes with both collision and visual shape controlled by one exported `platform_size`.

This lets `main.tscn` create custom starting platforms by overriding `platform_size`, while generated platforms use the default size from `Platform.tscn` unless changed elsewhere.

### Level Generation

The level generator creates a short chain of platforms above the starting layout:

- It anchors generation to the highest hand-placed platform.
- It randomly alternates left/right horizontal offsets.
- It consistently moves upward by subtracting vertical offset from `highest_y`.

Generated platforms are children of the `Level Generator` node, not siblings of the starting `Ground` nodes.

### Camera Follow

The camera follows the player using linear interpolation. This creates a smoothed tracking effect instead of hard-locking the camera to the player's position.

### Lava Hazard

The lava is a large `Area2D` that rises vertically over time.

The death condition is name-based:

- The body must be named `"Player"`.

On death:

- Player physics is disabled.
- Lava stops rising.
- Game-over UI appears after a short delay.

### Scoring

Score is height-based:

- The HUD records the player's starting `y` position.
- Moving upward decreases `y`, so height is calculated as `(start_y - current_y) / 10.0`.
- The displayed score is an integer number of meters.

Best score lives in the `Score` autoload and survives scene reloads, including restarts after game over.

### Game Over and Restart

The game-over loop is:

1. Lava collides with the player.
2. Player physics processing is disabled.
3. A short delay runs.
4. `GameOverUI.show_game_over()` displays final height and best height.
5. Pressing `ui_accept` reloads the current scene.

## Important Data Flow

### Runtime Startup

1. Godot loads `Scenes/main.tscn`.
2. `Score` autoload is already available.
3. `HUD` registers the player's starting height.
4. `Level Generator` finds the highest starting platform and spawns five additional platforms.
5. `Camera2D` resolves the player target.
6. `Lava` connects its body-entered signal and resolves `GameOverUI`.

### Per-Frame / Per-Physics Updates

- `Player._physics_process()`
  - Gravity, jump handling, horizontal movement, `move_and_slide()`.
- `Lava._physics_process()`
  - Raises lava until the player dies.
- `Camera2D._process()`
  - Smooths camera position toward player.
- `HUD._process()`
  - Updates score state and label text.

### Death Path

`Lava` detects `Player` by body name, disables player physics, then calls `GameOverUI.show_game_over()`. The game-over UI reads from `Score` to show current and best heights.

## File Inventory

Core project files:

- `project.godot`
- `icon.svg`
- `icon.svg.import`

Scenes:

- `Scenes/main.tscn`
- `Scenes/player.tscn`
- `Scenes/Platform.tscn`

Scripts:

- `Scenes/player.gd`
- `Scenes/platform.gd`
- `Scenes/level_generator.gd`
- `Scenes/camera_2d.gd`
- `Scenes/lava.gd`
- `Scenes/game_over_ui.gd`
- `Scenes/hud.gd`
- `Scenes/score.gd`

Godot metadata:

- `Scenes/*.gd.uid`
- `.godot/` editor and cache files

## Extension Points

Likely places to extend the project:

- Add continuous platform spawning to `level_generator.gd`.
- Add platform cleanup below the camera or lava line.
- Add persistent best-score storage to `score.gd`.
- Add player death animation or state handling instead of directly disabling physics from `lava.gd`.
- Add custom input actions in `project.godot` if replacing the default `ui_*` actions.
- Move the player script and final collision/visual setup into `player.tscn` if the base scene should be fully self-contained.

## Known Couplings and Assumptions

- `Lava` identifies the player by `body.name == "Player"`.
- `Level Generator` identifies starting platforms by names beginning with `"Ground"`.
- `HUD`, `Camera2D`, and `Lava` depend on exported `NodePath` references assigned in `main.tscn`.
- `GameOverUI` and `HUD` depend on the global `Score` autoload.
- Height assumes upward progress means decreasing global `y`.
- `Score.best_height` is session-persistent but not disk-persistent.
