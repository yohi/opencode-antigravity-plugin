# OpenCode Antigravity Plugin 仕様書 (SPEC)

## 1. 背景と目的

既存の `opencode-cursor-plugin`（TypeScript ベース）を参考に、主要なロジックを Google Antigravity SDK（Python）に委譲する「薄い TS ラッパー＋強力な Python コア」のハイブリッドアーキテクチャで構成されています。

本 MVP (Phase 1) では、配管（IPC・プロセス管理・エラー伝搬・自動再起動）の正しさと堅牢性を担保することに特化し、HTTP サーバーからのリクエストを Python の stdio JSON-RPC ワーカへ安全に中継・復旧する仕組みを提供します。

---

## 2. アーキテクチャ全体像

TS が HTTP サーバ、Python が stdio JSON-RPC ワーカとなるハイブリッド構成（案A）を採用しています。

```text
[OpenCode]
   │ HTTP (OpenAI 互換)
   ▼
[TS: HTTP サーバ + 親プロセス]
   │ stdio (NDJSON / JSON-RPC 2.0)
   ▼
[Python: stdio JSON-RPC ワーカ (MVP=echo)]
```

### 責務の分離
- **TypeScript 側**: OpenAI 互換 HTTP の受付、プロセス管理、エラー変換、中継のみを担当（OpenAI 互換 HTTP の詳細なセマンティクスは解釈しない）。
- **Python 側**: stdio 経由での JSON-RPC の受信、Pydantic による検証、純粋関数的な応答（echo 形式の `chat.completions`）の生成を担当。HTTP や SSE、ストリーミングの知識は持たない。

---

## 3. 設計判断 (パッケージ・ビルド管理)

- **パッケージ / 実行管理**: `uv` を採用（高速なインストール、`pyproject.toml` ネイティブ）。すべての開発・実行は `uv` 経由で行われます。
- **ビルドバックエンド**: `hatchling` を採用。`pyproject.toml` でビルドバックエンドを設定し、`backend/src` を src レイアウトとして指定しています。これにより editable インストール時の名前解決と構成の正しさを保証します。
- **責務境界の物理的分離**: TypeScript と Python は物理的なディレクトリ構造で完全に分離され、両者の通信境界が stdio JSON-RPC に閉じるように設計されています。

---

## 4. リポジトリ構成

```text
opencode-antigravity-plugin/
├── .devcontainer/               # 開発環境コンテナ定義
├── package.json                 # Node 依存関係・テストスクリプト定義
├── pyproject.toml               # Python 依存関係・パッケージ・Ruff定義
├── SPEC.md                      # 本仕様書（本書）
├── README.md                    # 開発・実行手順
├── src/                         # TypeScript ソースコード
│   ├── index.ts                 # CLI エントリ（サーバ起動・シグナルハンドリング）
│   ├── server.ts                # OpenAI 互換 HTTP サーバ
│   ├── backend.ts               # Python サブプロセスのライフサイクル管理 (PythonBackend)
│   ├── jsonrpc.ts               # JSON-RPC 2.0 クライアント (JsonRpcClient)
│   ├── errors.ts                # エラークラス定義と OpenAI 形式への変換ロジック
│   ├── logger.ts                # pino ロガー設定
│   └── types.ts                 # 各種型定義
├── backend/
│   └── src/opencode_antigravity/ # Python ソースコード
│       ├── __init__.py          # パッケージ初期化
│       ├── __main__.py          # コマンドラインエントリポイント
│       ├── server.py            # stdio JSON-RPC ディスパッチループ
│       ├── protocol.py          # JSON-RPC メッセージモデルと検証
│       └── handlers.py          # 各種ハンドラ (health, echo, chat.completions)
└── tests/                       # テストコード
    ├── ts/                      # TS 側テスト (unit, integration, e2e)
    └── python/                  # Python 側テスト (unit, e2e)
```

---

## 5. コンポーネントと責務 (公開 API)

### 5.1 TypeScript 側

