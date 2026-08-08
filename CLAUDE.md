# DevInsight Dashboard

Telemetry pipeline for the Godot game "Ascent," built as an SWE internship portfolio piece. User is new to CS — keep explanations plain-language and step-by-step, avoid jargon without defining it.

**Stack:** Godot (`godot/system_logger.gd`, full game lives outside this repo on purpose) → Supabase (Postgres + REST, RLS-locked anon key, insert/select only) → static `index.html` dashboard (Chart.js) on Vercel → GitHub Actions (`scripts/check-regression.mjs`, `.github/workflows/perf-gate.yml`) fails CI on >10% FPS regression between builds, tracked via `build_version` and the `build_fps_summary` view.

Prioritize genuinely differentiated work over tutorial-tier features. Be careful with destructive commands (`rm -rf`, force-push) — confirm before running.
