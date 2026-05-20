# OpenCode Antigravity Plugin MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TypeScript（HTTP前段）と Python（stdio JSON-RPC ワーカ）をハイブリッド構成した `opencode-antigravity-plugin` の MVP を、設計書 `docs/superpowers/specs/2026-05-20-opencode-antigravity-plugin-mvp-design.md` の 21 テストケースが `pnpm verify` で全パスする状態までフルスクラッチで構築する。

**Architecture:** OpenCode から `127.0.0.1:11435` への OpenAI 互換 HTTP を TS 親プロセスが受け、Python サブプロセスへ NDJSON over stdio で JSON-RPC 2.0 を中継する案 A 構成。MVP では echo 形式の `chat.completions` を返却し、Antigravity SDK・SSE・MCP・OAuth は Phase 2 以降に後回し。配管（IPC・プロセス管理・クラッシュ復旧・エラー伝搬）の正しさに集中する。

**Tech Stack:** Node.js 24 (現行 Active LTS) / TypeScript 5 / pnpm / vitest / pino, Python 3.13 / uv / hatchling / pydantic / pytest / ruff, Devcontainer (mcr.microsoft.com/devcontainers/python:3.13 + NodeSource setup_24.x), Bitbucket Pipelines (image: `ubuntu-slim`).

---

## Git ブランチ運用フロー

本計画は **AI-Native Stacked PR Workflow** に準拠します（参照: <https://different-sunday-448.notion.site/AI-Native-Stacked-PR-Workflow-3611669a4c16802eb032eb4ab05a8adb>）。

主要ルール:

- 各 Task は専用ブランチで作業し、**直前 Task のブランチに向けて Draft PR を出す**（master 直行ではない）。
- 「直列必須（スタック）」タスクは、先行 Task の Draft PR が作成された後に開始する。
- 「並列可能（独立）」タスクは、対象ファイルが他タスクと競合しないことが保証されている場合に限り、同一 Base から派生して同時実行できる。
- 派生元の正当性は、**Step 1 のポカヨケ検証スクリプト**で物理的にチェックする（誤ったブランチで作業を開始すると `exit 1` で進行不可）。
- 全 Task は最後に**派生元ブランチに向けた Draft PR の URL を `docs/superpowers/plans/_pr-urls.md` へ追記**する。

ブランチツリー全体像:

```text
master
└─ phase-0/devcontainer (Task 0.1)
   └─ phase-0/package-init (Task 0.2)
      └─ phase-0/cicd (Task 0.3) ★Phase Base
         ├─ phase-1/types-jsonrpc (Task 1.1) ─並列可能 with Phase 2
         │  └─ phase-1/errors (Task 1.2)
         │     └─ phase-1/jsonrpc-client (Task 1.3)  ★Phase 1 Tip
         └─ phase-2/protocol (Task 2.1) ─並列可能 with Phase 1
            └─ phase-2/handlers (Task 2.2)
               └─ phase-3/server-loop (Task 3.1)  ★Phase 2/3 Tip
                  └─ phase-4/integration (Task 4.0)  ←phase-1/jsonrpc-client をマージ
                     └─ phase-4/backend-lifecycle (Task 4.1)
                        └─ phase-4/permanent-failure (Task 4.2)
                           └─ phase-5/http-server (Task 5.1)
                              └─ phase-5/e2e-verify (Task 5.2)
```

---

## 実行環境ポリシー（CRITICAL）

すべての **テスト実行・静的解析・Step 1 のブランチ検証**は、必ず **Devcontainer 内で実行**してください。Task 0.1 で devcontainer がビルドされた以降、ホストで直接 `pnpm` / `uv run` / `pytest` 等を実行することは禁止します。

Devcontainer 突入の標準コマンド（VS Code または `devcontainer-cli`）:

```bash
# VS Code 利用時: "Reopen in Container" を実行
# CLI 利用時:
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash
```

以後の Bash ブロックの先頭には `# (devcontainer 内で実行)` を付与しています。

---

## ファイル構成（最終形）

`design.md §4` の構成を最終形とします。Phase ごとに以下のファイルを生成/更新します。

| Phase | 主な生成/変更ファイル |
|---|---|
| 0 | `.devcontainer/devcontainer.json`, `.devcontainer/Dockerfile`, `.gitignore`, `README.md`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `pyproject.toml`, `uv.lock`, `bitbucket-pipelines.yml` |
| 1 | `src/types.ts`, `src/jsonrpc.ts`, `src/errors.ts`, `tests/ts/jsonrpc.test.ts`, `tests/ts/errors.test.ts` |
| 2 | `backend/src/opencode_antigravity/__init__.py`, `protocol.py`, `handlers.py`, `tests/python/test_protocol.py`, `tests/python/test_handlers.py` |
| 3 | `backend/src/opencode_antigravity/server.py`, `__main__.py`, `tests/python/test_server_e2e.py` |
| 4 | `src/backend.ts`, `tests/ts/backend.test.ts` |
| 5 | `src/server.ts`, `src/index.ts`, `tests/ts/integration.test.ts` |

---

## Phase 0: Foundation

### Task 0.1: Devcontainer 構築

**メタデータ:**

- 派生元ブランチ: `master`
- 実行モード: 直列必須（本計画の最初の Task）
- 前提条件: なし

**Files:**

- Create: `.devcontainer/devcontainer.json`
- Create: `.devcontainer/Dockerfile`
- Create: `.gitignore`
- Modify: `README.md`（最小スケルトン追記）

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (ホストで実行: devcontainer がまだ無いため初手のみホスト許容)
git fetch origin
git checkout master
git pull --ff-only
git checkout -b phase-0/devcontainer

# ポカヨケ: 派生元検証
EXPECTED_BASE="master"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

期待出力: `OK: phase-0/devcontainer は master から派生しています。`

- [ ] **Step 2: .gitignore を作成**

```gitignore
# Node
node_modules/
.pnpm-store/
dist/
*.log

# Python
__pycache__/
*.py[cod]
*$py.class
.venv/
.uv-cache/
*.egg-info/

# IDE
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db

# Build artifacts
build/
*.tsbuildinfo
```

- [ ] **Step 3: .devcontainer/Dockerfile を作成**

```dockerfile
FROM mcr.microsoft.com/devcontainers/python:3.13

# Node 24 (Active LTS) を NodeSource 経由で導入（features は使わず軽量化）
ARG NODE_VERSION=24

# pnpm + uv を導入
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@9 \
    && pip install --no-cache-dir uv

# 動作ユーザは devcontainer 既定の vscode
USER vscode
WORKDIR /workspaces/opencode-antigravity-plugin
```

- [ ] **Step 4: .devcontainer/devcontainer.json を作成**

```json
{
  "name": "opencode-antigravity-plugin",
  "build": { "dockerfile": "Dockerfile" },
  "forwardPorts": [11435],
  "portsAttributes": {
    "11435": { "label": "OpenAI-compatible endpoint", "onAutoForward": "silent" }
  },
  "remoteUser": "vscode",
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

- [ ] **Step 5: README.md を最小化**

```markdown
# opencode-antigravity-plugin

OpenAI 互換 HTTP を OpenCode から受け、Python の Antigravity ワーカへ stdio JSON-RPC で中継するハイブリッドプラグイン。

## 開発

1. VS Code で本リポジトリを開き「Reopen in Container」を実行
2. devcontainer 内で `pnpm install && uv sync`
3. `pnpm verify` で全テスト実行

設計の詳細は `docs/superpowers/specs/2026-05-20-opencode-antigravity-plugin-mvp-design.md` を参照。
```

- [ ] **Step 6: devcontainer ビルド検証**

```bash
# (ホストで実行)
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash -lc 'node --version && python --version && pnpm --version && uv --version'
```

期待出力: `v24.x.x`, `Python 3.13.x`, `9.x.x`, `0.x.x` の 4 行。

- [ ] **Step 7: コミットと Draft PR 作成**

```bash
git add .devcontainer/ .gitignore README.md
git commit -m "feat(devcontainer): Node 24 + Python 3.13 + pnpm + uv 環境を整備"
git push -u origin phase-0/devcontainer

gh pr create --draft --base master --title "Phase 0.1: Devcontainer 構築" --body "$(cat <<'EOF'
## Summary
- Node 24 (Active LTS) + Python 3.13 の devcontainer (Dockerfile + devcontainer.json)
- pnpm@9 と uv を導入
- ポート 11435 をフォワード設定
- .gitignore と README スケルトン