| モジュール | 主要 API / クラス | 単一責務 |
|---|---|---|
| `src/index.ts` | `main()` | プロセス起動・終了シグナルハンドリング |
| `src/server.ts` | `createServer(backend)` | OpenAI 互換 HTTP ハンドラ (`POST /v1/chat/completions`, `GET /v1/models`, `GET /healthz`) |
| `src/backend.ts` | `class PythonBackend` | Python サブプロセスの起動・停止・再起動・状態管理およびヘルス監視 |
| `src/jsonrpc.ts` | `JsonRpcClient`, `encodeRequest`, `parseMessage` | JSON-RPC 2.0 over stdio の NDJSON 純粋シリアライズ/デシリアライズロジック |
| `src/errors.ts` | 各種例外クラス、`toOpenAIError()` | 内部例外の定義と、OpenAI 互換エラー形式（HTTPステータス / JSON）への変換 |
| `src/types.ts` | 型定義 | OpenAI 互換 API 型、および JSON-RPC 2.0 プロトコル型 |

### 5.2 Python 側

| モジュール | 主要 API / 関数 | 単一責務 |
|---|---|---|
| `__main__.py` | `python -m opencode_antigravity` | アプリケーションのエントリポイント |
| `server.py` | `run(stdin, stdout, handlers)` | stdio からの読み込みループと JSON-RPC ディスパッチ |
| `protocol.py` | `parse_request()`, `format_response()`, `format_error()` | Pydantic モデルによる JSON-RPC メッセージの厳密な検証と整形 |
| `handlers.py` | `health()`, `echo()`, `chat_completions()` | 各 RPC メソッドのビジネスロジック実装 |

---

## 6. JSON-RPC プロトコル仕様

TS 親プロセスと Python サブプロセスは、標準入出力 (stdio) を介した NDJSON (Newline-Delimited JSON) 形式で JSON-RPC 2.0 通信を行います。

### 6.1 メソッド一覧
1. **health**: プロセスのヘルスチェック。
   - リクエスト: `{"jsonrpc":"2.0","id":1,"method":"health","params":{}}`
   - レスポンス: `{"jsonrpc":"2.0","id":1,"result":{"status":"ok","version":"0.1.0"}}`
2. **echo**: 接続・疎通検証。
   - リクエスト: `{"jsonrpc":"2.0","id":2,"method":"echo","params":{"text":"hello"}}`
   - レスポンス: `{"jsonrpc":"2.0","id":2,"result":{"text":"hello"}}`
3. **chat.completions**: OpenAI 互換のチャット補完。
   - リクエスト:
     ```json
     {
       "jsonrpc": "2.0",
       "id": 3,
       "method": "chat.completions",
       "params": {
         "model": "opencode-antigravity-echo",
         "messages": [{"role": "user", "content": "hi"}]
       }
     }
     ```
   - レスポンス:
     ```json
     {
       "jsonrpc": "2.0",
       "id": 3,
       "result": {
         "id": "chatcmpl-...",
         "object": "chat.completion",
         "model": "opencode-antigravity-echo",
         "choices": [{
           "index": 0,
           "message": {"role": "assistant", "content": "[echo] hi"},
           "finish_reason": "stop"
         }],
         "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
       }
     }
     ```

### 6.2 プロトコル詳細ルール
- **エンコーディング**: 文字エンコーディングは UTF-8 固定とし、改行（`\n`）をメッセージの区切りとします。
- **1MB メッセージサイズ制限**: NDJSON の送受信メッセージともに、1メッセージあたり **1MB（1,048,576 バイト）** を超えた場合にエラーとします。
  - TS送信時: 1MB 超過時は送信せずに即座に例外をスロー。
  - Python受信時: 1MB 超過時は `-32600` (Invalid Request) を返し、通常のパースエラー（`-32700`）とは区別して処理します。
- **Notification (通知) の扱い**: ID のないリクエスト（Notification）を受信した場合、Python 側はハンドラを実行しますが、標準出力への応答（レスポンス）は返しません。なお、本 MVP において TS 側から Notification を送信するユースケースはありません。

---

## 7. ライフサイクルと異常系制御

### 7.1 起動シーケンス
1. `PythonBackend.start()` が呼び出され、`python -m opencode_antigravity` を子プロセスとして起動。
2. 起動後、5秒以内に `health` メソッドを呼び出し、成功した時点で準備完了状態 (`ready`) と判定。
3. `server.ts` が HTTP サーバを `127.0.0.1:11435` で Listen 開始。

### 7.2 クラッシュ検知と自動再起動
- Python プロセスが異常終了 (`exit` イベント検知) した場合、進行中の未完了リクエスト（Promise）を `BackendCrashedError` で即座に reject します。
- 内部状態を `restarting` へ遷移させ、自動再起動を開始します。
- **再起動ポリシー**:
  - 指数バックオフを採用 (1回目: 1s, 2回目: 2s, 3回目: 4s)。
  - 最大再起動試行回数は **3回**。
  - 3回連続で失敗した場合、内部状態を `permanently_failed` (永久失敗状態) に遷移させます。

