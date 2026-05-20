# OpenCode Antigravity Plugin — MVP 設計書

- **作成日**: 2026-05-20
- **スコープ**: Phase 1 (MVP)
- **言語**: 日本語

## 1. 背景と目的

既存の `opencode-cursor-plugin`（TypeScript ベース）を参考に、主要なロジックを Google Antigravity SDK（Python）に委譲する「薄い TS ラッパー＋強力な Python コア」のハイブリッドアーキテクチャを、空ディレクトリからフルスクラッチで構築する。

最終目的は、Antigravity の高度なエージェント管理と既存 Cursor の OpenAI 互換プロバイダ機構を組み合わせて、OpenCode をシームレスに動作させること。

本 MVP では、Antigravity SDK 連携・ストリーミング・MCP・認証といった重い要素はすべて Phase 2 以降に後回しし、**配管（IPC・プロセス管理・エラー伝搬）の正しさを最優先で固める**ことに集中する。

## 2. MVP のゴール

| 項目 | 内容 |
|---|---|
| 動作目標 | Cursor から `127.0.0.1:11435` に OpenAI 互換 POST を打つと、Python 側で組み立てた echo 形式の `chat.completions` レスポンスが返る |
| 必須機能 | (a) HTTP サーバ起動、(b) Python サブプロセス起動と stdio JSON-RPC 通信、(c) クラッシュ検知と自動再起動 (指数バックオフ・最大 3 回)、(d) 永続失敗状態への遷移と 503 応答 |
| 受け入れ基準 | devcontainer 内で `pnpm verify` がパスする（後述 21 ケース） |
| 明示的に非ゴール | Antigravity SDK 実呼び出し、SSE ストリーミング、Agent Pool、MCP、PKCE/OAuth、Cursor 拡張パッケージング |

## 3. アーキテクチャ全体像

採用案: **案 A — TS が HTTP サーバ、Python が純粋 stdio JSON-RPC ワーカ**。

```
[Cursor]
   │ HTTP (OpenAI 互換)
   ▼
[TS: HTTP サーバ + 親プロセス]
   │ stdio (NDJSON / JSON-RPC 2.0)
   ▼
[Python: stdio JSON-RPC ワーカ (MVP=echo)]
```

責務分離の根拠:

- TS は **OpenAI 互換 HTTP の意味論を理解しない**。中継・プロセス管理・エラー変換のみを担当
- Python は **HTTP / SSE を知らない**。stdio JSON-RPC の受信と純粋関数的な応答生成に集中
- Phase 2 で Antigravity SDK を差し込む際、変更が Python `handlers.py` に閉じる

## 4. リポジトリ構成

```
opencode-antigravity-plugin/
├── .devcontainer/
│   ├── devcontainer.json        # Node 20 + Python 3.11、ports forward
│   └── Dockerfile               # mcr.microsoft.com/devcontainers/python:3.11 + Node 20 feature
├── package.json                 # pnpm, vitest, tsx, @types/node
├── pnpm-lock.yaml
├── tsconfig.json
├── pyproject.toml               # uv 管理。src ディレクトリは `backend/src/` を参照
├── uv.lock
├── README.md
│
├── src/                         # TypeScript（HTTP 前段・親プロセス）
│   ├── index.ts                 # CLI エントリ（サーバ起動）
│   ├── server.ts                # HTTP サーバ (OpenAI 互換ハンドラ)
│   ├── backend.ts               # Python サブプロセスのライフサイクル管理
│   ├── jsonrpc.ts               # JSON-RPC 2.0 over stdio クライアント
│   ├── errors.ts                # エラー型と OpenAI 形式への変換
│   └── types.ts                 # OpenAI 互換型 + JSON-RPC 型
│
├── backend/                     # Python（stdio JSON-RPC ワーカ）
│   └── src/opencode_antigravity/
│       ├── __init__.py
│       ├── __main__.py          # `python -m opencode_antigravity` で起動
│       ├── server.py            # stdio JSON-RPC ループ
│       ├── handlers.py          # echo / health / chat.completions
│       └── protocol.py          # JSON-RPC 型と pydantic 検証
│   # 注: pyproject.toml はリポジトリルートに1つだけ置く。
│   # [tool.hatch.build.targets.wheel.sources] = { "backend/src" = "" } 等で src レイアウトを指定する。
│
└── tests/
    ├── ts/
    │   ├── jsonrpc.test.ts
    │   ├── backend.test.ts
    │   ├── errors.test.ts
    │   └── integration.test.ts
    └── python/
        ├── test_protocol.py
        ├── test_handlers.py
        └── test_server_e2e.py
```

設計判断:

- **uv** を Python のパッケージ管理に採用（高速、`pyproject.toml` ネイティブ、devcontainer ブートストラップが短い）
- TS と Python は物理ディレクトリで分離（責務境界を構造で表現）
- 統合テストは TS 側に置き、実 Python を spawn する（実環境に近い）

