prjury (meta PR review bot)
==========================

Goal: run multiple code-review AIs/tools inside a single GitHub Action job, collect their findings silently, deduplicate, and post one unified review as `prjury`. No hosting/server needed.

License
-------
Apache 2.0 (`LICENSE` file). This keeps adoption friction low for enterprises while preserving patent protection.

How it works
------------
- A workflow runs on `pull_request`.
- Optional adapter steps invoke third-party reviewers (Gemini CLI, CodeRabbit Action/CLI, Cursor CLI, etc.) **without** GitHub tokens so they cannot post directly. They only write JSON results to `./outputs/*.json`.
- `prjury` aggregates those JSON files, filters/dedupes, and (optionally) posts one review comment back to the PR via `GITHUB_TOKEN`.

Files in this repo
------------------
- `action.yml` – composite GitHub Action that runs aggregation + posting.
- `scripts/aggregate.mjs` – merges adapter outputs into `report.json` and `report.md`.
- `scripts/unify-llm.mjs` – optional OpenAI call to rewrite the unified comment (uses `OPENAI_API_KEY`), preserving disagreements.
- `.github/workflows/example.yml` – example workflow wiring the action and adapters.

Expected adapter output schema
------------------------------
Each tool should emit a JSON array of objects shaped like:
```json
[
  {
    "tool": "coderabbit",
    "severity": "major",       // blocker|major|minor|nit (case-insensitive accepted)
    "file": "src/app.ts",
    "line": 42,
    "message": "Explain the issue",
    "suggestion": "Optional fix or patch text"
  }
]
```
Place each adapter’s output at `outputs/<tool>.json`. The aggregator will ignore invalid/empty files.

Running an LLM pass inside the Action
-------------------------------------
If you provide `openai-api-key`, the action will call `scripts/unify-llm.mjs` to rewrite the comment using `gpt-4o-mini` (configurable via `openai-model` and `openai-base-url`). If no key is provided, it posts the deterministic summary from `aggregate.mjs`. Both variants include tool provenance and a “Disagreements” section when tools differ by severity.

Example workflow (everything in-action, no hosting)
---------------------------------------------------
This demonstrates running adapters silently (Codex Action, Gemini CLI, Cursor CLI) and letting `prjury` post a PR **review** (not just an issue comment):
```yaml
name: prjury
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Adapter 1: OpenAI Codex Action (silent). Use the output schema to force our JSON format.
      - name: Codex review (silent)
        id: codex
        uses: openai/codex-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          prompt: |
            You are a code reviewer. Output JSON array only, matching:
            [{"tool":"codex","severity":"major|minor|nit|blocker","file":"path","line":123,"message":"...", "suggestion":"..."}]
            Review the current repo diff (workspace) and emit findings.
          output-schema: |
            type Issue = {
              tool: "codex",
              severity: "blocker" | "major" | "minor" | "nit",
              file: string,
              line: number,
              message: string,
              suggestion?: string,
            }
            type Output = Issue[]
          output-file: outputs/codex.json
          sandbox: read-only   # keep it safe; also omit GITHUB_TOKEN here

      # Adapter 2: Gemini CLI via official Action (silent). Prompt it to JSON and capture the output.
      - name: Gemini review (silent)
        id: gemini
        uses: google-github-actions/run-gemini-cli@v0
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
          prompt: |
            Emit ONLY JSON array: [{"tool":"gemini","severity":"major|minor|nit|blocker","file":"path","line":123,"message":"...", "suggestion":"..."}]
            Review changed files in this repo for issues. Keep it concise.
          upload_artifacts: "false"
        continue-on-error: true
      - name: Persist Gemini JSON
        if: always()
        run: |
          mkdir -p outputs
          echo '${{ steps.gemini.outputs.summary }}' > outputs/gemini.json

      # Adapter 3: Cursor CLI (headless). Adjust flags per your version; keep GH token out.
      - name: Cursor review (silent)
        if: ${{ vars.RUN_CURSOR == 'true' }}
        continue-on-error: true
        run: |
          mkdir -p outputs
          cursor review --diff "origin/${{ github.event.pull_request.base.ref }}...HEAD" --format json --output outputs/cursor.json || true
        env:
          CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}

      # -------- Aggregation + posting --------
      - name: prjury
        uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }} # used only for posting
          input-dir: outputs
          max-comments: "15"
          post-review: "true"
          openai-api-key: ${{ secrets.OPENAI_API_KEY }} # optional LLM rewrite
```
When published, replace `uses: ./` with `uses: prjury/prjury-action@v1`.

Notes and tips
--------------
- Keep adapters short and `continue-on-error: true` so one failure doesn’t block the review.
- Omit `GITHUB_TOKEN` (or set a fake token) for adapter steps to prevent them from posting.
- `post-review: "false"` lets you dry-run and only archive `outputs/report.*`.
- Tune `max-comments` to control noise; severity order: blocker > major > minor > nit.
- If you want to use non-OpenAI providers, set `openai-base-url` and ensure the provider follows the OpenAI-compatible chat completions API.
- All upstream calls (Codex/OpenAI, Gemini, Cursor) use the caller’s secrets/credits; prjury does not proxy or host anything.
- The unified output includes tool labels per finding and a Disagreements section when tools diverge on severity at the same location.

Development status
------------------
This is a starter skeleton. Extend by:
- Adding more adapters (write their JSON into `outputs/`).
- Improving dedupe heuristics (currently based on file/line/message token).
- Enriching the summary (include risk scoring, asked questions, etc.).