### 7.3 再起動待機中の 503 即時返却
- 内部状態が `starting` または `restarting` (再起動バックオフ待機中、プロセス起動中、初期ヘルスチェック完了前を含む) の間に到着した新規 HTTP リクエストは、**キューイングせず即座に 503 (`backend_unavailable`) を返却**します。
- **キューイングしない理由**: タイムアウトと再起動の競合による複雑化を防ぎ、リクエスト滞留によるメモリ圧迫を回避し、一貫したリトライ戦略をクライアントに委ねるためです。
- 503 応答時の OpenAI エラー形式 `message` には、状態に応じたメッセージを含めます。
  - `restarting` 時: `"backend restarting, retry later: [原因]"`
  - `permanently_failed` 時: `"backend permanently failed"`

### 7.4 タイムアウト時の状態クリーンアップ順序
タイムアウト（デフォルト60秒）発生時の Pending Map（id → Promise の対応表）クリーンアップは、以下の順序を厳密に順守して行われます。
1. **Pending Map から該当 id のエントリを `delete` する**（`reject` よりも先に行う）。
2. `BackendTimeoutError` で Promise を `reject` する。

これにより、タイムアウト後に遅れて Python から届いた遅延応答が、既に reject 済みの Promise を二重解決することを防ぎ、メモリリークも同時に防止します。

### 7.5 観測性 (Observability)
- **X-Request-Id**: 各 HTTP リクエストに `X-Request-Id` (UUID v4) を付与し、JSON-RPC の `id` にそのまま転写してトレーサビリティを確保します。
- **再起動回数**: 再起動回数を内部カウンタに保持し、`GET /healthz` で `{"status":"ok", "python_restarts":N}` を返却します。

---

## 8. エラーハンドリング

### 8.1 エラー対応表

| 発生原因 | TS 内部例外クラス | HTTP ステータス | OpenAI 形式 error.type |
|---|---|---|---|
| 不正な JSON リクエスト | `ProtocolError` | 400 | `invalid_request_error` |
| `stream: true` (未実装機能要求) | `NotImplementedError` | 501 | `not_implemented` |
| Python から `-32602 Invalid params` 返却 | `BackendResponseError` | 400 | `invalid_request_error` |
| Python から `-32603 Internal error` 返却 | `BackendResponseError` | 500 | `server_error` |
| リクエストタイムアウト (60秒超過) | `BackendTimeoutError` | 504 | `timeout` |
| バックエンド突然死 | `BackendCrashedError` | 503 | `backend_unavailable` |
| 3回連続再起動失敗 (永久失敗状態) | `BackendPermanentlyFailedError` | 503 | `backend_unavailable` |

### 8.2 JSON-RPC エラーコード
- `-32700` Parse error (入力データのパース失敗時に Python 側で JsonRpcParseError から発生)
- `-32600` Invalid Request (リクエスト形式が不正な場合に Python 側で JsonRpcInvalidRequestError から発生)
- `-32601` Method not found
- `-32602` Invalid params (Pydantic によるバリデーション失敗時)
- `-32603` Internal error (ハンドラ内での例外発生時)

### 8.3 ログ方針
- **TypeScript 側**: 標準出力 (stdout) / 標準エラー出力 (stderr) に `pino` 形式の JSON ログを出力。
- **Python 側**: `sys.stderr` のみに標準ライブラリの `logging` 経由でログを出力。標準出力 (stdout) は JSON-RPC 通信専用であり、`print()` の使用は厳禁とします（Ruff の `T20` カテゴリで静的解析チェックを実施）。

---

## 9. テスト戦略と受け入れ基準

本 MVP では、以下のテスト構造によって配管と堅牢性を検証し、デグレ防止と品質を担保します。

### 9.1 テストレイヤー

| レイヤー | 使用フレームワーク | テスト対象・目的 | 実行コマンド |
|---|---|---|---|
| Python 単体 | pytest | `protocol.py`, `handlers.py` の純粋なロジック検証 | `uv run pytest` |
| Python 統合 | pytest | `server.py` を子プロセスで起動し、stdio 経由での通信を検証 | `uv run pytest tests/python/test_server_e2e.py` |
| TS 単体 | vitest | `jsonrpc.ts`, `errors.ts` などの純粋ロジック検証 | `pnpm test:unit` |
| TS 統合 | vitest | `backend.ts` から実際の Python プロセスを起動してライフサイクルを検証 | `pnpm test:integration` |
| E2E | vitest | `index.ts` サーバを起動し、HTTP 経由で OpenAI 互換の接続・応答を検証 | `pnpm test:e2e` |

