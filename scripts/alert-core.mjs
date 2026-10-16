// Decides what the performance gate should tell people, as GitHub issues, after it runs on main.
//
// Kept free of network code so every decision is unit-tested; scripts/alert.mjs carries them out.
//
// Two separate alerts, because they mean different things and need different people to act:
//
// - "regression": the gate ran, and the declared build is slower than its baseline by more than
//   the threshold. Opened once; each later run on main that is still regressed adds a comment with
//   the new numbers; closed automatically, with a comment, once the build measures healthy again.
//
// - "gate-down": the gate could not run at all — the telemetry database unreachable, a secret
//   missing, a manifest that does not match the logger. This one exists because of a real gap:
//   in September 2026 the Supabase project was paused for inactivity, the gate failed on every
//   push from then on, and nothing said so for weeks. A red check on a commit nobody is looking at
//   is not an alert; an open issue (which GitHub emails to everyone watching the repo) is.
//
// "pending" (the gate ran but has too few samples to judge) is deliberately neither: a lack of
// data is not evidence of a regression, and it is not evidence of a recovery either, so it never
// closes a regression alert. It does close gate-down — the gate demonstrably ran.

export const MARKERS = {
  regression: "<!-- devinsight:alert:regression -->",
  gateDown: "<!-- devinsight:alert:gate-down -->"
};

const KNOWN_STATUSES = new Set(["healthy", "warning", "pending", "regression", "error"]);

// The gate's verdict arrives as a JSON string through an environment variable. Anything that is
// not a well-formed verdict is treated as the gate having failed to run — the safe reading,
// because the alternative is silence.
export function parseResult(raw) {
  try {
    const result = JSON.parse(raw);
    if (result && KNOWN_STATUSES.has(result.status) && typeof result.message === "string") return result;
  } catch {
    // fall through
  }
  return { status: "error", message: `The gate did not report a readable verdict (got ${JSON.stringify(String(raw ?? "").slice(0, 200))}).` };
}

// Finds this workflow's own open alerts among the repository's open issues. Matching on the hidden
// marker *and* the bot author means a person quoting an alert in their own issue is never mistaken
// for one, and never closed by the bot. Labels are not relied on: GitHub silently drops labels on
// issue creation when the token lacks push access, which would make every run open a duplicate.
export function findOpenAlerts(issues) {
  const open = { regression: null, gateDown: null };
  for (const issue of issues) {
    if (issue.pull_request || issue.user?.login !== "github-actions[bot]" || typeof issue.body !== "string") continue;
    if (issue.body.startsWith(MARKERS.regression) && open.regression === null) open.regression = issue.number;
    if (issue.body.startsWith(MARKERS.gateDown) && open.gateDown === null) open.gateDown = issue.number;
  }
  return open;
}

const fenced = text => `\`\`\`\n${text.replaceAll("```", "'''")}\n\`\`\``;

// `context`: { commit, commitUrl, runUrl } for the links in the text.
export function planAlerts(result, open, context) {
  const at = `[\`${context.commit.slice(0, 7)}\`](${context.commitUrl}) ([run](${context.runUrl}))`;
  const actions = [];

  if (result.status === "error") {
    if (open.gateDown === null) {
      actions.push({
        kind: "gateDown",
        action: "open",
        title: "Performance gate cannot run",
        body: [
          MARKERS.gateDown,
          `The FPS regression gate in \`perf-gate.yml\` could not run on main at ${at}, so no build is being judged against real telemetry until this is fixed.`,
          fenced(result.message),
          "Common causes: the Supabase project is paused or unreachable, or the `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` secrets are missing. This issue closes itself the next time the gate runs."
        ].join("\n\n")
      });
    }
    // A regression alert stays exactly as it was: a gate that cannot see has learned nothing.
    return actions;
  }

  if (open.gateDown !== null) {
    actions.push({ kind: "gateDown", action: "close", issue: open.gateDown, body: `The gate ran again at ${at} (verdict: ${result.status}). Closing.` });
  }

  if (result.status === "regression") {
    const where = result.build && result.baseline ? ` in build ${result.build} (vs ${result.baseline})` : "";
    if (open.regression === null) {
      actions.push({
        kind: "regression",
        action: "open",
        title: `Performance regression${where}`,
        body: [
          MARKERS.regression,
          `The FPS regression gate found a regression on main at ${at}.`,
          fenced(result.message),
          "Each later run on main that is still regressed adds a comment with its numbers. This issue closes itself once the declared build measures healthy against its baseline."
        ].join("\n\n")
      });
    } else {
      actions.push({ kind: "regression", action: "comment", issue: open.regression, body: `Still regressed at ${at}:\n\n${fenced(result.message)}` });
    }
  } else if ((result.status === "healthy" || result.status === "warning") && open.regression !== null) {
    actions.push({ kind: "regression", action: "close", issue: open.regression, body: `Recovered at ${at}:\n\n${fenced(result.message)}` });
  }

  return actions;
}
