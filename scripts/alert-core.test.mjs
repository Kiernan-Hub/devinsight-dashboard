// Tests for the gate's alerting: the pure decisions in alert-core.mjs, then scripts/alert.mjs
// driven through a whole lifecycle against an in-memory stand-in for GitHub's issues API.

import test from "node:test";
import assert from "node:assert/strict";

import { findOpenAlerts, MARKERS, parseResult, planAlerts } from "./alert-core.mjs";
import { run } from "./alert.mjs";

const context = { commit: "abcdef1234567890", commitUrl: "https://x/commit/abc", runUrl: "https://x/runs/1" };
const none = { regression: null, gateDown: null };
const verdict = (status, extra = {}) => ({ status, message: `${status.toUpperCase()}: details`, build: "0.6.0", baseline: "0.3.0", ...extra });

test("a malformed or missing verdict is treated as the gate failing to run, never as silence", () => {
  for (const raw of [undefined, "", "not json", '{"status":"great"}', '{"status":"healthy"}']) {
    assert.equal(parseResult(raw).status, "error", String(raw));
  }
  assert.equal(parseResult(JSON.stringify(verdict("healthy"))).status, "healthy");
});

test("only the bot's own marked issues count as open alerts", () => {
  const issues = [
    { number: 1, user: { login: "someone" }, body: `${MARKERS.regression} quoted by a person` },
    { number: 2, user: { login: "github-actions[bot]" }, body: "an unrelated bot issue" },
    { number: 3, user: { login: "github-actions[bot]" }, body: `${MARKERS.regression}\nreal`, pull_request: {} },
    { number: 4, user: { login: "github-actions[bot]" }, body: `${MARKERS.regression}\nreal` },
    { number: 5, user: { login: "github-actions[bot]" }, body: `${MARKERS.gateDown}\nreal` }
  ];
  assert.deepEqual(findOpenAlerts(issues), { regression: 4, gateDown: 5 });
});

test("a regression opens one alert, then comments while it persists", () => {
  const [opened] = planAlerts(verdict("regression"), none, context);
  assert.equal(opened.action, "open");
  assert.equal(opened.title, "Performance regression in build 0.6.0 (vs 0.3.0)");
  assert.ok(opened.body.startsWith(MARKERS.regression));
  assert.deepEqual(planAlerts(verdict("regression"), { ...none, regression: 7 }, context).map(a => [a.action, a.issue]), [["comment", 7]]);
});

test("pending closes nothing that matters: no data is not a recovery", () => {
  assert.deepEqual(planAlerts(verdict("pending"), { ...none, regression: 7 }, context), []);
});

test("a gate that cannot run says so, and leaves the regression alert alone", () => {
  const actions = planAlerts(verdict("error", { message: "Supabase request failed: ENOTFOUND" }), { ...none, regression: 7 }, context);
  assert.deepEqual(actions.map(a => [a.kind, a.action]), [["gateDown", "open"]]);
  assert.match(actions[0].body, /ENOTFOUND/);
  assert.deepEqual(planAlerts(verdict("error"), { regression: 7, gateDown: 8 }, context), [], "already open: nothing new to say");
});

test("verdict text cannot break out of its code block", () => {
  const [opened] = planAlerts(verdict("regression", { message: "x\n```\n# injected heading" }), none, context);
  assert.equal(opened.body.match(/```/g).length, 2);
});

// --- the whole lifecycle, through scripts/alert.mjs -------------------------------------------

function fakeGitHub() {
  const issues = [];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const path = url.replace("https://api.github.com/repos/owner/repo/", "");
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push(`${method} ${path.split("?")[0]}`);
    assert.equal(options.headers.Authorization, "Bearer t0ken");
    const reply = (status, data) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });

    if (method === "GET" && path.startsWith("issues?")) {
      return reply(200, issues.filter(i => i.state === "open"));
    }
    if (method === "POST" && path === "issues") {
      const issue = { number: issues.length + 1, state: "open", user: { login: "github-actions[bot]" }, comments: [], ...body };
      issues.push(issue);
      return reply(201, issue);
    }
    const match = path.match(/^issues\/(\d+)(\/comments)?$/);
    const issue = match && issues.find(i => i.number === Number(match[1]));
    if (!issue) return reply(404, { message: "Not Found" });
    if (method === "POST" && match[2]) { issue.comments.push(body.body); return reply(201, {}); }
    if (method === "PATCH") { Object.assign(issue, body); return reply(200, issue); }
    return reply(400, {});
  };
  return { issues, calls, fetchImpl };
}

test("lifecycle: regression → still regressed → database down → back → recovered", async () => {
  const gh = fakeGitHub();
  const quiet = { info() {} };
  const push = (sha, result) => run({
    GITHUB_TOKEN: "t0ken", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: sha, GITHUB_RUN_ID: "9",
    GATE_RESULT: JSON.stringify(result)
  }, gh.fetchImpl, quiet);
  const openTitles = () => gh.issues.filter(i => i.state === "open").map(i => i.title);

  await push("1111111", verdict("regression"));
  assert.deepEqual(openTitles(), ["Performance regression in build 0.6.0 (vs 0.3.0)"]);

  await push("2222222", verdict("regression"));
  assert.equal(gh.issues.length, 1, "no duplicate issue");
  assert.equal(gh.issues[0].comments.length, 1);

  await push("3333333", verdict("error", { message: "Supabase request failed: ENOTFOUND" }));
  assert.deepEqual(openTitles(), ["Performance regression in build 0.6.0 (vs 0.3.0)", "Performance gate cannot run"]);

  await push("4444444", verdict("error"));
  assert.equal(gh.issues.length, 2, "still down: no second gate-down issue");

  await push("5555555", verdict("pending"));
  assert.deepEqual(openTitles(), ["Performance regression in build 0.6.0 (vs 0.3.0)"], "gate ran: gate-down closes; pending does not close the regression");

  await push("6666666", verdict("healthy"));
  assert.deepEqual(openTitles(), []);
  assert.match(gh.issues[0].comments.at(-1), /^Recovered at \[`6666666`\]/);
  assert.equal(gh.issues[0].state_reason, "completed");
});
