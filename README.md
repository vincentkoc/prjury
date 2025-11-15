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
- `scripts/prjury.mjs` – orchestrator used by the Action (and runnable locally) that aggregates, runs the optional LLM pass, and posts to GitHub.
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

Example workflow (fork-safe, toggle adapters)
---------------------------------------------
Works on external PRs (via `pull_request_target`) and lets you flip adapters via repo variables (`PRJURY_RUN_CODEX`, etc.). Secrets (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GREPTILE_API_KEY`, `CURSOR_API_KEY`) supply the upstream tools and the meta review.
```yaml
name: prjury
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write
  contents: read

env:
  PRJURY_INPUT_DIR: outputs
  RUN_CODEX: ${{ vars.PRJURY_RUN_CODEX || 'false' }}
  RUN_GEMINI: ${{ vars.PRJURY_RUN_GEMINI || 'false' }}
  RUN_GREPTILE: ${{ vars.PRJURY_RUN_GREPTILE || 'false' }}
  RUN_CURSOR: ${{ vars.PRJURY_RUN_CURSOR || 'false' }}

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
          repository: ${{ github.event.pull_request.head.repo.full_name }}

      - run: mkdir -p "$PRJURY_INPUT_DIR"

      - name: Codex adapter (optional)
        if: ${{ env.RUN_CODEX == 'true' }}
        uses: openai/codex-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          prompt: |
            You are a PR reviewer. Emit ONLY JSON array:
            [{"tool":"codex","severity":"blocker|major|minor|nit","file":"path","line":0,"message":"...", "suggestion":"..."}]
            Review the diff in this repo for issues.
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
          output-file: ${{ env.PRJURY_INPUT_DIR }}/codex.json
          sandbox: read-only

      - name: Gemini adapter (optional)
        if: ${{ env.RUN_GEMINI == 'true' }}
        id: gemini
        uses: google-github-actions/run-gemini-cli@v0
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
          prompt: |
            Emit ONLY JSON array:
            [{"tool":"gemini","severity":"blocker|major|minor|nit","file":"path","line":0,"message":"...", "suggestion":"..."}]
            Review changed files.
          upload_artifacts: "false"
      - name: Persist Gemini JSON
        if: ${{ env.RUN_GEMINI == 'true' }}
        run: |
          echo '${{ steps.gemini.outputs.summary }}' > "${PRJURY_INPUT_DIR}/gemini.json"

      - name: Greptile adapter (optional)
        if: ${{ env.RUN_GREPTILE == 'true' }}
        env:
          GREPTILE_API_KEY: ${{ secrets.GREPTILE_API_KEY }}
        run: |
          greptile pr review             --repo "$GITHUB_REPOSITORY"             --pr "${{ github.event.pull_request.number }}"             --format json > "${PRJURY_INPUT_DIR}/greptile.raw.json" || true
          jq '[.findings[] | {
                tool: "greptile",
                severity: (.severity // "minor"),
                file: (.file // .path // ""),
                line: (.line // .start_line // null),
                message: (.message // .description // ""),
                suggestion: (.suggestion // .recommendation // null)
              }]' "${PRJURY_INPUT_DIR}/greptile.raw.json" > "${PRJURY_INPUT_DIR}/greptile.json" || echo "[]" > "${PRJURY_INPUT_DIR}/greptile.json"

      - name: Cursor adapter (optional)
        if: ${{ env.RUN_CURSOR == 'true' }}
        env:
          CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
        run: |
          cursor review             --diff "origin/${{ github.event.pull_request.base.ref }}...HEAD"             --format json             --output "${PRJURY_INPUT_DIR}/cursor.json" || true

      - name: prjury (aggregate + review)
        uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }} # used only for posting
          input-dir: ${{ env.PRJURY_INPUT_DIR }}
          max-comments: "15"
          post-review: "true"
          openai-api-key: ${{ secrets.OPENAI_API_KEY }} # optional LLM rewrite
```
When published, replace `uses: ./` with `uses: prjury/prjury-action@v1`.

Notes and tips
--------------

Notes and tips
--------------
- Keep adapters short and `continue-on-error: true` so one failure doesn’t block the review.
- Omit `GITHUB_TOKEN` (or set a fake token) for adapter steps to prevent them from posting.
- `post-review: "false"` lets you dry-run and only archive `outputs/report.*`.
- Tune `max-comments` to control noise; severity order: blocker > major > minor > nit.
- If you want to use non-OpenAI providers, set `openai-base-url` and ensure the provider follows the OpenAI-compatible chat completions API.
- All upstream calls (Codex/OpenAI, Gemini, Greptile, Cursor) use the caller’s secrets/credits; prjury does not proxy or host anything.
- The unified output includes tool labels per finding and a Disagreements section when tools diverge on severity at the same location.

Development status
------------------
This is a starter skeleton. Extend by:
- Adding more adapters (write their JSON into `outputs/`).
- Improving dedupe heuristics (currently based on file/line/message token).
- Enriching the summary (include risk scoring, asked questions, etc.).