## 5. コンポーネントと公開 API

### 5.1 TypeScript 側

| ファイル | 公開 API | 単一責務 |
|---|---|---|
| `src/index.ts` | `main()` | プロセス起動・終了シグナルハンドリング |
| `src/server.ts` | `createServer(backend): http.Server` | OpenAI 互換 HTTP ハンドラ (`POST /v1/chat/completions`, `GET /v1/models`, `GET /healthz`) |
| `src/backend.ts` | `class PythonBackend { start(); call(method, params); stop(); on('crash', cb) }` | Python サブプロセスの起動・再起動・ヘルス監視 |
| `src/jsonrpc.ts` | `encodeRequest`, `parseMessage`, `JsonRpcClient` | JSON-RPC 2.0 over stdio の純粋ロジック |
| `src/errors.ts` | `BackendCrashedError`, `BackendTimeoutError`, `BackendPermanentlyFailedError`, `ProtocolError`, `toOpenAIError()` | エラー型と OpenAI エラー応答への変換 |
| `src/types.ts` | OpenAI 互換型、JSON-RPC 型 | 型定義のみ |

### 5.2 Python 側

| モジュール | 公開 API | 単一責務 |
|---|---|---|
| `__main__.py` | `python -m opencode_antigravity` | エントリポイント |
| `server.py` | `run(stdin, stdout, handlers)` | stdio ループ・JSON-RPC ディスパッチ |
| `protocol.py` | `parse_request`, `format_response`, `format_error`（pydantic） | JSON-RPC メッセージの検証 |
| `handlers.py` | `echo(params)`, `health()`, `chat_completions(params)` | MVP ハンドラ実装 |

## 6. JSON-RPC メソッド一覧 (MVP)

```jsonc
// 1. ヘルスチェック
{"jsonrpc":"2.0","id":1,"method":"health","params":{}}
// → {"jsonrpc":"2.0","id":1,"result":{"status":"ok","version":"0.1.0"}}

// 2. echo（疎通検証）
{"jsonrpc":"2.0","id":2,"method":"echo","params":{"text":"hello"}}
// → {"jsonrpc":"2.0","id":2,"result":{"text":"hello"}}

// 3. chat.completions
{"jsonrpc":"2.0","id":3,"method":"chat.completions","params":{
  "model":"opencode-antigravity-echo",
  "messages":[{"role":"user","content":"hi"}]
}}
// → {"jsonrpc":"2.0","id":3,"result":{
//      "id":"chatcmpl-...","model":"opencode-antigravity-echo",
//      "object":"chat.completion",
//      "choices":[{
//        "index":0,
//        "message":{"role":"assistant","content":"[echo] hi"},
//        "finish_reason":"stop"
//      }]
//    }}
```

設計判断:

- ストリーミング (`stream: true`) は MVP 未対応。TS 側で 501 を返す
- `chat.completions` の params は OpenAI フォーマットそのまま。変換は Python 側 `handlers.py` の内部に閉じる
- pydantic 検証で不正があれば `-32602 Invalid params` を返し、TS が 400 に変換

## 7. データフローとライフサイクル

### 7.1 起動シーケンス

1. devcontainer 起動 → `uv sync && pnpm install`
2. ユーザが `pnpm start` を実行
3. `src/index.ts` → `PythonBackend.start()`
   - `child_process.spawn('python', ['-m', 'opencode_antigravity'], { stdio: ['pipe','pipe','inherit'] })`
   - stderr は親に inherit（デバッグ用にそのまま表示）
4. `backend.ts`: 起動後 5 秒以内の `health` 呼び出し成功を ready 条件とする
5. `server.ts`: HTTP サーバを 127.0.0.1:11435 で listen 開始
6. Cursor からの接続待ち

### 7.2 正常系リクエストフロー

```
[Cursor] POST /v1/chat/completions
   ▼
[TS server.ts]
   - JSON パース
   - X-Request-Id (uuid v4) 付与
   ▼
[TS backend.ts] call('chat.completions', body, { timeout: 60s })
   - JSON-RPC を stdin へ書き込み (NDJSON, 1 行 = 1 メッセージ)
   - id ベース Map に Promise を登録
   ▼
[Python server.py]
   - stdin から 1 行受信 → protocol.parse_request()
   - handlers.chat_completions(params) を呼ぶ
   - protocol.format_response() を stdout へ書き込み
   ▼
[TS backend.ts]
   - stdout 受信 → id で Promise を resolve
   ▼
[TS server.ts] HTTP 200 で返却
```

### 7.3 クラッシュ検知と再起動

