import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const aggregateScript = path.join(repoRoot, "scripts", "aggregate.mjs");

const runAggregate = (inputDir, maxComments = 15) => {
  const result = spawnSync(
    "node",
    [aggregateScript, "--input", inputDir, "--max-comments", String(maxComments), "--out", path.join(inputDir, "report")],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`aggregate script failed: ${result.stderr}`);
  }
};

test("aggregate dedupes issues and orders by severity", () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.cwd()), "tmp-aggregate-"));
  const sampleIssues = [
    {
      tool: "demo",
      severity: "minor",
      file: "src/a.ts",
      line: 10,
      message: "First",
    },
    {
      tool: "demo",
      severity: "blocker",
      file: "src/a.ts",
      line: 10,
      message: "First", // duplicate message/location but higher severity
    },
    {
      tool: "demo2",
      severity: "nit",
      file: "src/b.ts",
      line: 5,
      message: "Second",
    },
  ];
  fs.writeFileSync(path.join(tmp, "demo.json"), JSON.stringify(sampleIssues, null, 2));

  runAggregate(tmp, 5);

  const report = JSON.parse(fs.readFileSync(path.join(tmp, "report.json"), "utf8"));
  assert.equal(report.total, 2);
  assert.equal(report.issues.length, 2);
  assert.equal(report.issues[0].severity, "blocker"); // dedup kept higher severity
  assert.equal(report.issues[0].message, "First");
  assert.equal(report.issues[1].severity, "nit");
});

test("aggregate captures disagreements when severities differ", () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.cwd()), "tmp-aggregate-"));
  const sampleIssues = [
    { tool: "codex", severity: "major", file: "src/c.ts", line: 7, message: "X" },
    { tool: "gemini", severity: "minor", file: "src/c.ts", line: 7, message: "X" },
  ];
  fs.writeFileSync(path.join(tmp, "demo.json"), JSON.stringify(sampleIssues, null, 2));
  runAggregate(tmp, 5);
  const report = JSON.parse(fs.readFileSync(path.join(tmp, "report.json"), "utf8"));
  assert.ok(report.disagreements);
  assert.equal(report.disagreements.length, 1);
  assert.equal(report.disagreements[0].location, "src/c.ts:7");
});