## Test plan
- [ ] devcontainer up が成功する
- [ ] node, python, pnpm, uv の各バージョン取得が成功する
EOF
)"
```

PR URL を `docs/superpowers/plans/_pr-urls.md` に追記する（後続タスクが参照）。

---

### Task 0.2: パッケージ初期化（pnpm + uv + 最小 hello テスト）

**メタデータ:**

- 派生元ブランチ: `phase-0/devcontainer`
- 実行モード: 直列必須（Wait for Task 0.1）
- 前提条件: Task 0.1 の Draft PR URL が存在し、`phase-0/devcontainer` がリモートに push されていること

**Files:**

- Create: `package.json`, `tsconfig.json`, `pyproject.toml`
- Create: `tests/ts/hello.test.ts`, `tests/python/test_hello.py`
- Create: `backend/src/opencode_antigravity/__init__.py`（空）

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-0/devcontainer
git pull --ff-only
git checkout -b phase-0/package-init

EXPECTED_BASE="phase-0/devcontainer"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: package.json を作成**

```json
{
  "name": "opencode-antigravity-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test:unit": "vitest run tests/ts --exclude tests/ts/backend.test.ts --exclude tests/ts/integration.test.ts",
    "test:integration": "vitest run tests/ts/backend.test.ts",
    "test:e2e": "vitest run tests/ts/integration.test.ts",
    "test:python": "uv run pytest",
    "lint:python": "uv run ruff check backend/src tests/python",
    "verify": "uv run ruff check backend/src tests/python && uv run pytest && pnpm test:unit && pnpm test:integration && pnpm test:e2e"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.4.0",
    "pino": "^9.0.0"
  }
}
```

- [ ] **Step 3: tsconfig.json を作成**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/ts/**/*.ts"]
}
```

- [ ] **Step 4: pyproject.toml を作成（hatchling + src レイアウト + ruff T20）**

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "opencode-antigravity"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = [
    "pydantic>=2.6.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "ruff>=0.4.0",
    "pyyaml>=6.0",
]

[tool.hatch.build.targets.wheel]
packages = ["backend/src/opencode_antigravity"]

[tool.hatch.build.targets.wheel.sources]
"backend/src" = ""

[tool.uv]
dev-dependencies = [
    "pytest>=8.0.0",
    "ruff>=0.4.0",
    "pyyaml>=6.0",
]

[tool.ruff]
line-length = 100
target-version = "py313"

[tool.ruff.lint]
select = ["E", "F", "I", "T20"]  # T201 = print, T203 = pprint

[tool.pytest.ini_options]
pythonpath = ["backend/src"]
testpaths = ["tests/python"]
```

- [ ] **Step 5: 最小 Python パッケージスケルトン**

`backend/src/opencode_antigravity/__init__.py`:

```python
"""opencode_antigravity package."""

__version__ = "0.1.0"
```

- [ ] **Step 6: 最小テストを書く（hello tests）**

`tests/python/test_hello.py`:

```python
from opencode_antigravity import __version__


def test_version_is_set() -> None:
    assert __version__ == "0.1.0"
```

`tests/ts/hello.test.ts`:

```typescript
import { describe, expect, test } from "vitest";

