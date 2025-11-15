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
Runs on `pull_request_target` so forks are safe, caches each adapter's CLI, and executes adapters in parallel jobs. Enable adapters by setting repo variables (`PRJURY_RUN_CODEX`, etc.) and storing the matching secrets (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `GREPTILE_API_KEY`, `CURSOR_API_KEY`).
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
  codex:
    if: ${{ vars.PRJURY_RUN_CODEX == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
          repository: ${{ github.event.pull_request.head.repo.full_name }}

      - name: Cache Codex CLI state
        uses: actions/cache@v4
        with:
          path: |
            ~/.npm
            ~/.codex
          key: ${{ runner.os }}-codex-cli-v1

      - run: mkdir -p "$PRJURY_INPUT_DIR"

      - name: Codex adapter
        uses: openai/codex-action@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          prompt: |
            You are a PR reviewer. Emit ONLY JSON array:
            [{"tool":"codex","severity":"blocker|major|minor|nit","file":"path","line":0,"message":"...", "suggestion":"..."}]
            Review the diff in this repo for issues.
          output-schema: |
            {
              "type": "object",
              "properties": {
                "findings": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": ["tool", "severity", "file", "line", "message"],
                    "properties": {
                      "tool": { "const": "codex" },
                      "severity": { "enum": ["blocker", "major", "minor", "nit"] },
                      "file": { "type": "string" },
                      "line": { "type": "integer" },
                      "message": { "type": "string" },
                      "suggestion": { "type": "string" }
                    },
                    "additionalProperties": false
                  },
                  "additionalProperties": false
                }
              },
              "required": ["findings"],
              "additionalProperties": false
            }
          output-file: ${{ env.PRJURY_INPUT_DIR }}/codex.raw.json
          sandbox: read-only

      - run: jq '.findings // []' "${PRJURY_INPUT_DIR}/codex.raw.json" > "${PRJURY_INPUT_DIR}/codex.json"

      - uses: actions/upload-artifact@v4
        with:
          name: codex-json
          path: ${{ env.PRJURY_INPUT_DIR }}/codex.json

  gemini:
    if: ${{ vars.PRJURY_RUN_GEMINI == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
          repository: ${{ github.event.pull_request.head.repo.full_name }}

      - name: Cache Gemini CLI state
        uses: actions/cache@v4
        with:
          path: |
            ~/.npm
            .gemini
          key: ${{ runner.os }}-gemini-cli-v1

      - run: mkdir -p "$PRJURY_INPUT_DIR"

      - name: Gemini adapter
        id: gemini
        uses: google-github-actions/run-gemini-cli@v0
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
          gemini_model: gemini-2.5-flash
          prompt: |
            Emit ONLY JSON array:
            [{"tool":"gemini","severity":"blocker|major|minor|nit","file":"path","line":0,"message":"...", "suggestion":"..."}]
            Review changed files.
          upload_artifacts: "false"

      - run: |
          cat <<'EOF' > "${PRJURY_INPUT_DIR}/gemini.raw.txt"
${{ steps.gemini.outputs.summary }}
EOF
          if [ ! -s "${PRJURY_INPUT_DIR}/gemini.raw.txt" ]; then
            echo "[]" > "${PRJURY_INPUT_DIR}/gemini.json"
          else
            jq '.' "${PRJURY_INPUT_DIR}/gemini.raw.txt" > "${PRJURY_INPUT_DIR}/gemini.json" || echo "[]" > "${PRJURY_INPUT_DIR}/gemini.json"
          fi

      - uses: actions/upload-artifact@v4
        with:
          name: gemini-json
          path: ${{ env.PRJURY_INPUT_DIR }}/gemini.json

  greptile:
    if: ${{ vars.PRJURY_RUN_GREPTILE == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
          repository: ${{ github.event.pull_request.head.repo.full_name }}

      - name: Cache greptile CLI
        uses: actions/cache@v4
        with:
          path: ~/.cache/greptile
          key: ${{ runner.os }}-greptile-cli-v1

      - run: mkdir -p "$PRJURY_INPUT_DIR"

      - name: Install greptile CLI
        run: pip install --user greptile-cli

      - name: Greptile adapter
        env:
          GREPTILE_API_KEY: ${{ secrets.GREPTILE_API_KEY }}
          PATH: ${{ env.PATH }}:~/.local/bin
        run: |
          greptile pr review \
            --repo "$GITHUB_REPOSITORY" \
            --pr "${{ github.event.pull_request.number }}" \
            --format json > "${PRJURY_INPUT_DIR}/greptile.raw.json" || true
          jq '[.findings[] | {
                tool: "greptile",
                severity: (.severity // "minor"),
                file: (.file // .path // ""),
                line: (.line // .start_line // null),
                message: (.message // .description // ""),
                suggestion: (.suggestion // .recommendation // null)
              }]' "${PRJURY_INPUT_DIR}/greptile.raw.json" > "${PRJURY_INPUT_DIR}/greptile.json" || echo "[]" > "${PRJURY_INPUT_DIR}/greptile.json"

      - uses: actions/upload-artifact@v4
        with:
          name: greptile-json
          path: ${{ env.PRJURY_INPUT_DIR }}/greptile.json

  cursor:
    if: ${{ vars.PRJURY_RUN_CURSOR == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
          repository: ${{ github.event.pull_request.head.repo.full_name }}

      - name: Cache cursor CLI
        uses: actions/cache@v4
        with:
          path: ~/.cache/cursor
          key: ${{ runner.os }}-cursor-cli-v1

      - run: mkdir -p "$PRJURY_INPUT_DIR"

      - name: Install cursor CLI
        run: npm install -g cursor-cli || true

      - name: Cursor adapter
        env:
          CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
        run: |
          if command -v cursor >/dev/null 2>&1; then
            cursor review \
              --diff "origin/${{ github.event.pull_request.base.ref }}...HEAD" \
              --format json \
              --output "${PRJURY_INPUT_DIR}/cursor.json" || true
          else
            echo "cursor CLI not installed; skipping." && echo "[]" > "${PRJURY_INPUT_DIR}/cursor.json"
          fi

      - uses: actions/upload-artifact@v4
        with:
          name: cursor-json
          path: ${{ env.PRJURY_INPUT_DIR }}/cursor.json

  review:
    needs: [codex, gemini, greptile, cursor]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
          repository: ${{ github.event.pull_request.head.repo.full_name }}

      - run: mkdir -p "$PRJURY_INPUT_DIR"

      - name: Download Codex output
        if: ${{ vars.PRJURY_RUN_CODEX == 'true' }}
        uses: actions/download-artifact@v4
        with:
          name: codex-json
          path: ${{ env.PRJURY_INPUT_DIR }}
          if-no-files-found: ignore

      - name: Download Gemini output
        if: ${{ vars.PRJURY_RUN_GEMINI == 'true' }}
        uses: actions/download-artifact@v4
        with:
          name: gemini-json
          path: ${{ env.PRJURY_INPUT_DIR }}
          if-no-files-found: ignore

      - name: Download Greptile output
        if: ${{ vars.PRJURY_RUN_GREPTILE == 'true' }}
        uses: actions/download-artifact@v4
        with:
          name: greptile-json
          path: ${{ env.PRJURY_INPUT_DIR }}
          if-no-files-found: ignore

      - name: Download Cursor output
        if: ${{ vars.PRJURY_RUN_CURSOR == 'true' }}
        uses: actions/download-artifact@v4
        with:
          name: cursor-json
          path: ${{ env.PRJURY_INPUT_DIR }}
          if-no-files-found: ignore

      - name: prjury (aggregate + review)
        uses: ./
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          input-dir: ${{ env.PRJURY_INPUT_DIR }}
          max-comments: "15"
          post-review: "true"
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```
When published, replace `uses: ./` with `uses: prjury/prjury-action@v1`.

Testing
-------
- Install deps once: `npm install`.
- Run `npm test` to execute the Node test suite (see `tests/aggregate.test.mjs`).
- CI (`.github/workflows/ci.yml`) runs the same tests on pushes and pull requests targeting `main`.

Notes and tips
--------------
- Keep adapters short and `continue-on-error: true` so one failure doesn’t block the review.
- Omit `GITHUB_TOKEN` (or set a fake token) for adapter steps to prevent them from posting.
- `post-review: "false"` lets you dry-run and only archive `outputs/report.*`.
- Tune `max-comments` to control noise; severity order: blocker > major > minor > nit.
- If you want to use non-OpenAI providers, set `openai-base-url` and ensure the provider follows the OpenAI-compatible chat completions API.
- All upstream calls (Codex/OpenAI, Gemini, Greptile, Cursor) use the caller’s secrets/credits; prjury does not proxy or host anything.
- The unified output includes tool labels per finding and a Disagreements section when tools diverge on severity at the same location.
- Gemini defaults to `gemini-2.5-flash` in the snippets above—override `gemini_model` if you need something else.
- Adapters hand off results via artifacts so they can run in parallel jobs; caches (`actions/cache@v4`) keep their CLIs warm between runs.

Development status
------------------
This is a starter skeleton. Extend by:
- Adding more adapters (write their JSON into `outputs/`).
- Improving dedupe heuristics (currently based on file/line/message token).
- Enriching the summary (include risk scoring, asked questions, etc.).
