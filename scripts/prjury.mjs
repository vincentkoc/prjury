#!/usr/bin/env node
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const options = {
  inputDir: "outputs",
  maxComments: 15,
  post: true,
  repo: process.env.GITHUB_REPOSITORY || "",
  pr: process.env.PR_NUMBER || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  openaiKey: "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
};

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case "--input":
    case "--input-dir":
      options.inputDir = args[++i];
      break;
    case "--max":
    case "--max-comments":
      options.maxComments = Number(args[++i]);
      break;
    case "--post":
      options.post = args[++i] !== "false";
      break;
    case "--no-post":
      options.post = false;
      break;
    case "--repo":
      options.repo = args[++i];
      break;
    case "--pr":
      options.pr = args[++i];
      break;
    case "--github-token":
      options.githubToken = args[++i];
      break;
    case "--openai-key":
      options.openaiKey = args[++i];
      break;
    case "--openai-model":
      options.openaiModel = args[++i];
      break;
    case "--openai-base-url":
      options.openaiBaseUrl = args[++i];
      break;
    default:
      console.warn(`Unknown argument ${arg}`);
  }
}

const run = (command, commandArgs, env = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with code ${result.status}`);
  }
};

const aggregate = () => {
  run("node", [path.join(scriptDir, "aggregate.mjs"), "--input", options.inputDir, "--max-comments", String(options.maxComments), "--out", path.join(options.inputDir, "report")]);
};

const unify = () => {
  if (!options.openaiKey) return;
  run(
    "node",
    [
      path.join(scriptDir, "unify-llm.mjs"),
      "--issues",
      path.join(options.inputDir, "report.json"),
      "--fallback",
      path.join(options.inputDir, "report.md"),
      "--out",
      path.join(options.inputDir, "comment.md"),
      "--model",
      options.openaiModel,
    ],
    {
      OPENAI_API_KEY: options.openaiKey,
      OPENAI_MODEL: options.openaiModel,
      OPENAI_BASE_URL: options.openaiBaseUrl || "",
    }
  );
};

const postReview = () => {
  if (!options.post) {
    console.log("Skipping GitHub review post (post=false).");
    return;
  }
  const repo = options.repo || process.env.GITHUB_REPOSITORY;
  const pr = options.pr || process.env.PR_NUMBER;
  if (!repo || !pr) {
    throw new Error("Missing repo or PR number for posting review.");
  }
  const commentPath = fs.existsSync(path.join(options.inputDir, "comment.md"))
    ? path.join(options.inputDir, "comment.md")
    : path.join(options.inputDir, "report.md");
  if (!fs.existsSync(commentPath)) {
    console.warn("No report/comment found to post; skipping.");
    return;
  }
  const ghEnv = { GITHUB_TOKEN: options.githubToken || process.env.GITHUB_TOKEN || "" };
  if (!ghEnv.GITHUB_TOKEN) {
    throw new Error("Missing github token for posting review.");
  }
  console.log(`Posting unified review to ${repo}#${pr}`);
  run(
    "gh",
    ["api", `repos/${repo}/pulls/${pr}/reviews`, "-f", "event=COMMENT", "-F", `body=@${commentPath}`],
    ghEnv
  );
};

const main = () => {
  fs.mkdirSync(options.inputDir, { recursive: true });
  aggregate();
  unify();
  postReview();
};

main();