describe("hello", () => {
  test("smoke", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: 依存解決とテストが通ることを確認**

```bash
# (devcontainer 内で実行)
pnpm install
uv sync
uv run pytest -q
pnpm test:unit
uv run ruff check backend/src tests/python
```

期待出力: pytest `1 passed`、vitest `1 passed`、ruff エラー 0 件。

- [ ] **Step 8: コミットと Draft PR 作成**

```bash
git add package.json tsconfig.json pyproject.toml uv.lock pnpm-lock.yaml backend/ tests/
git commit -m "feat(package): pnpm + uv + hatchling + ruff T20 を初期化し最小テストを通す"
git push -u origin phase-0/package-init

gh pr create --draft --base phase-0/devcontainer --title "Phase 0.2: パッケージ初期化と最小テスト" --body "$(cat <<'EOF'
## Summary
- package.json (vitest, tsx, pino, typescript)
- pyproject.toml (hatchling backend, pydantic, pytest, ruff T20)
- 最小 hello テスト (TS / Python 各1件) が通る
- ruff lint がエラー 0 件

## Test plan
- [ ] `pnpm install && uv sync` が成功
- [ ] `pnpm test:unit` が PASS
- [ ] `uv run pytest` が PASS
- [ ] `uv run ruff check` がエラー 0
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。

---

### Task 0.3: Bitbucket Pipelines CI/CD 設定

**メタデータ:**

- 派生元ブランチ: `phase-0/package-init`
- 実行モード: 直列必須（Wait for Task 0.2）
- 前提条件: Task 0.2 の Draft PR URL が存在すること

**Files:**

- Create: `bitbucket-pipelines.yml`

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-0/package-init
git pull --ff-only
git checkout -b phase-0/cicd

EXPECTED_BASE="phase-0/package-init"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: bitbucket-pipelines.yml を作成**

```yaml
image: ubuntu-slim

definitions:
  caches:
    pnpm: ~/.local/share/pnpm/store
    uv: ~/.cache/uv

  steps:
    - step: &verify
        name: Verify (lint + unit + integration + e2e)
        caches:
          - pnpm
          - uv
        script:
          # Node 24 (Active LTS) を NodeSource から明示インストール（Dockerfile と同一系列）
          - apt-get update && apt-get install -y curl ca-certificates gnupg python3.13 python3.13-venv python3-pip
          - curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
          - apt-get install -y nodejs
          - npm install -g pnpm@9
          - pip install uv
          - pnpm install --frozen-lockfile
          - uv sync --frozen
          - pnpm verify

pipelines:
  branches:
    master:
      - step: *verify
  pull-requests:
    '**':
      - step: *verify
```

ポイント:

- `image: ubuntu-slim` を最上位で指定（ユーザー要件）。
- `master` ブランチで `verify` が走る（21 テスト全実行）。
- PR にも同等チェックを実施。

- [ ] **Step 3: YAML 妥当性を確認**

`uv run` を経由して `pyyaml` を解決します（Task 0.2 で dev-dependencies に追加済み）。

```bash
# (devcontainer 内で実行)
uv run python -c "import yaml; yaml.safe_load(open('bitbucket-pipelines.yml')); print('YAML OK')"
```

期待出力: `YAML OK`

- [ ] **Step 4: コミットと Draft PR 作成**

```bash
git add bitbucket-pipelines.yml
git commit -m "ci: bitbucket-pipelines.yml を追加 (image: ubuntu-slim, master + PR トリガ)"
git push -u origin phase-0/cicd

gh pr create --draft --base phase-0/package-init --title "Phase 0.3: Bitbucket Pipelines CI/CD" --body "$(cat <<'EOF'
## Summary
- bitbucket-pipelines.yml を追加
- image: ubuntu-slim を明示
- master ブランチ + 全 PR で `pnpm verify` を実行

## Test plan
- [ ] YAML パース成功
- [ ] (master マージ後) Bitbucket Pipelines で verify ステップが PASS
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。**`phase-0/cicd` は以後 Phase Base として扱う**。

---

## Phase 1: TypeScript 純粋ロジック層

> Phase 1 と Phase 2 は対象ファイルが完全に分離しているため、両 Phase の入口タスク（1.1 と 2.1）は同一 Phase Base から派生する **並列可能** タスクです。

### Task 1.1: types.ts と jsonrpc.ts の encode/parse 純粋関数

**メタデータ:**

- 派生元ブランチ: `phase-0/cicd`（Phase Base）
- 実行モード: 並列可能（Phase 2 入口 Task 2.1 と並列実行可）
- 前提条件: Task 0.3 の Draft PR URL が存在すること（Phase Base が確定していること）
- 対応テスト: design.md test #9 `encodes request as NDJSON`

**Files:**

- Create: `src/types.ts`
- Create: `src/jsonrpc.ts`
- Create: `tests/ts/jsonrpc.test.ts`

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-0/cicd
git pull --ff-only
git checkout -b phase-1/types-jsonrpc

EXPECTED_BASE="phase-0/cicd"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: テストを書く（encode の RED）**

`tests/ts/jsonrpc.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { encodeRequest, parseMessage } from "../../src/jsonrpc.js";

describe("jsonrpc.encodeRequest", () => {
  test("encodes request as NDJSON (single trailing newline)", () => {
    const encoded = encodeRequest({ id: 1, method: "echo", params: { text: "hi" } });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.split("\n").length).toBe(2);
    const parsed = JSON.parse(encoded);
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, method: "echo", params: { text: "hi" } });
  });
});

describe("jsonrpc.parseMessage", () => {
  test("parses success response", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"text":"hi"}}');
    expect(msg).toEqual({ jsonrpc: "2.0", id: 1, result: { text: "hi" } });
  });
});
```

- [ ] **Step 3: RED を確認**

```bash
# (devcontainer 内で実行)
pnpm test:unit
```

期待出力: `tests/ts/jsonrpc.test.ts` で `Cannot find module ../../src/jsonrpc.js` または import エラー（型がまだ無いため FAIL）。

- [ ] **Step 4: 型定義を書く**

`src/types.ts`:

```typescript
// ----- JSON-RPC 2.0 -----
export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

// ----- OpenAI Chat Completions (subset) -----
export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
}

export interface OpenAIChatChoice {
  index: number;
  message: OpenAIChatMessage;
  finish_reason: "stop" | "length" | "content_filter";
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  model: string;
  choices: OpenAIChatChoice[];
}
```

- [ ] **Step 5: jsonrpc.ts の encode/parse 純粋関数を書く（GREEN 目標）**

`src/jsonrpc.ts`:

```typescript
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest } from "./types.js";

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB (design §7.4)

export function encodeRequest(args: {
  id: JsonRpcId;
  method: string;
  params: unknown;
}): string {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: args.id,
    method: args.method,
    params: args.params,
  };
  const line = JSON.stringify(req) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("jsonrpc: outbound message exceeds 1 MB");
  }
  return line;
}

export function parseMessage(line: string): JsonRpcMessage {
  const trimmed = line.replace(/\n$/, "");
  if (Buffer.byteLength(trimmed, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("jsonrpc: inbound message exceeds 1 MB");
  }
  const obj = JSON.parse(trimmed) as JsonRpcMessage;
  if (obj.jsonrpc !== "2.0") {
    throw new Error("jsonrpc: missing or invalid jsonrpc version");
  }
  return obj;
}
```

- [ ] **Step 6: GREEN を確認**

```bash
# (devcontainer 内で実行)
pnpm test:unit
```

期待出力: `tests/ts/jsonrpc.test.ts` で 2 件 PASS（既存 `hello` 含めて 3 件 PASS）。

- [ ] **Step 7: コミットと Draft PR 作成**

```bash
git add src/types.ts src/jsonrpc.ts tests/ts/jsonrpc.test.ts
git commit -m "feat(jsonrpc): NDJSON エンコード/パース純粋関数と OpenAI/JSON-RPC 型定義"
git push -u origin phase-1/types-jsonrpc

gh pr create --draft --base phase-0/cicd --title "Phase 1.1: types + jsonrpc encode/parse" --body "$(cat <<'EOF'
## Summary
- OpenAI 互換型 + JSON-RPC 2.0 型を src/types.ts に定義
- encodeRequest / parseMessage 純粋関数
- 1 MB 上限チェック (design §7.4)
- design.md test #9 を通す

## Test plan
- [ ] encodes request as NDJSON (PASS)
- [ ] parses success response (PASS)
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。

---

### Task 1.2: errors.ts（エラー型と OpenAI 形式変換）

**メタデータ:**

- 派生元ブランチ: `phase-1/types-jsonrpc`
- 実行モード: 直列必須（Wait for Task 1.1）
- 前提条件: Task 1.1 の Draft PR URL が存在すること
- 対応テスト: design.md test #12 `converts BackendCrashedError to OpenAI 503`

**Files:**

- Create: `src/errors.ts`
- Create: `tests/ts/errors.test.ts`

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-1/types-jsonrpc
git pull --ff-only
git checkout -b phase-1/errors

EXPECTED_BASE="phase-1/types-jsonrpc"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: テストを書く（RED）**

`tests/ts/errors.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import {
  BackendCrashedError,
  BackendTimeoutError,
  BackendPermanentlyFailedError,
  ProtocolError,
  toOpenAIError,
} from "../../src/errors.js";

describe("toOpenAIError", () => {
  test("converts BackendCrashedError to OpenAI 503 backend_unavailable", () => {
    const { status, body } = toOpenAIError(new BackendCrashedError("python died"));
    expect(status).toBe(503);
    expect(body.error.type).toBe("backend_unavailable");
    expect(body.error.message).toContain("python died");
  });

  test("converts BackendTimeoutError to 504 timeout", () => {
    const { status, body } = toOpenAIError(new BackendTimeoutError("60s exceeded"));
    expect(status).toBe(504);
    expect(body.error.type).toBe("timeout");
  });

  test("converts BackendPermanentlyFailedError to 503 with permanently failed message", () => {
    const { status, body } = toOpenAIError(new BackendPermanentlyFailedError());
    expect(status).toBe(503);
    expect(body.error.type).toBe("backend_unavailable");
    expect(body.error.message).toMatch(/permanently failed/);
  });

  test("converts ProtocolError to 400 invalid_request_error", () => {
    const { status, body } = toOpenAIError(new ProtocolError("bad json"));
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
  });
});
```

- [ ] **Step 3: RED を確認**

```bash
# (devcontainer 内で実行)
pnpm test:unit -- errors
```

期待出力: モジュール未定義で FAIL。

- [ ] **Step 4: errors.ts を実装（GREEN）**

`src/errors.ts`:

```typescript
export class BackendCrashedError extends Error {
  readonly name = "BackendCrashedError";
}

export class BackendTimeoutError extends Error {
  readonly name = "BackendTimeoutError";
}

export class BackendPermanentlyFailedError extends Error {
  readonly name = "BackendPermanentlyFailedError";
  constructor(message = "backend permanently failed") {
    super(message);
  }
}

export class ProtocolError extends Error {
  readonly name = "ProtocolError";
}

export class NotImplementedError extends Error {
  readonly name = "NotImplementedError";
}

export interface OpenAIErrorBody {
  error: { type: string; message: string };
}

export function toOpenAIError(err: Error): { status: number; body: OpenAIErrorBody } {
  if (err instanceof BackendPermanentlyFailedError) {
    return {
      status: 503,
      body: { error: { type: "backend_unavailable", message: err.message } },
    };
  }
  if (err instanceof BackendCrashedError) {
    return {
      status: 503,
      body: {
        error: {
          type: "backend_unavailable",
          message: `backend restarting, retry later: ${err.message}`,
        },
      },
    };
  }
  if (err instanceof BackendTimeoutError) {
    return { status: 504, body: { error: { type: "timeout", message: err.message } } };
  }
  if (err instanceof NotImplementedError) {
    return {
      status: 501,
      body: { error: { type: "not_implemented", message: err.message } },
    };
  }
  if (err instanceof ProtocolError) {
    return {
      status: 400,
      body: { error: { type: "invalid_request_error", message: err.message } },
    };
  }
  return { status: 500, body: { error: { type: "server_error", message: err.message } } };
}
```

- [ ] **Step 5: GREEN を確認**

```bash
# (devcontainer 内で実行)
pnpm test:unit
```

期待出力: errors.test.ts の 4 件すべて PASS。

- [ ] **Step 6: コミットと Draft PR 作成**

```bash
git add src/errors.ts tests/ts/errors.test.ts
git commit -m "feat(errors): backend エラー型と OpenAI エラー形式への変換"
git push -u origin phase-1/errors

gh pr create --draft --base phase-1/types-jsonrpc --title "Phase 1.2: errors.ts と OpenAI 変換" --body "$(cat <<'EOF'
## Summary
- BackendCrashedError / BackendTimeoutError / BackendPermanentlyFailedError / ProtocolError / NotImplementedError
- toOpenAIError() で HTTP status + OpenAI 形式 body へ変換
- design.md §8.1 のエラー対応表に準拠
- design.md test #12 を通す

## Test plan
- [ ] BackendCrashedError → 503 backend_unavailable
- [ ] BackendTimeoutError → 504 timeout
- [ ] BackendPermanentlyFailedError → 503 permanently failed
- [ ] ProtocolError → 400 invalid_request_error
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。

---

### Task 1.3: JsonRpcClient（pending map + timeout + 遅延応答握り潰し）

**メタデータ:**

- 派生元ブランチ: `phase-1/errors`
- 実行モード: 直列必須（Wait for Task 1.2）
- 前提条件: Task 1.2 の Draft PR URL が存在すること
- 対応テスト: design.md test #10 `parses response and resolves by id`, #11 `handles error response`, #13 `timeout rejects promise and removes entry from pending map; late response is ignored`

**Files:**

- Modify: `src/jsonrpc.ts`（`JsonRpcClient` クラスを追加）
- Modify: `tests/ts/jsonrpc.test.ts`（テスト追加）

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-1/errors
git pull --ff-only
git checkout -b phase-1/jsonrpc-client

EXPECTED_BASE="phase-1/errors"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: テスト追加（RED）**

`tests/ts/jsonrpc.test.ts` に追記:

```typescript
import { JsonRpcClient } from "../../src/jsonrpc.js";
import { BackendTimeoutError } from "../../src/errors.js";

describe("JsonRpcClient", () => {
  test("resolves promise by id when response arrives", async () => {
    const sent: string[] = [];
    const client = new JsonRpcClient({ write: (line) => sent.push(line) });
    const promise = client.call("echo", { text: "hi" }, { timeoutMs: 1000 });
    expect(sent.length).toBe(1);
    const sentReq = JSON.parse(sent[0]!);
    client.handleInboundLine(
      JSON.stringify({ jsonrpc: "2.0", id: sentReq.id, result: { text: "hi" } }),
    );
    await expect(promise).resolves.toEqual({ text: "hi" });
  });

  test("rejects with error response", async () => {
    const sent: string[] = [];
    const client = new JsonRpcClient({ write: (line) => sent.push(line) });
    const promise = client.call("bad", {}, { timeoutMs: 1000 });
    const id = JSON.parse(sent[0]!).id;
    client.handleInboundLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      }),
    );
    await expect(promise).rejects.toThrow(/Method not found/);
  });

  test("timeout rejects, removes entry from pending map, ignores late response", async () => {
    const sent: string[] = [];
    const warnLogs: string[] = [];
    const client = new JsonRpcClient({
      write: (line) => sent.push(line),
      warn: (msg) => warnLogs.push(msg),
    });
    const promise = client.call("slow", {}, { timeoutMs: 10 });
    await expect(promise).rejects.toBeInstanceOf(BackendTimeoutError);
    expect(client.pendingCount).toBe(0);

    const id = JSON.parse(sent[0]!).id;
    client.handleInboundLine(
      JSON.stringify({ jsonrpc: "2.0", id, result: { text: "late" } }),
    );
    expect(warnLogs.some((m) => m.includes("unknown id"))).toBe(true);
    expect(client.pendingCount).toBe(0);
  });
});
```

- [ ] **Step 3: RED を確認**

```bash
# (devcontainer 内で実行)
pnpm test:unit -- jsonrpc
```

期待出力: `JsonRpcClient` 未定義で FAIL。

- [ ] **Step 4: JsonRpcClient を実装（GREEN）**

`src/jsonrpc.ts` の末尾に追記:

```typescript
import { BackendTimeoutError } from "./errors.js";
import type { JsonRpcId, JsonRpcResponse } from "./types.js";

interface PendingEntry {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
}

export interface JsonRpcClientOptions {
  write: (line: string) => void;
  warn?: (message: string) => void;
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingEntry>();

  constructor(private readonly opts: JsonRpcClientOptions) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  call(method: string, params: unknown, { timeoutMs }: { timeoutMs: number }): Promise<unknown> {
    const id = this.nextId++;
    const line = encodeRequest({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        // design §7.5: delete FIRST, then reject
        this.pending.delete(id);
        reject(new BackendTimeoutError(`call timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutHandle });
      this.opts.write(line);
    });
  }

  handleInboundLine(line: string): void {
    const msg = parseMessage(line) as JsonRpcResponse;
    const entry = msg.id == null ? undefined : this.pending.get(msg.id);
    if (!entry) {
      this.opts.warn?.(`unknown id from backend: ${String(msg.id)} (already cleaned up)`);
      return;
    }
    // design §7.5: delete FIRST, then resolve/reject
    this.pending.delete(msg.id!);
    clearTimeout(entry.timeoutHandle);
    if ("error" in msg) {
      entry.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  rejectAll(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timeoutHandle);
      this.pending.delete(id);
      entry.reject(err);
    }
  }
}
```

- [ ] **Step 5: GREEN を確認**

```bash
# (devcontainer 内で実行)
pnpm test:unit
```

期待出力: 既存テスト + 新規 3 件、すべて PASS。

- [ ] **Step 6: コミットと Draft PR 作成**

```bash
git add src/jsonrpc.ts tests/ts/jsonrpc.test.ts
git commit -m "feat(jsonrpc): JsonRpcClient with pending map と timeout 後の遅延応答握り潰し"
git push -u origin phase-1/jsonrpc-client

