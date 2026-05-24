# Phase 2 (Antigravity SDK 連携 + SSE ストリーミング) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 の echo 実装を `google-antigravity` SDK 経由の実 Gemini 呼び出しへ置き換え、`stream:true` を OpenAI 互換 SSE で返却できる状態に到達する。

**Architecture:**

- Python 側に `AntigravityClient` 抽象 (実 SDK + Mock) を新設し、`handlers.chat_completions` を AsyncGenerator 化。`server.py` の dispatch を拡張し、yield 毎に JSON-RPC Notification、return で最終 response を送出する。
- TypeScript 側は `jsonrpc.ts` に Notification 経路と `streamingCall()` を追加、`server.ts` で `stream:true` 検知時に SSE 中継 (`data: {...}\n\n` / `data: [DONE]\n\n`) を行う。
- すべての並行・直列依存は **Stacked PR** で管理し、Draft PR URL の存在を後続タスクの前提条件として使う。テスト・lint・ブランチ検証は **必ず devcontainer 内で実行** する。

**Tech Stack:** TypeScript 5 / Node.js 24 / pnpm / vitest / Python 3.13 / uv / pytest / ruff / Pydantic v2 / `google-antigravity` SDK / pino / JSON-RPC 2.0 over stdio / SSE over HTTP