```
[Python プロセス異常終了]
   ▼
[TS backend.ts]
   - child_process 'exit' 発火
   - 未完了 Promise を BackendCrashedError で reject し、Pending Map から破棄
   - 内部状態を `restarting` に遷移
   - 再起動ポリシー: 指数バックオフ (1 回目=1s 待機, 2 回目=2s, 3 回目=4s)、最大 3 回
   │
   ├ 再起動成功 → 内部状態を `ready` に戻し通常運用復帰
   │
   └ 3 回連続失敗
       → 内部状態を `permanently_failed` に遷移
       → 以降の HTTP リクエストは 503 (backend_unavailable) を即時応答
       → SIGTERM / SIGINT で全体終了
```

**再起動待機中のリクエスト挙動**:

内部状態が `restarting` の間（バックオフ待機中・プロセス起動中・初回 health 完了前のいずれも含む）に到着した新規 HTTP リクエストは、**キューイングせず即座に 503 (`backend_unavailable`) を返す**。理由は次の通り:

- キューイングは「リクエスト処理時間が予測不能になる」「タイムアウトと再起動完了の競合で挙動が複雑化する」「滞留がメモリ圧迫の原因となる」というデメリットが大きい
- Cursor 側のリトライ戦略（指数バックオフ付き再送）に判断を委ねる方が semantic が明確
- 永続失敗状態の 503 と挙動が揃い、クライアントから見た一貫性が保たれる

503 応答時の OpenAI エラー形式 `message` フィールドには、`restarting` と `permanently_failed` を区別できる文言を含める（例: `"backend restarting, retry later"` / `"backend permanently failed"`）。

### 7.4 プロトコル詳細

- NDJSON: 1 行 = 1 メッセージ（改行 `\n` 区切り）
- 文字エンコーディング: UTF-8 固定
- 1 メッセージ最大 1 MB（超過は `-32600`）
- 双方向すべて id を持つ。Notification は MVP では使わない

### 7.5 タイムアウト

| 操作 | タイムアウト | 失敗時 |
|---|---|---|
| 起動時 health | 5 秒 | 起動失敗、3 回リトライ |
| chat.completions | 60 秒 | クライアントに 504 |
| プロセス停止 (SIGTERM) | 3 秒 | SIGKILL |

**タイムアウト時の状態クリーンアップ**:

`backend.ts` の Pending Map（id → Promise の対応表）は、リクエストごとに `{ resolve, reject, timeoutHandle }` のエントリを保持する。タイムアウト発火時は次の順序で確実に状態を破棄する:

1. Pending Map から該当 id のエントリを `delete` する（**reject より先に行う**）
2. `BackendTimeoutError` で Promise を reject する
3. 以降に Python から該当 id の遅延応答が到着した場合は、Map に存在しないため `unknown id` として warn ログを残し、握り潰す（既に reject 済みの Promise を二重 resolve しない、メモリにも残さない）

この順序を守ることで、(a) Promise の二重 resolve、(b) 遅延応答による不整合、(c) Map に古いエントリが残り続けるメモリリーク、の 3 つを同時に防止する。

正常応答受信時・クラッシュ検知時・永続失敗遷移時にも同じ Map クリーンアップを行う。実装では「Map から `delete` してから resolve/reject する」を `JsonRpcClient` 内のヘルパに集約し、抜け道を作らない。

## 8. エラーハンドリング

### 8.1 エラー対応表

| 発生源 | TS 内部型 | HTTP | OpenAI 形式 type |
|---|---|---|---|
| Cursor の不正リクエスト（JSON パース失敗） | `ProtocolError` | 400 | `invalid_request_error` |
| `stream: true`（MVP 未対応） | `NotImplementedError` | 501 | `not_implemented` |
| Python から `-32602 Invalid params` | 伝搬 | 400 | `invalid_request_error` |
| Python から `-32603 Internal error` | 伝搬 | 500 | `server_error` |
| `chat.completions` 60 秒超 | `BackendTimeoutError` | 504 | `timeout` |
| Python プロセス突然死（処理中） | `BackendCrashedError` | 503 | `backend_unavailable` |
| 3 回連続再起動失敗 | `BackendPermanentlyFailedError` | 503 | `backend_unavailable` |

### 8.2 JSON-RPC エラーコード

標準コードのみ使用（MVP では独自コードを増やさない）:

- `-32700` Parse error
- `-32600` Invalid Request
- `-32601` Method not found
- `-32602` Invalid params（pydantic 検証失敗）
- `-32603` Internal error（ハンドラ内例外）

### 8.3 ログ方針

| プロセス | 出力先 | 形式 |
|---|---|---|
| TS | stdout / stderr | pino の JSON ログ、`LOG_LEVEL` で制御 |
| Python | **stderr のみ** | 標準 logging、INFO 以上、stdout は JSON-RPC 専用で汚さない |
| 統合時 | TS が Python の stderr を inherit | TS ログにそのまま流れる |