gh pr create --draft --base phase-1/errors --title "Phase 1.3: JsonRpcClient (pending map + timeout cleanup)" --body "$(cat <<'EOF'
## Summary
- JsonRpcClient: write/warn を DI、call() が timeoutMs を受ける
- 7.5 規約: pending Map から delete を resolve/reject より先に実行
- timeout 発火後の遅延応答は warn ログを残して握り潰す
- rejectAll() でクラッシュ時の一括 reject に備える
- design.md test #10, #11, #13 を通す

## Test plan
- [ ] resolves by id
- [ ] handles error response
- [ ] timeout cleans pending map + late response ignored
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。**`phase-1/jsonrpc-client` は Phase 1 Tip として Task 4.0 でマージされる**。

---

## Phase 2: Python 純粋ロジック層

> Phase 1 と並列実行可能。Python ファイルのみを触り、TS と競合しない。

### Task 2.1: protocol.py（pydantic JSON-RPC 検証）

**メタデータ:**

- 派生元ブランチ: `phase-0/cicd`（Phase Base）
- 実行モード: 並列可能（Phase 1 入口 Task 1.1 と並列実行可）
- 前提条件: Task 0.3 の Draft PR URL が存在すること
- 対応テスト: design.md test #1〜#4

**Files:**

- Create: `backend/src/opencode_antigravity/protocol.py`
- Create: `tests/python/test_protocol.py`

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-0/cicd
git pull --ff-only
git checkout -b phase-2/protocol

EXPECTED_BASE="phase-0/cicd"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: テストを書く（RED）**

`tests/python/test_protocol.py`:

```python
import pytest

from opencode_antigravity.protocol import (
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcSuccess,
    format_error,
    format_response,
    parse_request,
)


def test_parse_valid_request() -> None:
    req = parse_request('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"hi"}}')
    assert isinstance(req, JsonRpcRequest)
    assert req.id == 1
    assert req.method == "echo"
    assert req.params == {"text": "hi"}


def test_parse_invalid_jsonrpc_version() -> None:
    with pytest.raises(ValueError, match="jsonrpc version"):
        parse_request('{"jsonrpc":"1.0","id":1,"method":"echo","params":{}}')


def test_format_response() -> None:
    resp = format_response(JsonRpcSuccess(id=1, result={"text": "hi"}))
    assert resp == '{"jsonrpc":"2.0","id":1,"result":{"text":"hi"}}'


def test_format_error_with_code() -> None:
    err = format_error(JsonRpcError(id=1, code=-32602, message="Invalid params"))
    assert '"code":-32602' in err
    assert '"message":"Invalid params"' in err
```

- [ ] **Step 3: RED を確認**

```bash
# (devcontainer 内で実行)
uv run pytest tests/python/test_protocol.py -v
```

期待出力: ImportError で FAIL。

- [ ] **Step 4: protocol.py を実装（GREEN）**

`backend/src/opencode_antigravity/protocol.py`:

```python
"""JSON-RPC 2.0 protocol types and serialization (pydantic-backed)."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError


class JsonRpcRequest(BaseModel):
    jsonrpc: Literal["2.0"]
    id: int | str
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class JsonRpcSuccess(BaseModel):
    id: int | str
    result: Any


class JsonRpcError(BaseModel):
    id: int | str | None
    code: int
    message: str
    data: Any | None = None


def parse_request(line: str) -> JsonRpcRequest:
    """Parse one NDJSON line into a JsonRpcRequest. Raises ValueError on invalidity."""
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as e:
        raise ValueError(f"parse error: {e}") from e
    if obj.get("jsonrpc") != "2.0":
        raise ValueError("invalid jsonrpc version (expected '2.0')")
    try:
        return JsonRpcRequest.model_validate(obj)
    except ValidationError as e:
        raise ValueError(f"invalid request shape: {e}") from e


def format_response(success: JsonRpcSuccess) -> str:
    return json.dumps(
        {"jsonrpc": "2.0", "id": success.id, "result": success.result},
        separators=(",", ":"),
        ensure_ascii=False,
    )


def format_error(err: JsonRpcError) -> str:
    body: dict[str, Any] = {"code": err.code, "message": err.message}
    if err.data is not None:
        body["data"] = err.data
    return json.dumps(
        {"jsonrpc": "2.0", "id": err.id, "error": body},
        separators=(",", ":"),
        ensure_ascii=False,
    )
```

- [ ] **Step 5: GREEN を確認**

```bash
# (devcontainer 内で実行)
uv run pytest tests/python/test_protocol.py -v
uv run ruff check backend/src tests/python
```

期待出力: 4 件 PASS、ruff エラー 0。

- [ ] **Step 6: コミットと Draft PR 作成**

```bash
git add backend/src/opencode_antigravity/protocol.py tests/python/test_protocol.py
git commit -m "feat(protocol): pydantic で JSON-RPC 2.0 リクエスト/レスポンス検証"
git push -u origin phase-2/protocol

gh pr create --draft --base phase-0/cicd --title "Phase 2.1: protocol.py (pydantic JSON-RPC)" --body "$(cat <<'EOF'
## Summary
- pydantic ベースの JsonRpcRequest / JsonRpcSuccess / JsonRpcError
- parse_request: jsonrpc バージョン検証 + 形式検証
- format_response / format_error: 安定したキー順での JSON 直列化
- design.md test #1〜#4 を通す

## Test plan
- [ ] valid request パース成功
- [ ] invalid jsonrpc version で ValueError
- [ ] success レスポンス整形
- [ ] error レスポンス整形 (code 付き)
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。

---

### Task 2.2: handlers.py（echo / health / chat.completions）

**メタデータ:**

- 派生元ブランチ: `phase-2/protocol`
- 実行モード: 直列必須（Wait for Task 2.1）
- 前提条件: Task 2.1 の Draft PR URL が存在すること
- 対応テスト: design.md test #5〜#8

**Files:**

- Create: `backend/src/opencode_antigravity/handlers.py`
- Create: `tests/python/test_handlers.py`

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-2/protocol
git pull --ff-only
git checkout -b phase-2/handlers

EXPECTED_BASE="phase-2/protocol"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: テストを書く（RED）**

`tests/python/test_handlers.py`:

```python
import pytest

from opencode_antigravity.handlers import (
    chat_completions,
    echo,
    health,
)


def test_echo() -> None:
    assert echo({"text": "hi"}) == {"text": "hi"}


def test_health() -> None:
    result = health({})
    assert result["status"] == "ok"
    assert "version" in result