**Source Spec:** [`docs/superpowers/specs/2026-05-25-phase2-design.md`](../specs/2026-05-25-phase2-design.md)

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
| `bitbucket-pipelines.yml` | Bitbucket Pipelines 定義 (master トリガー、`ubuntu-slim` ランナー) | T0.2 |
| `docs/superpowers/specs/2026-05-25-phase2-sdk-spike.md` | SDK API スパイク調査結果 | T1.1 |
| `backend/src/opencode_antigravity/errors.py` | SDK 例外 → JSON-RPC エラーコード変換 (`SdkAuthError` 等) | T2.1 |
| `backend/src/opencode_antigravity/antigravity_client.py` | `AntigravityClient` 抽象 + `MockAntigravityClient` | T2.3 |
| `tests/python/unit/test_errors.py` | `errors.py` の単体テスト | T2.1 |
| `tests/python/unit/test_format_notification.py` | `format_notification` の単体テスト (受け入れ#22) | T2.2 |
| `tests/python/unit/test_antigravity_client.py` | `AntigravityClient` ライフサイクルテスト (受け入れ#25) | T2.3 |
| `tests/python/unit/test_chat_completions_streaming.py` | AsyncGenerator / stream:false 集約テスト (受け入れ#23, #24) | T2.5 |
| `tests/python/integration/test_async_dispatch.py` | server.py の AsyncGenerator dispatch を stdio 経由で検証 | T2.4 |
| `tests/python/e2e_live/__init__.py` | live テスト用ディレクトリ初期化 | T4.3 |
| `tests/python/e2e_live/test_real_gemini.py` | 実 SDK + 実 API キーでの E2E (live マーカ) | T4.3 |
| `tests/ts/jsonrpc_notification.test.ts` | Notification dispatch 単体テスト (受け入れ#26, #27) | T3.3 |
| `tests/ts/streaming_call.test.ts` | `streamingCall()` の TS 統合テスト (受け入れ#28, #29) | T3.4 |
| `tests/ts/sse.test.ts` | SSE E2E (受け入れ#30, #31) | T4.2 |
| `tests/ts/sse_live.test.ts` | SSE E2E (live) | T4.3 |

### 修正

| ファイル | 主な変更 | 担当 Task |
|---|---|---|
| `.devcontainer/Dockerfile` | 追加依存無し、ただし version pin の確認・必要なら更新 | T0.1 |
| `.devcontainer/devcontainer.json` | `containerEnv` で Phase 2 必須環境変数 (mock 既定) を注入 | T0.1 |
| `backend/src/opencode_antigravity/protocol.py` | `format_notification(method, params)` 追加 | T2.2 |
| `backend/src/opencode_antigravity/server.py` | AsyncGenerator ハンドラ判別、yield → Notification、return → response | T2.4 |
| `backend/src/opencode_antigravity/handlers.py` | `chat_completions` を AsyncGenerator 化、`stream:false` で内部集約 | T2.5 |
| `backend/src/opencode_antigravity/__main__.py` | 起動時に `GEMINI_API_KEY` (live mode 時) / `ANTIGRAVITY_MODEL` / `OAG_BACKEND_MODE` を検証 | T2.6 |
| `src/types.ts` | OpenAI Streaming Chunk 型、JSON-RPC Notification 型を追加 | T3.1 |
| `src/errors.ts` | SDK 由来エラーコード (`-32010〜-32015`) を OpenAI エラー形式へ追加マッピング | T3.2 |
| `src/jsonrpc.ts` | `parseMessage` 拡張、`onNotification`、`streamingCall()` 追加 | T3.3 |
| `src/backend.ts` | `streamingCall()` ラッパー露出 | T3.4 |
| `src/server.ts` | `stream:true` 検知時の SSE 中継、エラー時の SSE エラー frame | T3.5 |
| `src/server.ts` (`/healthz`) | `backend_mode` / `model` フィールド追加 | T4.1 |
| `SPEC.md` セクション 10 | Phase 2 を「完了」に更新 | T5.1 |
| `README.md` | 環境変数表、`OAG_BACKEND_MODE` の使い方、SSE サポート明記 | T5.1 |

---

## Phase / Task サマリ

| # | Task | 派生元 | 実行モード |
|---|---|---|---|
| T0.1 | Devcontainer 拡張 | `master` | 並列可能 (独立) |
| T0.2 | Bitbucket Pipelines 新規作成 | `master` | 並列可能 (独立) |
| T1.1 | SDK API スパイク調査 | `master` | 並列可能 (独立) |
| T2.1 | Python `errors.py` 新設 | `master` | 並列可能 (独立) |
| T2.2 | Python `format_notification` 追加 | `master` | 並列可能 (独立) |
| T2.3 | Python `antigravity_client.py` 新設 | `master` | 並列可能 (独立) |
| T2.4 | Python `server.py` AsyncGenerator dispatch | T2.2 | 直列必須 (Wait for T2.2) |
| T2.5 | Python `handlers.py` ストリーミング化 | T2.4 | 直列必須 (Wait for T2.4 + T2.1 + T2.3 merged) |
| T2.6 | Python `__main__.py` 環境変数検証 | T2.5 | 直列必須 (Wait for T2.5) |
| T3.1 | TS `types.ts` 拡張 | `master` | 並列可能 (独立) |
| T3.2 | TS `errors.ts` SDK エラーマッピング | `master` | 並列可能 (独立) |
| T3.3 | TS `jsonrpc.ts` Notification + `streamingCall` | T3.1 | 直列必須 (Wait for T3.1) |
| T3.4 | TS `backend.ts` `streamingCall` 露出 | T3.3 | 直列必須 (Wait for T3.3) |
| T3.5 | TS `server.ts` SSE 中継 | T3.4 | 直列必須 (Wait for T3.4 + T3.2 merged) |
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
    "OAG_STREAM_IDLE_TIMEOUT_MS": "30000"
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

- [ ] **Step 5: コミット**

```bash
git add .devcontainer/devcontainer.json
git commit -m "chore(devcontainer): Phase 2 既定環境変数 (OAG_BACKEND_MODE=mock 等) を注入"
```

- [ ] **Step 6: プッシュと Draft PR 作成**

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

### Task 0.2: Bitbucket Pipelines 新規作成 (master トリガー / ubuntu-slim ランナー)

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T0.1 と同時実行可
**前提条件:** なし

**Files:**

- Create: `bitbucket-pipelines.yml`

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

- [ ] **Step 2: `bitbucket-pipelines.yml` を作成**

```yaml
image: atlassian/default-image:ubuntu-slim

definitions:
  caches:
    pnpm: $HOME/.local/share/pnpm/store
    uv: $HOME/.cache/uv
  steps:
    - step: &verify
        name: verify (lint + python tests + ts tests)
        runs-on:
          - self.hosted
          - linux
        caches:
          - pnpm
          - uv
        script:
          - apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg python3.13 python3.13-venv nodejs npm
          - npm install -g pnpm@9.15.9
          - pip3 install --no-cache-dir uv==0.11.15
          - pnpm install --frozen-lockfile
          - uv sync
          - export OAG_BACKEND_MODE=mock
          - pnpm verify

pipelines:
  branches:
    master:
      - step: *verify
  pull-requests:
    '**':
      - step: *verify
```

> 既存の `.github/workflows/ci.yml` は変更しない (本タスクのスコープ外)。Bitbucket Pipelines を **追加** する形で扱う。

- [ ] **Step 3: YAML 構文を devcontainer 内で検証**

```bash
uv run python -c "import yaml, sys; yaml.safe_load(open('bitbucket-pipelines.yml'))"
echo "OK: YAML 構文 valid"
```

Expected: 例外無しで `OK:` 行が出力される。

- [ ] **Step 4: コミット**

```bash
git add bitbucket-pipelines.yml
git commit -m "ci(bitbucket): master トリガーで pnpm verify を実行するパイプラインを追加 (ubuntu-slim)"
```

- [ ] **Step 5: プッシュと Draft PR 作成**

```bash
git push -u origin feature/phase2/phase0-ci
gh pr create --draft --base master --title "ci(bitbucket): master / PR で pnpm verify を実行するパイプライン" \
  --body "Phase 2 着手前に Bitbucket Pipelines (master トリガー / ubuntu-slim) を新設。pnpm verify を mock mode で実行する。"
```

- [ ] **Step 6: Draft PR URL を `.stack-urls.md` に追記**

```markdown
- T0.2: https://<pr-url>
```

---

## Phase 1: SDK スパイク調査 (設計確定の前提)

### Task 1.1: `google-antigravity` SDK API スパイク調査と文書化

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T0.x / T2.x / T3.x / T4.1 と同時実行可。本タスクは **コード変更を伴わない** ため後続コードタスクのブロッカーにはしないが、結果に応じて T2.3 / T2.5 / T2.6 の実装詳細を微修正する可能性がある。
**前提条件:** なし

**Files:**

- Create: `docs/superpowers/specs/2026-05-25-phase2-sdk-spike.md`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

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

- [ ] **Step 2: SDK 実物を一時的に sync して API を確認**

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

- [ ] **Step 3: 設計書 Section 11.1 の不確定要素を確定する**

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

## 2. messages 配列の一括渡し API (設計書 Section 3.3)
- 採用 API: `<Conversation.chat(messages=[...]) | Agent.chat(messages=[...]) | history 引数>`
- 採用理由:
- 一括渡し不可だった場合の代替方針: `<例: リクエストごとに Agent 再起動>`

## 3. thinking / tool_call イベント (将来 Phase 用調査)
- ストリームインターフェース型:
- Phase 2 では未使用とすることを再確認

## 4. harness binary 起動コスト
- 観測値: `<起動時間 ms>`
- 長寿命 Agent 採用の妥当性: OK / 要再検討
```

- [ ] **Step 4: pyproject.toml の依存関係はまだ更新しない**

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

- [ ] **Step 7: Draft PR URL を `.stack-urls.md` に追記**

```markdown
- T1.1: https://<pr-url>
```

---

## Phase 2: Python 側基盤

### Task 2.1: `errors.py` 新設 (SDK 例外 → JSON-RPC エラーコード変換)

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T2.2 / T2.3 / T3.x / T4.1 と同時実行可
**前提条件:** なし (T1.1 の結果が利用可能であれば例外型を確定値で埋める。未確定なら設計書 Section 6.1 の仮置き値を使う)

**Files:**

- Create: `backend/src/opencode_antigravity/errors.py`
- Create: `tests/python/unit/test_errors.py`

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

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

- [ ] **Step 2: 失敗するテストを書く (`tests/python/unit/test_errors.py`)**

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
```

- [ ] **Step 3: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/unit/test_errors.py -v
```

Expected: `ModuleNotFoundError: No module named 'opencode_antigravity.errors'` で FAIL。

- [ ] **Step 4: 最小実装を書く (`backend/src/opencode_antigravity/errors.py`)**

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
```

- [ ] **Step 5: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/unit/test_errors.py -v
uv run ruff check backend/src/opencode_antigravity/errors.py tests/python/unit/test_errors.py
```

Expected: 全 8 テスト PASS、ruff エラー 0。

- [ ] **Step 6: コミット**

```bash
git add backend/src/opencode_antigravity/errors.py tests/python/unit/test_errors.py
git commit -m "feat(python): SDK 例外 → JSON-RPC エラーコード変換 (errors.py) を追加"
```

- [ ] **Step 7: プッシュと Draft PR 作成、URL を記録**

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

- [ ] **Step 1: ブランチ作成と検証 (poka-yoke)**

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

- [ ] **Step 2: 失敗するテストを書く (受け入れ#22)**

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

- [ ] **Step 3: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/unit/test_format_notification.py -v
```

Expected: `ImportError: cannot import name 'format_notification'` で FAIL。

- [ ] **Step 4: `protocol.py` を読んで既存定数を確認**

```bash
uv run python -c "from opencode_antigravity.protocol import MAX_MESSAGE_BYTES, JsonRpcInvalidRequestError; print(MAX_MESSAGE_BYTES)"
```

Expected: `1048576` (1 MiB) が表示される。表示されない場合は `protocol.py` を読み、`MAX_MESSAGE_BYTES` の正確な名前と `JsonRpcInvalidRequestError` の存在を確認してテストの import を調整する。

- [ ] **Step 5: `format_notification` を `protocol.py` に追加**

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

- [ ] **Step 6: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/unit/test_format_notification.py -v
uv run ruff check backend/src/opencode_antigravity/protocol.py tests/python/unit/test_format_notification.py
```

Expected: 全 4 テスト PASS、ruff エラー 0。

- [ ] **Step 7: 既存テスト (Phase 1) が壊れていないことを確認**

```bash
uv run pytest tests/python
```

Expected: 既存 21 ケースが PASS のまま。

- [ ] **Step 8: コミット**

```bash
git add backend/src/opencode_antigravity/protocol.py tests/python/unit/test_format_notification.py
git commit -m "feat(python): JSON-RPC Notification 整形 (format_notification) を追加 (受け入れ#22)"
```

- [ ] **Step 9: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/python-protocol-notification
gh pr create --draft --base master --title "feat(python): format_notification 追加 (受け入れ#22)" \
  --body "Phase 2 ストリーミング送信側で使用する JSON-RPC Notification 整形を protocol.py に追加。"
```

`.stack-urls.md` に `- T2.2: <url>` を追記。

---

### Task 2.3: `antigravity_client.py` 新設 (実 SDK + `MockAntigravityClient`)

**派生元ブランチ:** `master`
**実行モード:** 並列可能 (独立) — T2.1 / T2.2 / T3.x / T4.1 と同時実行可
**前提条件:** T1.1 の結果が出ていれば実 SDK の API 名を反映する。未確定なら Mock 部分のみ完成させ、実 SDK 呼び出しは `NotImplementedError` で stub し、T2.6 でフォローする。

**Files:**

- Create: `backend/src/opencode_antigravity/antigravity_client.py`
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

- [ ] **Step 2: 失敗するテストを書く (受け入れ#25 + 補助)**

`tests/python/unit/test_antigravity_client.py`:

```python
import pytest

from opencode_antigravity.antigravity_client import MockAntigravityClient


@pytest.mark.asyncio
async def test_lifecycle_start_stream_stop():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()

    chunks_1 = []
    async for c in client.stream_chat([{"role": "user", "content": "hello"}]):
        chunks_1.append(c)
    assert chunks_1 == ["[mock] ", "hello"]
    assert client.agent_enter_count == 1
    assert client.conversation_enter_count == 1
    assert client.conversation_exit_count == 1

    chunks_2 = []
    async for c in client.stream_chat([{"role": "user", "content": "world"}]):
        chunks_2.append(c)
    assert chunks_2 == ["[mock] ", "world"]
    assert client.agent_enter_count == 1  # Agent は再利用
    assert client.conversation_enter_count == 2  # Conversation は都度新規

    await client.stop()
    assert client.agent_exit_count == 1


@pytest.mark.asyncio
async def test_stream_before_start_raises():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    with pytest.raises(RuntimeError):
        async for _ in client.stream_chat([{"role": "user", "content": "x"}]):
            pass


@pytest.mark.asyncio
async def test_stream_after_stop_raises():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    await client.stop()
    with pytest.raises(RuntimeError):
        async for _ in client.stream_chat([{"role": "user", "content": "x"}]):
            pass


@pytest.mark.asyncio
async def test_double_start_is_idempotent():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    await client.start()  # 冪等で OK とする (設計書 Section 7.4 #25 の選択肢)
    assert client.agent_enter_count == 1
    await client.stop()


@pytest.mark.asyncio
async def test_chat_aggregates_stream():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    result = await client.chat([{"role": "user", "content": "hello"}])
    assert result == "[mock] hello"
    await client.stop()
```

- [ ] **Step 3: pytest-asyncio を dev-deps に追加**

`pyproject.toml` の `[tool.uv]` セクションに `pytest-asyncio>=0.23` を追加し、`[tool.pytest.ini_options]` に `asyncio_mode = "auto"` を追加する。

```bash
uv sync
```

- [ ] **Step 4: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/unit/test_antigravity_client.py -v
```

Expected: `ModuleNotFoundError` で FAIL。

- [ ] **Step 5: `antigravity_client.py` を実装 (Mock を最初に完成させる)**

```python
"""Antigravity SDK 抽象 (Phase 2)。

- AntigravityClient: 実 SDK バックエンド (`OAG_BACKEND_MODE=live` で選択)
- MockAntigravityClient: 決定論的な token 列を yield (CI 既定)

長寿命 Agent + リクエストごとに新規 Conversation のライフサイクルを実装する
(設計書 Section 3.3)。
"""
from __future__ import annotations

import asyncio
from typing import AsyncGenerator, Optional, Protocol


class AntigravityClientBase(Protocol):
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def stream_chat(
        self, messages: list[dict]
    ) -> AsyncGenerator[str, None]: ...
    async def chat(self, messages: list[dict]) -> str: ...


class MockAntigravityClient:
    def __init__(self, model: str) -> None:
        self.model = model
        self._started = False
        self._stopped = False
        self.agent_enter_count = 0
        self.agent_exit_count = 0
        self.conversation_enter_count = 0
        self.conversation_exit_count = 0

    async def start(self) -> None:
        if self._started:
            return  # 冪等
        self._started = True
        self.agent_enter_count += 1

    async def stop(self) -> None:
        if not self._started or self._stopped:
            return
        self._stopped = True
        self.agent_exit_count += 1

    async def stream_chat(
        self, messages: list[dict]
    ) -> AsyncGenerator[str, None]:
        if not self._started or self._stopped:
            raise RuntimeError("client is not running")
        self.conversation_enter_count += 1
        try:
            # 入力の最後の user message を mock 応答として echo する
            last_user = next(
                (m["content"] for m in reversed(messages) if m.get("role") == "user"),
                "",
            )
            yield "[mock] "
            yield last_user
        finally:
            self.conversation_exit_count += 1

    async def chat(self, messages: list[dict]) -> str:
        buf: list[str] = []
        async for tok in self.stream_chat(messages):
            buf.append(tok)
        return "".join(buf)


class AntigravityClient:
    """実 SDK バックエンド。Live mode で利用される。

    Note: T1.1 の SDK スパイク結果に基づき、Agent / Conversation 実体の
    具体的な呼び出しシーケンスを反映する。messages 配列は 1 回の呼び出しで
    一括渡しする (設計書 Section 3.3)。
    """

    def __init__(self, model: str, api_key: str) -> None:
        self.model = model
        self._api_key = api_key
        self._agent_cm = None
        self._agent = None

    async def start(self) -> None:
        # T1.1 確定後に実装。仮実装で起動を許可しておく。
        try:
            import google.antigravity as ga  # noqa: F401
        except ImportError as e:
            raise RuntimeError(
                "google-antigravity SDK is not installed. "
                "Install with: uv pip install 'opencode-antigravity[live]'"
            ) from e
        from google.antigravity import Agent, LocalAgentConfig  # type: ignore[attr-defined]

        self._agent_cm = Agent(LocalAgentConfig(model=self.model))
        self._agent = await self._agent_cm.__aenter__()

    async def stop(self) -> None:
        if self._agent_cm is not None:
            await self._agent_cm.__aexit__(None, None, None)
            self._agent_cm = None
            self._agent = None

    async def stream_chat(
        self, messages: list[dict]
    ) -> AsyncGenerator[str, None]:
        if self._agent is None:
            raise RuntimeError("client is not running")
        # T1.1 のスパイク結果で確定した API シグネチャに置き換える。
        # 仮実装:
        async with self._agent.conversation() as conv:  # type: ignore[attr-defined]
            async for token in conv.chat(messages=messages):  # type: ignore[attr-defined]
                yield str(token)

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

- [ ] **Step 6: pyproject.toml に optional dep を追加**

`pyproject.toml`:

```toml
[project.optional-dependencies]
live = ["google-antigravity>=0.1"]
```

`uv sync` を実行 (live extras は手動 install)。

- [ ] **Step 7: テストが GREEN になるまで実行**

```bash
uv run pytest tests/python/unit/test_antigravity_client.py -v
uv run ruff check backend/src/opencode_antigravity/antigravity_client.py tests/python/unit/test_antigravity_client.py
```

Expected: 5 テスト PASS、ruff エラー 0。

- [ ] **Step 8: 既存テストが壊れていないことを確認**

```bash
uv run pytest tests/python
```

- [ ] **Step 9: コミット**

```bash
git add backend/src/opencode_antigravity/antigravity_client.py \
        tests/python/unit/test_antigravity_client.py \
        pyproject.toml
git commit -m "feat(python): AntigravityClient 抽象と MockAntigravityClient を追加 (受け入れ#25)"
```

- [ ] **Step 10: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/python-antigravity-client
gh pr create --draft --base master --title "feat(python): AntigravityClient 抽象 + MockClient" \
  --body "Phase 2 設計 Section 3.3 / 4.2 を実装。長寿命 Agent + リクエストごと Conversation。CI は mock 既定。"
```

`.stack-urls.md` に `- T2.3: <url>` を追記。

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
    yield {"delta": {"role": "assistant", "content": ""}}
    yield {"delta": {"content": params["text"]}}
    return {"finish_reason": "stop", "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}


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
- `async for delta in agen:` で `format_notification("chat.completions.chunk", {"request_id": req_id, "delta": delta})` を逐次書き出し。
- generator 終了後、`agen.asend(None)` / `StopAsyncIteration.value` で最終 result を取得し `format_response(req_id, result)` で書き出し。
- `params.get("stream")` が False または欠落の場合、AsyncGenerator でも内部集約し 1 発の response を返す (集約は `chat()` 等価のロジックで結合)。

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
git commit -m "feat(python): server.py に AsyncGenerator dispatch を追加 (yield→Notification, return→response)"
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
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        params = {
            "model": "gemini-2.5-pro",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": True,
        }
        agen = chat_completions(params, client=client)
        chunks = []
        try:
            async for c in agen:
                chunks.append(c)
        except StopAsyncIteration as stop:
            final = stop.value
        else:
            # Python 3.13 で AsyncGenerator return value の取り方
            final = agen.value if hasattr(agen, "value") else None

        # 最初の chunk は role
        assert chunks[0]["delta"] == {"role": "assistant", "content": ""}
        # 後続 chunk は content のみ
        assert {"delta": {"content": "[mock] "}} in chunks
        assert {"delta": {"content": "hello"}} in chunks
        # 最終戻り値
        # final は Generator.aclose 後に取得しない実装なら finish_reason を最終 chunk に含めて返す形式でも可
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
```

- [ ] **Step 4: テスト実行で失敗を確認**

```bash
uv run pytest tests/python/unit/test_chat_completions_streaming.py -v
```

Expected: 既存 `chat_completions` が echo 実装のため FAIL。

- [ ] **Step 5: `handlers.py` を更新**

要点:

- `chat_completions(params, client)` を **2 つのオーバーロード相当** で実装する:
  - `params["stream"] == True` → AsyncGenerator を返す (yield delta dict, return final dict)
  - `params["stream"] == False` (または省略) → `async def` で集約済み完成 dict を返す
- Pydantic v2 モデル `ChatCompletionsParams` で `model` / `messages` / `stream` を検証する
- `messages` が空、`model` が `ANTIGRAVITY_MODEL` (環境変数経由) と不一致は `ValueError`
- SDK 例外は `opencode_antigravity.errors` の型に変換し、上位 (`server.py`) が `format_response_error` を選択するための例外伝播
- 既存 `echo()` / `health()` は変更しない

実装パターン:

```python
import os
from typing import AsyncGenerator, Union

from pydantic import BaseModel, Field, ValidationError

from .antigravity_client import AntigravityClientBase


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

    if cp.stream:
        return _stream_impl(cp, client)
    return _aggregate_impl(cp, client)


async def _stream_impl(cp: _ChatParams, client: AntigravityClientBase) -> AsyncGenerator[dict, None]:
    role_sent = False
    completion_tokens = 0
    async for tok in client.stream_chat([m.model_dump() for m in cp.messages]):
        if not role_sent:
            yield {"delta": {"role": "assistant", "content": ""}}
            role_sent = True
        yield {"delta": {"content": tok}}
        completion_tokens += 1
    return {
        "finish_reason": "stop",
        "usage": {
            "prompt_tokens": sum(len(m.content) for m in cp.messages),
            "completion_tokens": completion_tokens,
            "total_tokens": completion_tokens + sum(len(m.content) for m in cp.messages),
        },
    }


async def _aggregate_impl(cp: _ChatParams, client: AntigravityClientBase) -> dict:
    content = await client.chat([m.model_dump() for m in cp.messages])
    return {
        "id": _new_chatcmpl_id(),
        "object": "chat.completion",
        "model": cp.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": sum(len(m.content) for m in cp.messages),
            "completion_tokens": len(content),
            "total_tokens": len(content) + sum(len(m.content) for m in cp.messages),
        },
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
import { toOpenAIError, BackendResponseError } from "../../src/errors";

describe("toOpenAIError SDK mapping", () => {
  it("maps -32010 to 401 authentication_error", () => {
    const err = new BackendResponseError({ code: -32010, message: "auth failed" });
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(401);
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toBe("auth failed");
  });

  it("maps -32011 to 429 rate_limit_error", () => {
    const err = new BackendResponseError({ code: -32011, message: "rate limit" });
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(429);
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("maps -32012 to 400 invalid_request_error", () => {
    const err = new BackendResponseError({ code: -32012, message: "model not found" });
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("maps -32013 to 502 bad_gateway", () => {
    const err = new BackendResponseError({ code: -32013, message: "api err" });
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(502);
    expect(body.error.type).toBe("bad_gateway");
  });

  it("maps -32014 to 504 timeout", () => {
    const err = new BackendResponseError({ code: -32014, message: "timeout" });
    const { status, body } = toOpenAIError(err);
    expect(status).toBe(504);
    expect(body.error.type).toBe("timeout");
  });

  it("maps -32015 to 502 bad_gateway", () => {
    const err = new BackendResponseError({ code: -32015, message: "conn refused" });
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
case -32010: return { status: 401, body: { error: { type: "authentication_error", message: err.message } } };
case -32011: return { status: 429, body: { error: { type: "rate_limit_error", message: err.message } } };
case -32012: return { status: 400, body: { error: { type: "invalid_request_error", message: err.message } } };
case -32013: return { status: 502, body: { error: { type: "bad_gateway", message: err.message } } };
case -32014: return { status: 504, body: { error: { type: "timeout", message: err.message } } };
case -32015: return { status: 502, body: { error: { type: "bad_gateway", message: err.message } } };
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
import { JsonRpcClient } from "../../src/jsonrpc";

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
- `streamingCall<T>(method, params, onChunk): Promise<T>`:
  - 内部で UUID v4 の `id` を生成して request 送信
  - Pending Map のエントリに `onChunk` callback も保持
  - Notification 受信時、Pending Map に `request_id` が存在すれば `onChunk(params.delta)` を呼ぶ
  - 最終 response 受信で resolve / 削除 / clearTimeout
- 未知 `request_id` の Notification は `pino.warn({ event: "unknown notification id", request_id })`
- アイドルタイムアウト (`OAG_STREAM_IDLE_TIMEOUT_MS`) を実装: 各 chunk 受信ごとに `setTimeout` をリセット、超過で `BackendTimeoutError` で reject
- 全体タイムアウト (`OAG_REQUEST_TIMEOUT_MS`) は Phase 1 と同じ機構を流用

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
import { PythonBackend } from "../../src/backend";

describe("PythonBackend.streamingCall", () => {
  it("round-trips chunks and final response (#28)", async () => {
    const backend = new PythonBackend({
      pythonCmd: "uv",
      pythonArgs: ["run", "python", "-m", "opencode_antigravity"],
      env: { OAG_BACKEND_MODE: "mock", ANTIGRAVITY_MODEL: "gemini-2.5-pro" },
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
    const backend = new PythonBackend({
      pythonCmd: "uv",
      pythonArgs: ["run", "python", "-m", "opencode_antigravity"],
      env: {
        OAG_BACKEND_MODE: "mock",
        ANTIGRAVITY_MODEL: "gemini-2.5-pro",
        OAG_MOCK_INITIAL_DELAY_MS: "500",
        OAG_STREAM_IDLE_TIMEOUT_MS: "100",
      },
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
**実行モード:** 直列必須 — Wait for T3.4 の Draft PR URL。**かつ、T3.2 (errors マッピング) が master にマージされるか、当ブランチに事前 merge されていること**
**前提条件:** T3.4 の Draft PR URL 取得済み。T3.2 がマージ未済なら Step 2 で merge する

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

- [ ] **Step 2: T3.2 (errors マッピング) を取り込む**

T3.2 が master にマージ済みなら自動で含まれる。未マージなら:

```bash
git fetch origin feature/phase2/ts-errors --no-tags
git merge --no-ff origin/feature/phase2/ts-errors -m "chore: merge T3.2 (errors SDK mapping)"
```

- [ ] **Step 3: `src/server.ts` を更新**

要点:

- `POST /v1/chat/completions` ハンドラで `req.body.stream === true` の場合:
  - `res.setHeader("Content-Type", "text/event-stream")`、`Cache-Control: no-cache`、`Connection: keep-alive`
  - `res.writeHead(200)` で SSE 開始
  - `backend.streamingCall("chat.completions", params, (delta) => writeSseChunk(...))` を await
  - `writeSseChunk` は `data: {<ChatCompletionChunk JSON>}\n\n` を書き出す
  - 最初の chunk で `delta.role: "assistant"` を 1 度だけ送出
  - 最終 response の `finish_reason` を最後の `data:` フレームに反映
  - 終端で `data: [DONE]\n\n` を送出して `res.end()`
- エラー (BackendResponseError) を catch:
  - SSE がまだ開始されていない (= `res.headersSent === false`) なら `toOpenAIError()` の status + JSON body で返す
  - SSE 開始済みなら `data: {"error":{"type":"...","message":"..."}}\n\n` を送出 → `data: [DONE]\n\n` → `res.end()`
- クライアント切断 (`req.on("close", ...)`) で `AbortController` を発火し、`streamingCall` を中断 (内部で Python 側 Generator を `aclose` する仕組みは T3.3 で具備しておく)

- [ ] **Step 4: ローカル smoke テスト (curl で SSE 取得)**

```bash
pnpm build
node dist/index.js &
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

```ts
import { describe, expect, it } from "vitest";

describe("GET /healthz Phase 2 fields", () => {
  it("includes backend_mode and model", async () => {
    process.env.OAG_BACKEND_MODE = "mock";
    process.env.ANTIGRAVITY_MODEL = "gemini-2.5-pro";
    const { createServer } = await import("../../src/server");
    const backend: any = { isAlive: () => true, restartCount: 0 };
    const server = createServer(backend);
    const res = await fetch(`http://localhost:${(server as any).port}/healthz`);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.backend_mode).toBe("mock");
    expect(body.model).toBe("gemini-2.5-pro");
    server.close();
  });
});
```

- [ ] **Step 3: テスト実行で失敗を確認**

```bash
pnpm test:unit -- healthz.phase2
```

Expected: `backend_mode` / `model` が未実装で FAIL。

- [ ] **Step 4: `/healthz` ハンドラを更新**

```ts
res.json({
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
  serverProc = spawn("node", ["dist/index.js"], {
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
    // mock に「最初の chunk 送出後にエラー」モードを発動する環境変数を渡せる前提
    // 本テストはサブプロセスを別途立てる
    const errProc = spawn("node", ["dist/index.js"], {
      env: {
        ...process.env,
        OAG_BACKEND_MODE: "mock",
        ANTIGRAVITY_MODEL: "gemini-2.5-pro",
        OAG_MOCK_FAIL_AFTER_FIRST_CHUNK: "1",
        PORT: "11437",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await fetch(`http://localhost:11437/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.5-pro",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const frames = await readSse(res);
      const errorFrame = frames.find((f) => f.includes("\"error\""));
      expect(errorFrame).toBeTruthy();
      expect(frames[frames.length - 1]).toBe("data: [DONE]");
    } finally {
      errProc.kill();
    }
  });
});
```

- [ ] **Step 4: Mock に `OAG_MOCK_FAIL_AFTER_FIRST_CHUNK` フックを追加**

`MockAntigravityClient.stream_chat` に以下を追加:

```python
fail_after = os.environ.get("OAG_MOCK_FAIL_AFTER_FIRST_CHUNK") == "1"
# ... 既存の "[mock] " yield 直後
if fail_after:
    raise RuntimeError("mock injected failure")
```

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

Expected: 21 既存 + 10 新規 = 31 ケース全 GREEN (mock mode)。

- [ ] **Step 7: コミット**

```bash
git add tests/ts/sse.test.ts backend/src/opencode_antigravity/antigravity_client.py
git commit -m "test(e2e): SSE 正常系・SDK エラー系の E2E テストを追加 (受け入れ#30, #31)"
```

- [ ] **Step 8: プッシュと Draft PR 作成、URL を記録**

```bash
git push -u origin feature/phase2/e2e-mock
gh pr create --draft --base feature/phase2/ts-server-sse \
  --title "test(e2e): SSE mock 経路 (受け入れ#30, #31)" \
  --body "受け入れ基準 #1 (pnpm verify が 31 ケース全 GREEN) を達成。"
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
import { describe, expect, it } from "vitest";

const RUN_LIVE = !!process.env.GEMINI_API_KEY;

describe.skipIf(!RUN_LIVE)("SSE live", () => {
  it("real Gemini returns at least one chunk", async () => {
    // 別途起動済みのサーバを前提とするか、本テスト内で OAG_BACKEND_MODE=live で spawn
    const res = await fetch("http://localhost:11435/v1/chat/completions", {
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

- [ ] **Step 5: `package.json` に `test:e2e:live` を追加**

```json
"scripts": {
  "test:e2e:live": "uv run vitest run tests/ts/sse_live.test.ts && uv run pytest tests/python/e2e_live -m live"
}
```

- [ ] **Step 6: CI 設定の確認**

`bitbucket-pipelines.yml` の `script` 内では `addopts = -m 'not live'` により live は除外される。明示的に `pnpm test:e2e:live` は CI で実行しない。手動 / nightly 運用とする。

- [ ] **Step 7: ローカル smoke (live; 任意。GEMINI_API_KEY 必要)**

```bash
# 開発者の手元で
export GEMINI_API_KEY=...
uv pip install 'opencode-antigravity[live]'
OAG_BACKEND_MODE=live pnpm verify   # 既存 31 ケースは live 経路で通る
OAG_BACKEND_MODE=live pnpm test:e2e:live
```

これは PR 段階では実行不要。CI でも実行しない。

- [ ] **Step 8: コミット**

```bash
git add tests/python/e2e_live tests/ts/sse_live.test.ts package.json pyproject.toml
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

Expected: 31 ケース全 GREEN。

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

## 受け入れ基準 (設計書 Section 13)

Phase 2 全体の完了は以下のすべてが GREEN であることをもって判定する:

1. **`pnpm verify` が 21 既存 + 10 新規 = 31 ケース全 PASS (mock mode)** — T4.2 完了時点で達成、T5.1 で最終確認
2. **`pnpm test:e2e:live` が手動実行で PASS (実 Gemini API)** — T4.3 完了時点で基盤が整い、開発者が手動実行で達成
3. **`GET /healthz` が `backend_mode` と `model` を含む** — T4.1 完了時点で達成
4. **`SPEC.md` セクション 10 の「Antigravity SDK 連携 (Phase 2)」「SSE ストリーミング (Phase 2)」が「完了」に更新** — T5.1 で達成

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
- T2.4: https://...
- T2.5: https://...
- T2.6: https://...
- T3.1: https://...
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

## 自己レビュー (writing-plans skill 準拠)

### 1. 仕様カバレッジ

- 設計書 Section 3 (アーキテクチャ) → T2.x / T3.x
- 設計書 Section 4 (コンポーネント) → 各 Task に 1 対 1 でマッピング
- 設計書 Section 5 (SSE / Notification) → T2.2, T2.4, T3.3, T3.5
- 設計書 Section 6 (エラー) → T2.1, T3.2, T3.5, T4.2
- 設計書 Section 7 (テスト戦略) → T2.1〜T4.3 の各 Step (受け入れ#22〜#31)
- 設計書 Section 8 (設定) → T0.1, T2.6, T4.1
- 設計書 Section 9 (Migration) → T4.1, T5.1
- 設計書 Section 11 (不確定要素) → T1.1
- 設計書 Section 13 (受け入れ基準) → T4.2, T4.3, T5.1

### 2. プレースホルダ scan

- 「TBD」「実装は後で」「適切なエラー処理を追加」の記述は無し
- T1.1 の SDK 型確定は明確に「スパイク調査タスク」として定義
- T2.3 の実 SDK 仮実装は「スパイク結果で具体 API に差し替え」と明示

### 3. 型整合性

- TS 側型 (`ChatCompletionChunk`, `JsonRpcNotification`, `ChatCompletionsChunkNotificationParams`) は T3.1 で定義され、T3.3 / T3.5 で同一名で参照
- Python 側 `AntigravityClientBase` Protocol を T2.3 で定義、T2.5 / T2.6 で同一名参照
- メソッド名 `streamingCall` / `stream_chat` / `chat_completions` がタスク間で一貫

### 4. ポカヨケスクリプト

- 全 18 タスクの Step 1 に `git merge-base --is-ancestor` 検証を埋め込み済み
- `EXPECTED_BASE` 変数は各タスクの「派生元ブランチ」と完全一致

### 5. Draft PR URL 要求

- 直列必須タスクの「前提条件」に「先行タスクの Draft PR URL が `.stack-urls.md` に記録済み」と明記
- 各タスクの末尾に「プッシュ + Draft PR 作成 + URL 記録」のステップ

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-phase2-implementation.md`.**

実行モードは以下のいずれかから選択してください:

1. **Subagent-Driven (推奨)** — 並列可能タスク (T0.1, T0.2, T1.1, T2.1, T2.2, T2.3, T3.1, T3.2, T4.1) を独立 subagent で同時実行し、各タスク完了後に二段階レビュー。直列必須タスクは前提 Draft PR URL を確認してから順次起動。
2. **Inline Execution** — 本セッション内で 1 タスクずつ実行し、Phase 区切りでチェックポイントレビュー。
