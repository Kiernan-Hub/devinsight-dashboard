// Carries out scripts/alert-core.mjs's decisions against the GitHub API. Run by the `alert` job
// in perf-gate.yml after the regression gate, on pushes to main only.
//
//   GATE_RESULT='{"status":"regression",...}' GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
//   GITHUB_SHA=... node scripts/alert.mjs
//
// Uses the job's short-lived GITHUB_TOKEN (permissions: issues: write), plain fetch, and no
// third-party action.

import { pathToFileURL } from "node:url";
import { findOpenAlerts, parseResult, planAlerts } from "./alert-core.mjs";

export async function run(env, fetchImpl = fetch, log = console) {
  const api = env.GITHUB_API_URL || "https://api.github.com";
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  const repo = env.GITHUB_REPOSITORY;
  if (!env.GITHUB_TOKEN || !repo || !env.GITHUB_SHA) throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA are required");

  async function github(method, path, body) {
    const response = await fetchImpl(`${api}/repos/${repo}/${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.status === 204 ? null : response.json();
  }

  const result = parseResult(env.GATE_RESULT);
  const issues = await github("GET", "issues?state=open&creator=github-actions%5Bbot%5D&per_page=100");
  const open = findOpenAlerts(issues);
  const actions = planAlerts(result, open, {
    commit: env.GITHUB_SHA,
    commitUrl: `${server}/${repo}/commit/${env.GITHUB_SHA}`,
    runUrl: `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
  });

  log.info(`gate verdict: ${result.status}; open alerts: regression #${open.regression ?? "-"}, gate-down #${open.gateDown ?? "-"}`);
  if (!actions.length) log.info("nothing to change");

  for (const step of actions) {
    if (step.action === "open") {
      const created = await github("POST", "issues", { title: step.title, body: step.body });
      log.info(`opened #${created.number}: ${step.title}`);
    } else {
      await github("POST", `issues/${step.issue}/comments`, { body: step.body });
      if (step.action === "close") {
        await github("PATCH", `issues/${step.issue}`, { state: "closed", state_reason: "completed" });
        log.info(`closed #${step.issue} (${step.kind})`);
      } else {
        log.info(`commented on #${step.issue} (${step.kind})`);
      }
    }
  }
  return actions;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run(process.env);
  } catch (error) {
    console.error(`alert: ${error.message}`);
    process.exit(1);
  }
}