def test_chat_completions_returns_openai_format() -> None:
    result = chat_completions(
        {
            "model": "opencode-antigravity-echo",
            "messages": [{"role": "user", "content": "hi"}],
        }
    )
    assert result["object"] == "chat.completion"
    assert result["model"] == "opencode-antigravity-echo"
    assert result["choices"][0]["message"]["role"] == "assistant"
    assert result["choices"][0]["message"]["content"] == "[echo] hi"
    assert result["choices"][0]["finish_reason"] == "stop"
    assert result["id"].startswith("chatcmpl-")


def test_chat_completions_invalid_params() -> None:
    with pytest.raises(ValueError):
        chat_completions({"model": "x"})  # messages 欠落
```

- [ ] **Step 3: RED を確認**

```bash
# (devcontainer 内で実行)
uv run pytest tests/python/test_handlers.py -v
```

期待出力: ImportError で FAIL。

- [ ] **Step 4: handlers.py を実装（GREEN）**

`backend/src/opencode_antigravity/handlers.py`:

```python
"""MVP handlers: echo / health / chat.completions."""

from __future__ import annotations

import logging
import secrets
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from . import __version__

logger = logging.getLogger(__name__)


def echo(params: dict[str, Any]) -> dict[str, Any]:
    text = params.get("text", "")
    return {"text": text}


def health(_params: dict[str, Any]) -> dict[str, Any]:
    return {"status": "ok", "version": __version__}


class _ChatMessage(BaseModel):
    role: str
    content: str


class _ChatRequest(BaseModel):
    model: str
    messages: list[_ChatMessage] = Field(min_length=1)


def chat_completions(params: dict[str, Any]) -> dict[str, Any]:
    try:
        req = _ChatRequest.model_validate(params)
    except ValidationError as e:
        raise ValueError(f"invalid chat.completions params: {e}") from e

    last_user_msg = next(
        (m for m in reversed(req.messages) if m.role == "user"),
        req.messages[-1],
    )
    reply = f"[echo] {last_user_msg.content}"
    return {
        "id": f"chatcmpl-{secrets.token_hex(12)}",
        "object": "chat.completion",
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }
        ],
    }
```

- [ ] **Step 5: GREEN を確認**

```bash
# (devcontainer 内で実行)
uv run pytest tests/python/test_handlers.py -v
uv run ruff check backend/src tests/python
```

期待出力: 4 件 PASS、ruff エラー 0（`print` 使用 0）。

- [ ] **Step 6: コミットと Draft PR 作成**

```bash
git add backend/src/opencode_antigravity/handlers.py tests/python/test_handlers.py
git commit -m "feat(handlers): echo / health / chat.completions の echo 応答を実装"
git push -u origin phase-2/handlers

gh pr create --draft --base phase-2/protocol --title "Phase 2.2: handlers.py (echo/health/chat.completions)" --body "$(cat <<'EOF'
## Summary
- echo: そのまま text を返す
- health: status + version
- chat.completions: 最後の user メッセージを "[echo] ..." として OpenAI 形式で返す
- pydantic で params 検証、不正は ValueError
- design.md test #5〜#8 を通す

## Test plan
- [ ] echo round-trip
- [ ] health returns ok + version
- [ ] chat.completions returns OpenAI shape
- [ ] chat.completions invalid params raises
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。

---

## Phase 3: Python stdio JSON-RPC サーバ

### Task 3.1: server.py（stdio ループ）と __main__.py + e2e

**メタデータ:**

- 派生元ブランチ: `phase-2/handlers`
- 実行モード: 直列必須（Wait for Task 2.2）
- 前提条件: Task 2.2 の Draft PR URL が存在すること
- 対応テスト: なし（テスト #14, #15 は Phase 4 で TS から実 Python を spawn して検証）。本タスクは Python e2e として独自に `test_server_e2e.py` を追加。

**Files:**

- Create: `backend/src/opencode_antigravity/server.py`
- Create: `backend/src/opencode_antigravity/__main__.py`
- Create: `tests/python/test_server_e2e.py`

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-2/handlers
git pull --ff-only
git checkout -b phase-3/server-loop

EXPECTED_BASE="phase-2/handlers"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: e2e テストを書く（RED）**

`tests/python/test_server_e2e.py`:

```python
import json
import subprocess
import sys
import time


def _spawn() -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [sys.executable, "-m", "opencode_antigravity"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _rpc(proc: subprocess.Popen[bytes], req: dict) -> dict:
    assert proc.stdin and proc.stdout
    proc.stdin.write((json.dumps(req) + "\n").encode())
    proc.stdin.flush()
    line = proc.stdout.readline().decode()
    return json.loads(line)


def test_health_round_trip() -> None:
    proc = _spawn()
    try:
        time.sleep(0.2)  # 起動猶予
        resp = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "health", "params": {}})
        assert resp["id"] == 1
        assert resp["result"]["status"] == "ok"
    finally:
        proc.terminate()
        proc.wait(timeout=3)


def test_unknown_method_returns_minus_32601() -> None:
    proc = _spawn()
    try:
        time.sleep(0.2)
        resp = _rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "nope", "params": {}})
        assert resp["error"]["code"] == -32601
    finally:
        proc.terminate()
        proc.wait(timeout=3)
```

- [ ] **Step 3: RED を確認**

```bash
# (devcontainer 内で実行)
uv run pytest tests/python/test_server_e2e.py -v
```

期待出力: `No module named opencode_antigravity.__main__` で FAIL。

- [ ] **Step 4: server.py を実装**

`backend/src/opencode_antigravity/server.py`:

```python
"""stdio JSON-RPC dispatch loop."""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable
from typing import Any, BinaryIO

from .handlers import chat_completions, echo, health
from .protocol import JsonRpcError, JsonRpcSuccess, format_error, format_response, parse_request

logger = logging.getLogger(__name__)

Handler = Callable[[dict[str, Any]], dict[str, Any]]


def _default_handlers() -> dict[str, Handler]:
    return {
        "health": health,
        "echo": echo,
        "chat.completions": chat_completions,
    }


def run(stdin: BinaryIO, stdout: BinaryIO, handlers: dict[str, Handler] | None = None) -> None:
    """Read one NDJSON request per line, dispatch, write one response per line."""
    table = handlers if handlers is not None else _default_handlers()
    for raw in stdin:
        line = raw.decode("utf-8").rstrip("\n")
        if not line:
            continue
        out = _process_one(line, table)
        stdout.write((out + "\n").encode("utf-8"))
        stdout.flush()


def _process_one(line: str, table: dict[str, Handler]) -> str:
    try:
        req = parse_request(line)
    except ValueError as e:
        logger.warning("parse error: %s", e)
        return format_error(JsonRpcError(id=None, code=-32700, message=f"Parse error: {e}"))

    handler = table.get(req.method)
    if handler is None:
        return format_error(
            JsonRpcError(id=req.id, code=-32601, message=f"Method not found: {req.method}")
        )

    try:
        result = handler(req.params)
    except ValueError as e:
        return format_error(JsonRpcError(id=req.id, code=-32602, message=f"Invalid params: {e}"))
    except Exception as e:  # noqa: BLE001
        logger.exception("handler crashed: %s", req.method)
        return format_error(JsonRpcError(id=req.id, code=-32603, message=f"Internal error: {e}"))

    return format_response(JsonRpcSuccess(id=req.id, result=result))


def main() -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    run(sys.stdin.buffer, sys.stdout.buffer)
```

- [ ] **Step 5: __main__.py を実装**

`backend/src/opencode_antigravity/__main__.py`:

```python
"""Entry point: `python -m opencode_antigravity`."""

from .server import main

if __name__ == "__main__":
    main()
```

- [ ] **Step 6: GREEN を確認**

```bash
# (devcontainer 内で実行)
uv run pytest tests/python -v
uv run ruff check backend/src tests/python
```

期待出力: Python 全 10 件 PASS、ruff エラー 0（**`print()` 使用 0 を T20 で保証**）。

- [ ] **Step 7: コミットと Draft PR 作成**

