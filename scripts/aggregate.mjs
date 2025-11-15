#!/usr/bin/env node
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const options = {
  input: "outputs",
  out: "outputs/report",
  maxComments: 15,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--input") options.input = args[++i];
  if (arg === "--out") options.out = args[++i];
  if (arg === "--max-comments") options.maxComments = Number(args[++i] ?? options.maxComments);
}

const severityOrder = ["blocker", "major", "minor", "nit"];

const normalizeSeverity = (value) => {
  if (!value) return "minor";
  const lower = String(value).toLowerCase();
  if (severityOrder.includes(lower)) return lower;
  if (["critical", "high"].includes(lower)) return "blocker";
  if (["medium"].includes(lower)) return "major";
  if (["low"].includes(lower)) return "minor";
  return "minor";
};

const tryReadJson = (filepath) => {
  try {
    const raw = fs.readFileSync(filepath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Skipping ${filepath}: ${err.message}`);
    return null;
  }
};

const loadIssues = (dir) => {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const items = [];
  for (const file of entries) {
    const data = tryReadJson(path.join(dir, file));
    if (!Array.isArray(data)) continue;
    for (const issue of data) {
      if (!issue || typeof issue !== "object") continue;
      const normalized = {
        tool: issue.tool || path.basename(file, ".json"),
        severity: normalizeSeverity(issue.severity),
        file: issue.file || null,
        line: Number.isFinite(issue.line) ? issue.line : null,
        message: issue.message || issue.text || "",
        suggestion: issue.suggestion || issue.fix || null,
        tools: issue.tools || null, // pass-through if already aggregated upstream
      };
      if (!normalized.message) continue;
      items.push(normalized);
    }
  }
  return items;
};

// Merge duplicate issues and accumulate tool provenance.
const dedupe = (issues) => {
  const map = new Map();
  for (const issue of issues) {
    const key = [
      issue.file || "",
      issue.line || "",
      issue.message.slice(0, 160).replace(/\s+/g, " ").trim(),
    ].join("|");
    if (!map.has(key)) {
      map.set(key, {
        ...issue,
        tools: Array.from(new Set([...(issue.tools || []), issue.tool || "unknown"])),
      });
      continue;
    }
    const existing = map.get(key);
    // Keep the highest severity (lowest index).
    if (severityOrder.indexOf(issue.severity) < severityOrder.indexOf(existing.severity)) {
      existing.severity = issue.severity;
    }
    existing.tools = Array.from(new Set([...existing.tools, issue.tool || "unknown", ...(issue.tools || [])]));
    // Prefer existing suggestion unless missing.
    if (!existing.suggestion && issue.suggestion) existing.suggestion = issue.suggestion;
  }
  return Array.from(map.values());
};

const findDisagreements = (issues) => {
  const byLocation = new Map();
  for (const issue of issues) {
    const loc = `${issue.file || "unknown"}:${issue.line || "?"}`;
    if (!byLocation.has(loc)) byLocation.set(loc, []);
    byLocation.get(loc).push(issue);
  }
  const disagreements = [];
  for (const [loc, list] of byLocation.entries()) {
    const severities = new Set(list.map((i) => i.severity));
    if (severities.size > 1) {
      disagreements.push({
        location: loc,
        severities: Array.from(severities),
        tools: Array.from(new Set(list.flatMap((i) => i.tools || [i.tool || "unknown"]))),
      });
    }
  }
  return disagreements;
};

const formatSummary = (issues, disagreements, toolCounts) => {
  const counts = severityOrder.reduce((acc, sev) => ({ ...acc, [sev]: 0 }), {});
  for (const issue of issues) counts[issue.severity] = (counts[issue.severity] || 0) + 1;
  const total = issues.length;
  const lines = [];
  const toolLine = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${t}:${c}`)
    .join(" ");
  lines.push(
    `prjury report — ${total} finding${total === 1 ? "" : "s"} (blocker:${counts.blocker} major:${counts.major} minor:${counts.minor} nit:${counts.nit})` +
      (toolLine ? ` | tools ${toolLine}` : "")
  );
  lines.push("");
  const toList = issues.slice(0, options.maxComments);
  for (const issue of toList) {
    const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "unknown";
    const toolLabel = issue.tools && issue.tools.length ? ` [${issue.tools.join("+")}]` : "";
    lines.push(
      `- [${issue.severity}]${toolLabel} ${location} — ${issue.message}${
        issue.suggestion ? ` (suggestion: ${issue.suggestion})` : ""
      }`
    );
  }
  if (total > toList.length) {
    lines.push("");
    lines.push(`… trimmed to top ${toList.length} of ${total} by severity.`);
  }
  if (disagreements.length) {
    lines.push("");
    lines.push("Disagreements:");
    for (const d of disagreements) {
      lines.push(
        `- ${d.location} — severities ${d.severities.join("/")} from ${d.tools.join("+")}`
      );
    }
  }
  return lines.join("\n");
};

const ensureDir = (p) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
};

const main = () => {
  const issues = loadIssues(options.input);
  const deduped = dedupe(
    issues.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity))
  );
  const sorted = deduped.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity));
  const trimmed = sorted.slice(0, options.maxComments);
  const disagreements = findDisagreements(deduped);
  const toolCounts = {};
  for (const issue of sorted) {
    for (const t of issue.tools || [issue.tool || "unknown"]) {
      toolCounts[t] = (toolCounts[t] || 0) + 1;
    }
  }
  const summary = formatSummary(sorted, disagreements, toolCounts);

  const reportJson = {
    total: sorted.length,
    emitted: trimmed.length,
    maxComments: options.maxComments,
    issues: trimmed,
    disagreements,
    toolCounts,
  };

  const outJson = `${options.out}.json`;
  const outMd = `${options.out}.md`;
  ensureDir(outJson);
  fs.writeFileSync(outJson, JSON.stringify(reportJson, null, 2));
  fs.writeFileSync(outMd, summary);

  console.log(`Collected ${issues.length} -> deduped ${sorted.length} -> emitting ${trimmed.length}`);
  console.log(`Wrote ${outJson} and ${outMd}`);
};

main();