**最重要ルール**: Python 側は `print()` 禁止、`logger.info()` 強制（stdout 汚染防止）。`ruff` でルール化する。

### 8.4 観測性（MVP の最小限）

- 各 HTTP リクエストに `X-Request-Id` ヘッダ付与（uuid v4）、JSON-RPC の id に転写
- 再起動回数を内部カウンタに保持し、`GET /healthz` で `{"status":"ok","python_restarts":N}` を返す
- それ以上のメトリクス (OpenTelemetry, Prometheus) は Phase 2 以降

## 9. テスト戦略と受け入れ基準

### 9.1 テスト層

| 層 | フレームワーク | 対象 | 実行コマンド |
|---|---|---|---|
| Python 単体 | pytest | `protocol.py`, `handlers.py`（純粋関数） | `uv run pytest` |
| Python 統合 | pytest | `server.py` を子プロセスで起動して stdio で叩く | `uv run pytest tests/python/test_server_e2e.py` |
| TS 単体 | vitest | `jsonrpc.ts`, `errors.ts` | `pnpm test:unit` |
| TS 統合 | vitest | `backend.ts` を実 Python で起動 | `pnpm test:integration` |
| E2E | vitest | `index.ts` 起動 → HTTP → echo 応答 | `pnpm test:e2e` |

### 9.2 MVP 完了のための 21 ケース

Python 単体:

1. `test_protocol.py::test_parse_valid_request`
2. `test_protocol.py::test_parse_invalid_jsonrpc_version`
3. `test_protocol.py::test_format_response`
4. `test_protocol.py::test_format_error_with_code`
5. `test_handlers.py::test_echo`
6. `test_handlers.py::test_health`
7. `test_handlers.py::test_chat_completions_returns_openai_format`
8. `test_handlers.py::test_chat_completions_invalid_params`

TS 単体:

9. `jsonrpc.test.ts::encodes request as NDJSON`
10. `jsonrpc.test.ts::parses response and resolves by id`
11. `jsonrpc.test.ts::handles error response`
12. `errors.test.ts::converts BackendCrashedError to OpenAI 503`
13. `jsonrpc.test.ts::timeout rejects promise and removes entry from pending map; late response is ignored` — 7.5 のクリーンアップ規約を検証

TS 統合（実 Python を spawn）:

14. `backend.test.ts::starts python and health succeeds`
15. `backend.test.ts::echo round-trips correctly`
16. `backend.test.ts::detects crash and restarts` — `kill -9` 後に自動復帰
17. `backend.test.ts::after 3 failed restarts, marks permanently failed`
18. `backend.test.ts::request arriving during restart wait returns 503 immediately without queueing` — 7.3 の即時 503 規約を検証（再起動バックオフ中にリクエストを送り、即時 503 を確認し、再起動完了後の後続リクエストは正常応答することも確認）

E2E:

19. `integration.test.ts::POST /v1/chat/completions returns echo result`
20. `integration.test.ts::GET /healthz returns ok with restart count`
21. `integration.test.ts::POST with stream:true returns 501`

### 9.3 受け入れ基準

devcontainer 内で次が成功すれば MVP 完了:

```bash
pnpm verify   # = uv run pytest && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

### 9.4 MVP に含めないテスト

- 並列リクエスト負荷
- メモリリーク
- Antigravity SDK モックの本格的テスト
- ロングランテスト（30 分以上）

## 10. 既知の前提と Phase 2 以降への申し送り

- **Antigravity SDK** はインストール可能と確認済みだが、具体的なインストール方法 (PyPI 名 / Git URL) は Phase 2 着手時にユーザから提供を受ける
- **SSE ストリーミング**は Phase 2 の最初のテーマ。設計上、Python `handlers.py` を generator 化し、TS `backend.ts` で JSON-RPC notification を SSE chunk に変換する形にする想定
- **PKCE / OAuth** は Phase 3。MVP の `/v1/chat/completions` は Authorization ヘッダを受け入れるが検証しない
- **MCP ブリッジ**は Phase 4。`backend/src/opencode_antigravity/mcp/` 配下に追加する想定
- **Cursor VSCode 拡張パッケージング**は当面非対応。ユーザは Cursor 設定で `OPENAI_BASE_URL=http://127.0.0.1:11435/v1` を手動設定して利用する

## 11. 用語集

| 用語 | 定義 |
|---|---|
| MVP | Minimum Viable Product。本書では Phase 1 = 配管検証 + クラッシュ復旧を指す |
| NDJSON | Newline-Delimited JSON。1 行 = 1 メッセージ |
| Cursor | AI ペアプログラミング IDE。OpenAI 互換 base URL 設定をサポート |
| Antigravity SDK | Google が提供する Python ベースのエージェント SDK（具体仕様は Phase 2 で確認） |
| OpenCode | 本プラグインが Cursor から呼び出し可能にする対象のコーディング基盤 |