```bash
git add backend/src/opencode_antigravity/server.py backend/src/opencode_antigravity/__main__.py tests/python/test_server_e2e.py
git commit -m "feat(server): stdio JSON-RPC ループとエントリポイント"
git push -u origin phase-3/server-loop

gh pr create --draft --base phase-2/handlers --title "Phase 3.1: server.py + __main__.py + e2e" --body "$(cat <<'EOF'
## Summary
- stdio から 1 行ずつ NDJSON を読み、ハンドラへディスパッチ
- 不明メソッドは -32601、pydantic 失敗は -32602、ハンドラ例外は -32603
- ログは stderr のみ (logging)、stdout は JSON-RPC 専用
- `python -m opencode_antigravity` で起動可能
- ruff T20 で print() 利用を禁止

## Test plan
- [ ] health round-trip via subprocess
- [ ] unknown method returns -32601
- [ ] ruff check passes (no print)
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。**`phase-3/server-loop` は Phase 2/3 Tip として Task 4.0 で Phase 1 Tip とマージされる**。

---

## Phase 4: TypeScript Backend Integration

> ここから先は Phase 1 と Phase 2/3 の両方が必要。Task 4.0 で物理的に統合ブランチを作る。

### Task 4.0: Phase 1 Tip と Phase 2/3 Tip の統合ブランチ作成

**メタデータ:**

- 派生元ブランチ: `phase-3/server-loop`（Phase 2/3 Tip）
- 実行モード: 直列必須（Wait for Task 1.3 AND Task 3.1）
- 前提条件: Task 1.3 と Task 3.1 の Draft PR URL が両方存在し、両ブランチがリモートに push されていること

**Files:**

- なし（マージのみ）

- [ ] **Step 1: ブランチ作成と検証（統合点）**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-3/server-loop
git pull --ff-only
git checkout -b phase-4/integration

EXPECTED_BASE="phase-3/server-loop"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: Phase 1 Tip をマージ**

```bash
# (devcontainer 内で実行)
git fetch origin phase-1/jsonrpc-client
git merge --no-ff origin/phase-1/jsonrpc-client -m "merge: phase-1/jsonrpc-client into phase-4/integration"
```

- [ ] **Step 3: 統合後の sanity check**

```bash
# (devcontainer 内で実行)
pnpm install
uv sync
uv run ruff check backend/src tests/python
uv run pytest -q
pnpm test:unit
```

期待出力: ruff 0 エラー、Python 11 件 PASS（hello 1 + protocol 4 + handlers 4 + server_e2e 2）、TS 単体テスト（jsonrpc + errors + hello）すべて PASS。

- [ ] **Step 4: 統合点を確認するメタテスト追記（軽量）**

`tests/ts/integration_smoke.test.ts` を作成:

```typescript
import { describe, expect, test } from "vitest";
import { encodeRequest } from "../../src/jsonrpc.js";

describe("phase-4 integration smoke", () => {
  test("TS jsonrpc module is importable on the integration branch", () => {
    const line = encodeRequest({ id: 1, method: "health", params: {} });
    expect(line.endsWith("\n")).toBe(true);
  });
});
```

```bash
# (devcontainer 内で実行)
pnpm test:unit
```

期待出力: 全 PASS。

- [ ] **Step 5: コミットと Draft PR 作成**

```bash
git add tests/ts/integration_smoke.test.ts
git commit -m "chore(integration): phase-1 と phase-2/3 を統合 (smoke 込み)"
git push -u origin phase-4/integration

gh pr create --draft --base phase-3/server-loop --title "Phase 4.0: Phase 1 / 2-3 統合ブランチ" --body "$(cat <<'EOF'
## Summary
- phase-1/jsonrpc-client を phase-3/server-loop にマージし、TS と Python の純粋ロジックが同一ブランチに揃った状態を作る
- 統合後の smoke テストを追加

## Test plan
- [ ] uv run pytest が PASS
- [ ] pnpm test:unit が PASS
- [ ] ruff check がエラー 0
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。

---

### Task 4.1: backend.ts（spawn / health / echo / クラッシュ検知 / 再起動）

**メタデータ:**

- 派生元ブランチ: `phase-4/integration`
- 実行モード: 直列必須（Wait for Task 4.0）
- 前提条件: Task 4.0 の Draft PR URL が存在すること
- 対応テスト: design.md test #14 `starts python and health succeeds`, #15 `echo round-trips correctly`, #16 `detects crash and restarts`

**Files:**

- Create: `src/backend.ts`
- Create: `tests/ts/backend.test.ts`

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-4/integration
git pull --ff-only
git checkout -b phase-4/backend-lifecycle

EXPECTED_BASE="phase-4/integration"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: 統合テストを書く（RED）**

`tests/ts/backend.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PythonBackend } from "../../src/backend.js";

let backend: PythonBackend;

beforeEach(() => {
  backend = new PythonBackend({
    pythonBin: "python",
    moduleName: "opencode_antigravity",
    cwd: process.cwd(),
    healthTimeoutMs: 5000,
    callTimeoutMs: 10000,
    maxRestarts: 3,
    backoffMs: [1000, 2000, 4000],
  });
});

afterEach(async () => {
  await backend.stop();
});

describe("PythonBackend lifecycle", () => {
  test("starts python and health succeeds (#14)", async () => {
    await backend.start();
    const res = (await backend.call("health", {})) as { status: string };
    expect(res.status).toBe("ok");
  });

  test("echo round-trips correctly (#15)", async () => {
    await backend.start();
    const res = (await backend.call("echo", { text: "ping" })) as { text: string };
    expect(res.text).toBe("ping");
  });

  test("detects crash and restarts (#16)", async () => {
    await backend.start();
    const pid = backend.pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGKILL");
    // 再起動完了を待つ (最大 ~3 秒)
    await new Promise<void>((resolve) => backend.once("ready", () => resolve()));
    expect(backend.restartCount).toBe(1);
    const res = (await backend.call("health", {})) as { status: string };
    expect(res.status).toBe("ok");
  });
});
```

- [ ] **Step 3: RED を確認**

```bash
# (devcontainer 内で実行)
pnpm test:integration
```

期待出力: PythonBackend 未定義で FAIL。

- [ ] **Step 4: backend.ts を実装（GREEN）**

`src/backend.ts`:

```typescript
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcClient } from "./jsonrpc.js";
import {
  BackendCrashedError,
  BackendPermanentlyFailedError,
} from "./errors.js";

export type BackendState = "starting" | "ready" | "restarting" | "permanently_failed" | "stopped";

export interface PythonBackendOptions {
  pythonBin: string;
  moduleName: string;
  cwd: string;
  healthTimeoutMs: number;
  callTimeoutMs: number;
  maxRestarts: number;
  backoffMs: number[]; // length === maxRestarts
}

export class PythonBackend extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private client: JsonRpcClient | null = null;
  private state: BackendState = "stopped";
  private _restartCount = 0;
  private stdoutBuf = "";

  constructor(private readonly opts: PythonBackendOptions) {
    super();
  }

  get currentState(): BackendState {
    return this.state;
  }

  get restartCount(): number {
    return this._restartCount;
  }

  get pid(): number {
    return this.proc?.pid ?? -1;
  }

  async start(): Promise<void> {
    this.state = "starting";
    this.spawnAndWire();
    await this.waitForHealthy();
    this.state = "ready";
    this.emit("ready");
  }

  async call(method: string, params: unknown): Promise<unknown> {
    if (this.state === "permanently_failed") {
      throw new BackendPermanentlyFailedError();
    }
    if (this.state !== "ready" || this.client === null) {
      throw new BackendCrashedError(`backend not ready (state=${this.state})`);
    }
    return this.client.call(method, params, { timeoutMs: this.opts.callTimeoutMs });
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    if (this.proc) {
      this.proc.kill("SIGTERM");
      await this.waitProcExit(3000);
      if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGKILL");
    }
    this.proc = null;
    this.client = null;
  }

  private spawnAndWire(): void {
    const proc = spawn(this.opts.pythonBin, ["-m", this.opts.moduleName], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.proc = proc;
    this.client = new JsonRpcClient({
      write: (line) => proc.stdin.write(line),
      warn: (msg) => console.warn(`[backend] ${msg}`),
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdoutChunk(chunk));
    proc.once("exit", (code, signal) => this.onProcExit(code, signal));
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      this.client?.handleInboundLine(line);
    }
  }

  private async waitForHealthy(): Promise<void> {
    if (this.client === null) throw new BackendCrashedError("client missing during health");
    await this.client.call("health", {}, { timeoutMs: this.opts.healthTimeoutMs });
  }

  private onProcExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.state === "stopped") return; // intentional stop
    const err = new BackendCrashedError(
      `python exited code=${code} signal=${signal}`,
    );
    this.client?.rejectAll(err);
    this.proc = null;
    this.client = null;
    void this.attemptRestart();
  }

  private async attemptRestart(): Promise<void> {
    this.state = "restarting";
    this.emit("restarting");
    if (this._restartCount >= this.opts.maxRestarts) {
      this.state = "permanently_failed";
      this.emit("permanently_failed");
      return;
    }
    const wait = this.opts.backoffMs[this._restartCount] ?? 4000;
    this._restartCount += 1;
    await new Promise((r) => setTimeout(r, wait));
    try {
      this.spawnAndWire();
      await this.waitForHealthy();
      this.state = "ready";
      this.emit("ready");
    } catch {
      void this.attemptRestart();
    }
  }

  private waitProcExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      const t = setTimeout(resolve, timeoutMs);
      this.proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
```

- [ ] **Step 5: GREEN を確認**

```bash
# (devcontainer 内で実行)
pnpm test:integration
```

期待出力: backend.test.ts 内 3 件すべて PASS（テスト #14, #15, #16）。

- [ ] **Step 6: コミットと Draft PR 作成**