### 9.2 受け入れ基準となる 21 のテストケース

開発完了・保証にあたっては、以下の 21 のテストケースすべてが `pnpm verify` でパスすることが求められます。

#### Python 側 (8ケース)
1. `test_parse_valid_request`: 正しいリクエストのパース検証
2. `test_parse_invalid_jsonrpc_version`: jsonrpc バージョン不正の検出
3. `test_format_response`: レスポンス整形の検証
4. `test_format_error_with_code`: エラーレスポンス整形の検証
5. `test_echo`: echo ハンドラの検証
6. `test_health`: health ハンドラの検証
7. `test_chat_completions_returns_openai_format`: chat.completions の正常検証
8. `test_chat_completions_invalid_params`: chat.completions のバリデーション検証

#### TS 単体 (5ケース)
9. `encodes request as NDJSON`: 送信時の NDJSON エンコード検証
10. `parses response and resolves by id`: 受信時の正常パースと Promise 解決の検証
11. `handles error response`: JSON-RPC エラー応答のハンドリング検証
12. `converts BackendCrashedError to OpenAI 503`: クラッシュエラーの 503 変換検証
13. `timeout rejects promise and removes entry from pending map; late response is ignored`: タイムアウト時の Pending Map クリーンアップ順序と遅延応答の無視検証

#### TS 統合（実 Python を起動する 5ケース）
14. `starts python and health succeeds`: 初期起動と初期ヘルスチェックの検証
15. `echo round-trips correctly`: stdio 経由の双方向通信疎通検証
16. `detects crash and restarts`: `kill -9` によるクラッシュ検知と自動再起動検証
17. `after 3 failed restarts, marks permanently failed`: 3回再起動失敗後の永久失敗状態遷移の検証
18. `request arriving during restart wait returns 503 immediately without queueing`: 再起動中の HTTP 即時 503 応答および、再起動完了後のリクエスト復帰検証

#### E2E (3ケース)
19. `POST /v1/chat/completions returns echo result`: HTTP 経由のチャット補完正常系検証
20. `GET /healthz returns ok with restart count`: HTTP 経由のヘルスチェックと再起動数返却検証
21. `POST with stream:true returns 501`: ストリーミング要求に対する 501 応答検証

---

## 10. 既知の前提と Phase 2 以降への申し送り (ロードマップ)

本 MVP であえて非ゴールとした機能や、今後のフェーズでの申し送り事項は以下の通りです。

- **Antigravity SDK 連携 (Phase 2)**: 
  - SDK 自体はインストール可能であることが確認されていますが、具体的なインストール方法 (PyPI パッケージ名 / Git URL) は Phase 2 着手時に決定されます。
- **SSE ストリーミング (Phase 2)**: 
  - `stream: true` を要求するリクエストへの対応。設計上、Python 側の `handlers.py` を Generator 化して逐次 yield させ、TS 側の `backend.ts` で JSON-RPC の通知 (Notification) もしくはチャンク応答として受け取り、SSE チャンクへ変換してクライアントに返送する構成が想定されています。
- **PKCE / OAuth 認証 (Phase 3)**:
  - MVP では `Authorization` ヘッダを受け入れますが検証しません。Phase 3 で正式な認証認可フローを整備します。
- **MCP ブリッジ (Phase 4)**:
  - Model Context Protocol への対応。`backend/src/opencode_antigravity/mcp/` 配下に MCP 連携用のモジュールを追加する形で拡張する設計となっています。
- **プラグインのパッケージ化**:
  - 当面はパッケージングを行わず、OpenCode の設定ファイル (`opencode.jsonc`) の `options.baseURL` に直接本プラグインの起動アドレス (`http://127.0.0.1:11435/v1`) を設定して開発・利用する運用とします。
- **再起動ポリシーの外部設定化**:
  - MVP では再起動ポリシー (`max_retries=3`、バックオフ秒 `1s / 2s / 4s`) はハードコードされていますが、今後の実 Antigravity ワークロードに適用していく段階で、環境変数や設定ファイルから注入可能にする予定です。
