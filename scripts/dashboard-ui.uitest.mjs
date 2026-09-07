// Browser tests for index.html.
//
// The unit tests in scripts/*.test.mjs cover the calculations in
// dashboard-core.mjs, but nothing checked that the page itself still works: a
// typo in the module import, a renamed element id, or a Chart.js call that
// throws would all leave the tests green and the dashboard blank. These tests
// load the real page in a real browser and assert on what a visitor sees.
//
// Named .uitest.mjs rather than .test.mjs on purpose, so `node --test
// scripts/*.test.mjs` stays dependency-free and runnable straight from a
// clone. Run these with `npm run test:ui`.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css" };

let server;
let browser;
let origin;

// Serving over HTTP rather than file:// matters: index.html uses an ES module
// import, which file:// blocks as a cross-origin request.
before(async () => {
  server = http.createServer(async (req, res) => {
    const requested = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const filePath = path.join(ROOT, requested === "/" ? "index.html" : requested);
    // Refuse to serve outside the repo even in a test fixture.
    if (!filePath.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      const body = await fs.readFile(filePath);
      res.writeHead(200, { "content-type": TYPES[path.extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});

/**
 * Open the dashboard and fail the test on any console error or uncaught
 * exception. Silent JS failures are exactly what this suite exists to catch,
 * so they are collected rather than ignored.
 */
async function openDashboard(query = "") {
  const page = await browser.newPage();
  // The page renders from a local fixture in well under a second, so a failure
  // is a failure, not slowness. Playwright's 30s default would turn one broken
  // selector into half a minute of CI sitting idle per assertion.
  page.setDefaultTimeout(5_000);
  const errors = [];
  page.on("console", message => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${origin}/index.html${query}`);
  return { page, errors };
}

const textOf = (page, id) => page.locator(`#${id}`).innerText();

test("demo mode renders the whole dashboard without console errors", async () => {
  const { page, errors } = await openDashboard("?demo=1");

  await page.waitForFunction(() => document.getElementById("connectionText").textContent === "Demo data");
  assert.equal(await textOf(page, "connectionText"), "Demo data");

  // Every headline metric must hold a real number, not the "—" placeholder.
  for (const id of ["currentFps", "p95FrameTime", "onePercentLow", "currentMemory"]) {
    const value = await textOf(page, id);
    assert.notEqual(value, "—", `${id} was never populated`);
    assert.ok(Number.isFinite(Number(value)), `${id} rendered "${value}", which is not a number`);
  }

  assert.match(await textOf(page, "sampleCount"), /48 visible samples/);
  assert.deepEqual(errors, [], `page reported errors: ${errors.join(" | ")}`);
  await page.close();
});

test("the build panel reports the seeded regression", async () => {
  const { page } = await openDashboard("?demo=1");
  await page.waitForFunction(() => document.getElementById("buildChange").textContent !== "—");

  assert.equal(await textOf(page, "buildVersion"), "0.3.0");
  assert.equal(await textOf(page, "buildChange"), "-29.0% vs 0.2.0");
  assert.equal(await textOf(page, "buildStatus"), "Regression");
  // A regression must also raise the banner, not just recolour a badge.
  await page.waitForSelector("#notice.visible");
  assert.match(await textOf(page, "noticeText"), /0\.3\.0 is 29\.0% slower than 0\.2\.0/);
  await page.close();
});

test("both charts draw pixels rather than showing the empty state", async () => {
  const { page } = await openDashboard("?demo=1");
  await page.waitForFunction(() => document.getElementById("connectionText").textContent === "Demo data");

  for (const id of ["fpsChart", "memChart"]) {
    const drawn = await page.evaluate(canvasId => {
      const canvas = document.getElementById(canvasId);
      const context = canvas.getContext("2d");
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      // Any non-transparent pixel means Chart.js actually rendered something.
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
      return false;
    }, id);
    assert.ok(drawn, `${id} rendered no pixels`);
  }

  assert.equal(await page.locator("#fpsEmpty.visible").count(), 0);
  assert.equal(await page.locator("#memoryEmpty.visible").count(), 0);
  await page.close();
});

test("changing the range redraws and relabels both charts", async () => {
  const { page, errors } = await openDashboard("?demo=1");
  await page.waitForFunction(() => document.getElementById("connectionText").textContent === "Demo data");

  await page.click('[data-minutes="30"]');
  await page.waitForFunction(() => document.getElementById("fpsWindow").textContent === "FPS / LAST 30M");
  assert.equal(await textOf(page, "memoryWindow"), "MB / LAST 30M");
  assert.equal(await page.locator('.range-button.active').innerText(), "30m");

  assert.deepEqual(errors, [], `page reported errors: ${errors.join(" | ")}`);
  await page.close();
});

test("filtering to one build narrows the data the page shows", async () => {
  const { page } = await openDashboard("?demo=1");
  await page.waitForFunction(() => document.getElementById("sampleCount").textContent.startsWith("48"));

  // The demo set is 48 samples split evenly across two builds.
  await page.selectOption("#buildFilter", "0.3.0");
  await page.waitForFunction(() => document.getElementById("sampleCount").textContent.startsWith("24"));
  assert.match(await textOf(page, "sampleCount"), /24 visible samples/);

  await page.selectOption("#buildFilter", "all");
  await page.waitForFunction(() => document.getElementById("sampleCount").textContent.startsWith("48"));
  await page.close();
});

test("pause stops live updates and resume restarts them", async () => {
  const { page } = await openDashboard("?demo=1");
  await page.waitForFunction(() => document.getElementById("connectionText").textContent === "Demo data");

  await page.click("#pauseButton");
  assert.equal(await textOf(page, "connectionText"), "Paused");
  assert.equal(await textOf(page, "pauseButton"), "Resume live");

  await page.click("#pauseButton");
  await page.waitForFunction(() => document.getElementById("connectionText").textContent === "Demo data");
  assert.equal(await textOf(page, "pauseButton"), "Pause live");

  // Refresh must also clear a paused state rather than silently doing nothing.
  await page.click("#pauseButton");
  assert.equal(await textOf(page, "connectionText"), "Paused");
  await page.click("#refreshButton");
  await page.waitForFunction(() => document.getElementById("connectionText").textContent === "Demo data");
  assert.equal(await textOf(page, "pauseButton"), "Pause live");
  await page.close();
});

test("performance events are listed and clicking one focuses the FPS chart", async () => {
  const { page, errors } = await openDashboard("?demo=1");
  await page.waitForSelector("#performanceEvents button");

  const labels = await page.locator("#performanceEvents button strong").allInnerTexts();
  // The demo set deliberately contains a build boundary, FPS drops and a spike.
  assert.ok(labels.includes("FPS drop"), `expected an FPS drop, got ${labels.join(", ")}`);
  assert.ok(labels.includes("Memory spike"), `expected a memory spike, got ${labels.join(", ")}`);

  await page.locator("#performanceEvents button").first().click();
  const active = await page.evaluate(() => {
    const chart = Chart.getChart(document.getElementById("fpsChart"));
    return chart.getActiveElements().length;
  });
  assert.ok(active > 0, "clicking an event did not highlight a point on the FPS chart");

  assert.deepEqual(errors, [], `page reported errors: ${errors.join(" | ")}`);
  await page.close();
});

test("a failing backend surfaces an offline state instead of a blank page", async () => {
  const { page } = await openDashboard();
  // Production mode with Supabase unreachable — the path a real outage takes.
  await page.route("**/rest/v1/**", route => route.abort());
  await page.reload();

  await page.waitForFunction(() => document.getElementById("connectionText").textContent === "Offline");
  await page.waitForSelector("#notice.visible.error");
  assert.match(await textOf(page, "noticeText"), /retry automatically/i);
  // The retry control has to be reachable, otherwise the page is a dead end.
  assert.ok(await page.locator("#retryButton").isVisible());
  await page.close();
});