```bash
git add src/backend.ts tests/ts/backend.test.ts
git commit -m "feat(backend): PythonBackend ライフサイクル (spawn/health/crash検知/再起動)"
git push -u origin phase-4/backend-lifecycle

gh pr create --draft --base phase-4/integration --title "Phase 4.1: backend.ts (spawn/health/crash/restart)" --body "$(cat <<'EOF'
## Summary
- PythonBackend: spawn → health 検証 → ready 遷移
- stdout を NDJSON 単位でバッファリングし JsonRpcClient へ流す
- 異常終了で client.rejectAll() → 指数バックオフ再起動
- 3 回失敗で permanently_failed へ遷移 (試験は Task 4.2 で実施)
- design.md test #14, #15, #16 を通す

## Test plan
- [ ] starts python and health succeeds
- [ ] echo round-trips
- [ ] detects crash and restarts (kill -9 から復帰)
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。

---

### Task 4.2: 永続失敗状態と再起動待機中の即時 503

**メタデータ:**

- 派生元ブランチ: `phase-4/backend-lifecycle`
- 実行モード: 直列必須（Wait for Task 4.1）
- 前提条件: Task 4.1 の Draft PR URL が存在すること
- 対応テスト: design.md test #17 `after 3 failed restarts, marks permanently failed`, #18 `request arriving during restart wait returns 503 immediately without queueing`

**Files:**

- Modify: `src/backend.ts`（永続失敗時のクリーンアップ強化、起動失敗カウント）
- Modify: `tests/ts/backend.test.ts`（テスト追加）

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-4/backend-lifecycle
git pull --ff-only
git checkout -b phase-4/permanent-failure

EXPECTED_BASE="phase-4/backend-lifecycle"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: テストを追記（RED）**

`tests/ts/backend.test.ts` に追記:

```typescript
import { BackendCrashedError, BackendPermanentlyFailedError } from "../../src/errors.js";

describe("PythonBackend failure semantics", () => {
  test("after 3 failed restarts marks permanently_failed (#17)", async () => {
    // 起動の度に即終了するスタブを使う: 存在しないモジュール名で連続失敗を再現
    const bad = new PythonBackend({
      pythonBin: "python",
      moduleName: "this_module_does_not_exist_xyz",
      cwd: process.cwd(),
      healthTimeoutMs: 500,
      callTimeoutMs: 1000,
      maxRestarts: 3,
      backoffMs: [50, 50, 50], // テスト高速化
    });
    await expect(bad.start()).rejects.toBeInstanceOf(BackendCrashedError);
    // 3 回再起動失敗まで待つ
    await new Promise<void>((resolve) => bad.once("permanently_failed", () => resolve()));
    expect(bad.currentState).toBe("permanently_failed");
    await expect(bad.call("health", {})).rejects.toBeInstanceOf(BackendPermanentlyFailedError);
    await bad.stop();
  });

  test("request arriving during restart wait returns 503 immediately without queueing (#18)", async () => {
    const back = new PythonBackend({
      pythonBin: "python",
      moduleName: "opencode_antigravity",
      cwd: process.cwd(),
      healthTimeoutMs: 5000,
      callTimeoutMs: 5000,
      maxRestarts: 3,
      backoffMs: [1500, 1500, 1500],
    });
    await back.start();
    const pid = back.pid;
    process.kill(pid, "SIGKILL");
    // restarting 状態に遷移するのを待つ
    await new Promise<void>((r) => back.once("restarting", () => r()));
    const t0 = Date.now();
    await expect(back.call("echo", { text: "x" })).rejects.toBeInstanceOf(BackendCrashedError);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200); // キューイングしていないことを ms で検証
    // restart 完了後の通常応答も確認
    await new Promise<void>((r) => back.once("ready", () => r()));
    const res = (await back.call("echo", { text: "after" })) as { text: string };
    expect(res.text).toBe("after");
    await back.stop();
  });
});
```

- [ ] **Step 3: RED を確認**

```bash
# (devcontainer 内で実行)
pnpm test:integration
```

期待出力: テスト #17 または #18 で FAIL（現状の `attemptRestart` は初回 start の失敗を再起動カウントへ反映していないため）。

- [ ] **Step 4: backend.ts を補強（GREEN）**

`src/backend.ts` の `start()` と `spawnAndWire()` 周辺を以下に置き換え:

```typescript
async start(): Promise<void> {
  this.state = "starting";
  try {
    this.spawnAndWire();
    await this.waitForHealthy();
    this.state = "ready";
    this.emit("ready");
  } catch (err) {
    // 初回起動失敗もクラッシュとして数える
    this.client?.rejectAll(err as Error);
    this.proc?.kill("SIGKILL");
    this.proc = null;
    this.client = null;
    // permanently_failed に到達するまで attemptRestart に委ねる
    void this.attemptRestart();
    throw err;
  }
}
```

さらに `call()` 内で `restarting` 状態時の即時 reject を明示化:

```typescript
async call(method: string, params: unknown): Promise<unknown> {
  if (this.state === "permanently_failed") {
    throw new BackendPermanentlyFailedError();
  }
  if (this.state === "restarting" || this.state === "starting") {
    // design §7.3: キューイングせず即座に reject (HTTP 層が 503 へ変換)
    throw new BackendCrashedError(`backend ${this.state}, retry later`);
  }
  if (this.state !== "ready" || this.client === null) {
    throw new BackendCrashedError(`backend not ready (state=${this.state})`);
  }
  return this.client.call(method, params, { timeoutMs: this.opts.callTimeoutMs });
}
```

- [ ] **Step 5: GREEN を確認**

```bash
# (devcontainer 内で実行)
pnpm test:integration
```

期待出力: テスト #14, #15, #16, #17, #18 がすべて PASS。

- [ ] **Step 6: コミットと Draft PR 作成**

```bash
git add src/backend.ts tests/ts/backend.test.ts
git commit -m "feat(backend): 永続失敗状態と restarting 中の即時 503 セマンティクス"
git push -u origin phase-4/permanent-failure

gh pr create --draft --base phase-4/backend-lifecycle --title "Phase 4.2: permanently_failed + restarting 中の即時 503" --body "$(cat <<'EOF'
## Summary
- start() の初回失敗もクラッシュとしてカウントし attemptRestart へ
- call() は restarting / starting 中はキューイングせず BackendCrashedError を即時 throw
- 3 回連続失敗で permanently_failed に遷移し、以降の call() は BackendPermanentlyFailedError
- design.md test #17, #18 を通す

## Test plan
- [ ] 3 回起動失敗 → permanently_failed
- [ ] restart 待機中の call は <200ms で reject
- [ ] restart 完了後は正常応答
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。

---

## Phase 5: HTTP server と E2E 検証

### Task 5.1: server.ts（OpenAI 互換 HTTP ハンドラ）

**メタデータ:**

- 派生元ブランチ: `phase-4/permanent-failure`
- 実行モード: 直列必須（Wait for Task 4.2）
- 前提条件: Task 4.2 の Draft PR URL が存在すること
- 対応テスト: なし（テスト #19, #20, #21 は Task 5.2 で E2E として実行）

**Files:**

- Create: `src/server.ts`

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-4/permanent-failure
git pull --ff-only
git checkout -b phase-5/http-server

EXPECTED_BASE="phase-4/permanent-failure"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: server.ts を実装**

`src/server.ts`:

```typescript
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { NotImplementedError, ProtocolError, toOpenAIError } from "./errors.js";
import type { PythonBackend } from "./backend.js";
import type { OpenAIChatRequest } from "./types.js";

export function createServer(backend: PythonBackend): http.Server {
  return http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);

    if (req.method === "GET" && req.url === "/healthz") {
      return sendJson(res, 200, {
        status: "ok",
        python_restarts: backend.restartCount,
      });
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      return sendJson(res, 200, {
        object: "list",
        data: [{ id: "opencode-antigravity-echo", object: "model" }],
      });
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      try {
        const body = await readJson<OpenAIChatRequest>(req);
        if (body.stream === true) {
          throw new NotImplementedError("streaming is not supported in MVP");
        }
        const result = await backend.call("chat.completions", body);
        return sendJson(res, 200, result);
      } catch (err) {
        const { status, body } = toOpenAIError(err as Error);
        return sendJson(res, status, body);
      }
    }

    return sendJson(res, 404, {
      error: { type: "not_found", message: `no route for ${req.method} ${req.url}` },
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new ProtocolError(`invalid JSON body: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 3: 型チェックが通ることを確認**

```bash
# (devcontainer 内で実行)
pnpm exec tsc -p tsconfig.json --noEmit
```

期待出力: 0 エラー。

- [ ] **Step 4: コミットと Draft PR 作成**

```bash
git add src/server.ts
git commit -m "feat(server): OpenAI 互換 HTTP ハンドラ (/v1/chat/completions, /v1/models, /healthz)"
git push -u origin phase-5/http-server

gh pr create --draft --base phase-4/permanent-failure --title "Phase 5.1: HTTP server (server.ts)" --body "$(cat <<'EOF'
## Summary
- POST /v1/chat/completions: backend.call('chat.completions', body)
- GET /v1/models: 固定モデル一覧
- GET /healthz: python_restarts 込みのヘルス
- stream:true は NotImplementedError → 501
- 全レスポンスに X-Request-Id ヘッダ
- toOpenAIError でエラー変換

## Test plan
- [ ] tsc --noEmit エラー 0
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。

---

### Task 5.2: index.ts エントリ + E2E + `pnpm verify` 完走

**メタデータ:**

- 派生元ブランチ: `phase-5/http-server`
- 実行モード: 直列必須（Wait for Task 5.1）
- 前提条件: Task 5.1 の Draft PR URL が存在すること
- 対応テスト: design.md test #19, #20, #21（E2E 3 件）

**Files:**

- Create: `src/index.ts`
- Create: `tests/ts/integration.test.ts`

- [ ] **Step 1: ブランチ作成と検証**

```bash
# (devcontainer 内で実行)
git fetch origin
git checkout phase-5/http-server
git pull --ff-only
git checkout -b phase-5/e2e-verify

