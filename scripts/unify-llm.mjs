#!/usr/bin/env node
/**
 * Optional LLM pass to rewrite/aggregate the deduped issues into a single
 * Markdown review comment. Uses OpenAI's chat completions API via fetch.
 */
import fs from "fs";

const args = process.argv.slice(2);
const options = {
  issuesPath: "outputs/report.json",
  fallbackPath: "outputs/report.md",
  outPath: "outputs/comment.md",
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  temperature: Number(process.env.OPENAI_TEMPERATURE || 0.2),
  maxTokens: Number(process.env.OPENAI_MAX_TOKENS || 800),
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--issues") options.issuesPath = args[++i];
  if (arg === "--fallback") options.fallbackPath = args[++i];
  if (arg === "--out") options.outPath = args[++i];
  if (arg === "--model") options.model = args[++i];
}

const apiKey = process.env.OPENAI_API_KEY;
const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const fallbackCopy = () => {
  if (options.fallbackPath && fs.existsSync(options.fallbackPath)) {
    fs.copyFileSync(options.fallbackPath, options.outPath);
    console.warn("LLM skipped; wrote fallback report.");
  } else {
    console.warn("LLM skipped; no fallback available.");
  }
};

const buildPrompt = (report) => {
  const header = `You are prjury, a terse PR reviewer. You receive issues from multiple bots. Combine them into ONE short GitHub-ready review comment.`;
  const rules = [
    "Keep it concise: 1 short summary paragraph, then a bullet list.",
    "Order bullets by severity (blocker > major > minor > nit).",
    "Show tool provenance in each bullet (e.g., [codex+gemini]).",
    "Highlight disagreements between tools explicitly in the summary if any exist.",
    "Group similar items; avoid duplicates.",
    "If nothing critical, say so.",
    "If suggestions exist, include them succinctly inline with the bullet.",
    "Do not invent files/lines; prefer provided locations.",
    `Cap to ~${report.maxComments || 15} bullets; drop beyond that.`,
  ];
  const payload = {
    total: report.total,
    issues: report.issues,
    disagreements: report.disagreements || [],
    toolCounts: report.toolCounts || {},
  };
  const userContent = [
    "Issues JSON:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
  const systemContent = [header, "Rules:", ...rules.map((r) => `- ${r}`)].join("\n");
  return { systemContent, userContent };
};

const main = async () => {
  if (!apiKey) {
    console.warn("OPENAI_API_KEY missing; skipping LLM aggregation.");
    fallbackCopy();
    return;
  }
  if (!fs.existsSync(options.issuesPath)) {
    console.warn(`Issues file ${options.issuesPath} missing; skipping LLM aggregation.`);
    fallbackCopy();
    return;
  }

  const report = readJson(options.issuesPath);
  const { systemContent, userContent } = buildPrompt(report);

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    const msg = data.choices?.[0]?.message?.content?.trim();
    if (!msg) throw new Error("No content returned from model");

    fs.writeFileSync(options.outPath, msg);
    console.log(`LLM aggregation complete -> ${options.outPath}`);
  } catch (err) {
    console.error(`LLM aggregation failed: ${err.message}`);
    fallbackCopy();
  }
};

main();
