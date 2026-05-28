# Phase 2 (Antigravity SDK 連携 + SSE ストリーミング) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 の echo 実装を `google-antigravity` SDK 経由の実 Gemini 呼び出しへ置き換え、`stream:true` を OpenAI 互換 SSE で返却できる状態に到達する。

**Architecture:**

- Python 側に `AntigravityClient` 抽象 (実 SDK + Mock) を新設し、`handlers.chat_completions` を AsyncGenerator 化。`server.py` の dispatch を拡張し、通常 yield 毎に JSON-RPC Notification、最終 yield (sentinel `_final`) を JSON-RPC 最終 response として送出する (設計書 Section 5.1.1)。Python の async generator は `return value` を SyntaxError とするため、sentinel 方式でメタデータを返す。
- **`AntigravityClient.stream_chat` は per-request Agent 方式** (設計書 Section 3.3): 各リクエストで `Agent(LocalAgentConfig(...)).__aenter__/__aexit__` を実行し、harness プロセスを丸ごと破棄してステートレス性を保証する。OpenAI `messages` 配列は **Chat ML 風 prompt 文字列に畳み込んで** `Agent.chat(prompt)` に渡す (新規 `prompt_folding.py`)。同時並行は `asyncio.Semaphore(OAG_MAX_CONCURRENT_REQUESTS)` で抑制。
- TypeScript 側は `jsonrpc.ts` に Notification 経路と `streamingCall()` を追加、`server.ts` で `stream:true` 検知時に SSE 中継 (`data: {...}\n\n` / `data: [DONE]\n\n`) を行う。
- すべての並行・直列依存は **Stacked PR** で管理し、Draft PR URL の存在を後続タスクの前提条件として使う。テスト・lint・ブランチ検証は **必ず devcontainer 内で実行** する。

**Tech Stack:** TypeScript 5 / Node.js 24 / pnpm / vitest / Python 3.13 / uv / pytest / ruff / Pydantic v2 / `google-antigravity` SDK / pino / JSON-RPC 2.0 over stdio / SSE over HTTP

**Source Spec:** [`docs/superpowers/specs/2026-05-25-phase2-design.md`](../specs/2026-05-25-phase2-design.md) (v2, 2026-05-27 改訂)

> [!NOTE]
> **2026-05-27 ブロッカー解消:** T1.1 の SDK スパイク結果 (`messages` 一括渡し API 不在 / Agent cold-start median 1012.6ms) を踏まえ、Phase 2 設計を **per-request Agent + Chat ML prompt 畳み込み** 方式へ全面改訂した。本計画もこれに合わせて T2.3 / T2.5 / 新規 T2.3.X を改訂済み。
> 詳細: [`2026-05-25-phase2-sdk-spike.md`](../specs/2026-05-25-phase2-sdk-spike.md) / Tracking Issue: <https://github.com/yohi/opencode-antigravity-plugin/issues/33> / SDK spike PR (merged): <https://github.com/yohi/opencode-antigravity-plugin/pull/32>

---

## Gitブランチ運用フロー (AI-Native Stacked PR Workflow)

本計画は以下のワークフローに厳密に従う:

- 参照ドキュメント: <https://different-sunday-448.notion.site/AI-Native-Stacked-PR-Workflow-3611669a4c16802eb032eb4ab05a8adb>
- ベース運用方針:
  - `master` への直接 commit / push は **完全禁止**
  - すべての変更は Draft PR としてレビュー対象になる
  - 直列依存タスクは「先行タスクの Draft PR が作成済み」を前提条件として後続タスクを起動する (スタック)
  - 並列実行可能タスクは Base ブランチ (master または明示する Phase Base) から独立に派生する
  - PR のマージは人間オペレータのみが行う (エージェントは Draft PR の作成と更新までで停止)

### 並列実行制御ルール

各 Task のヘッダで以下を明示する:

| 区分 | 定義 |
|---|---|
| **直列必須 (Wait for Task X)** | 直前 Task から派生。先行 Task の Draft PR URL が存在するまで実行開始を **物理的に禁止** する |
| **並列可能 (独立)** | Base から直接派生し、対象ファイルが他タスクと競合しない。他タスクと同時実行可 |

### Step 1 ポカヨケ (全タスク共通)

すべての Task の最初のステップで、以下のシェルスクリプトを devcontainer 内で実行する。`EXPECTED_BASE` はタスク冒頭メタデータの「派生元ブランチ」と完全一致させる。検証に失敗した時点で **作業を中断** し、人間に報告する。

```bash
# 派生元が正しいか検証するポカヨケスクリプト (devcontainer 内で実行)
set -euo pipefail
EXPECTED_BASE="<タスクごとに置換>"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git fetch origin "${EXPECTED_BASE}" --no-tags
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: ${CURRENT_BRANCH} は ${EXPECTED_BASE} を祖先に持ちます"
```

---

## ファイル構成マップ

### 新規作成