EXPECTED_BASE="phase-5/http-server"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git merge-base --is-ancestor $EXPECTED_BASE $CURRENT_BRANCH || { echo "ERROR: 派生元ブランチが $EXPECTED_BASE ではありません。スタック構造が壊れています。"; exit 1; }
echo "OK: $CURRENT_BRANCH は $EXPECTED_BASE から派生しています。"
```

- [ ] **Step 2: E2E テストを書く（RED）**

`tests/ts/integration.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type http from "node:http";
import { PythonBackend } from "../../src/backend.js";
import { createServer } from "../../src/server.js";

let backend: PythonBackend;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  backend = new PythonBackend({
    pythonBin: "python",
    moduleName: "opencode_antigravity",
    cwd: process.cwd(),
    healthTimeoutMs: 5000,
    callTimeoutMs: 10000,
    maxRestarts: 3,
    backoffMs: [1000, 2000, 4000],
  });
  await backend.start();
  server = createServer(backend);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (typeof addr === "object" && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await backend.stop();
});

describe("E2E", () => {
  test("POST /v1/chat/completions returns echo result (#19)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode-antigravity-echo",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      model: string;
    };
    expect(body.model).toBe("opencode-antigravity-echo");
    expect(body.choices[0].message.content).toBe("[echo] hi");
  });

  test("GET /healthz returns ok with restart count (#20)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; python_restarts: number };
    expect(body.status).toBe("ok");
    expect(typeof body.python_restarts).toBe("number");
  });

  test("POST with stream:true returns 501 (#21)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode-antigravity-echo",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_implemented");
  });
});
```

- [ ] **Step 3: index.ts を実装（GREEN）**

`src/index.ts`:

```typescript
import { PythonBackend } from "./backend.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const backend = new PythonBackend({
    pythonBin: process.env.PYTHON_BIN ?? "python",
    moduleName: "opencode_antigravity",
    cwd: process.cwd(),
    healthTimeoutMs: 5000,
    callTimeoutMs: 60_000,
    maxRestarts: 3,
    backoffMs: [1000, 2000, 4000],
  });
  await backend.start();

  const server = createServer(backend);
  const port = Number(process.env.PORT ?? 11435);
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ level: "info", msg: "listening", port }));
  });

  const shutdown = async (sig: NodeJS.Signals) => {
    console.log(JSON.stringify({ level: "info", msg: "shutdown", signal: sig }));
    await new Promise<void>((r) => server.close(() => r()));
    await backend.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
```

- [ ] **Step 4: GREEN を確認（E2E）**

```bash
# (devcontainer 内で実行)
pnpm test:e2e
```

期待出力: integration.test.ts の 3 件すべて PASS。

- [ ] **Step 5: 全 21 ケース完走を確認**

```bash
# (devcontainer 内で実行)
pnpm verify
```

期待出力（順序通り）:

1. `uv run ruff check` → エラー 0
2. `uv run pytest` → Python **11 件 PASS**（内訳: hello 1 + protocol 4 + handlers 4 + server_e2e 2。設計書 §9.2 が要求する必須 8 件は protocol 4 + handlers 4。hello / server_e2e は補助テスト）
3. `pnpm test:unit` → TS 単体 PASS（hello 1 + jsonrpc 4 + errors 4 + smoke 1 = 10 件以上）
4. `pnpm test:integration` → backend.test.ts 5 件 PASS（#14, #15, #16, #17, #18）
5. `pnpm test:e2e` → integration.test.ts 3 件 PASS（#19, #20, #21）

設計書 §9.2 の **21 ケース全 PASS** を最終確認。

- [ ] **Step 6: 起動スモークテスト（手動）**

```bash
# (devcontainer 内で実行)
pnpm exec tsx src/index.ts &
SERVER_PID=$!
sleep 2
curl -s http://127.0.0.1:11435/healthz
curl -s -X POST http://127.0.0.1:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"opencode-antigravity-echo","messages":[{"role":"user","content":"manual"}]}'
kill $SERVER_PID
```

期待出力: `/healthz` が `{"status":"ok","python_restarts":0}`、`/v1/chat/completions` のレスポンス `content` が `"[echo] manual"`。

- [ ] **Step 7: コミットと Draft PR 作成**

```bash
git add src/index.ts tests/ts/integration.test.ts
git commit -m "feat(e2e): index.ts エントリと E2E テスト、pnpm verify 21 件完走"
git push -u origin phase-5/e2e-verify

gh pr create --draft --base phase-5/http-server --title "Phase 5.2: index.ts + E2E + pnpm verify 完走" --body "$(cat <<'EOF'
## Summary
- src/index.ts: PythonBackend を立ち上げ 127.0.0.1:11435 で listen
- tests/ts/integration.test.ts: E2E 3 件 (#19, #20, #21)
- pnpm verify で design.md §9.2 の 21 ケースが全 PASS する状態を達成

## Test plan
- [ ] pnpm verify が全 PASS
- [ ] 手動 curl: /healthz が 200, /v1/chat/completions が echo を返す
- [ ] curl with stream:true が 501 を返す
EOF
)"
```

PR URL を `_pr-urls.md` へ追記。**ここで MVP 完成**。

---

## マージ戦略（実装完了後）

すべての Draft PR が作成され、レビューが通った時点で、**Phase Base に近い順から**親 PR を Ready for Review → Merge していきます。スタック構造のため、`phase-0/devcontainer` を master にマージすると、後続 PR の base が自動的にスライドします。

推奨マージ順:

1. `phase-0/devcontainer` → master
2. `phase-0/package-init` → master
3. `phase-0/cicd` → master ← ここで Bitbucket Pipelines が初稼働
4. `phase-1/types-jsonrpc` → master
5. `phase-1/errors` → master
6. `phase-1/jsonrpc-client` → master
7. `phase-2/protocol` → master
8. `phase-2/handlers` → master
9. `phase-3/server-loop` → master
10. `phase-4/integration` → master（差分は smoke テストのみのはず）
11. `phase-4/backend-lifecycle` → master
12. `phase-4/permanent-failure` → master
13. `phase-5/http-server` → master
14. `phase-5/e2e-verify` → master ← 最後に master 上で `pnpm verify` がパスすることを Bitbucket Pipelines で再確認

---

## Self-Review（事後チェックリスト）

設計書とこの計画を突き合わせた結果:

- [x] **design §2 受け入れ基準** `pnpm verify` 完走 → Task 5.2 Step 5 で検証
- [x] **design §6** JSON-RPC メソッド 3 種 → handlers.py (Task 2.2) が実装
- [x] **design §7.3** 再起動ポリシ（指数バックオフ・最大 3 回）→ Task 4.1/4.2 で実装
- [x] **design §7.3** restarting 中は即時 503 → Task 4.2 で実装、test #18 で検証
- [x] **design §7.5** Pending Map クリーンアップ規約 → Task 1.3 で実装、test #13 で検証
- [x] **design §8.1** エラー対応表 → Task 1.2 で実装
- [x] **design §8.3** `print()` 禁止（ruff T20）→ Task 0.2 で pyproject.toml に設定
- [x] **design §9.2** 21 ケース全配置確認:
  - #1〜#4 → Task 2.1
  - #5〜#8 → Task 2.2
  - #9 → Task 1.1
  - #10, #11, #13 → Task 1.3
  - #12 → Task 1.2
  - #14, #15, #16 → Task 4.1
  - #17, #18 → Task 4.2
  - #19, #20, #21 → Task 5.2
- [x] **CI/CD要件** master トリガ + image: ubuntu-slim → Task 0.3
- [x] **Devcontainer 強制** Task 0.2 以降の全 Bash ブロックに `# (devcontainer 内で実行)` を明記（Task 0.1 は devcontainer 自体を構築する Task のため `# (ホストで実行)` を明示し、main policy の例外規定と整合）
- [x] **ポカヨケ** 全 14 タスクの Step 1 に `git merge-base --is-ancestor` を埋め込み済み
- [x] **Draft PR URL 要求** 全タスクの「前提条件」に明記、最終 Step で URL 記録を要求

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-opencode-antigravity-plugin-mvp.md`. Two execution options:

**1. Subagent-Driven (recommended)** — フレッシュなサブエージェントを Task ごとに dispatch し、Task 間でレビュー。スタック構造の検証（ポカヨケ実行ログ確認）を主エージェントが集中チェックできます。

**2. Inline Execution** — 本セッション内で `superpowers:executing-plans` を使い、Task 0.1 から順に実行。チェックポイントで停止しレビュー。

**Which approach?**