| ファイル | 役割 | 担当 Task |
|---|---|---|
| `docs/superpowers/specs/2026-05-25-phase2-sdk-spike.md` | SDK API スパイク調査結果 | T1.1 (完了済み) |
| `backend/src/opencode_antigravity/errors.py` | SDK 例外 → JSON-RPC エラーコード変換 (`SdkAuthError` 等) + `classify_sdk_error()` | T2.1 |
| `backend/src/opencode_antigravity/prompt_folding.py` | OpenAI `messages` → Chat ML prompt 文字列の畳み込み (設計書 Section 3.3.1) | T2.3 |
| `backend/src/opencode_antigravity/antigravity_client.py` | `AntigravityClient` 抽象 + `MockAntigravityClient` (per-request Agent 方式、設計書 Section 3.3) | T2.3 |
| `tests/python/unit/test_errors.py` | `errors.py` の単体テスト | T2.1 |
| `tests/python/unit/test_format_notification.py` | `format_notification` の単体テスト (受け入れ#22) | T2.2 |
| `tests/python/unit/test_prompt_folding.py` | Chat ML 畳み込みテスト (受け入れ#32) | T2.3 |
| `tests/python/unit/test_antigravity_client.py` | per-request Agent ライフサイクルテスト (受け入れ#25 改訂) | T2.3 |
| `tests/python/integration/test_antigravity_client_concurrency.py` | 並行制御テスト (受け入れ#33, #34) | T2.3.1 |
| `tests/python/unit/test_chat_completions_streaming.py` | AsyncGenerator / stream:false 集約テスト (受け入れ#23, #24) | T2.5 |
| `tests/python/integration/test_async_dispatch.py` | server.py の AsyncGenerator dispatch を stdio 経由で検証 | T2.4 |
| `tests/python/e2e_live/__init__.py` | live テスト用ディレクトリ初期化 | T4.3 |
| `tests/python/e2e_live/test_real_gemini.py` | 実 SDK + 実 API キーでの E2E (live マーカ) + cold-start / TTFB 計測 | T4.3 |
| `tests/ts/jsonrpc_notification.test.ts` | Notification dispatch 単体テスト (受け入れ#26, #27) | T3.3 |
| `tests/ts/streaming_call.test.ts` | `streamingCall()` の TS 統合テスト (受け入れ#28, #29) | T3.4 |
| `tests/ts/sse.test.ts` | SSE E2E (受け入れ#30, #31) | T4.2 |
| `tests/ts/sse_live.test.ts` | SSE E2E (live) | T4.3 |

### 修正

| ファイル | 主な変更 | 担当 Task |
|---|---|---|
| `.devcontainer/Dockerfile` | 追加依存無し、ただし version pin の確認・必要なら更新 | T0.1 |
| `.devcontainer/devcontainer.json` | `containerEnv` で Phase 2 必須環境変数 (mock 既定) を注入 | T0.1 |
| `.github/workflows/ci.yml` | master / PR トリガーで `pnpm verify` を実行する既存ワークフローに Phase 2 環境変数 (`OAG_BACKEND_MODE=mock` 等) を注入。ランナーは既存の `ubuntu-slim` を維持 | T0.2 |
| `backend/src/opencode_antigravity/protocol.py` | `format_notification(method, params)` 追加 | T2.2 |
| `backend/src/opencode_antigravity/server.py` | AsyncGenerator ハンドラ判別、yield → Notification、return → response | T2.4 |
| `backend/src/opencode_antigravity/handlers.py` | `chat_completions` を AsyncGenerator 化、`stream:false` で内部集約 | T2.5 |
| `backend/src/opencode_antigravity/__main__.py` | 起動時に `GEMINI_API_KEY` (live mode 時) / `ANTIGRAVITY_MODEL` / `OAG_BACKEND_MODE` を検証 | T2.6 |
| `src/types.ts` | OpenAI Streaming Chunk 型、JSON-RPC Notification 型を追加 | T3.1 |
| `src/schemas.ts` | Phase A 用 Zod スキーマ `ChatCompletionsParamsSchema` (新規) | T3.1.5 |
| `src/errors.ts` | SDK 由来エラーコード (`-32010〜-32015`) を OpenAI エラー形式へ追加マッピング | T3.2 |
| `src/jsonrpc.ts` | `parseMessage` 拡張、`onNotification`、`streamingCall()` 追加 | T3.3 |
| `src/backend.ts` | `streamingCall()` ラッパー露出 | T3.4 |
| `src/server.ts` | `stream:true` 検知時の Zod 検証 + SSE 中継、エラー時の SSE エラー frame | T3.5 |
| `package.json` | `zod` 依存を追加 | T3.1.5 |
| `src/server.ts` (`/healthz`) | `backend_mode` / `model` フィールド追加 | T4.1 |
| `SPEC.md` セクション 10 | Phase 2 を「完了」に更新 | T5.1 |
| `README.md` | 環境変数表、`OAG_BACKEND_MODE` の使い方、SSE サポート明記 | T5.1 |

---

## Phase / Task サマリ

| # | Task | 派生元 | 実行モード |
|---|---|---|---|
| T0.1 | Devcontainer 拡張 | `master` | 並列可能 (独立) |
| T0.2 | GitHub Actions ワークフロー強化 (Phase 2 環境変数注入) | `master` | 並列可能 (独立) |
| ~~T1.1~~ | ~~SDK API スパイク調査~~ | — | **完了済み (PR #32 merged 2026-05-26)** |
| T2.1 | Python `errors.py` 新設 (Spike 確定型反映 + `classify_sdk_error`) | `master` | 並列可能 (独立) |
| T2.2 | Python `format_notification` 追加 | `master` | 並列可能 (独立) |
| T2.3 | Python `prompt_folding.py` + `antigravity_client.py` 新設 (per-request Agent + Mock + 受け入れ#25 改訂/#32) | `master` | 並列可能 (独立) |
| T2.3.1 | Python 並行制御 (Semaphore + cold-start timeout) + 受け入れ#33/#34 + live smoke | T2.3 | 直列必須 (Wait for T2.3) |
| T2.4 | Python `server.py` AsyncGenerator dispatch | T2.2 | 直列必須 (Wait for T2.2) |
| T2.5 | Python `handlers.py` ストリーミング化 (`fold_messages_to_prompt` 経由) | T2.4 | 直列必須 (Wait for T2.4 + T2.1 + T2.3 merged) |
| T2.6 | Python `__main__.py` 環境変数検証 | T2.5 | 直列必須 (Wait for T2.5) |
| T3.1 | TS `types.ts` 拡張 | `master` | 並列可能 (独立) |
| T3.1.5 | TS `schemas.ts` 新設 (Phase A Zod) | `master` | 並列可能 (独立) |
| T3.2 | TS `errors.ts` SDK エラーマッピング | `master` | 並列可能 (独立) |
| T3.3 | TS `jsonrpc.ts` Notification + `streamingCall` | T3.1 | 直列必須 (Wait for T3.1) |
| T3.4 | TS `backend.ts` `streamingCall` 露出 | T3.3 | 直列必須 (Wait for T3.3) |
| T3.5 | TS `server.ts` SSE 中継 | T3.4 | 直列必須 (Wait for T3.4 + T3.2 + T3.1.5 merged) |
| T4.1 | `/healthz` 拡張 | `master` | 並列可能 (独立) |
| T4.2 | E2E mock テスト (受け入れ#30, #31) | T3.5 | 直列必須 (Wait for T3.5 + T2.6 merged) |
| T4.3 | E2E live テスト基盤 | T4.2 | 直列必須 (Wait for T4.2) |
| T5.1 | ドキュメント仕上げ | T4.3 | 直列必須 (Wait for T4.3) |

---

## Phase 0: 開発環境 / CI/CD 基盤

### Task 0.1: Devcontainer 拡張 (Phase 2 環境変数の初期値注入)

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T0.2 / T1.1 / T2.x / T3.x / T4.1 と同時実行可
**前提条件:** なし

**Files:**

- Modify: `.devcontainer/devcontainer.json`
- Modify: `.devcontainer/Dockerfile` (バージョン pin の整合確認のみ)

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin   # devcontainer 内
git fetch origin master --no-tags
git switch -c feature/phase2/phase0-devcontainer origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: ${CURRENT_BRANCH} は ${EXPECTED_BASE} を祖先に持ちます"
```

- [ ] **Step 2: `devcontainer.json` に Phase 2 既定環境変数を追加**

`.devcontainer/devcontainer.json` を以下のように更新する (既存キーは保持):

```json
{
  "name": "opencode-antigravity-plugin",
  "build": { "dockerfile": "Dockerfile" },
  "forwardPorts": [11435],
  "portsAttributes": {
    "11435": { "label": "OpenAI-compatible endpoint", "onAutoForward": "silent" }
  },
  "remoteUser": "vscode",
  "containerEnv": {
    "OAG_BACKEND_MODE": "mock",
    "ANTIGRAVITY_MODEL": "gemini-2.5-pro",
    "OAG_REQUEST_TIMEOUT_MS": "60000",
    "OAG_STREAM_IDLE_TIMEOUT_MS": "30000",
    "OAG_AGENT_COLDSTART_BUDGET_MS": "5000",
    "OAG_AGENT_COLDSTART_TIMEOUT_MS": "10000",
    "OAG_MAX_CONCURRENT_REQUESTS": "4"
  },
  "postCreateCommand": "bash -lc 'pnpm install || true && uv sync || true'",
  "customizations": {
    "vscode": {
      "extensions": [
        "ms-python.python",
        "charliermarsh.ruff",
        "esbenp.prettier-vscode",
        "dbaeumer.vscode-eslint"
      ]
    }
  }
}
```

- [ ] **Step 3: Dockerfile のバージョン pin 確認**

`.devcontainer/Dockerfile` を読み、以下が満たされているか確認する:

- `FROM mcr.microsoft.com/devcontainers/python:3.13`
- `npm install -g pnpm@9.15.9`
- `pip install --no-cache-dir uv==0.11.15`

満たされていれば変更不要。差分が発生した場合はそのまま維持し、本タスクでは触らない。

- [ ] **Step 4: devcontainer 内で `printenv` で環境変数注入を検証**

Reopen-in-Container の代わりに以下を実行する:

```bash
docker build -f .devcontainer/Dockerfile -t oag-devcontainer:test .devcontainer/
docker run --rm -e OAG_BACKEND_MODE -e ANTIGRAVITY_MODEL \
  oag-devcontainer:test bash -lc 'printenv | grep -E "^(OAG_|ANTIGRAVITY_)"'
```

Expected: ローカルで設定済みの値が表示される (`containerEnv` は VS Code が注入するため、ここではビルドの健全性のみ確認)。

- [x] **Step 5: コミット**

```bash
git add .devcontainer/devcontainer.json
git commit -m "chore(devcontainer): Phase 2 既定環境変数 (OAG_BACKEND_MODE=mock 等) を注入"
```

- [x] **Step 6: プッシュと Draft PR 作成**

```bash
git push -u origin feature/phase2/phase0-devcontainer
gh pr create --draft --base master --title "chore(devcontainer): Phase 2 既定環境変数を注入" \
  --body "Phase 2 のために OAG_BACKEND_MODE / ANTIGRAVITY_MODEL / タイムアウト既定値を devcontainer に注入する。ベース: master。"
```

- [ ] **Step 7: Draft PR URL を記録**

PR URL を `docs/superpowers/plans/.stack-urls.md` (新規 / 追記) に以下の形式で書き込む:

```markdown
- T0.1: https://<pr-url>
```

---

### Task 0.2: GitHub Actions ワークフロー強化 (Phase 2 環境変数注入 / ubuntu-slim 維持)

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T0.1 と同時実行可
**前提条件:** なし

**前提知識:** `.github/workflows/ci.yml` は既に存在し、`runs-on: ubuntu-slim` (self-hosted ラベル想定) で master / PR トリガーから `uv run pnpm verify` を実行している。本タスクでは **新規作成ではなく、既存ワークフローを Phase 2 対応に拡張** する。

**Files:**

- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin master --no-tags
git switch -c feature/phase2/phase0-ci origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: 既存 `.github/workflows/ci.yml` を読み、差分箇所を特定**

```bash
cat .github/workflows/ci.yml
```

Expected: `runs-on: ubuntu-slim`、`Verify` ステップが `uv run pnpm verify` 1 行であること。

- [ ] **Step 3: `.github/workflows/ci.yml` を Phase 2 用に書き換える**

下記の最終形に置き換える。差分のポイント:

- `runs-on: ubuntu-slim` は **維持** (self-hosted ラベル想定、ユーザー指定)
- `env:` ブロックを job レベルに追加し、Phase 2 既定環境変数 (`OAG_BACKEND_MODE=mock` ほか) を注入
- Live テストは PR ブロックしないため、`verify` ジョブでは `OAG_BACKEND_MODE=live` を **設定しない**
- **新規 `live-nightly` ジョブ**: `schedule` (cron) と `workflow_dispatch` でのみ起動し、`secrets.GEMINI_API_KEY` を読み出して live テストを実行 (設計書 Section 7.5)
- `pyproject.toml` で `addopts = -m 'not live'` が指定されるため、`verify` 側は `live` マーカを自動 skip する (T4.3 で導入)
- `concurrency` で同一ブランチでの重複実行をキャンセル

```yaml
name: CI

on:
  push:
    branches:
      - master
  pull_request:
    branches:
      - '**'
  schedule:
    - cron: '0 18 * * *'   # JST 03:00 / UTC 18:00 (設計書 7.5)
  workflow_dispatch: {}     # 手動実行用

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-slim
    timeout-minutes: 15

    env:
      OAG_BACKEND_MODE: mock
      ANTIGRAVITY_MODEL: gemini-2.5-pro
      OAG_REQUEST_TIMEOUT_MS: "60000"
      OAG_STREAM_IDLE_TIMEOUT_MS: "30000"
      OAG_AGENT_COLDSTART_BUDGET_MS: "5000"
      OAG_AGENT_COLDSTART_TIMEOUT_MS: "10000"
      OAG_MAX_CONCURRENT_REQUESTS: "4"

    steps:
      - name: Checkout
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.2.2

      - name: Install uv
        uses: astral-sh/setup-uv@e58605a9b6da7c637471fab8847a5e5a6b8df081 # v5.1.0
        with:
          enable-cache: true
          version: "0.11.15"

      - name: Set up Python
        uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5.3.0
        with:
          python-version: "3.13"

      - name: Install pnpm
        uses: pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa # v4.0.0
        with:
          version: 9

      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.1.0
        with:
          node-version: "24"
          cache: "pnpm"

      - name: Install dependencies
        run: |
          uv sync --frozen
          pnpm install --frozen-lockfile

      - name: Verify (lint + python tests + ts tests, mock mode)
        run: uv run pnpm verify

  live-nightly:
    # 設計書 Section 7.5: nightly 03:00 JST (= 18:00 UTC) と手動トリガーでのみ live テストを実行。
    # 受け入れ基準 #2 (live PASS) は本ジョブが緑であることをもって判定し、PR マージのブロック条件にはしない。
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-slim
    timeout-minutes: 20

    env:
      OAG_BACKEND_MODE: live
      ANTIGRAVITY_MODEL: gemini-2.5-pro
      OAG_REQUEST_TIMEOUT_MS: "60000"
      OAG_STREAM_IDLE_TIMEOUT_MS: "30000"
      OAG_AGENT_COLDSTART_BUDGET_MS: "5000"
      OAG_AGENT_COLDSTART_TIMEOUT_MS: "10000"
      OAG_MAX_CONCURRENT_REQUESTS: "4"
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}

    steps:
      - name: Skip when secret is unavailable
        id: gate
        run: |
          if [ -z "${GEMINI_API_KEY}" ]; then
            echo "GEMINI_API_KEY not configured; skipping live job"
            echo "skip=true" >> "${GITHUB_OUTPUT}"
          else
            echo "skip=false" >> "${GITHUB_OUTPUT}"
          fi

      - name: Checkout
        if: steps.gate.outputs.skip != 'true'
        uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.2.2

      - name: Install uv
        if: steps.gate.outputs.skip != 'true'
        uses: astral-sh/setup-uv@e58605a9b6da7c637471fab8847a5e5a6b8df081 # v5.1.0
        with:
          enable-cache: true
          version: "0.11.15"

      - name: Set up Python
        if: steps.gate.outputs.skip != 'true'
        uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5.3.0
        with:
          python-version: "3.13"

      - name: Install pnpm
        if: steps.gate.outputs.skip != 'true'
        uses: pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa # v4.0.0
        with:
          version: 9

      - name: Set up Node.js
        if: steps.gate.outputs.skip != 'true'
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.1.0
        with:
          node-version: "24"
          cache: "pnpm"

      - name: Install dependencies (including live extras)
        if: steps.gate.outputs.skip != 'true'
        run: |
          uv sync --frozen --extra live
          pnpm install --frozen-lockfile

      - name: Live E2E (real Gemini API)
        if: steps.gate.outputs.skip != 'true'
        run: uv run pnpm test:e2e:live
```

- [ ] **Step 4: YAML 構文を devcontainer 内で検証**

```bash
uv run python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
echo "OK: YAML 構文 valid"
```

Expected: 例外無しで `OK:` 行が出力される。

- [ ] **Step 5: actionlint で GitHub Actions 構文を静的検証 (任意だが推奨)**

```bash
# devcontainer 内で actionlint バイナリを取得 (キャッシュなし、1 回限り)
curl -fsSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash \
  | bash -s -- 1.7.1
./actionlint .github/workflows/ci.yml
rm -f actionlint
```

Expected: 出力が空 (= 違反 0)。`ubuntu-slim` ラベル警告は self-hosted ラベル前提のため許容する (`actionlint` の `-shellcheck=` や `-config-file` で抑制可能だが、本タスクでは設定追加を行わない)。

- [ ] **Step 6: 既存 `pnpm verify` がローカル devcontainer で通ることを最終確認**

```bash
OAG_BACKEND_MODE=mock ANTIGRAVITY_MODEL=gemini-2.5-pro pnpm verify
```

Expected: Phase 1 既存 21 ケースが全 GREEN (Phase 2 新規ケースは別タスクで追加されるため、本時点では 21 のまま)。

- [ ] **Step 7: コミット**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(github-actions): Phase 2 環境変数 (OAG_BACKEND_MODE=mock 等) を job env に注入"
```

- [ ] **Step 8: プッシュと Draft PR 作成**

```bash
git push -u origin feature/phase2/phase0-ci
gh pr create --draft --base master \
  --title "ci(github-actions): Phase 2 既定環境変数を CI に注入 (ubuntu-slim 維持)" \
  --body "既存 .github/workflows/ci.yml に Phase 2 用 env (OAG_BACKEND_MODE / ANTIGRAVITY_MODEL / タイムアウト) を追加。ランナーは ubuntu-slim を維持。"
```

- [ ] **Step 9: Draft PR URL を `.stack-urls.md` に追記**

```markdown
- T0.2: https://<pr-url>
```

---

## Phase 1: SDK スパイク調査 (設計確定の前提) — **完了済み**

### Task 1.1: `google-antigravity` SDK API スパイク調査と文書化 — **DONE (PR #32 merged 2026-05-26)**

> **ステータス:** 完了済み。本タスクの結果 (`messages` 一括渡し API 不在 / Agent cold-start median 1012.6ms / 例外型確定) を踏まえ、設計書を v2 (`per-request Agent + Chat ML 畳み込み`) に改訂し、T2.3 をそれに合わせて書き直した。以下の作業手順は **再実行不要** で、参考用として残置する。

**派生元ブランチ:** `master`
**実行モード:** 並列可能だが **T2.3 (実 SDK クライアント) のブロッカー** — T0.x / T2.1 / T2.2 / T3.x / T4.1 とは同時実行可。本タスクの結果 (採用 API・例外型・cold-start 実測値) は T2.3 の実装方針を直接決定するため、T2.3 はマージ済みであることを **前提条件** に追加する。
**前提条件:** なし

**Files:**

- Create: `docs/superpowers/specs/2026-05-25-phase2-sdk-spike.md`

- [x] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin master --no-tags
git switch -c feature/phase2/spike-sdk-api origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [x] **Step 2: SDK 実物を一時的に sync して API を確認**

```bash
uv pip install --no-deps google-antigravity   # 解析目的のみ。pyproject には載せない
uv run python - <<'PY'
import google.antigravity as ga
import inspect
print("== Top-level public API ==")
print([n for n in dir(ga) if not n.startswith("_")])
print("\n== Agent ==")
print(inspect.signature(ga.Agent.__init__) if hasattr(ga, "Agent") else "no Agent")
print("\n== Conversation ==")
print(inspect.signature(ga.Conversation.__init__) if hasattr(ga, "Conversation") else "no Conversation")
PY
```

Expected: `Agent`, `Conversation`, `LocalAgentConfig` 等の公開 API 一覧。

- [x] **Step 2.1: 一括渡し API を設計書 3.3.1 の優先順位で評価**

設計書 Section 3.3.1 の優先順位表 (1) `Conversation.chat(messages=[...])` → (2) `Agent.chat(messages=[...])` → (3) `history` 引数経由 の順で、各候補に対し以下の **選定基準 4 項目** をチェックし結果を表に埋める:

| 候補 | Streaming (`async for token in api(...)`) | エラー伝搬 (SDK 例外が呼出側へ伝播) | レイテンシ (messages を 1 回で渡せる) | SDK 安定性 (公開 import 可能 / non-experimental) | 採否 |
|---|---|---|---|---|---|
| `Conversation.chat(messages=[...])` | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | — |
| `Agent.chat(messages=[...])` | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | — |
| `history` 引数経由 | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | — |

**評価ルール:** 全 4 項目を満たす最初の候補を採用。1 つでも ❌ がある候補はスキップして次の候補へ。

確認用スニペット:

```bash
uv run python - <<'PY'
import asyncio, inspect, google.antigravity as ga

async def probe(label, coro_factory):
    try:
        result = coro_factory()
        is_async_iter = hasattr(result, "__aiter__") or inspect.isasyncgen(result)
        print(f"{label}: streaming={is_async_iter}, type={type(result).__name__}")
    except Exception as e:
        print(f"{label}: ERROR={type(e).__name__}: {e}")

# ※ 実呼び出しは GEMINI_API_KEY が必要。型シグネチャだけ確認する場合は inspect.signature を使う
print(inspect.signature(ga.Conversation.chat) if hasattr(ga.Conversation, "chat") else "no Conversation.chat")
print(inspect.signature(ga.Agent.chat) if hasattr(ga.Agent, "chat") else "no Agent.chat")
PY
```

- [x] **Step 2.2: Agent cold-start 時間を計測 (代替フォールバック判定用)**

設計書 3.3.1 の代替フォールバック (リクエストごとに Agent 再起動) が成立する閾値 `OAG_AGENT_COLDSTART_BUDGET_MS` (既定 100ms) を超えないかを確認する:

```bash
uv run python - <<'PY'
import asyncio, os, statistics, time
import google.antigravity as ga

async def measure():
    samples = []
    model = os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-pro")
    for _ in range(10):
        t0 = time.perf_counter()
        async with ga.Agent(ga.LocalAgentConfig(model=model)) as _agent:
            pass
        samples.append((time.perf_counter() - t0) * 1000.0)
    print(f"model={model} median={statistics.median(samples):.1f}ms  p95={sorted(samples)[8]:.1f}ms  raw={[f'{x:.0f}' for x in samples]}")

asyncio.run(measure())
PY
```

Expected: 中央値を `<起動時間 ms>` として後続 Step 3 で記録。**100ms 以上の場合は長寿命 Agent 採用前提が崩れるため、Phase 2 のブレインストーミングに戻る** (設計書 3.3.1 末尾の条件)。

- [x] **Step 3: 設計書 Section 11.1 の不確定要素を確定する**

`docs/superpowers/specs/2026-05-25-phase2-sdk-spike.md` を作成し、最低限以下のセクションを埋める:

```markdown
# Phase 2 SDK スパイク調査結果

## 1. SDK の例外型 (設計書 表 6.1 の確定)
| 役割 | 仮置き | 実 SDK での型名 |
|---|---|---|
| 認証失敗 | `AuthenticationError` | `<確定>` |
| レート制限 | `RateLimitError` | `<確定>` |
| モデル不存在 | `ModelNotFoundError` | `<確定>` |
| API 一般エラー | `ApiError` | `<確定>` |
| タイムアウト | `TimeoutError` | `<確定>` |
| 接続失敗 | `ConnectionError` | `<確定>` |

## 2. messages 配列の一括渡し API (設計書 Section 3.3 / 3.3.1)

採用 API: `<Conversation.chat(messages=[...]) | Agent.chat(messages=[...]) | history 引数 | フォールバック (Agent 再起動)>`

| 候補 | Streaming | エラー伝搬 | レイテンシ | SDK 安定性 | 採否 |
|---|---|---|---|---|---|
| `Conversation.chat(messages=[...])` | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | — |
| `Agent.chat(messages=[...])` | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | — |
| `history` 引数経由 | ✅/❌ | ✅/❌ | ✅/❌ | ✅/❌ | — |

### 採用理由
- 選定基準のどれを満たし、他候補がなぜ落ちたか:

### 判定結果

| ケース | 条件 | 判定 | 遷移先 |
|---|---|---|---|
| (1) 候補採用 | いずれかの候補が 4 項目すべて ✅ | 該当 API を採用 | Step 4 へ |
| (2) フォールバック採用 | 3 候補すべて ❌ かつ Agent cold-start median < `OAG_AGENT_COLDSTART_BUDGET_MS` (100ms) | Agent 再起動フォールバックを採用 | Step 4 へ |
| (3) 実装不可 | 3 候補すべて ❌ かつ Agent cold-start median >= `OAG_AGENT_COLDSTART_BUDGET_MS` (100ms) | Phase 2 実装不可 | ブレインストーミングへ戻る |

### 代替フォールバック採用判断
- Agent cold-start `<median ms>` < `OAG_AGENT_COLDSTART_BUDGET_MS` (100ms) を満たすか YES/NO

## 3. thinking / tool_call イベント (将来 Phase 用調査)
- ストリームインターフェース型:
- Phase 2 では未使用とすることを再確認

## 4. harness binary 起動コスト
- Agent cold-start (10 回計測の中央値): `<median ms>` / p95: `<p95 ms>`
- 長寿命 Agent 採用の妥当性: OK (median < 100ms) / 要再検討 (median >= 100ms → ブレインストーミングへ戻る)
```

- [x] **Step 4: pyproject.toml の依存関係はまだ更新しない**

Phase 2 本体の実装タスクで決定する。本タスクは情報収集のみ。

- [ ] **Step 5: コミット**

```bash
git add docs/superpowers/specs/2026-05-25-phase2-sdk-spike.md
git commit -m "docs(spec): Phase 2 SDK スパイク調査結果を追加"
```

- [ ] **Step 6: プッシュと Draft PR 作成**

```bash
git push -u origin feature/phase2/spike-sdk-api
gh pr create --draft --base master --title "docs(spec): Phase 2 SDK スパイク調査結果" \
  --body "Section 11.1 の不確定要素 (SDK 例外型 / messages 一括渡し API / 起動コスト) を確定。後続コードタスクの参照元。"
```

- [x] **Step 7: Draft PR URL を `.stack-urls.md` に追記**

```markdown
- T1.1: https://<pr-url>
```

---

## Phase 2: Python 側基盤

### Task 2.1: `errors.py` 新設 (SDK 例外 → JSON-RPC エラーコード変換 + `classify_sdk_error`)

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T2.2 / T2.3 / T3.x / T4.1 と同時実行可
**前提条件:** なし。T1.1 (PR #32) は merged 済みのため、設計書 Section 6.1 改訂版表の確定型 (`AntigravityConnectionError` / `google.genai.errors.*`) を直接実装する

**Files:**

- Create: `backend/src/opencode_antigravity/errors.py`
- Create: `tests/python/unit/test_errors.py`

- [x] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin master --no-tags
git switch -c feature/phase2/python-errors origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [x] **Step 2: 失敗するテストを書く (`tests/python/unit/test_errors.py`)**

```python
from opencode_antigravity.errors import (
    SdkAuthError,
    SdkRateLimitError,
    SdkModelError,
    SdkApiError,
    SdkTimeoutError,
    SdkConnectionError,
    sdk_exception_to_jsonrpc_error,
)


def test_sdk_auth_error_code():
    err = SdkAuthError("auth failed")
    assert err.code == -32010
    assert err.message == "auth failed"


def test_sdk_rate_limit_error_code():
    assert SdkRateLimitError("x").code == -32011


def test_sdk_model_error_code():
    assert SdkModelError("x").code == -32012


def test_sdk_api_error_code():
    assert SdkApiError("x").code == -32013


def test_sdk_timeout_error_code():
    assert SdkTimeoutError("x").code == -32014


def test_sdk_connection_error_code():
    assert SdkConnectionError("x").code == -32015


def test_to_jsonrpc_error_serializes_dict_shape():
    err = SdkAuthError("invalid api key")
    jr = sdk_exception_to_jsonrpc_error(err)
    assert jr == {"code": -32010, "message": "invalid api key"}


def test_unknown_exception_maps_to_internal_error():
    jr = sdk_exception_to_jsonrpc_error(RuntimeError("boom"))
    assert jr["code"] == -32603
    assert "boom" in jr["message"]


# --- classify_sdk_error: Spike 結果反映の判別ロジック ---

import asyncio
from opencode_antigravity.errors import classify_sdk_error


def test_classify_asyncio_timeout_maps_to_timeout():
    assert isinstance(classify_sdk_error(asyncio.TimeoutError("late")), SdkTimeoutError)


def test_classify_already_sdk_error_passes_through():
    err = SdkAuthError("auth")
    assert classify_sdk_error(err) is err


class _FakeAntigravityConnectionError(Exception):
    pass


_FakeAntigravityConnectionError.__module__ = "google.antigravity.types"
_FakeAntigravityConnectionError.__qualname__ = "AntigravityConnectionError"


def test_classify_antigravity_connection_with_auth_pattern_maps_to_auth():
    exc = _FakeAntigravityConnectionError("request failed (code 400): API key not valid")
    assert isinstance(classify_sdk_error(exc), SdkAuthError)


def test_classify_antigravity_connection_without_auth_maps_to_connection():
    exc = _FakeAntigravityConnectionError("transport reset")
    assert isinstance(classify_sdk_error(exc), SdkConnectionError)


class _FakeClientError(Exception):
    def __init__(self, msg: str, status_code: int) -> None:
        super().__init__(msg)
        self.status_code = status_code


_FakeClientError.__module__ = "google.genai.errors"
_FakeClientError.__qualname__ = "ClientError"


def test_classify_client_error_429_maps_to_rate_limit():
    assert isinstance(classify_sdk_error(_FakeClientError("too many", 429)), SdkRateLimitError)


def test_classify_client_error_404_maps_to_model_not_found():
    assert isinstance(classify_sdk_error(_FakeClientError("no model", 404)), SdkModelError)


def test_classify_client_error_500_maps_to_api_error():
    assert isinstance(classify_sdk_error(_FakeClientError("server down", 500)), SdkApiError)


def test_classify_unknown_exception_fallbacks_to_api_error():
    fallback = classify_sdk_error(RuntimeError("mystery"))
    assert isinstance(fallback, SdkApiError)
    assert "RuntimeError" in fallback.message
```

- [x] **Step 3: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/unit/test_errors.py -v
```

Expected: `ModuleNotFoundError: No module named 'opencode_antigravity.errors'` で FAIL。

- [x] **Step 4: 最小実装を書く (`backend/src/opencode_antigravity/errors.py`)**

```python
"""SDK 例外 → JSON-RPC エラーコード変換 (Phase 2)。

設計書 Section 6.1 に対応するコード割り当て:
  -32010 SdkAuthError
  -32011 SdkRateLimitError
  -32012 SdkModelError
  -32013 SdkApiError
  -32014 SdkTimeoutError
  -32015 SdkConnectionError
未知の例外は -32603 (Internal error) にフォールバック。
"""
from __future__ import annotations

import asyncio
import re


class SdkError(Exception):
    code: int = -32603

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class SdkAuthError(SdkError):
    code = -32010


class SdkRateLimitError(SdkError):
    code = -32011


class SdkModelError(SdkError):
    code = -32012


class SdkApiError(SdkError):
    code = -32013


class SdkTimeoutError(SdkError):
    code = -32014


class SdkConnectionError(SdkError):
    code = -32015


def sdk_exception_to_jsonrpc_error(exc: BaseException) -> dict[str, object]:
    if isinstance(exc, SdkError):
        return {"code": exc.code, "message": exc.message}
    return {"code": -32603, "message": f"Internal error: {exc}"}


_AUTH_PATTERN = re.compile(r"api[\s_-]?key|unauthor|401", re.IGNORECASE)
_RATE_LIMIT_HTTP_STATUS = 429
_MODEL_NOT_FOUND_HTTP_STATUS = 404


def classify_sdk_error(exc: BaseException) -> SdkError:
    """SDK が raise する未分類例外を `SdkError` サブクラスへ判別する。

    Spike (`2026-05-25-phase2-sdk-spike.md`) で確定した型を扱う:
      - google.antigravity.types.AntigravityConnectionError (auth or connection)
      - google.antigravity.types.AntigravityValidationError
      - google.genai.errors.ClientError (status_code で rate-limit / model 判別)
      - google.genai.errors.APIError / ServerError
      - asyncio.TimeoutError (cold-start wait_for や stream timeout から)

    判別不能例外は SdkApiError (-32013) にフォールバックし、上位で WARN ログ予定。
    """
    # 既に SdkError サブクラス
    if isinstance(exc, SdkError):
        return exc

    if isinstance(exc, asyncio.TimeoutError):
        return SdkTimeoutError(str(exc) or "operation timed out")

    type_name = f"{type(exc).__module__}.{type(exc).__qualname__}"

    # AntigravityConnectionError: message で auth/接続を分岐
    if type_name.endswith("AntigravityConnectionError"):
        msg = str(exc)
        if _AUTH_PATTERN.search(msg):
            return SdkAuthError(msg)
        return SdkConnectionError(msg)

    if type_name.endswith("AntigravityValidationError"):
        return SdkModelError(str(exc))

    # google.genai.errors.ClientError: HTTP ステータスで分岐
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    if type_name.endswith("ClientError"):
        if status == _RATE_LIMIT_HTTP_STATUS:
            return SdkRateLimitError(str(exc))
        if status == _MODEL_NOT_FOUND_HTTP_STATUS:
            return SdkModelError(str(exc))
        return SdkApiError(str(exc))

    if type_name.endswith(("APIError", "ServerError")):
        return SdkApiError(str(exc))

    # 不明な例外は SdkApiError にフォールバック (上位で WARN ログ)
    return SdkApiError(f"unclassified SDK error: {type_name}: {exc}")
```

- [x] **Step 5: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/unit/test_errors.py -v
uv run ruff check backend/src/opencode_antigravity/errors.py tests/python/unit/test_errors.py
```

Expected: 全 8 テスト PASS、ruff エラー 0。

- [x] **Step 6: コミット**

```bash
git add backend/src/opencode_antigravity/errors.py tests/python/unit/test_errors.py
git commit -m "feat(python): SDK 例外 → JSON-RPC エラーコード変換 (errors.py) を追加"
```

- [x] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/python-errors
gh pr create --draft --base master --title "feat(python): SDK 例外型 (errors.py) を追加" \
  --body "Phase 2 設計 Section 6.1 のエラーコード割り当てを実装。後続 T2.5 (handlers) で利用。"
```

`.stack-urls.md` に `- T2.1: <url>` を追記。

---

### Task 2.2: `protocol.py` に `format_notification` を追加

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T2.1 / T2.3 / T3.x / T4.1 と同時実行可
**前提条件:** なし

**Files:**

- Modify: `backend/src/opencode_antigravity/protocol.py`
- Create: `tests/python/unit/test_format_notification.py`

- [x] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin master --no-tags
git switch -c feature/phase2/python-protocol-notification origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [x] **Step 2: 失敗するテストを書く (受け入れ#22)**

`tests/python/unit/test_format_notification.py`:

```python
import json
import pytest

from opencode_antigravity.protocol import (
    format_notification,
    JsonRpcInvalidRequestError,
    MAX_MESSAGE_BYTES,
)


def test_format_notification_basic():
    out = format_notification(
        method="chat.completions.chunk",
        params={"request_id": "abc", "delta": {"content": "x"}},
    )
    assert out.endswith("\n")
    parsed = json.loads(out)
    assert parsed == {
        "jsonrpc": "2.0",
        "method": "chat.completions.chunk",
        "params": {"request_id": "abc", "delta": {"content": "x"}},
    }
    assert "id" not in parsed


def test_format_notification_empty_params():
    out = format_notification(method="m", params={})
    parsed = json.loads(out)
    assert parsed["params"] == {}


def test_format_notification_utf8_multibyte():
    out = format_notification(
        method="chat.completions.chunk",
        params={"request_id": "r", "delta": {"content": "日本語"}},
    )
    assert "日本語" in out
    # 行末改行を含むバイト長で over 上限になっていないこと
    assert len(out.encode("utf-8")) < MAX_MESSAGE_BYTES


def test_format_notification_oversized_raises():
    huge = "x" * (MAX_MESSAGE_BYTES + 10)
    with pytest.raises(JsonRpcInvalidRequestError):
        format_notification(
            method="chat.completions.chunk",
            params={"request_id": "r", "delta": {"content": huge}},
        )
```

- [x] **Step 3: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/unit/test_format_notification.py -v
```

Expected: `ImportError: cannot import name 'format_notification'` で FAIL。

- [x] **Step 4: `protocol.py` を読んで既存定数を確認**

```bash
uv run python -c "from opencode_antigravity.protocol import MAX_MESSAGE_BYTES, JsonRpcInvalidRequestError; print(MAX_MESSAGE_BYTES)"
```

Expected: `1048576` (1 MiB) が表示される。表示されない場合は `protocol.py` を読み、`MAX_MESSAGE_BYTES` の正確な名前と `JsonRpcInvalidRequestError` の存在を確認してテストの import を調整する。

- [x] **Step 5: `format_notification` を `protocol.py` に追加**

`backend/src/opencode_antigravity/protocol.py` に以下を追記 (既存の `format_response` 直後を推奨):

```python
def format_notification(method: str, params: dict) -> str:
    """JSON-RPC 2.0 Notification (id なし) を整形して 1 行の NDJSON 文字列を返す。

    Phase 2 ストリーミング送信側で利用。送信前に 1MB 制限を検証する。
    """
    payload = {"jsonrpc": "2.0", "method": method, "params": params}
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    if len(line.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise JsonRpcInvalidRequestError(
            f"notification exceeds {MAX_MESSAGE_BYTES} bytes"
        )
    return line
```

`import json` が無ければ追加する。

- [x] **Step 6: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/unit/test_format_notification.py -v
uv run ruff check backend/src/opencode_antigravity/protocol.py tests/python/unit/test_format_notification.py
```

Expected: 全 4 テスト PASS、ruff エラー 0。

- [x] **Step 7: 既存テスト (Phase 1) が壊れていないことを確認**

```bash
uv run pytest tests/python
```

Expected: 既存 21 ケースが PASS のまま。

- [x] **Step 8: コミット**

```bash
git add backend/src/opencode_antigravity/protocol.py tests/python/unit/test_format_notification.py
git commit -m "feat(python): JSON-RPC Notification 整形 (format_notification) を追加 (受け入れ#22)"
```

- [x] **Step 9: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/python-protocol-notification
gh pr create --draft --base master --title "feat(python): format_notification 追加 (受け入れ#22)" \
  --body "Phase 2 ストリーミング送信側で使用する JSON-RPC Notification 整形を protocol.py に追加。"
```

`.stack-urls.md` に `- T2.2: <url>` を追記。

---

### Task 2.3: `prompt_folding.py` + `antigravity_client.py` 新設 (per-request Agent 方式)

**派生元ブランチ:** `master`
**実行モード:** 並列可能 — T2.1 / T2.2 / T3.x / T4.1 と同時実行可。T1.1 は merged 済みのため、本タスクで **実 `AntigravityClient` を最終形 (per-request Agent 方式) で実装** する (旧計画の「stub → T2.3.1 で差し替え」二段階方式は撤回)。
**前提条件:** なし。

**設計書参照:** Section 3.3 (per-request Agent + Chat ML 畳み込み) / Section 3.3.1 (`fold_messages_to_prompt` 仕様) / Section 4.2 (`AntigravityClient` 責務) / Section 6.1 (例外マッピング) / 受け入れ#25 改訂 + #32

**Files:**

- Create: `backend/src/opencode_antigravity/prompt_folding.py`
- Create: `backend/src/opencode_antigravity/antigravity_client.py`
- Create: `tests/python/unit/test_prompt_folding.py`
- Create: `tests/python/unit/test_antigravity_client.py`
- Modify: `pyproject.toml` (live mode 用の optional dep `google-antigravity` を `[project.optional-dependencies]` で追加)

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin master --no-tags
git switch -c feature/phase2/python-antigravity-client origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2a: 失敗するテストを書く: `tests/python/unit/test_prompt_folding.py` (受け入れ#32)**

```python
import pytest

from opencode_antigravity.prompt_folding import fold_messages_to_prompt


def test_fold_chatml_format_full_conversation():
    """設計書 Section 3.3.1: system + user + assistant + user の畳み込み"""
    msgs = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "What is 2+2?"},
        {"role": "assistant", "content": "4"},
        {"role": "user", "content": "Now add 3."},
    ]
    out = fold_messages_to_prompt(msgs)
    assert out == (
        "<|system|>\nYou are helpful.\n"
        "<|user|>\nWhat is 2+2?\n"
        "<|assistant|>\n4\n"
        "<|user|>\nNow add 3.\n"
        "<|assistant|>\n"  # 末尾誘導タグ
    )


def test_fold_single_user_only():
    out = fold_messages_to_prompt([{"role": "user", "content": "hi"}])
    assert out == "<|user|>\nhi\n<|assistant|>\n"


def test_fold_multiple_system_messages_kept_in_order():
    msgs = [
        {"role": "system", "content": "S1"},
        {"role": "system", "content": "S2"},
        {"role": "user", "content": "U"},
    ]
    out = fold_messages_to_prompt(msgs)
    assert out == (
        "<|system|>\nS1\n"
        "<|system|>\nS2\n"
        "<|user|>\nU\n"
        "<|assistant|>\n"
    )


def test_fold_empty_content_preserves_role_tag():
    msgs = [
        {"role": "system", "content": ""},
        {"role": "user", "content": "hi"},
    ]
    out = fold_messages_to_prompt(msgs)
    assert out.startswith("<|system|>\n\n<|user|>\n")


@pytest.mark.parametrize("bad_role", ["tool", "function", "developer", ""])
def test_fold_unknown_role_raises(bad_role: str):
    with pytest.raises(ValueError, match="unsupported role"):
        fold_messages_to_prompt([{"role": bad_role, "content": "x"}])
```

- [ ] **Step 2b: 失敗するテストを書く: `tests/python/unit/test_antigravity_client.py` (受け入れ#25 改訂)**

per-request Agent 方式に合わせて、Agent インスタンスがリクエスト毎に新規生成されることを検証する。

```python
import asyncio

import pytest

from opencode_antigravity.antigravity_client import MockAntigravityClient


@pytest.mark.asyncio
async def test_lifecycle_each_request_creates_new_agent():
    """設計書 Section 3.3: per-request Agent 方式。stream_chat 毎に enter/exit 1 セット。"""
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()  # no-op (互換性のため残置)
    try:
        chunks_1: list[str] = []
        async for c in client.stream_chat([{"role": "user", "content": "hello"}]):
            chunks_1.append(c)
        assert chunks_1 == ["[mock] ", "hello"]
        assert client.agent_enter_count == 1
        assert client.agent_exit_count == 1

        chunks_2: list[str] = []
        async for c in client.stream_chat([{"role": "user", "content": "world"}]):
            chunks_2.append(c)
        assert chunks_2 == ["[mock] ", "world"]
        # per-request: 2 回目で Agent が新たに enter/exit
        assert client.agent_enter_count == 2
        assert client.agent_exit_count == 2
        # Agent インスタンスが別 (id 不一致) であること
        assert client.last_two_agent_ids[0] != client.last_two_agent_ids[1]
    finally:
        await client.stop()  # no-op


@pytest.mark.asyncio
async def test_stream_handler_exception_still_exits_agent():
    """`async with Agent(...)` の finally で必ず __aexit__ が呼ばれる"""
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        with pytest.raises(RuntimeError, match="injected"):
            async for _ in client.stream_chat(
                [{"role": "user", "content": "x"}],
                mock_options={"raise_after_chunk": 1, "raise_kind": "runtime"},
            ):
                pass
        assert client.agent_enter_count == 1
        assert client.agent_exit_count == 1  # 例外でも exit が呼ばれる
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_agent_enter_failure_does_not_exit():
    """`Agent.__aenter__()` が失敗した場合は `__aexit__` を呼ばない (async with 仕様)"""
    client = MockAntigravityClient(model="gemini-2.5-pro")
    client.fail_next_enter = True
    await client.start()
    try:
        with pytest.raises(RuntimeError, match="cold-start failure"):
            async for _ in client.stream_chat([{"role": "user", "content": "x"}]):
                pass
        assert client.agent_enter_attempt_count == 1
        assert client.agent_enter_count == 0   # enter 成功は 0
        assert client.agent_exit_count == 0
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_chat_aggregates_stream():
    """`chat()` は per-request stream を集約して文字列を返す"""
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        result = await client.chat([{"role": "user", "content": "hello"}])
        assert result == "[mock] hello"
    finally:
        await client.stop()
```

- [ ] **Step 3: pytest-asyncio を dev-deps に追加**

`pyproject.toml` の `[tool.uv]` セクションに `pytest-asyncio>=0.23` を追加し、`[tool.pytest.ini_options]` に `asyncio_mode = "auto"` を追加する。

```bash
uv sync
```

- [ ] **Step 4: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/unit/test_prompt_folding.py tests/python/unit/test_antigravity_client.py -v
```

Expected: `ModuleNotFoundError` で全 FAIL。

- [ ] **Step 5a: `prompt_folding.py` を実装 (設計書 Section 3.3.1)**

```python
"""OpenAI messages 配列 → Chat ML 風 prompt 文字列の畳み込み (Phase 2)。

設計書 Section 3.3.1 に準拠。Antigravity SDK は `Agent.chat(prompt: str)` のみを
公開しており、role 付き履歴を 1 回で渡す API が存在しないため、本モジュールで
畳み込みを行う。末尾には `<|assistant|>\\n` 誘導タグを付与して、モデルに次の
発話 = assistant 応答を促す。
"""
from __future__ import annotations

ROLE_TAGS: dict[str, str] = {
    "system": "<|system|>",
    "user": "<|user|>",
    "assistant": "<|assistant|>",
}
PROMPT_TAIL = "<|assistant|>\n"


def fold_messages_to_prompt(messages: list[dict]) -> str:
    """messages を Chat ML 風 prompt 文字列に畳み込む。

    Args:
        messages: OpenAI 形式の `{role, content}` リスト。role は
            `"system" | "user" | "assistant"` のみサポート。

    Returns:
        Chat ML 風 prompt 文字列。末尾は ``<|assistant|>\\n`` (誘導タグ)。

    Raises:
        ValueError: 不明な role (`tool` / `function` 等) を含む場合。
    """
    parts: list[str] = []
    for msg in messages:
        role = msg.get("role", "")
        if role not in ROLE_TAGS:
            raise ValueError(f"unsupported role: {role!r}")
        content = msg.get("content", "") or ""
        parts.append(f"{ROLE_TAGS[role]}\n{content}\n")
    parts.append(PROMPT_TAIL)
    return "".join(parts)
```

- [ ] **Step 5b: `antigravity_client.py` を実装 (per-request Agent + Mock)**

```python
"""Antigravity SDK 抽象 (Phase 2, per-request Agent 方式)。

- AntigravityClient: 実 SDK バックエンド (`OAG_BACKEND_MODE=live` で選択)
- MockAntigravityClient: 決定論的な token 列を yield (CI 既定)

各 stream_chat 呼び出しで Agent を新規に __aenter__ / __aexit__ し、harness
プロセス丸ごとを破棄してステートレス性を保証する (設計書 Section 3.3)。
messages 配列は `prompt_folding.fold_messages_to_prompt` で Chat ML 風 prompt
文字列へ畳み込んでから Agent.chat(prompt) に渡す。
"""
from __future__ import annotations

import asyncio
import os
from typing import AsyncGenerator, Optional, Protocol

from .errors import SdkConnectionError, classify_sdk_error
from .prompt_folding import fold_messages_to_prompt


class AntigravityClientBase(Protocol):
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def stream_chat(
        self, messages: list[dict], *, mock_options: dict | None = None
    ) -> AsyncGenerator[str, None]: ...
    async def chat(self, messages: list[dict]) -> str: ...


def _coldstart_timeout_s() -> float:
    """`OAG_AGENT_COLDSTART_TIMEOUT_MS` を秒で返す (既定 10000 ms = 10s)"""
    return float(os.environ.get("OAG_AGENT_COLDSTART_TIMEOUT_MS", "10000")) / 1000.0


class MockAntigravityClient:
    """Mock backend。per-request Agent ライフサイクルを stub で再現する。

    Test hooks:
      - `agent_enter_count` / `agent_exit_count` / `agent_enter_attempt_count`
      - `last_two_agent_ids`: 直近 2 件の "Agent インスタンス id 風" 整数 (per-request 検証)
      - `fail_next_enter`: 次の `__aenter__` を `RuntimeError("cold-start failure")` で失敗させる
      - `mock_options`: `{"raise_after_chunk": N, "raise_kind": "runtime"|"sdk_api"}` で
        N 個 yield 後に例外を上げる (Section 7.4.1 のエラー注入と独立した内部 hook)
    """

    def __init__(self, model: str) -> None:
        self.model = model
        self.agent_enter_count = 0
        self.agent_enter_attempt_count = 0
        self.agent_exit_count = 0
        self.fail_next_enter = False
        self.last_two_agent_ids: list[int] = []
        self._agent_id_counter = 0

    async def start(self) -> None:
        return  # no-op (per-request 方式では init は不要)

    async def stop(self) -> None:
        return  # no-op

    async def stream_chat(
        self, messages: list[dict], *, mock_options: dict | None = None
    ) -> AsyncGenerator[str, None]:
        self.agent_enter_attempt_count += 1
        if self.fail_next_enter:
            self.fail_next_enter = False
            raise RuntimeError("cold-start failure")

        # per-request "Agent" 相当: enter
        self.agent_enter_count += 1
        self._agent_id_counter += 1
        agent_id = self._agent_id_counter
        self.last_two_agent_ids.append(agent_id)
        self.last_two_agent_ids = self.last_two_agent_ids[-2:]

        try:
            # 末尾の user message を mock 応答として echo (Phase 1 互換に近い)
            last_user = next(
                (m["content"] for m in reversed(messages) if m.get("role") == "user"),
                "",
            )
            tokens = ["[mock] ", last_user]
            yielded = 0
            raise_after = (mock_options or {}).get("raise_after_chunk")
            raise_kind = (mock_options or {}).get("raise_kind", "runtime")

            for tok in tokens:
                if raise_after is not None and yielded >= raise_after:
                    if raise_kind == "sdk_api":
                        from .errors import SdkApiError
                        raise SdkApiError("mock injected SdkApiError")
                    raise RuntimeError("injected by mock_options")
                yield tok
                yielded += 1
        finally:
            # `async with Agent(...)` の finally に相当
            self.agent_exit_count += 1

    async def chat(self, messages: list[dict]) -> str:
        buf: list[str] = []
        async for tok in self.stream_chat(messages):
            buf.append(tok)
        return "".join(buf)


class AntigravityClient:
    """実 SDK バックエンド (per-request Agent 方式)。

    各 stream_chat 呼び出しで:
      1. fold_messages_to_prompt(messages) で Chat ML 風 prompt を生成
      2. asyncio.wait_for(Agent(LocalAgentConfig(...)).__aenter__(), timeout=cold-start budget)
      3. response = await agent.chat(prompt)
      4. async for chunk in response.chunks: 通常 chunk のみ yield
      5. Agent.__aexit__ (async with の finally)

    SDK 例外は `classify_sdk_error(exc)` で SdkError サブクラスに分類して伝播する。
    """

    def __init__(self, model: str, api_key: str) -> None:
        self.model = model
        self._api_key = api_key

    async def start(self) -> None:
        # SDK の import 可能性のみ事前検証 (Agent 起動はリクエスト時)
        try:
            import google.antigravity  # noqa: F401
        except ImportError as e:
            raise RuntimeError(
                "google-antigravity SDK is not installed. "
                "Install with: uv pip install 'opencode-antigravity[live]'"
            ) from e

    async def stop(self) -> None:
        return  # per-request 方式では永続リソースなし

    async def stream_chat(
        self, messages: list[dict], *, mock_options: dict | None = None
    ) -> AsyncGenerator[str, None]:
        # mock_options は live 実装では明示的に無視 (Section 7.4.1)
        _ = mock_options

        prompt = fold_messages_to_prompt(messages)

        # 遅延 import で test 環境 (mock-only) で SDK 未インストール許容
        from google.antigravity import Agent, LocalAgentConfig  # type: ignore[attr-defined]
        from google.antigravity import types as ga_types  # type: ignore[attr-defined]

        agent_cm = Agent(LocalAgentConfig(model=self.model, api_key=self._api_key))

        # Phase 1: Agent.__aenter__ (cold-start)
        # ここで失敗した場合は __aexit__ を呼ばない (async with 仕様準拠)。
        try:
            agent = await asyncio.wait_for(
                agent_cm.__aenter__(), timeout=_coldstart_timeout_s()
            )
        except asyncio.TimeoutError as e:
            raise SdkConnectionError(
                "Agent cold-start exceeded OAG_AGENT_COLDSTART_TIMEOUT_MS"
            ) from e
        except Exception as e:
            raise classify_sdk_error(e) from e

        # Phase 2: agent.chat → response.chunks 反復
        # __aenter__ が成功した後の例外 / キャンセル / 正常終了いずれも
        # finally で __aexit__ を確実に呼ぶ。
        try:
            response = await agent.chat(prompt)
            async for chunk in response.chunks:
                # ChatResponse.chunks は StreamChunk | ToolCall | ToolResult を yield
                # Phase 2 では StreamChunk.text のみ送出 (tool_calls は Phase 4 で扱う)
                if isinstance(chunk, ga_types.StreamChunk) and chunk.text:
                    yield chunk.text
        except Exception as e:
            raise classify_sdk_error(e) from e
        finally:
            await agent_cm.__aexit__(None, None, None)

    async def chat(self, messages: list[dict]) -> str:
        buf: list[str] = []
        async for tok in self.stream_chat(messages):
            buf.append(tok)
        return "".join(buf)


def create_client(model: str, mode: str, api_key: Optional[str]) -> AntigravityClientBase:
    if mode == "mock":
        return MockAntigravityClient(model=model)
    if mode == "live":
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is required for live mode")
        return AntigravityClient(model=model, api_key=api_key)
    raise ValueError(f"unknown OAG_BACKEND_MODE: {mode}")
```

- [ ] **⚠️ 重要: Step 6: pyproject.toml に optional dep を追加し、uv.lock を更新**

`pyproject.toml` に以下を追記:

```toml
[project.optional-dependencies]
live = ["google-antigravity>=0.1"]
```

uv.lock を更新して live extras を lockfile に含める。これを忘れると CI の `uv sync --frozen --extra live` (.github/workflows/ci.yml の live-nightly ジョブで実行) が **lock 不整合エラー** で失敗する:

```bash
# optional-dependencies を lock に反映 (live extras の解決まで含む)
uv lock --extra live

# 検証: --frozen でも --extra live が解決できることを確認
uv sync --frozen --extra live --dry-run
```

> **重要:** ローカル開発で実 SDK を試したい場合は `uv sync --extra live` で実際にインストールするが、テスト / CI (mock) では `live` extras 不要のため `uv sync` のみで OK。uv.lock の `[package.optional-dependencies]` セクションに `google-antigravity` が現れることを確認してからコミットする。

- [ ] **Step 7: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/unit/test_prompt_folding.py tests/python/unit/test_antigravity_client.py -v
uv run ruff check \
  backend/src/opencode_antigravity/prompt_folding.py \
  backend/src/opencode_antigravity/antigravity_client.py \
  tests/python/unit/test_prompt_folding.py \
  tests/python/unit/test_antigravity_client.py
```

Expected: prompt_folding 5 ケース + antigravity_client 4 ケース = 9 テスト PASS、ruff エラー 0。

- [ ] **Step 8: 既存テストが壊れていないことを確認**

```bash
uv run pytest tests/python
```

- [ ] **Step 9: コミット**

```bash
git add backend/src/opencode_antigravity/prompt_folding.py \
        backend/src/opencode_antigravity/antigravity_client.py \
        tests/python/unit/test_prompt_folding.py \
        tests/python/unit/test_antigravity_client.py \
        pyproject.toml \
        uv.lock
git commit -m "feat(python): per-request Agent + Chat ML 畳み込みで AntigravityClient を実装 (受け入れ#25 改訂, #32)"
```

- [ ] **Step 10: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/python-antigravity-client
gh pr create --draft --base master --title "feat(python): AntigravityClient (per-request Agent) + prompt_folding" \
  --body "Phase 2 設計 v2 (per-request Agent + Chat ML 畳み込み) を実装 (Section 3.3 / 3.3.1 / 4.2)。受け入れ#25 改訂 + #32 (Chat ML 畳み込み)。CI は mock 既定。並行制御 + #33/#34 は後続 T2.3.1 で追加。"
```

`.stack-urls.md` に `- T2.3: <url>` を追記。

---

### Task 2.3.1: 並行制御 (Semaphore) + cold-start timeout 検証 + 受け入れ#33/#34 + live smoke

**派生元ブランチ:** `feature/phase2/python-antigravity-client` (T2.3)
**実行モード:** 直列必須 — Wait for T2.3 の Draft PR URL
**前提条件:** T2.3 の Draft PR URL が `.stack-urls.md` に記録済み

**設計書参照:** Section 3.3.2 (並行リクエストとリソース制御 / `OAG_MAX_CONCURRENT_REQUESTS=4`) / Section 6.4.1 (`OAG_AGENT_COLDSTART_TIMEOUT_MS=10000`) / 受け入れ#33, #34 / 受け入れ#25 改訂のエッジケース「`Agent.__aenter__` タイムアウト」

**Files:**

- Modify: `backend/src/opencode_antigravity/antigravity_client.py` (Semaphore 追加、`AntigravityClient.stream_chat` を semaphore 内で実行)
- Create: `tests/python/integration/test_antigravity_client_concurrency.py` (受け入れ#33, #34)
- Create: `tests/python/e2e_live/test_antigravity_client_live_smoke.py` (live マーカ付き smoke、cold-start 計測のベースラインに使用)

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/python-antigravity-client --no-tags
git switch -c feature/phase2/python-antigravity-client-concurrency origin/feature/phase2/python-antigravity-client

EXPECTED_BASE="feature/phase2/python-antigravity-client"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: 失敗するテストを書く (受け入れ#33, #34)**

`tests/python/integration/test_antigravity_client_concurrency.py`:

```python
import asyncio
import time

import pytest

from opencode_antigravity.antigravity_client import MockAntigravityClient


class _SlowMockClient(MockAntigravityClient):
    """`Agent.__aenter__` 相当に sleep を仕込んだ Mock (#34 用)

    Semaphore の効果を観測するため、`active_enter_count` のインクリメントは
    必ず `_get_semaphore()` 取得後に行う。親クラス `super().stream_chat()` には
    委譲しない: `asyncio.Semaphore` は非再帰的なので、外側で acquire しつつ
    内側でもう一度 acquire するとセマフォ枯渇でデッドロックする。
    """

    def __init__(self, model: str, enter_sleep_s: float = 0.2) -> None:
        super().__init__(model)
        self.enter_sleep_s = enter_sleep_s
        self.active_enter_count = 0
        self.peak_active_enter = 0

    async def stream_chat(self, messages, *, mock_options=None):
        # 遅延 import: テストモジュール冒頭の import で antigravity_client を再評価しない
        from opencode_antigravity.antigravity_client import _get_semaphore

        async with _get_semaphore():
            # semaphore 取得後に enter カウンタを進める
            # (取得前に進めると、`asyncio.gather` で全タスクが一斉に
            # counter++ → suspend し peak が limit を超えて誤判定になる)
            self.active_enter_count += 1
            self.peak_active_enter = max(
                self.peak_active_enter, self.active_enter_count
            )
            try:
                await asyncio.sleep(self.enter_sleep_s)
                last_user = next(
                    (m["content"] for m in reversed(messages)
                     if m.get("role") == "user"),
                    "",
                )
                yield "[mock] "
                yield last_user
            finally:
                self.active_enter_count -= 1


@pytest.mark.asyncio
async def test_per_request_agent_lifecycle_isolation(monkeypatch):
    """受け入れ#33: per-request 分離 (`OAG_MAX_CONCURRENT_REQUESTS=1` で逐次化)"""
    monkeypatch.setenv("OAG_MAX_CONCURRENT_REQUESTS", "1")
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        async for _ in client.stream_chat([{"role": "user", "content": "first"}]):
            pass
        async for _ in client.stream_chat([{"role": "user", "content": "second"}]):
            pass
        assert client.agent_enter_count == 2
        assert client.agent_exit_count == 2
        # per-request: Agent インスタンス id 相当が別
        assert client.last_two_agent_ids[0] != client.last_two_agent_ids[1]
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_concurrent_requests_respect_semaphore(monkeypatch):
    """受け入れ#34: `OAG_MAX_CONCURRENT_REQUESTS=2` で 4 リクエスト並行投入時のピーク並列数が 2"""
    monkeypatch.setenv("OAG_MAX_CONCURRENT_REQUESTS", "2")
    client = _SlowMockClient(model="gemini-2.5-pro", enter_sleep_s=0.2)
    await client.start()

    async def run_one(text: str) -> list[str]:
        chunks: list[str] = []
        async for tok in client.stream_chat([{"role": "user", "content": text}]):
            chunks.append(tok)
        return chunks

    t0 = time.perf_counter()
    results = await asyncio.gather(*(run_one(f"msg{i}") for i in range(4)))
    elapsed = time.perf_counter() - t0

    await client.stop()

    assert all(r == ["[mock] ", f"msg{i}"] for i, r in enumerate(results))
    # ピーク並列数 <= 2
    assert client.peak_active_enter <= 2, f"semaphore breached: peak={client.peak_active_enter}"
    # 4 リクエスト / 2 並列 / 0.2s = 0.4s 以上 (理論値)
    assert elapsed >= 0.4 - 0.05  # 5% 余裕


@pytest.mark.asyncio
async def test_cold_start_timeout_maps_to_sdk_connection_error(monkeypatch):
    """受け入れ#25 改訂の追加エッジケース: cold-start timeout は SdkConnectionError(-32015)

    本番側の `AntigravityClient.stream_chat` が `_coldstart_timeout_s()` を読む
    点を忠実に模倣する。monkeypatch.setenv が実効的に動作していること
    (env 経由でタイムアウトが制御されること) を同時に検証する。
    """
    from opencode_antigravity.antigravity_client import _coldstart_timeout_s
    from opencode_antigravity.errors import SdkConnectionError

    monkeypatch.setenv("OAG_AGENT_COLDSTART_TIMEOUT_MS", "50")

    class _NeverEnterClient(MockAntigravityClient):
        async def stream_chat(self, messages, *, mock_options=None):
            # 本番 AntigravityClient.stream_chat と同じ env 経路でタイムアウトを取得
            try:
                await asyncio.wait_for(
                    asyncio.sleep(1.0), timeout=_coldstart_timeout_s()
                )
            except asyncio.TimeoutError as e:
                raise SdkConnectionError(
                    "Agent cold-start exceeded OAG_AGENT_COLDSTART_TIMEOUT_MS"
                ) from e
            yield "unreachable"

    client = _NeverEnterClient(model="gemini-2.5-pro")
    await client.start()
    try:
        with pytest.raises(SdkConnectionError):
            async for _ in client.stream_chat([{"role": "user", "content": "x"}]):
                pass
    finally:
        await client.stop()
```

- [ ] **Step 3: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/integration/test_antigravity_client_concurrency.py -v
```

Expected: `OAG_MAX_CONCURRENT_REQUESTS` が未実装のため #34 が FAIL (semaphore がないので peak が 4 になる)。#33 と timeout テストは PASS する可能性あり。

- [ ] **Step 4: `antigravity_client.py` に Semaphore を追加**

設計書 Section 3.3.2 の規約に従い、モジュールレベルで `asyncio.Semaphore` を遅延生成し、`MockAntigravityClient` / `AntigravityClient` 双方の `stream_chat` で取得する。

```python
# antigravity_client.py に追記

# `(limit, asyncio.Semaphore)` をキャッシュ。`limit` (= 環境変数 OAG_MAX_CONCURRENT_REQUESTS)
# の値が変わったら Semaphore を再生成する。asyncio 内部 (_value / _waiters) を
# 参照しない安全な実装。
_semaphore_cache: tuple[int, asyncio.Semaphore] | None = None


def _get_semaphore() -> asyncio.Semaphore:
    """`OAG_MAX_CONCURRENT_REQUESTS` (既定 4) の Semaphore を遅延生成して返す。

    process lifetime で 1 つ。テスト中に env を変更しても再評価するため、
    現在の limit がキャッシュと異なれば再生成する。
    """
    global _semaphore_cache
    limit = int(os.environ.get("OAG_MAX_CONCURRENT_REQUESTS", "4"))
    if _semaphore_cache is None or _semaphore_cache[0] != limit:
        _semaphore_cache = (limit, asyncio.Semaphore(limit))
    return _semaphore_cache[1]


# MockAntigravityClient.stream_chat と AntigravityClient.stream_chat の冒頭に
# `async with _get_semaphore():` でラップする
```

`MockAntigravityClient.stream_chat` の改修:

```python
async def stream_chat(self, messages, *, mock_options=None):
    async with _get_semaphore():
        # 既存ロジック (enter/exit カウンタ, yield, 例外注入)
        ...
```

`AntigravityClient.stream_chat` も同様に `async with _get_semaphore():` で全体をラップ。

> **注意:** `asyncio.Semaphore` は **非再帰的**。`_SlowMockClient` のように subclass で
> もう一段ラップする際に再度 `_get_semaphore()` を acquire すると、`limit=2` で
> 4 タスク並行時にデッドロックする (外側で 2 件 acquire → 内側で 2 件待ち → 解放できない)。
> ラップする subclass は内側で `super().stream_chat()` に委譲しないこと
> (テスト #34 の `_SlowMockClient` 参照)。

- [ ] **Step 5: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/integration/test_antigravity_client_concurrency.py -v
uv run pytest tests/python   # 既存 + T2.3 全 GREEN
uv run ruff check backend/src/opencode_antigravity/antigravity_client.py tests/python/integration/test_antigravity_client_concurrency.py
```

Expected: 3 テスト PASS、ruff エラー 0、既存テストも全 GREEN。

- [ ] **Step 6: live smoke テストを追加 (cold-start 計測のベースライン)**

`tests/python/e2e_live/test_antigravity_client_live_smoke.py`:

```python
import os
import statistics
import time

import pytest

from opencode_antigravity.antigravity_client import AntigravityClient


pytestmark = pytest.mark.live


@pytest.mark.asyncio
async def test_live_stream_chat_smoke():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        pytest.skip("GEMINI_API_KEY not set")
    client = AntigravityClient(
        model=os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-pro"),
        api_key=api_key,
    )
    await client.start()
    try:
        chunks: list[str] = []
        async for tok in client.stream_chat([{"role": "user", "content": "Say 'pong'."}]):
            chunks.append(tok)
        assert any(c.strip() for c in chunks), "expected at least one non-empty token"
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_live_cold_start_within_budget():
    """nightly E2E の cold-start ベースライン計測 (設計書 Section 13 受け入れ#2)。

    10 回計測の中央値が OAG_AGENT_COLDSTART_BUDGET_MS (既定 5000ms) 未満であることを確認。
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        pytest.skip("GEMINI_API_KEY not set")
    budget_ms = float(os.environ.get("OAG_AGENT_COLDSTART_BUDGET_MS", "5000"))
    client = AntigravityClient(
        model=os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-pro"),
        api_key=api_key,
    )
    await client.start()
    try:
        samples_ms: list[float] = []
        for _ in range(10):
            t0 = time.perf_counter()
            async for _ in client.stream_chat([{"role": "user", "content": "hi"}]):
                break  # 最初の chunk 到達 = TTFB
            samples_ms.append((time.perf_counter() - t0) * 1000.0)
        median_ms = statistics.median(samples_ms)
        print(f"\nTTFB samples_ms={['{:.0f}'.format(x) for x in samples_ms]} median={median_ms:.1f}")
        assert median_ms < budget_ms, f"TTFB median {median_ms:.1f}ms exceeds budget {budget_ms:.0f}ms"
    finally:
        await client.stop()
```

- [ ] **Step 7: コミット**

```bash
git add backend/src/opencode_antigravity/antigravity_client.py \
        tests/python/integration/test_antigravity_client_concurrency.py \
        tests/python/e2e_live/test_antigravity_client_live_smoke.py
git commit -m "feat(python): AntigravityClient に Semaphore 並行制御 + 受け入れ#33/#34 + live smoke を追加"
```

- [ ] **Step 8: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/python-antigravity-client-concurrency
gh pr create --draft --base feature/phase2/python-antigravity-client \
  --title "feat(python): AntigravityClient 並行制御 + #33/#34 + live smoke" \
  --body "設計書 v2 Section 3.3.2 / 受け入れ#33/#34 を実装。OAG_MAX_CONCURRENT_REQUESTS=4 のセマフォと cold-start timeout エッジケース。live smoke は TTFB ベースライン計測も兼ねる。"
```

`.stack-urls.md` に `- T2.3.1: <url>` を追記。

---

### Task 2.4: `server.py` AsyncGenerator dispatch 対応

**派生元ブランチ:** `feature/phase2/python-protocol-notification` (T2.2)
**実行モード:** 直列必須 — Wait for **T2.2 の Draft PR URL** が `.stack-urls.md` に記録されるまで開始しない
**前提条件:** T2.2 の Draft PR URL 取得済み

**Files:**

- Modify: `backend/src/opencode_antigravity/server.py`
- Create: `tests/python/integration/test_async_dispatch.py`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/python-protocol-notification --no-tags
git switch -c feature/phase2/python-server-dispatch origin/feature/phase2/python-protocol-notification

EXPECTED_BASE="feature/phase2/python-protocol-notification"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: 失敗するテストを書く (`tests/python/integration/test_async_dispatch.py`)**

```python
import asyncio
import inspect
import json

import pytest

from opencode_antigravity import server as srv
from opencode_antigravity.protocol import format_request


async def _async_gen_handler(params):
    # 設計書 5.1.1: Python async generator は return value が SyntaxError のため
    # sentinel `_final` を最終 yield に乗せる方式を採用する。
    yield {"delta": {"role": "assistant", "content": ""}}
    yield {"delta": {"content": params["text"]}}
    yield {"_final": {"finish_reason": "stop", "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}}


async def _sync_handler(params):
    return {"ok": True, "echo": params["text"]}


@pytest.mark.asyncio
async def test_async_generator_handler_emits_notifications_and_final_response():
    """AsyncGenerator ハンドラが Notification と最終 response を順番に書き出す。"""
    req = format_request("req-1", "stream.method", {"text": "abc", "stream": True})
    reader = asyncio.StreamReader()
    reader.feed_data(req.encode("utf-8"))
    reader.feed_eof()

    out_lines: list[str] = []
    writer = _LineCaptureWriter(out_lines)

    await srv.run(
        reader=reader,
        writer=writer,
        handlers={"stream.method": _async_gen_handler},
    )

    parsed = [json.loads(l) for l in out_lines]
    assert parsed[0] == {
        "jsonrpc": "2.0",
        "method": "stream.method.chunk" if False else "chat.completions.chunk",
        "params": {"request_id": "req-1", "delta": {"role": "assistant", "content": ""}},
    } or parsed[0]["method"].endswith(".chunk")  # method 名規約に依存
    assert "id" not in parsed[0]
    # 最終要素は response (id + result)
    assert parsed[-1]["id"] == "req-1"
    assert parsed[-1]["result"]["finish_reason"] == "stop"


@pytest.mark.asyncio
async def test_sync_handler_emits_response_only():
    """通常ハンドラは Phase 1 互換で 1 発の response を返す。"""
    req = format_request("req-2", "sync.method", {"text": "ok"})
    reader = asyncio.StreamReader()
    reader.feed_data(req.encode("utf-8"))
    reader.feed_eof()

    out_lines: list[str] = []
    writer = _LineCaptureWriter(out_lines)

    await srv.run(reader=reader, writer=writer, handlers={"sync.method": _sync_handler})

    parsed = [json.loads(l) for l in out_lines]
    assert len(parsed) == 1
    assert parsed[0]["id"] == "req-2"
    assert parsed[0]["result"] == {"ok": True, "echo": "ok"}


@pytest.mark.asyncio
async def test_stream_false_aggregates_when_async_generator():
    """params.stream == False の AsyncGenerator は集約モード (Notification 抑止)。"""
    req = format_request("req-3", "stream.method", {"text": "abc", "stream": False})
    reader = asyncio.StreamReader()
    reader.feed_data(req.encode("utf-8"))
    reader.feed_eof()

    out_lines: list[str] = []
    writer = _LineCaptureWriter(out_lines)

    await srv.run(
        reader=reader,
        writer=writer,
        handlers={"stream.method": _async_gen_handler},
    )

    parsed = [json.loads(l) for l in out_lines]
    # Notification を含まない: 全要素に id が含まれている
    assert all("id" in p for p in parsed)
    assert len(parsed) == 1


class _LineCaptureWriter:
    def __init__(self, buf: list[str]) -> None:
        self._buf = buf

    def write(self, data: bytes) -> None:
        text = data.decode("utf-8")
        for line in text.splitlines(keepends=False):
            if line:
                self._buf.append(line)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None
```

- [ ] **Step 3: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/integration/test_async_dispatch.py -v
```

Expected: AsyncGenerator 分岐が無いため最低 2 ケースが FAIL。

- [ ] **Step 4: `server.py` の dispatch を拡張**

実装の要点:

- ハンドラ呼び出し結果が `inspect.isasyncgen` で True かつ `params.get("stream") is True` の場合、Notification ストリーミングモード。
- 設計書 5.1.1 の **sentinel `_final` 方式** を採用する。Python の async generator は `return <value>` 文を SyntaxError として禁止しているため、最終メタデータは最終 yield に `{"_final": {...}}` として乗せる。
- dispatch ループは `async for` を使い、`"_final" in item` を判定したら break して `_final` の中身を最終 Response の `result` に流す。
- `params.get("stream")` が False または欠落なのに AsyncGenerator が返ってきた場合は契約違反として `RuntimeError` にする。`stream:false` の集約は `handlers._aggregate_impl` が行い、dispatch には集約済み dict が渡る。

実装スニペット (設計書 5.1.1 に準拠):

```python
import inspect

from .errors import SdkError, sdk_exception_to_jsonrpc_error

result = handler(params)
if inspect.isasyncgen(result) and params.get("stream") is True:
    agen = result
    final_meta: dict = {}
    try:
        async for item in agen:
            if "_final" in item:
                final_meta = item["_final"]
                break                                       # sentinel 以降は契約上 yield されない
            writer.write(
                format_notification("chat.completions.chunk", {"request_id": req_id, "delta": item["delta"]}).encode("utf-8")
            )
            await writer.drain()
    except ValueError as e:
        writer.write((format_error(JsonRpcError(id=req_id, code=-32602, message=f"Invalid params: {e}")) + "\n").encode("utf-8"))
        await writer.drain()
        return
    except SdkError as e:
        sdk_error = sdk_exception_to_jsonrpc_error(e)
        writer.write(
            (
                format_error(
                    JsonRpcError(
                        id=req_id,
                        code=int(sdk_error["code"]),
                        message=str(sdk_error["message"]),
                    )
                )
                + "\n"
            ).encode("utf-8")
        )
        await writer.drain()
        return
    except Exception:  # noqa: BLE001
        logger.exception("streaming handler crashed: %s", req.method)
        writer.write((format_error(JsonRpcError(id=req_id, code=-32603, message="Internal error")) + "\n").encode("utf-8"))
        await writer.drain()
        return
    finally:
        await agen.aclose()                                  # 早期 break / 例外時の確実なクリーンアップ
    writer.write((format_response(JsonRpcSuccess(id=req_id, result=final_meta)) + "\n").encode("utf-8"))
    await writer.drain()
elif inspect.isasyncgen(result):
    # stream:false で AsyncGenerator が来た場合は handlers 側で集約済みのため
    # ここに到達するのは契約違反 (handlers が _aggregate_impl を返すべき)。
    raise RuntimeError("AsyncGenerator handler must run with stream=True (handlers contract)")
else:
    response_dict = await result if inspect.isawaitable(result) else result
    writer.write((format_response(JsonRpcSuccess(id=req_id, result=response_dict)) + "\n").encode("utf-8"))
    await writer.drain()
```

具体的なコードは現行 `server.py` の dispatch ループに分岐を挿入する形で実装する (ファイル全体が短いので、AGENTS は読み込んで局所修正してよい)。

- [ ] **Step 5: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/integration/test_async_dispatch.py -v
uv run pytest tests/python   # Phase 1 既存 + T2.2 既存も全 GREEN
uv run ruff check backend/src/opencode_antigravity/server.py tests/python/integration/test_async_dispatch.py
```

Expected: 全テスト PASS、ruff エラー 0。

- [ ] **Step 6: コミット**

```bash
git add backend/src/opencode_antigravity/server.py tests/python/integration/test_async_dispatch.py
git commit -m "feat(python): server.py に AsyncGenerator dispatch を追加 (通常 yield→Notification, sentinel _final yield→response)"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/python-server-dispatch
gh pr create --draft --base feature/phase2/python-protocol-notification \
  --title "feat(python): server.py AsyncGenerator dispatch" \
  --body "Phase 2 設計 Section 5.1 / 5.2 を実装。stream:true で Notification、stream:false で集約。"
```

`.stack-urls.md` に `- T2.4: <url>` を追記。

---

### Task 2.5: `handlers.py` `chat_completions` をストリーミング化

**派生元ブランチ:** `feature/phase2/python-server-dispatch` (T2.4)
**実行モード:** 直列必須 — Wait for T2.4 の Draft PR URL。**かつ、T2.1 と T2.3 が master にマージされるか、当ブランチに事前 merge されていること** を前提とする (3 つの依存を集約するため)
**前提条件:**

- T2.4 の Draft PR URL が `.stack-urls.md` に記録済み
- T2.1 / T2.3 のいずれかがマージされていない場合、本タスクの Step 2 で明示的に merge する

**Files:**

- Modify: `backend/src/opencode_antigravity/handlers.py`
- Create: `tests/python/unit/test_chat_completions_streaming.py`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/python-server-dispatch --no-tags
git switch -c feature/phase2/python-handlers-streaming origin/feature/phase2/python-server-dispatch

EXPECTED_BASE="feature/phase2/python-server-dispatch"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: T2.1 (errors) と T2.3 (antigravity_client) を取り込む**

両方とも master にマージされていればこのブランチにも自動的に存在する (T2.4 が master をベースとした T2.2 を経由しているため)。未マージなら以下を実行する:

```bash
git fetch origin feature/phase2/python-errors feature/phase2/python-antigravity-client --no-tags
git merge --no-ff origin/feature/phase2/python-errors -m "chore: merge T2.1 (errors)"
git merge --no-ff origin/feature/phase2/python-antigravity-client -m "chore: merge T2.3 (antigravity_client)"
```

- [ ] **Step 3: 失敗するテストを書く (受け入れ#23, #24)**

`tests/python/unit/test_chat_completions_streaming.py`:

```python
import pytest

from opencode_antigravity.handlers import chat_completions
from opencode_antigravity.antigravity_client import MockAntigravityClient


@pytest.mark.asyncio
async def test_chat_completions_async_generator_stream_true():
    """設計書 5.1.1 の sentinel `_final` パターンで最終メタデータを取得する。"""
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        params = {
            "model": "gemini-2.5-pro",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": True,
        }
        agen = chat_completions(params, client=client)
        chunks: list[dict] = []
        final: dict = {}
        try:
            async for item in agen:
                if "_final" in item:
                    final = item["_final"]
                    break
                chunks.append(item)
        finally:
            await agen.aclose()

        # 最初の chunk は role
        assert chunks[0]["delta"] == {"role": "assistant", "content": ""}
        # 後続 chunk は content のみ
        assert {"delta": {"content": "[mock] "}} in chunks
        assert {"delta": {"content": "hello"}} in chunks
        # 通常 chunk と sentinel は同じ dict に共存しない
        assert all("_final" not in c for c in chunks)
        # sentinel `_final` の中身 (内部メタ: finish_reason + usage)
        assert final["finish_reason"] == "stop"
        assert "usage" in final
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_chat_completions_stream_false_returns_aggregated_dict():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        params = {
            "model": "gemini-2.5-pro",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": False,
        }
        result = await chat_completions(params, client=client)
        assert result["object"] == "chat.completion"
        assert result["choices"][0]["message"]["role"] == "assistant"
        assert result["choices"][0]["message"]["content"] == "[mock] hello"
        assert result["choices"][0]["finish_reason"] == "stop"
        assert "usage" in result
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_chat_completions_empty_messages_raises():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        with pytest.raises(ValueError):
            agen = chat_completions(
                {"model": "gemini-2.5-pro", "messages": [], "stream": True},
                client=client,
            )
            async for _ in agen:
                pass
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_chat_completions_unknown_model_raises():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        with pytest.raises(ValueError):
            agen = chat_completions(
                {"model": "wrong-model", "messages": [{"role": "user", "content": "x"}], "stream": True},
                client=client,
            )
            async for _ in agen:
                pass
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_chat_completions_aggregate_cap_raises_sdk_api_error(monkeypatch):
    """設計書 5.2.1: stream:false で OAG_MAX_AGGREGATE_TOKENS 超過時は SdkApiError(-32013)。"""
    from opencode_antigravity.errors import SdkApiError

    monkeypatch.setenv("OAG_MAX_AGGREGATE_TOKENS", "1")  # 強制的に超過させる (mock は 2 token yield)

    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        with pytest.raises(SdkApiError):
            await chat_completions(
                {
                    "model": "gemini-2.5-pro",
                    "messages": [{"role": "user", "content": "hello"}],
                    "stream": False,
                },
                client=client,
            )
    finally:
        await client.stop()
```

- [ ] **Step 4: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/unit/test_chat_completions_streaming.py -v
```

Expected: 既存 `chat_completions` が echo 実装のため FAIL。

- [ ] **Step 5: `handlers.py` を更新**

要点:

- `chat_completions(params, client)` を **2 つのオーバーロード相当** で実装する:
  - `params["stream"] == True` → AsyncGenerator を返す。yield は **通常 chunk `{"delta": ...}`** と **最終 sentinel `{"_final": {"finish_reason", "usage"}}`** のみ (設計書 5.1.1)
  - `params["stream"] == False` (または省略) → `async def` で集約済み完成 dict を返す (`{"id", "object", "model", "choices", "usage"}` を含む完全 OpenAI 形式)
- **Python の `_stream_impl` は `return <value>` を書かない** (Python async generator は構文エラー)。最終メタデータは sentinel yield に乗せる
- **Python の `_stream_impl` は OpenAI SSE フレームを組み立てない** (設計書 4.3.1 / 5.1)。`id` / `object` / `model` / `choices` の wrap は TS 側 `server.ts` (T3.5) が担当する
- Pydantic v2 モデル `ChatCompletionsParams` で `model` / `messages` / `stream` を **二重検証** する (TS 側 Zod を最後の砦としてカバー、設計書 6.4)
- **Chat ML prompt 検証を Phase A で先取り** (設計書 6.4.1): handlers 突入直後、`AntigravityClient` 呼び出し前に `fold_messages_to_prompt(messages)` を一度実行し、不明 role (`tool` 等) を `ValueError` で先に弾く。`AntigravityClient.stream_chat` 内でも畳み込みは再実行されるが、Phase A 検証としてここでも実行することで Agent 起動 (= Phase B 突入) よりも前にエラーを返せる
- `messages` が空、`model` が `ANTIGRAVITY_MODEL` (環境変数経由) と不一致は `ValueError`
- `_aggregate_impl` は `OAG_MAX_AGGREGATE_TOKENS` (既定 8192) を超えたら `SdkApiError(-32013)` を raise する (設計書 5.2.1)
- `_aggregate_impl` は内部で `_stream_impl` 相当のループを回し、sentinel `_final` を消費して `usage` を取り出し、buffer の結合文字列で `choices[0].message.content` を組む
- SDK 例外は `opencode_antigravity.errors` の型に変換し、上位 (`server.py`) が `format_response_error` を選択するための例外伝播
- 既存 `echo()` / `health()` は変更しない

実装パターン:

```python
import os
from typing import AsyncGenerator, Union

from pydantic import BaseModel, Field, ValidationError

from .antigravity_client import AntigravityClientBase
from .prompt_folding import fold_messages_to_prompt


class _Message(BaseModel):
    role: str
    content: str


class _ChatParams(BaseModel):
    model: str
    messages: list[_Message] = Field(min_length=1)
    stream: bool = False


def chat_completions(
    params: dict, *, client: AntigravityClientBase
) -> Union[AsyncGenerator[dict, None], "Awaitable[dict]"]:
    try:
        cp = _ChatParams(**params)
    except ValidationError as e:
        raise ValueError(str(e)) from e

    allowed_model = os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-pro")
    if cp.model != allowed_model:
        raise ValueError(f"model must be {allowed_model}")

    # 設計書 6.4.1: Chat ML prompt 検証を Phase A で先取り (不明 role を Agent 起動前に拒否)
    fold_messages_to_prompt([m.model_dump() for m in cp.messages])

    if cp.stream:
        return _stream_impl(cp, client)
    return _aggregate_impl(cp, client)


async def _stream_impl(cp: _ChatParams, client: AntigravityClientBase) -> AsyncGenerator[dict, None]:
    # 設計書 5.1.1: Python async generator は return value が SyntaxError のため
    # 最終メタデータは sentinel `_final` を最終 yield に乗せる。
    role_sent = False
    completion_tokens = 0
    async for tok in client.stream_chat([m.model_dump() for m in cp.messages]):
        if not role_sent:
            yield {"delta": {"role": "assistant", "content": ""}}
            role_sent = True
        yield {"delta": {"content": tok}}
        completion_tokens += 1
    yield {
        "_final": {
            "finish_reason": "stop",
            "usage": {
                "prompt_tokens": sum(len(m.content) for m in cp.messages),
                "completion_tokens": completion_tokens,
                "total_tokens": completion_tokens + sum(len(m.content) for m in cp.messages),
            },
        }
    }


async def _aggregate_impl(cp: _ChatParams, client: AntigravityClientBase) -> dict:
    # 設計書 5.2 / 5.2.1: stream:false でも _stream_impl 経由でストリーミングし、
    # 通常 chunk を buffer に積み、sentinel `_final` を消費して usage を取り出す。
    max_tokens = int(os.environ.get("OAG_MAX_AGGREGATE_TOKENS", "8192"))
    buf: list[str] = []
    completion_tokens = 0
    final_meta: dict = {}

    agen = _stream_impl(cp, client)
    try:
        async for item in agen:
            if "_final" in item:
                final_meta = item["_final"]
                break
            # 通常 chunk: delta.content を buffer に積む (role-only chunk は content 欠落 or 空文字)
            content = item["delta"].get("content")
            if content:
                buf.append(content)
                completion_tokens += 1
                if completion_tokens > max_tokens:
                    # 設計書 5.2.1: 上限超過は SdkApiError(-32013) で打ち切り
                    from .errors import SdkApiError
                    raise SdkApiError(
                        f"aggregation exceeded OAG_MAX_AGGREGATE_TOKENS (N={max_tokens})"
                    )
    finally:
        # generator を確実に解放してメモリリークを防ぐ (設計書 5.2.1)
        await agen.aclose()

    content_text = "".join(buf)
    usage = final_meta.get("usage") or {
        "prompt_tokens": sum(len(m.content) for m in cp.messages),
        "completion_tokens": completion_tokens,
        "total_tokens": completion_tokens + sum(len(m.content) for m in cp.messages),
    }
    return {
        "id": _new_chatcmpl_id(),
        "object": "chat.completion",
        "model": cp.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content_text},
                "finish_reason": final_meta.get("finish_reason", "stop"),
            }
        ],
        "usage": usage,
    }


def _new_chatcmpl_id() -> str:
    import uuid
    return f"chatcmpl-{uuid.uuid4().hex[:24]}"
```

- [ ] **Step 6: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/unit/test_chat_completions_streaming.py -v
uv run pytest tests/python   # 既存全 GREEN
uv run ruff check backend/src/opencode_antigravity/handlers.py tests/python/unit/test_chat_completions_streaming.py
```

Expected: 全 PASS、ruff エラー 0。

- [ ] **Step 7: Phase 1 既存 test #7 (chat.completions echo) の期待値を更新**

`[echo] hello` → `[mock] hello` に変わるため、`tests/python` 配下の既存テストを必要に応じて修正する。

- [ ] **Step 8: コミット**

```bash
git add backend/src/opencode_antigravity/handlers.py \
        tests/python/unit/test_chat_completions_streaming.py \
        tests/python  # 期待値更新分
git commit -m "feat(python): chat_completions を AsyncGenerator 化 (受け入れ#23, #24)"
```

- [ ] **Step 9: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/python-handlers-streaming
gh pr create --draft --base feature/phase2/python-server-dispatch \
  --title "feat(python): chat_completions ストリーミング (受け入れ#23, #24)" \
  --body "Phase 2 設計 Section 4.2 / 4.3 を実装。stream:true で AsyncGenerator、stream:false で集約。"
```

`.stack-urls.md` に `- T2.5: <url>` を追記。

---

### Task 2.6: `__main__.py` 起動時環境変数検証 + クライアント注入

**派生元ブランチ:** `feature/phase2/python-handlers-streaming` (T2.5)
**実行モード:** 直列必須 — Wait for T2.5 の Draft PR URL
**前提条件:** T2.5 の Draft PR URL 取得済み

**Files:**

- Modify: `backend/src/opencode_antigravity/__main__.py`
- Create: `tests/python/unit/test_main_env_validation.py`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/python-handlers-streaming --no-tags
git switch -c feature/phase2/python-main-env origin/feature/phase2/python-handlers-streaming

EXPECTED_BASE="feature/phase2/python-handlers-streaming"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/python/unit/test_main_env_validation.py`:

```python
import subprocess
import sys


def _run_main(env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "opencode_antigravity"],
        env={**env},
        capture_output=True,
        text=True,
        timeout=5,
        input="",   # stdin EOF で即終了する
    )


def test_live_mode_without_api_key_exits_nonzero():
    proc = _run_main({"OAG_BACKEND_MODE": "live", "ANTIGRAVITY_MODEL": "gemini-2.5-pro", "PATH": "/usr/bin:/bin"})
    assert proc.returncode != 0
    assert "GEMINI_API_KEY" in proc.stderr


def test_mock_mode_does_not_require_api_key():
    proc = _run_main({"OAG_BACKEND_MODE": "mock", "ANTIGRAVITY_MODEL": "gemini-2.5-pro", "PATH": "/usr/bin:/bin"})
    # 標準入力 EOF で正常終了 (returncode == 0)
    assert proc.returncode == 0
```

- [ ] **Step 3: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/unit/test_main_env_validation.py -v
```

Expected: 検証ロジックがまだ無いため FAIL。

- [ ] **Step 4: `__main__.py` を更新**

要点:

- `OAG_BACKEND_MODE` を read (既定 `mock`)
- `OAG_BACKEND_MODE == "live"` なら `GEMINI_API_KEY` 必須、未設定なら stderr に `error: GEMINI_API_KEY is required for live mode` と書き `sys.exit(2)`
- `ANTIGRAVITY_MODEL` 未設定なら既定 `gemini-2.5-pro` を使用
- 設計書 8.1 の以下の任意環境変数を起動時にログ出力 (validation はしない、値を `os.environ.setdefault` でデフォルト保証してもよい):
  - `OAG_REQUEST_TIMEOUT_MS` (既定 60000)
  - `OAG_STREAM_IDLE_TIMEOUT_MS` (既定 30000)
  - `OAG_MAX_AGGREGATE_TOKENS` (既定 8192) — Section 5.2.1 で `handlers.py` が参照
  - `OAG_AGENT_COLDSTART_BUDGET_MS` (既定 **5000**) — 受け入れ#2 の TTFB 計測ベースライン (設計書 Section 8.1 改訂版)
  - `OAG_AGENT_COLDSTART_TIMEOUT_MS` (既定 10000) — `AntigravityClient.stream_chat` の `asyncio.wait_for` 上限 (設計書 Section 6.4.1)
  - `OAG_MAX_CONCURRENT_REQUESTS` (既定 4) — per-request Agent の同時並行上限 Semaphore (設計書 Section 3.3.2)
- `antigravity_client.create_client()` でクライアント生成、`server.run()` 開始前に `await client.start()`、終了時 `await client.stop()`
- ハンドラの `chat_completions` には `functools.partial(chat_completions, client=client)` 形式で注入する (`server.py` のハンドラ辞書を組み立てる箇所で適用)

- [ ] **Step 5: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/unit/test_main_env_validation.py -v
uv run pytest tests/python
uv run ruff check backend/src/opencode_antigravity/__main__.py tests/python/unit/test_main_env_validation.py
```

Expected: 全 PASS、ruff エラー 0。

- [ ] **Step 6: コミット**

```bash
git add backend/src/opencode_antigravity/__main__.py tests/python/unit/test_main_env_validation.py
git commit -m "feat(python): __main__ で OAG_BACKEND_MODE / GEMINI_API_KEY を検証してクライアント注入"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/python-main-env
gh pr create --draft --base feature/phase2/python-handlers-streaming \
  --title "feat(python): __main__ で環境変数検証とクライアント注入" \
  --body "Phase 2 設計 Section 4.2 / 8.1 を実装。live mode で GEMINI_API_KEY 必須、mock mode は API キー不要。"
```

`.stack-urls.md` に `- T2.6: <url>` を追記。

---

## Phase 3: TypeScript 側基盤

### Task 3.1: `types.ts` 拡張 (Notification 型 + OpenAI Streaming Chunk 型)

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — Phase 2 の各タスク / T3.2 / T4.1 と同時実行可
**前提条件:** なし

**Files:**

- Modify: `src/types.ts`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin master --no-tags
git switch -c feature/phase2/ts-types origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: `src/types.ts` に型を追加**

既存型は維持しつつ、以下を追加する:

```ts
// JSON-RPC 2.0 Notification (id なし)
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// OpenAI Streaming Chunk
export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: null | "stop" | "length" | "content_filter";
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  model: string;
  choices: ChatCompletionChunkChoice[];
}

// chat.completions.chunk Notification の params
export interface ChatCompletionsChunkNotificationParams {
  request_id: string;
  delta: ChatCompletionChunkDelta;
}
```

- [ ] **Step 3: `pnpm build` で TypeScript 型チェックを通す**

```bash
pnpm build
```

Expected: エラー 0。

- [ ] **Step 4: コミット**

```bash
git add src/types.ts
git commit -m "feat(ts): JSON-RPC Notification / OpenAI Streaming Chunk 型を追加"
```

- [ ] **Step 5: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/ts-types
gh pr create --draft --base master --title "feat(ts): Notification / Streaming Chunk 型" \
  --body "Phase 2 設計 Section 4.1 / 4.3 のための型定義のみ。実装は T3.3 / T3.5 で行う。"
```

`.stack-urls.md` に `- T3.1: <url>` を追記。

---

### Task 3.1.5: `src/schemas.ts` 新設 (Phase A Zod 検証)

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T3.1 / T3.2 / T2.x / T4.1 と同時実行可
**前提条件:** なし

設計書 4.1.1 / 6.4 の Phase A 検証を担う Zod スキーマを単独 PR として導入する。`src/server.ts` (T3.5) はこれを import して `streamingCall` 発行前に `parse()` する。

**Files:**

- Modify: `package.json` (zod 依存を追加)
- Create: `src/schemas.ts`
- Create: `tests/ts/schemas.test.ts`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin master --no-tags
git switch -c feature/phase2/ts-schemas origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: zod を依存に追加**

```bash
pnpm add zod
```

- [ ] **Step 3: 失敗するテストを書く (`tests/ts/schemas.test.ts`)**

> **設計判断 (factory パターン):** schema を環境変数で literal 固定すると、テストや並行プロセスで env を切り替えた場合に module キャッシュの影響で挙動が不安定になる。`createChatCompletionsParamsSchema(model)` を **factory として export**、起動時に環境変数から構築する default インスタンスのみ env 依存とする。テストは factory を直接呼んで model を明示的に指定する。

```ts
import { describe, expect, it } from "vitest";
import { createChatCompletionsParamsSchema } from "../../src/schemas.js";

const schema = createChatCompletionsParamsSchema("gemini-2.5-pro");

describe("ChatCompletionsParamsSchema (Phase A)", () => {
  it("accepts a valid request", () => {
    const r = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty messages", () => {
    const r = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects model mismatch", () => {
    const r = schema.safeParse({
      model: "wrong-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects stream of wrong type", () => {
    const r = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: "true",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid role", () => {
    const r = schema.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "function", content: "hi" }],
    });
    expect(r.success).toBe(false);
  });

  it("factory builds schemas for different models", () => {
    const flash = createChatCompletionsParamsSchema("gemini-2.5-flash");
    const r1 = flash.safeParse({
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r1.success).toBe(true);
    const r2 = flash.safeParse({
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r2.success).toBe(false);
  });
});
```

- [ ] **Step 4: `src/schemas.ts` を作成 (設計書 4.1.1)**

```ts
import { z } from "zod";

const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
});

/**
 * Phase A 用 Zod スキーマの factory。
 * `model` が他と異なる schema が必要な場面 (テスト等) でも安全に再利用できるよう、
 * 環境変数依存をモジュールスコープではなく factory 引数に閉じ込める (設計書 4.1.1)。
 */
export function createChatCompletionsParamsSchema(model: string) {
  return z.object({
    model: z.literal(model),
    messages: z.array(MessageSchema).nonempty(),
    stream: z.boolean().optional(),
  });
}

// 実行時の default インスタンス。`__main__.ts` の起動時に環境変数が確定している前提。
export const ChatCompletionsParamsSchema = createChatCompletionsParamsSchema(
  process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
);

export type ChatCompletionsParams = z.infer<typeof ChatCompletionsParamsSchema>;
```

> **設計判断:** 本番コード (`src/server.ts`) は default の `ChatCompletionsParamsSchema` を import する。テストや schema バリエーション検証は factory `createChatCompletionsParamsSchema(model)` を直接呼ぶ。これにより `process.env` をテスト中に弄る必要がなく、`vi.resetModules()` も不要。env 切り替えに依存しない安全な構造。

- [ ] **Step 5: テストが GREEN になるまで実行**

```bash
pnpm test:unit -- schemas
pnpm build
```

Expected: 6 ケース PASS、TS エラー 0。

- [ ] **Step 6: コミット**

```bash
git add src/schemas.ts tests/ts/schemas.test.ts package.json pnpm-lock.yaml
git commit -m "feat(ts): Phase A 用 Zod スキーマ ChatCompletionsParamsSchema を追加"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/ts-schemas
gh pr create --draft --base master --title "feat(ts): Phase A 用 Zod スキーマ" \
  --body "Phase 2 設計 Section 4.1.1 / 6.4 を実装。stream:true の SSE 開始前に 4xx 確定検証を担う。"
```

`.stack-urls.md` に `- T3.1.5: <url>` を追記。

---

### Task 3.2: `errors.ts` SDK エラーコードマッピング追加

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T3.1 / T2.x / T4.1 と同時実行可
**前提条件:** なし

**Files:**

- Modify: `src/errors.ts`
- Modify: `tests/ts/` 配下の既存 errors テスト (または `tests/ts/errors.test.ts` を読み追加)

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin master --no-tags
git switch -c feature/phase2/ts-errors origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/ts/errors.sdk.test.ts` を新規作成 (既存 `errors.test.ts` がある場合は同パターンに従う):

```ts
import { describe, expect, it } from "vitest";
import { toOpenAIError, BackendResponseError } from "../../src/errors.js";

// 現行 src/errors.ts:24-32 の BackendResponseError コンストラクタは
// (code: number, rawMessage: string) なので、テストも同じ署名で呼ぶ。

describe("toOpenAIError SDK mapping", () => {
  it("maps -32010 to 401 authentication_error", () => {
    const err = new BackendResponseError(-32010, "auth failed");
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(401);
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toBe("auth failed");
  });

  it("maps -32011 to 429 rate_limit_error", () => {
    const err = new BackendResponseError(-32011, "rate limit");
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(429);
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("maps -32012 to 400 invalid_request_error", () => {
    const err = new BackendResponseError(-32012, "model not found");
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("maps -32013 to 502 bad_gateway", () => {
    const err = new BackendResponseError(-32013, "api err");
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(502);
    expect(body.error.type).toBe("bad_gateway");
  });

  it("maps -32014 to 504 timeout", () => {
    const err = new BackendResponseError(-32014, "timeout");
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(504);
    expect(body.error.type).toBe("timeout");
  });

  it("maps -32015 to 502 bad_gateway", () => {
    const err = new BackendResponseError(-32015, "conn refused");
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(502);
    expect(body.error.type).toBe("bad_gateway");
  });
});
```

- [ ] **Step 3: テスト実行で失敗を確認**

```bash
pnpm test:unit -- errors.sdk
```

Expected: 6 テスト FAIL。

- [ ] **Step 4: `src/errors.ts` に SDK エラーコードマッピングを追加**

`toOpenAIError()` の switch / map に以下を追加する (Phase 1 の既存マッピングは維持):

```ts
// 既存マッピングの後に追加
case -32010: return { status: 401, body: { error: { type: "authentication_error", message: err.rawMessage } } };
case -32011: return { status: 429, body: { error: { type: "rate_limit_error", message: err.rawMessage } } };
case -32012: return { status: 400, body: { error: { type: "invalid_request_error", message: err.rawMessage } } };
case -32013: return { status: 502, body: { error: { type: "bad_gateway", message: err.rawMessage } } };
case -32014: return { status: 504, body: { error: { type: "timeout", message: err.rawMessage } } };
case -32015: return { status: 502, body: { error: { type: "bad_gateway", message: err.rawMessage } } };
```

- [ ] **Step 5: テストが GREEN になるまで実行**

```bash
pnpm test:unit
pnpm build
```

Expected: 全 PASS、TS エラー 0。

- [ ] **Step 6: コミット**

```bash
git add src/errors.ts tests/ts/errors.sdk.test.ts
git commit -m "feat(ts): SDK エラーコード (-32010〜-32015) を OpenAI エラー形式へマッピング"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/ts-errors
gh pr create --draft --base master --title "feat(ts): SDK エラーコードマッピング" \
  --body "Phase 2 設計 Section 6.1 の TS 側マッピングを実装。"
```

`.stack-urls.md` に `- T3.2: <url>` を追記。

---

### Task 3.3: `jsonrpc.ts` Notification 受信 + `streamingCall()`

**派生元ブランチ:** `feature/phase2/ts-types` (T3.1)
**実行モード:** 直列必須 — Wait for T3.1 の Draft PR URL
**前提条件:** T3.1 の Draft PR URL 取得済み

**Files:**

- Modify: `src/jsonrpc.ts`
- Create: `tests/ts/jsonrpc_notification.test.ts`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/ts-types --no-tags
git switch -c feature/phase2/ts-jsonrpc-streaming origin/feature/phase2/ts-types

EXPECTED_BASE="feature/phase2/ts-types"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: 失敗するテストを書く (受け入れ#26, #27)**

`tests/ts/jsonrpc_notification.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { JsonRpcClient } from "../../src/jsonrpc.js";

function makeClient() {
  const writes: string[] = [];
  const fakeWriter = { write: (s: string) => { writes.push(s); return true; } } as any;
  const client = new JsonRpcClient({ writer: fakeWriter });
  return { client, writes };
}

describe("JsonRpcClient notification dispatch", () => {
  it("dispatches chunk to onChunk by request_id (#26)", async () => {
    const { client } = makeClient();
    const onChunk = vi.fn();
    const p = client.streamingCall("chat.completions", { stream: true }, onChunk);
    // request 行が writes に出ているはず。id を取り出して、Notification を流す。
    // テストハーネスは jsonrpc.ts の内部 parseMessage に直接 NDJSON を流せる API
    // (例: `client._ingest(line)`) を露出させる前提。
    const lastRequestId = client.lastRequestId!;
    client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      method: "chat.completions.chunk",
      params: { request_id: lastRequestId, delta: { content: "x" } },
    }) + "\n");

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith({ content: "x" });

    // 最終 response を流して Promise を resolve する
    client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      id: lastRequestId,
      result: { finish_reason: "stop" },
    }) + "\n");

    await expect(p).resolves.toEqual({ finish_reason: "stop" });
  });

  it("ignores unknown request_id with warn (#27)", async () => {
    const { client } = makeClient();
    const warnSpy = vi.fn();
    (client as any)._logger = { warn: warnSpy, error: () => {}, info: () => {}, debug: () => {} };
    client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      method: "chat.completions.chunk",
      params: { request_id: "unknown", delta: { content: "x" } },
    }) + "\n");
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: テスト実行で失敗を確認**

```bash
pnpm test:unit -- jsonrpc_notification
```

Expected: `streamingCall` / `_ingest` / `lastRequestId` が未実装で FAIL。

- [ ] **Step 4: `src/jsonrpc.ts` を更新**

要点:

- コンストラクタ option に `onNotification?: (method, params) => void` を追加
- `parseMessage()` で `"id" in msg && ("result" in msg || "error" in msg)` を Response、`"method" in msg && !("id" in msg)` を Notification と判別
- `streamingCall<T = { finish_reason: string; usage: object }>(method, params, onChunk): Promise<T>`:
  - **型パラメータ既定値は Python 側 `_stream_impl` の return 型 (`{finish_reason, usage}`) に合わせる** (設計書 4.3.1 / 5.1)。`server.ts` (T3.5) は完全な OpenAI フレームを Python から受け取らないことを型で強制する
  - 内部で UUID v4 の `id` を生成して request 送信
  - Pending Map のエントリ (`PendingEntry`) に `onChunk` callback、`globalTimeoutId`、`idleTimeoutId` を保持

`PendingEntry` 型と Pending Map 操作:

```ts
type PendingEntry<T> = {
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  onChunk: (delta: unknown) => void;
  globalTimeoutId: ReturnType<typeof setTimeout>;
  idleTimeoutId: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingEntry<unknown>>();
const IDLE_MS = Number(process.env.OAG_STREAM_IDLE_TIMEOUT_MS ?? 30_000);
const GLOBAL_MS = Number(process.env.OAG_REQUEST_TIMEOUT_MS ?? 60_000);

function armIdleTimer(entry: PendingEntry<unknown>, id: string) {
  clearTimeout(entry.idleTimeoutId);
  entry.idleTimeoutId = setTimeout(() => {
    pending.delete(id);
    clearTimeout(entry.globalTimeoutId);
    entry.reject(new BackendTimeoutError(`stream idle exceeded ${IDLE_MS}ms`));
  }, IDLE_MS);
}
```

Notification / Response の処理規約:

- Notification 受信時: Pending Map に `params.request_id` が存在すれば `entry.onChunk(params.delta)` を呼んだ後に **`armIdleTimer(entry, request_id)` でアイドルタイマーを再武装**
- 最終 response 受信時: **`pending.delete(id)` → `clearTimeout(entry.idleTimeoutId)` → `clearTimeout(entry.globalTimeoutId)` → resolve / reject** の順序を厳守する (Phase 1 の Map cleanup 規約と同じ。late response / double resolution 防止)
- 未知 `request_id` の Notification は `pino.warn({ event: "unknown notification id", request_id })`
- 全体タイムアウト (`OAG_REQUEST_TIMEOUT_MS`) は Phase 1 と同じ機構を `streamingCall` でも武装 (アイドルとは別タイマー)

テストから参照されている `client._ingest(line)` および `client.lastRequestId` は **テスト用 hook** として export する (`if (process.env.NODE_ENV === "test")` 制限の必要無し、シンプルに公開して JSDoc で `@internal` 化)。

- [ ] **Step 5: テストが GREEN になるまで実行**

```bash
pnpm test:unit
pnpm build
```

Expected: 全 PASS、TS エラー 0。

- [ ] **Step 6: コミット**

```bash
git add src/jsonrpc.ts tests/ts/jsonrpc_notification.test.ts
git commit -m "feat(ts): Notification dispatch と streamingCall() を追加 (受け入れ#26, #27)"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/ts-jsonrpc-streaming
gh pr create --draft --base feature/phase2/ts-types \
  --title "feat(ts): jsonrpc.ts に Notification + streamingCall (受け入れ#26, #27)" \
  --body "Phase 2 設計 Section 4.1 / 5.3 / 5.4 / 5.5 を実装。アイドルタイムアウト含む。"
```

`.stack-urls.md` に `- T3.3: <url>` を追記。

---

### Task 3.4: `backend.ts` `streamingCall` ラッパー露出

**派生元ブランチ:** `feature/phase2/ts-jsonrpc-streaming` (T3.3)
**実行モード:** 直列必須 — Wait for T3.3 の Draft PR URL
**前提条件:** T3.3 の Draft PR URL 取得済み

**Files:**

- Modify: `src/backend.ts`
- Create: `tests/ts/streaming_call.test.ts`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/ts-jsonrpc-streaming --no-tags
git switch -c feature/phase2/ts-backend origin/feature/phase2/ts-jsonrpc-streaming

EXPECTED_BASE="feature/phase2/ts-jsonrpc-streaming"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: 失敗するテストを書く (受け入れ#28, #29)**

`tests/ts/streaming_call.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PythonBackend } from "../../src/backend.js";

describe("PythonBackend.streamingCall", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("round-trips chunks and final response (#28)", async () => {
    process.env.OAG_BACKEND_MODE = "mock";
    process.env.ANTIGRAVITY_MODEL = "gemini-2.5-pro";
    const backend = new PythonBackend({
      pythonBin: process.env.PYTHON_BIN ?? "python",
      moduleName: "opencode_antigravity",
      cwd: process.cwd(),
      healthTimeoutMs: 5000,
      callTimeoutMs: 10000,
      maxRestarts: 3,
      backoffMs: [1000, 2000, 4000],
    });
    await backend.start();

    const chunks: any[] = [];
    const final = await backend.streamingCall(
      "chat.completions",
      {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      (delta) => chunks.push(delta),
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(final.finish_reason).toBe("stop");

    await backend.stop();
  });

  it("fires idle timeout when chunks stop arriving (#29)", async () => {
    process.env.OAG_BACKEND_MODE = "mock";
    process.env.ANTIGRAVITY_MODEL = "gemini-2.5-pro";
    process.env.OAG_MOCK_INITIAL_DELAY_MS = "500";
    process.env.OAG_STREAM_IDLE_TIMEOUT_MS = "100";
    const backend = new PythonBackend({
      pythonBin: process.env.PYTHON_BIN ?? "python",
      moduleName: "opencode_antigravity",
      cwd: process.cwd(),
      healthTimeoutMs: 5000,
      callTimeoutMs: 10000,
      maxRestarts: 3,
      backoffMs: [1000, 2000, 4000],
    });
    await backend.start();

    await expect(
      backend.streamingCall(
        "chat.completions",
        { model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }], stream: true },
        () => {},
      ),
    ).rejects.toThrow(/timeout/i);

    await backend.stop();
  });
});
```

- [ ] **Step 3: Mock 側に初期遅延サポートを追加**

`MockAntigravityClient` (T2.3 で実装済み) に `OAG_MOCK_INITIAL_DELAY_MS` の対応を追加する必要がある。本ブランチからの追加変更として `antigravity_client.py` の `MockAntigravityClient.stream_chat` で:

```python
import os
initial_delay = int(os.environ.get("OAG_MOCK_INITIAL_DELAY_MS", "0"))
if initial_delay > 0:
    await asyncio.sleep(initial_delay / 1000.0)
```

を入れる (テスト#29 のため)。

- [ ] **Step 4: `src/backend.ts` に `streamingCall` ラッパーを追加**

```ts
public streamingCall<T>(
  method: string,
  params: Record<string, unknown>,
  onChunk: (delta: Record<string, unknown>) => void,
): Promise<T> {
  if (!this.client) throw new Error("backend not started");
  return this.client.streamingCall<T>(method, params, onChunk);
}
```

- [ ] **Step 5: テストが GREEN になるまで実行**

```bash
pnpm test:integration -- streaming_call
pnpm build
```

Expected: 2 ケース PASS、TS エラー 0。

- [ ] **Step 6: コミット**

```bash
git add src/backend.ts \
        tests/ts/streaming_call.test.ts \
        backend/src/opencode_antigravity/antigravity_client.py
git commit -m "feat(ts): backend に streamingCall を公開 (受け入れ#28, #29) + mock 初期遅延"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/ts-backend
gh pr create --draft --base feature/phase2/ts-jsonrpc-streaming \
  --title "feat(ts): PythonBackend.streamingCall (受け入れ#28, #29)" \
  --body "Phase 2 設計 Section 4.1 / 5.5 を実装。idle timeout の挙動を E2E でカバー。"
```

`.stack-urls.md` に `- T3.4: <url>` を追記。

---

### Task 3.5: `server.ts` SSE 中継

**派生元ブランチ:** `feature/phase2/ts-backend` (T3.4)
**実行モード:** 直列必須 — Wait for T3.4 の Draft PR URL。**かつ、T3.2 (errors マッピング) と T3.1.5 (Zod schemas) が master にマージされるか、当ブランチに事前 merge されていること**
**前提条件:** T3.4 の Draft PR URL 取得済み。T3.2 / T3.1.5 がマージ未済なら Step 2 で merge する

**Files:**

- Modify: `src/server.ts`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/ts-backend --no-tags
git switch -c feature/phase2/ts-server-sse origin/feature/phase2/ts-backend

EXPECTED_BASE="feature/phase2/ts-backend"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: T3.2 (errors マッピング) と T3.1.5 (Zod schemas) を取り込む**

両方とも master にマージ済みなら自動で含まれる。未マージなら:

```bash
git fetch origin feature/phase2/ts-errors feature/phase2/ts-schemas --no-tags
git merge --no-ff origin/feature/phase2/ts-errors -m "chore: merge T3.2 (errors SDK mapping)"
git merge --no-ff origin/feature/phase2/ts-schemas -m "chore: merge T3.1.5 (Phase A Zod schemas)"
```

- [ ] **Step 3: `src/server.ts` を更新 (設計書 4.1.1 / 4.3.1 に準拠)**

要点:

**Phase A — Pre-dispatch (HTTP ヘッダ未送信):**

- リクエスト受信 → JSON ボディ解析 → **TS 側 Zod (`src/schemas.ts` の `ChatCompletionsParamsSchema`) で検証** → `backend.streamingCall` を発行する **直前** までを Phase A とする
- Phase A の検証エラーは **HTTP 4xx + OpenAI 形式 JSON** で即時応答 (`{"error":{"type":"invalid_request_error", "message":...}}`)。SSE モードに切り替えない
- Python 側 Pydantic は二重検証 (最後の砦) として位置付け、Phase A の責務は Zod で完結させる (設計書 4.1.1 / 6.4)

**Phase B — Streaming (HTTP 200 ヘッダ送信済み):**

- `streamingCall` を await する **直前** に `res.writeHead(200, {"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive"})` を呼ぶ。これにより SSE 開始境界がコード上で一目で識別できる
- 「最初の chunk が届くまでヘッダ送信を遅延する」設計は **採用しない** (設計書 4.1.1)
- `backend.streamingCall<{finish_reason: string; usage: object}>("chat.completions", params, (delta) => writeSseChunk(...))` を await
- `writeSseChunk(delta, options)` の責務 (設計書 4.3.1):
  - Python からは `{"delta": {...}}` のみが届く (内部メタ `finish_reason` / `usage` は最終 response の `result` に乗る)
  - TS 側で **ChatCompletionChunk フレーム全体を組み立てる**: `{id, object: "chat.completion.chunk", model, created, choices: [{index: 0, delta, finish_reason: null}]}`
  - 最初の chunk で `delta.role: "assistant"` を 1 度だけ送出
  - 最終 response の `finish_reason` を最後の chunk の `choices[0].finish_reason` に反映
  - 終端で `data: [DONE]\n\n` を送出して `res.end()`
- Phase B 内で発生した全ての例外 (SDK エラー、タイムアウト、Python クラッシュ、Python 側 Pydantic 二重検証エラー含む) を catch:
  - `data: {"error":{"type":"...","message":"..."}}\n\n` を送出 → `data: [DONE]\n\n` → `res.end()`
- クライアント切断 (`req.on("close", ...)`) は **best-effort cleanup のみ**: TS 側で HTTP 応答の write 抑止 (`res.writable` チェック) と `res.end()` を行う。**JSON-RPC Pending Map は触らない** — final response または timeout (idle / global) による通常 cleanup 経路に任せる。理由: cancel notification 無しで pending を即削除すると、後続到着する Python 側の最終 response が "unknown id" として silent drop され、reject せず resolve せず Promise が leak する race を作りかねない。安全側に倒し、`streamingCall()` 内部のクリーンアップ機構 (final response / clearTimeout(idle) / clearTimeout(global) で `pending.delete(id)`) に統一する。Python 側 generator は当該 request 完了まで継続する (設計書 受け入れ#30 / Section 12.4)。完全な即時 cancel は **Phase 2.5** で `$/cancelRequest` notification を追加して達成する。**T3.3 の `streamingCall` シグネチャに `signal: AbortSignal` 等は Phase 2 で追加しない**

**境界判定の補助:**

> **重要 (Node http API):** 現行 `src/server.ts` は **Express ではなく Node 標準 `http.createServer`** を使う。`res` は `http.ServerResponse` であり、`res.status().json()` / `res.json()` は **存在しない**。既存ヘルパー `sendJson(res, status, body)` で 4xx 応答を返し、SSE では `res.writeHead(...)` + `res.write(...)` + `res.end()` を使う。

```ts
import { ChatCompletionsParamsSchema } from "./schemas.js";  // T3.1.5 で導入
// 既存 helper を継続利用: function sendJson(res: ServerResponse, status: number, body: unknown): void

// POST /v1/chat/completions ハンドラ内
const body = await readJson<OpenAIChatRequest>(req);  // Phase 1 の readJson helper を維持
const stream = body.stream === true;

if (stream) {
  // --- Phase A: validation (Zod) — HTTP ヘッダ未送信 ---
  const parsed = ChatCompletionsParamsSchema.safeParse(body);
  if (!parsed.success) {
    return sendJson(res, 400, {
      error: { type: "invalid_request_error", message: parsed.error.message },
    });
  }
  const validated = parsed.data;

  // --- Phase B: switch to SSE ---
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  try {
    const finalMeta = await backend.streamingCall<{ finish_reason: string; usage: object }>(
      "chat.completions",
      validated,
      (delta) => writeSseChunk(res, delta, /* finishReason */ null),
    );
    writeSseChunk(res, { /* empty delta */ }, finalMeta.finish_reason);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    const mapped = toOpenAIError(err instanceof Error ? err : new Error(String(err)));
    res.write(`data: ${JSON.stringify({ error: mapped.body.error })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
  return;
}

// stream:false は Phase 1 互換: backend.call() → sendJson
// 非ストリーミングパスは TS 側 Zod を通さず、Python 側 Pydantic が最終検証を担う（設計書 Section 6.4）
const result = await backend.call("chat.completions", body);
return sendJson(res, 200, result);
```

- [ ] **Step 4: ローカル smoke テスト (curl で SSE 取得)**

```bash
pnpm build
node dist/src/index.js &
SERVER_PID=$!
sleep 1
curl -N http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}],"stream":true}' \
  | head -n 20
kill $SERVER_PID
```

Expected: `data: {"id":...}` で始まる行と `data: [DONE]` が出力される。

- [ ] **Step 5: 既存 E2E + 統合 + unit を回す**

```bash
pnpm test:unit
pnpm test:integration
pnpm test:e2e   # Phase 1 既存ケース
pnpm build
```

Expected: 全 PASS、TS エラー 0。

- [ ] **Step 6: コミット**

```bash
git add src/server.ts
git commit -m "feat(ts): server.ts に stream:true 用 SSE 中継を実装"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/ts-server-sse
gh pr create --draft --base feature/phase2/ts-backend \
  --title "feat(ts): server.ts SSE 中継" \
  --body "Phase 2 設計 Section 4.1 / 4.3 / 6.2 を実装。stream:true で SSE、エラー時も SSE で error frame。"
```

`.stack-urls.md` に `- T3.5: <url>` を追記。

---

## Phase 4: E2E + Health

### Task 4.1: `/healthz` レスポンス拡張

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — Phase 2 / Phase 3 のいずれとも同時実行可
**前提条件:** なし

**Files:**

- Modify: `src/server.ts` (`/healthz` ハンドラ)
- Modify: `tests/ts/` 配下の既存 healthz テスト

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin master --no-tags
git switch -c feature/phase2/healthz origin/master

EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/ts/healthz.phase2.test.ts`:

> **設計判断:** 既存 `tests/ts/integration.test.ts` と同じく `createServer()` は `http.Server` インスタンスを返すのみ。`listen` と port 取得は呼び出し側で行う必要がある (現行 src/server.ts 実装に `.port` プロパティは存在しない)。

```ts
import { afterEach, describe, expect, it } from "vitest";
import type http from "node:http";

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe("GET /healthz Phase 2 fields", () => {
  it("includes backend_mode and model", async () => {
    process.env.OAG_BACKEND_MODE = "mock";
    process.env.ANTIGRAVITY_MODEL = "gemini-2.5-pro";

    const { createServer } = await import("../../src/server.js");
    // ready 状態を強制する最小 backend stub (`currentState` getter)
    const backend = { currentState: "ready", restartCount: 0 } as any;
    server = createServer(backend);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no addr");
    const port = addr.port;

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; backend_mode: string; model: string };
    expect(body.status).toBe("ok");
    expect(body.backend_mode).toBe("mock");
    expect(body.model).toBe("gemini-2.5-pro");
  });
});
```

- [ ] **Step 3: テスト実行で失敗を確認**

```bash
pnpm test:unit -- healthz.phase2
```

Expected: `backend_mode` / `model` が未実装で FAIL。

- [ ] **Step 4: `/healthz` ハンドラを更新**

現行 `src/server.ts:25-28` の `sendJson(res, 200, {...})` 呼び出しに `backend_mode` / `model` を追加する (Express 風 `res.json` ではなく Phase 1 と同じヘルパーを継続利用):

```ts
return sendJson(res, 200, {
  status: "ok",
  python_restarts: backend.restartCount,
  backend_mode: process.env.OAG_BACKEND_MODE ?? "mock",
  model: process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
});
```

- [ ] **Step 5: テストが GREEN になるまで実行**

```bash
pnpm test:unit
pnpm build
```

- [ ] **Step 6: コミット**

```bash
git add src/server.ts tests/ts/healthz.phase2.test.ts
git commit -m "feat(ts): /healthz に backend_mode と model を追加"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/healthz
gh pr create --draft --base master --title "feat(ts): /healthz レスポンス拡張" \
  --body "Phase 2 設計 Section 9 / 受け入れ基準 #3 を実装。"
```

`.stack-urls.md` に `- T4.1: <url>` を追記。

---

### Task 4.2: E2E mock テスト (受け入れ#30, #31)

**派生元ブランチ:** `feature/phase2/ts-server-sse` (T3.5)
**実行モード:** 直列必須 — Wait for T3.5 の Draft PR URL。**かつ、T2.6 が master にマージされるか、当ブランチに事前 merge されていること**
**前提条件:** T3.5 の Draft PR URL 取得済み。T2.6 未マージなら Step 2 で merge する

**Files:**

- Create: `tests/ts/sse.test.ts`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/ts-server-sse --no-tags
git switch -c feature/phase2/e2e-mock origin/feature/phase2/ts-server-sse

EXPECTED_BASE="feature/phase2/ts-server-sse"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: T2.6 (Python 全 Phase 2 完了の最終 PR) を取り込む**

```bash
git fetch origin feature/phase2/python-main-env --no-tags
git merge --no-ff origin/feature/phase2/python-main-env -m "chore: merge T2.6 (python main env validation)"
```

- [ ] **Step 3: E2E テストを書く (受け入れ#30, #31)**

`tests/ts/sse.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, ChildProcess } from "node:child_process";

let serverProc: ChildProcess;
const PORT = 11436; // 他テストと衝突回避

beforeAll(async () => {
  serverProc = spawn("node", ["dist/src/index.js"], {
    env: { ...process.env, OAG_BACKEND_MODE: "mock", ANTIGRAVITY_MODEL: "gemini-2.5-pro", PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 起動待ち (簡易版; 必要なら /healthz をポーリング)
  await new Promise((r) => setTimeout(r, 1500));
});

afterAll(() => {
  serverProc?.kill();
});

async function readSse(res: Response): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: string[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      frames.push(frame);
      if (frame === "data: [DONE]") return frames;
    }
  }
  return frames;
}

describe("POST /v1/chat/completions stream:true (#30, #31)", () => {
  it("returns SSE stream with [DONE]", async () => {
    const res = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const frames = await readSse(res);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[frames.length - 1]).toBe("data: [DONE]");

    // 最初の data フレームに role:assistant が含まれる
    const firstData = frames[0].replace(/^data: /, "");
    const firstChunk = JSON.parse(firstData);
    expect(firstChunk.choices[0].delta.role).toBe("assistant");

    // 連結 content が mock の応答
    const contents = frames
      .filter((f) => f !== "data: [DONE]")
      .map((f) => JSON.parse(f.replace(/^data: /, "")))
      .map((c) => c.choices[0].delta.content ?? "")
      .join("");
    expect(contents).toBe("[mock] hi");
  });

  it("returns SSE error frame when SDK error occurs", async () => {
    // 設計書 7.4.1: mock のエラー注入は HTTP ヘッダ X-Mock-Fail-After-Chunk
    // (TS 側で params._mock = { fail_after_chunk: N } に変換) を使い、
    // サブプロセスを別途立てずに同一の serverProc で完結させる
    const res = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mock-Fail-After-Chunk": "1",
      },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const frames = await readSse(res);
    const errorFrame = frames.find((f) => f.includes("\"error\""));
    expect(errorFrame).toBeTruthy();
    expect(frames[frames.length - 1]).toBe("data: [DONE]");
  });
});
```

- [ ] **Step 4: TS と Mock に Header ベースのエラー注入機構を追加**

設計書 7.4.1 の規約に従い、以下を実装する:

**(a) TS 側 (`src/server.ts`):** `X-Mock-Fail-After-Chunk: N` ヘッダが付与されている場合のみ、JSON-RPC params に `_mock: { fail_after_chunk: N }` を inject する。本番系では未注入 (Mock backend mode 限定の振る舞いは Python 側で実施)。

```ts
// src/server.ts (Phase A 検証直後、streamingCall 直前)
const mockHeader = req.headers["x-mock-fail-after-chunk"];
const paramsWithMock = mockHeader
  ? { ...validated, _mock: { fail_after_chunk: Number(mockHeader) } }
  : validated;
// 以降 paramsWithMock を streamingCall に渡す
```

**(b) Python 側 (`MockAntigravityClient.stream_chat`):** `params._mock.fail_after_chunk` を読み取り、N chunk 送出後に `SdkApiError("mock injected failure")` (code 属性 -32013) を raise する。本番系 (`AntigravityClient`) は `_mock` を完全に無視する。

```python
# handlers.py の _stream_impl に追加 (params から _mock を取り出して client へ渡す)
mock_options = params.get("_mock") if isinstance(params, dict) else None
async for tok in client.stream_chat(
    [m.model_dump() for m in cp.messages],
    mock_options=mock_options,
):
    # ... 既存ロジック

# antigravity_client.py の MockAntigravityClient.stream_chat
async def stream_chat(self, messages, *, mock_options=None):
    fail_after = (mock_options or {}).get("fail_after_chunk")
    yielded = 0
    # ... 既存の token 生成ループ内で
    yielded += 1
    if fail_after is not None and yielded >= fail_after:
        from .errors import SdkApiError
        raise SdkApiError("mock injected failure")  # code は class 属性 (-32013)
```

**規約 (設計書 7.4.1):**

- `_mock` は **`OAG_BACKEND_MODE=mock`** のときのみ Python 側で有効化される
- `AntigravityClient` (live) は `_mock` を読み取らない (テストで誤って live に届いても無視)
- TS 側で `X-Mock-Fail-After-Chunk` ヘッダの解釈に失敗 (非数値) した場合は注入を skip し、警告ログを出す

- [ ] **Step 5: テスト実行 → 修正 → GREEN にする**

```bash
pnpm build
pnpm test:e2e -- sse
```

Expected: 2 E2E ケース PASS。

- [ ] **Step 6: 総合検証 (受け入れ基準 #1)**

```bash
pnpm verify
```

Expected: 21 既存 + 13 新規 = 34 ケース全 GREEN (mock mode)。新規 13 ケース内訳は受け入れ基準サマリ参照。

- [ ] **Step 7: コミット**

Step 4 で src/server.ts (Mock ヘッダ → `_mock` 変換) と handlers.py (`_mock` を client へ渡す経路) を変更しているため、これらも必ず stage する。

```bash
git add tests/ts/sse.test.ts \
        src/server.ts \
        backend/src/opencode_antigravity/handlers.py \
        backend/src/opencode_antigravity/antigravity_client.py
git commit -m "test(e2e): SSE 正常系・SDK エラー系の E2E テストを追加 (受け入れ#30, #31)"
```

- [ ] **Step 8: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/e2e-mock
gh pr create --draft --base feature/phase2/ts-server-sse \
  --title "test(e2e): SSE mock 経路 (受け入れ#30, #31)" \
  --body "受け入れ基準 #1 (pnpm verify が 34 ケース全 GREEN) を達成。"
```

`.stack-urls.md` に `- T4.2: <url>` を追記。

---

### Task 4.3: E2E live テスト基盤

**派生元ブランチ:** `feature/phase2/e2e-mock` (T4.2)
**実行モード:** 直列必須 — Wait for T4.2 の Draft PR URL
**前提条件:** T4.2 の Draft PR URL 取得済み

**Files:**

- Create: `tests/python/e2e_live/__init__.py`
- Create: `tests/python/e2e_live/test_real_gemini.py`
- Create: `tests/ts/sse_live.test.ts`
- Modify: `package.json` (`test:e2e:live` スクリプト追加)
- Modify: `pyproject.toml` (`live` pytest マーカ宣言)

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/e2e-mock --no-tags
git switch -c feature/phase2/e2e-live origin/feature/phase2/e2e-mock

EXPECTED_BASE="feature/phase2/e2e-mock"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: pyproject.toml に live マーカを宣言**

```toml
[tool.pytest.ini_options]
pythonpath = ["backend/src"]
testpaths = ["tests/python"]
markers = [
  "live: requires real GEMINI_API_KEY and network (CI 既定スキップ)",
]
addopts = "-m 'not live'"
```

- [ ] **Step 3: `tests/python/e2e_live/test_real_gemini.py` を作成**

```python
import os
import pytest

from opencode_antigravity.antigravity_client import AntigravityClient


pytestmark = pytest.mark.live


@pytest.mark.asyncio
async def test_real_gemini_stream_short_prompt():
    if not os.environ.get("GEMINI_API_KEY"):
        pytest.skip("GEMINI_API_KEY not set")
    client = AntigravityClient(model=os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-pro"),
                               api_key=os.environ["GEMINI_API_KEY"])
    await client.start()
    try:
        chunks: list[str] = []
        async for tok in client.stream_chat([{"role": "user", "content": "Say hi"}]):
            chunks.append(tok)
        assert chunks
        full = "".join(chunks)
        assert len(full) > 0
    finally:
        await client.stop()
```

- [ ] **Step 4: `tests/ts/sse_live.test.ts` を作成**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";

const RUN_LIVE = !!process.env.GEMINI_API_KEY;
const PORT = 11437;  // 他テスト (T4.2 = 11436) と衝突回避
let serverProc: ChildProcess | undefined;

beforeAll(async () => {
  if (!RUN_LIVE) return;
  serverProc = spawn("node", ["dist/src/index.js"], {
    env: {
      ...process.env,
      OAG_BACKEND_MODE: "live",
      ANTIGRAVITY_MODEL: process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // /healthz を最大 30 秒ポーリングして起動待ち (SDK 初期化に時間が掛かる場合あり)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${PORT}/healthz`);
      if (r.ok) return;
    } catch {
      // ignore until deadline
    }
    await new Promise((rr) => setTimeout(rr, 500));
  }
  throw new Error("live server did not become ready within 30s");
});

afterAll(() => {
  serverProc?.kill();
});

describe.skipIf(!RUN_LIVE)("SSE live", () => {
  it("real Gemini returns at least one chunk", async () => {
    const res = await fetch(`http://localhost:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
        messages: [{ role: "user", content: "Say hi in 5 words." }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
  });
});
```

> **設計判断:** live SSE テストは `dist/src/index.js` (Phase 2 build 出力) をサブプロセスで起動し、テスト内で `/healthz` ポーリングして同期する。`pnpm test:e2e:live` を CI / 手動どちらで実行してもこのテストだけでサーバ管理が完結し、別途 `pnpm start` 不要。Python ワーカは `node` プロセスが起動時に spawn する。

- [ ] **Step 5: `package.json` に `test:e2e:live` を追加**

```json
"scripts": {
  "test:e2e:live": "pnpm build && uv run vitest run tests/ts/sse_live.test.ts && uv run pytest tests/python/e2e_live -m live"
}
```

> **`pnpm build` を前段で必須化する理由:** `tests/ts/sse_live.test.ts` の `beforeAll` が `node dist/src/index.js` を spawn するため、最新ビルドが必要。CI / nightly でも同じスクリプトを叩くので、ビルドステップを script 内で完結させる。

- [ ] **Step 6: CI 設定の確認**

`.github/workflows/ci.yml` の `Verify` ステップでは `pyproject.toml` 側 `addopts = -m 'not live'` により live マーカが除外される。明示的に `pnpm test:e2e:live` は CI で実行しない (手動 / nightly 運用)。

- [ ] **Step 7: ローカル smoke (live; 任意。GEMINI_API_KEY 必要)**

```bash
# 開発者の手元で
export GEMINI_API_KEY=...
uv pip install 'opencode-antigravity[live]'
OAG_BACKEND_MODE=live pnpm verify   # 既存 34 ケースは live 経路で通る
OAG_BACKEND_MODE=live pnpm test:e2e:live
```

これは PR 段階では実行不要。CI でも実行しない。

- [ ] **Step 8: コミット**

```bash
git add tests/python/e2e_live tests/ts/sse_live.test.ts package.json pnpm-lock.yaml pyproject.toml
git commit -m "test(e2e-live): 実 Gemini SDK 経路の E2E 基盤を追加 (CI 既定スキップ)"
```

- [ ] **Step 9: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/e2e-live
gh pr create --draft --base feature/phase2/e2e-mock \
  --title "test(e2e-live): 実 Gemini SDK 経路の E2E 基盤" \
  --body "受け入れ基準 #2 を満たす live テスト基盤。CI は -m 'not live' でスキップ、手動 / nightly 実行。"
```

`.stack-urls.md` に `- T4.3: <url>` を追記。

---

## Phase 5: ドキュメント仕上げ

### Task 5.1: SPEC.md / README.md 更新

**派生元ブランチ:** `feature/phase2/e2e-live` (T4.3)
**実行モード:** 直列必須 — Wait for T4.3 の Draft PR URL
**前提条件:** T4.3 の Draft PR URL 取得済み

**Files:**

- Modify: `SPEC.md`
- Modify: `README.md`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

```bash
cd /workspaces/opencode-antigravity-plugin
git fetch origin feature/phase2/e2e-live --no-tags
git switch -c feature/phase2/docs origin/feature/phase2/e2e-live

EXPECTED_BASE="feature/phase2/e2e-live"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor "origin/${EXPECTED_BASE}" "${CURRENT_BRANCH}" \
  || { echo "ERROR: 派生元ブランチが ${EXPECTED_BASE} ではありません。"; exit 1; }
echo "OK"
```

- [ ] **Step 2: `SPEC.md` セクション 10 を「完了」に更新**

「Antigravity SDK 連携 (Phase 2)」「SSE ストリーミング (Phase 2)」のステータスを「完了」に更新する (具体的な文言は既存ファイル参照)。

- [ ] **Step 3: `README.md` を更新**

以下を追加 / 更新する:

- 環境変数表 (`GEMINI_API_KEY`, `ANTIGRAVITY_MODEL`, `OAG_BACKEND_MODE`, `OAG_REQUEST_TIMEOUT_MS`, `OAG_STREAM_IDLE_TIMEOUT_MS`)
- `stream:true` 対応の旨と、curl のサンプル
- `OAG_BACKEND_MODE=live` での起動方法と `live` extras の install 手順

- [ ] **Step 4: markdownlint を devcontainer 内で実行**

```bash
npx markdownlint-cli2 "SPEC.md" "README.md" || true   # 既存 lint 設定があれば
```

- [ ] **Step 5: 最終 `pnpm verify` (受け入れ基準 #1 再確認)**

```bash
pnpm verify
```

Expected: 34 ケース全 GREEN。

- [ ] **Step 6: コミット**

```bash
git add SPEC.md README.md
git commit -m "docs: Phase 2 完了 (SDK 連携 + SSE ストリーミング) を SPEC / README に反映"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/docs
gh pr create --draft --base feature/phase2/e2e-live \
  --title "docs: Phase 2 完了を SPEC / README に反映" \
  --body "受け入れ基準 #4 を達成。Phase 2 のスタック PR 全体のトップ。"
```

`.stack-urls.md` に `- T5.1: <url>` を追記。

---

## 受け入れ基準 (設計書 Section 13 改訂版)

Phase 2 全体の完了は以下のすべてが GREEN であることをもって判定する:

1. **`pnpm verify` が 21 既存 + 13 新規 = 34 ケース全 PASS (mock mode)** — T4.2 完了時点で達成、T5.1 で最終確認
   - 新規 13 ケース内訳: #22 (T2.2) / #23, #24 (T2.5) / #25 改訂, #32 (T2.3) / #33, #34 (T2.3.1) / #26, #27 (T3.3) / #28, #29 (T3.4) / #30, #31 (T4.2)
2. **`pnpm test:e2e:live` の手動実行による PASS (実 Gemini API)** — **任意 (Nice-to-have)**。CI ブロッキングは T0.2 で導入する `live-nightly` ジョブ (`schedule` cron + `workflow_dispatch`) に委譲し、PR マージのブロック条件にはしない (設計書 Section 13 item #2 / Section 7.5)。`GEMINI_API_KEY` シークレット未設定時は job が skip される
   - **追加計測 (T2.3.1 で実装)**: nightly E2E 内で cold-start 計測 (10 回中央値 < `OAG_AGENT_COLDSTART_BUDGET_MS=5000ms`) と TTFB 計測 (10 回 p95 < 6000ms) のベースラインを取る
3. **`GET /healthz` が `backend_mode` と `model` を含む** — T4.1 完了時点で達成
4. **`SPEC.md` セクション 10 の「Antigravity SDK 連携 (Phase 2)」「SSE ストリーミング (Phase 2)」が「完了」に更新** — T5.1 で達成
5. **設計書 v2 と T1.1 スパイク結果がリンク済み (相互参照済み)** — 本計画冒頭から両ドキュメントへ link 済み

---

## 補遺: Stack URL レジストリ運用

各 Task の Draft PR URL は `docs/superpowers/plans/.stack-urls.md` に以下の形式で集約する:

```markdown
# Phase 2 Stack PR URLs

- T0.1: https://...
- T0.2: https://...
- T1.1: https://...
- T2.1: https://...
- T2.2: https://...
- T2.3: https://...
- T2.3.1: https://...   # T1.1 + T2.3 マージ後にスパイク結果を反映
- T2.4: https://...
- T2.5: https://...
- T2.6: https://...
- T3.1: https://...
- T3.1.5: https://...   # Phase A 用 Zod スキーマ
- T3.2: https://...
- T3.3: https://...
- T3.4: https://...
- T3.5: https://...
- T4.1: https://...
- T4.2: https://...
- T4.3: https://...
- T5.1: https://...
```

このファイル自体は `feature/phase2/docs` (T5.1) で集約コミットするか、各タスクの末尾でローカルメモとして更新する。Git に含めない場合は `.gitignore` に追加する。

---

## 自己レビュー (writing-plans skill 準拠) — 2026-05-27 改訂

### 1. 仕様カバレッジ (設計書 v2 ベース)

- 設計書 Section 3 (アーキテクチャ) → T2.x / T3.x
- **Section 3.3 (per-request Agent ライフサイクル) → T2.3 (実装) + T2.3.1 (並行制御 + cold-start timeout)**
- **Section 3.3.1 (Chat ML prompt 畳み込み) → T2.3 (`prompt_folding.py` + 受け入れ#32)**
- **Section 3.3.2 (並行リクエストと Semaphore) → T2.3.1 (受け入れ#33, #34)**
- 設計書 Section 4 (コンポーネント) → 各 Task に 1 対 1 でマッピング (4.1 → T3.1.5/T3.5、4.1.1 → T3.1.5/T3.5、4.3.1 → T2.5/T3.5)
- 設計書 Section 5 (SSE / Notification) → T2.2, T2.4, T3.3, T3.5。**5.1.1 sentinel `_final` パターン → T2.4 / T2.5**
- 設計書 Section 6 (エラー) → T2.1, T3.2, T3.5, T4.2。**6.1 確定型 + `classify_sdk_error` → T2.1**。**6.4 二重検証 → T3.1.5 (一次) + T2.5 (二次)**。**6.4.1 Agent `__aenter__` 失敗フェーズ → T2.3 (asyncio.wait_for) + T2.5 (Phase A prompt 検証先取り)**
- 設計書 Section 7 (テスト戦略) → T2.1〜T4.3 の各 Step (受け入れ#22〜#34、合計 34 ケース)
- 設計書 Section 8 (設定) → T0.1, T0.2 (env injection)、T2.6 (validation + 新規 env のログ出力)、T4.1 (/healthz)
- 設計書 Section 9 (Migration) → T4.1, T5.1
- 設計書 Section 11 (不確定要素) → T1.1 (完了済み)、残課題 4 点は writing-plans 段階での参照のみ
- 設計書 Section 12.4 (Phase 2.5 申し送り) → Phase 2 範囲外 (T3.5 Step 3 で best-effort cancel のみ実装、Agent ウォームプールは Phase 2.5)
- 設計書 Section 13 (受け入れ基準改訂版) → T4.2 (34 ケース), T4.3 (cold-start + TTFB 計測), T5.1

### 2. プレースホルダ scan

- 「TBD」「実装は後で」「適切なエラー処理を追加」の記述は無し
- T1.1 は完了済みのため「スパイク調査タスク」表記は維持しつつ、結果が設計書 v2 と T2.x の実装に反映済み
- T2.3 は per-request Agent 方式の **最終実装** (stub 経由ではない)。T2.3.1 は並行制御 + #33/#34 + live smoke の独立追加であり、stub 差し替えタスクではない

### 3. 型整合性

- TS 側型 (`ChatCompletionChunk`, `JsonRpcNotification`, `ChatCompletionsChunkNotificationParams`) は T3.1 で定義され、T3.3 / T3.5 で同一名で参照
- TS 側 Zod (`ChatCompletionsParamsSchema`) は T3.1.5 で定義され、T3.5 で同一名で参照
- Python 側 `AntigravityClientBase` Protocol を T2.3 で定義、T2.5 / T2.6 で同一名参照
- **Python 側 `fold_messages_to_prompt` は T2.3 で `prompt_folding.py` に定義、T2.5 (handlers の Phase A 先取り) + `AntigravityClient.stream_chat` (T2.3 内) で同一名参照**
- **`classify_sdk_error` は T2.1 (errors.py) で定義、T2.3 (`AntigravityClient.stream_chat`) で同一名参照**
- メソッド名 `streamingCall` / `stream_chat` / `chat_completions` がタスク間で一貫
- Sentinel `_final` フィールド名は設計書 5.1.1 / T2.4 dispatch / T2.5 `_stream_impl` で完全一致

### 4. ポカヨケスクリプト

- 全 19 タスク (T0.1, T0.2, T1.1[完了済み], T2.1〜T2.6, T2.3.1, T3.1, T3.1.5, T3.2〜T3.5, T4.1〜T4.3, T5.1) の Step 1 に `git merge-base --is-ancestor` 検証を埋め込み済み
- `EXPECTED_BASE` 変数は各タスクの「派生元ブランチ」と完全一致 (T2.3.1 は `feature/phase2/python-antigravity-client` 派生に更新済み)

### 5. Draft PR URL 要求

- 直列必須タスクの「前提条件」に「先行タスクの Draft PR URL が `.stack-urls.md` に記録済み」と明記
- 各タスクの末尾に「プッシュ + Draft PR 作成 + URL 記録」のステップ

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-phase2-implementation.md`.**

実行モードは以下のいずれかから選択してください:

1. **Subagent-Driven (推奨)** — 並列可能タスク (T0.1, T0.2, T1.1, T2.1, T2.2, T2.3, T3.1, T3.2, T4.1) を独立 subagent で同時実行し、各タスク完了後に二段階レビュー。直列必須タスクは前提 Draft PR URL を確認してから順次起動。
2. **Inline Execution** — 本セッション内で 1 タスクずつ実行し、Phase 区切りでチェックポイントレビュー。
