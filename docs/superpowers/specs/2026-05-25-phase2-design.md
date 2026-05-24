# Phase 2 設計 — Antigravity SDK 連携 + SSE ストリーミング

- **日付**: 2026-05-25
- **対象 Phase**: Phase 2 (詳細) + 全 Phase ロードマップ (概要)
- **ステータス**: Draft (ブレインストーミング合意済み)
- **前提**: Phase 1 (MVP) 完了 (SPEC.md セクション 9.2 の 21 テストケース全 GREEN)

---

## 1. 目的と背景

Phase 1 (MVP) では TS↔Python 間の配管 (JSON-RPC over stdio、再起動、エラー伝搬) の堅牢性を担保した。Phase 2 では、Python 側の echo 実装を `google-antigravity` SDK の実呼び出しに置き換え、OpenAI Chat Completions API の `stream:true` (SSE) を正式サポートすることで、実用的な Gemini プロキシとしてリリース可能な状態に到達することを目的とする。

### Phase 2 のスコープ (最小)

- 実 SDK (`google-antigravity`) を経由した Gemini チャット応答の返却
- `stream:true` リクエストへの SSE 形式での応答 (OpenAI 互換)
- `stream:false` リクエストの維持 (Phase 1 互換)
- API キー方式の認証 (`GEMINI_API_KEY` 環境変数)
- 1 モデル固定運用 (`ANTIGRAVITY_MODEL` 環境変数)
- SDK 抽象化レイヤとモック実装による CI 互換性の維持

### Phase 2 の非ゴール (将来 Phase で扱う)

- `tool_calls`、Gemini Thinking (CoT)、マルチモーダル
- セッション永続化 (`X-Session-Id` 等の状態管理)
- 複数モデル同時提供
- OAuth/PKCE 認証 (Phase 3 で扱う)
- MCP ブリッジ (Phase 4 で扱う)

---

## 2. 全 Phase ロードマップ

### ロードマップ表

| Phase | テーマ | 目的 | 主要成果物 | 依存 |
|---|---|---|---|---|
| 1 (済) | 配管 (MVP) | IPC・再起動・エラー伝搬の堅牢性 | echo 実装、JSON-RPC、PythonBackend ライフサイクル | — |
| **2** | **実 SDK 接続 + SSE** | echo を `google-antigravity` SDK 呼び出しに置き換え、`stream:true` をサポート | `AntigravityClient` 抽象、Notification ベースのストリーミング、SSE 中継 | Phase 1 |
| 3 | OAuth/PKCE 認証 | `Authorization` ヘッダの正式検証 + Google アカウント連携 | OAuth 認可サーバ連携、トークン管理、`Authorization` ヘッダ検証 | Phase 2 |
| 4 | MCP ブリッジ | OpenCode 側のツール・SDK の MCP 連携機能を露出 | MCP サーバ機能 / クライアント機能の Python 側実装、ツール露出 API | Phase 2 |
| 補 | パッケージ化 | OpenCode プラグインとして配布 | npm パッケージ化、`opencode.jsonc` 自動登録 | Phase 2 以降の任意時点 |
| 補 | 再起動ポリシー外部化 | バックオフパラメータの環境変数化 | `OAG_MAX_RESTARTS` / `OAG_BACKOFF_*` 等 | 任意時点で挿入可能 |

### 依存関係

- Phase 2 は Phase 1 上に純粋追加 (既存 21 テストは破壊しない)
- Phase 3 と Phase 4 は Phase 2 完了後にどちらからでも着手可能 (並行可)
- 補助タスクは独立した小さな PR として任意時点で挿入可能

### Phase 移行ゲート

- **Phase 2 → 3 移行ゲート**: 実 SDK で `pnpm verify` (モック側) と nightly E2E (実 API) の両方が安定 GREEN
- **Phase 3 → 4 ゲート**: OAuth フロー完成、HTTP `Authorization` 検証が `pnpm verify` でカバー済み

---

## 3. Phase 2 アーキテクチャ全体像

### 3.1 データフロー (stream:true)

```text
[OpenCode]
  │  POST /v1/chat/completions {stream:true}
  ▼
[TS: HTTP サーバ (server.ts)]
  │  SSE で接続維持、JsonRpcClient へ転送
  ▼
[TS: JsonRpcClient (jsonrpc.ts)]
  │  request 送信 → Notification を onChunk(id) で受信 →
  │  最終 response (id 一致) で完了
  ▼
[Python: server.py JSON-RPC dispatch]
  │  ハンドラが AsyncGenerator → yield ごとに Notification 送信、
  │  return で 最終 result を送信
  ▼
[Python: handlers.chat_completions]
  │  AntigravityClient.stream_chat() を呼び、token を逐次 yield
  ▼
[Python: AntigravityClient 抽象 (新規)]
  │  google.antigravity.Agent / Conversation を起動・再利用
  ▼
[Google Antigravity SDK + Gemini]
```

### 3.2 責務の分離 (Phase 1 からの差分)

| 層 | Phase 1 | Phase 2 追加 |
|---|---|---|
| `server.ts` | OpenAI 互換ハンドラ | `stream:true` 検出時に SSE 応答開始、chunk callback を SSE フレームに変換 |
| `jsonrpc.ts` | request/response の id マッチ | Notification 受信ハンドラ追加、`streamingCall()` API 追加 |
| `backend.ts` | プロセス管理 | `streamingCall()` のラッパー露出のみ |
| `errors.ts` | OpenAI エラー変換 | SDK 由来エラーコード (`-32010〜-32015`) のマッピング |
| `server.py` | 同期 dispatch | AsyncGenerator ハンドラ判別、yield → Notification、return → response の自動切替 |
| `handlers.py` | echo 実装 | `chat_completions` を AsyncGenerator 化、`AntigravityClient` へ委譲 |
| `protocol.py` | request/response モデル | `format_notification(method, params)` 追加 |
| `antigravity_client.py` (新規) | — | SDK ライフサイクル管理、`stream_chat()` / `chat()`、Mock 同梱 |

### 3.3 Agent ライフサイクル (長寿命 Agent + ステートレス呼び出し)

会話履歴 (messages 配列) は SDK に **1 回の呼び出しで一括渡し** する。リクエスト間で会話状態を共有せず、OpenAI Chat Completions API の stateless 性を厳守する。

```text
[Python ワーカ起動]
  └─ AntigravityClient.start()
      └─ Agent(LocalAgentConfig(model=$ANTIGRAVITY_MODEL)).__aenter__()  ← 1度だけ
[Each chat.completions request]
  └─ AntigravityClient.stream_chat(messages)
      ├─ Conversation.create(strategy).__aenter__()       ← 都度 (新規履歴で起動)
      ├─ messages 配列全体を 1 回の呼び出しで SDK へ一括渡し
      │   (具体 API は SDK 調査で確定。下記 3.3.1 の優先順位で評価)
      ├─ chat() の AsyncGenerator から token を逐次 yield
      └─ Conversation.__aexit__()                         ← 都度破棄
[Python ワーカ停止]
  └─ AntigravityClient.stop()
      └─ Agent.__aexit__()
```

**ステートレス特性の保証**:

- Conversation インスタンスはリクエストをまたいで再利用しない (毎回破棄)
- SDK 側に履歴を蓄積させず、各リクエストは独立して扱う
- 「過去 messages を順次 send」のような擬似的な履歴再生は**行わない** (順次 send は SDK が中間応答を返すか挙動が不確実で、stateless 性と矛盾する可能性があるため)
- 一括渡し API が SDK で提供されない場合は Section 11.1 の不確定要素として再検討対象

#### 3.3.1 一括渡し API の優先順位と選定基準

T1.1 のスパイク (Section 11.1) で以下の順序で評価し、最初に **選定基準** をすべて満たす API を採用する。各候補は実物の SDK で動作確認した上で採択判断する。

| 優先 | 候補 API | 期待される利点 |
|---|---|---|
| 1 | `Conversation.chat(messages=[...])` | Conversation スコープに閉じた純粋なステートレス呼び出し。最も `__aenter__/__aexit__` のライフサイクルと整合 |
| 2 | `Agent.chat(messages=[...])` | Conversation を介さない直結 API。中間レイヤを 1 段減らせる |
| 3 | `history=[...]` 引数経由 (`Conversation.chat(prompt, history=[...])` 等) | 最も SDK 標準的な history 表現。最終手段 |

**選定基準 (全項目を満たす必要あり):**

1. **Streaming サポート**: 採用 API が AsyncGenerator または同等のストリーミング応答を返せる (`async for token in api(...)` が成立)
2. **エラー伝搬**: SDK 例外 (Section 6.1 の `Auth/RateLimit/Model/Api/Timeout/Connection`) が呼び出し側に伝播する (内部で握り潰さない)
3. **レイテンシ**: messages を 1 回で渡せる (順次 send が不要)
4. **SDK 安定性**: SDK の `__init__.py` から公開 import 可能で、experimental / private API ではない

**代替フォールバック (リクエストごとに Agent 再起動):**

上記 3 候補がいずれも選定基準を満たさない場合のみ、リクエストごとに `Agent.__aenter__/__aexit__` を実行する代替案を検討する。ただし採用は以下の **条件** が満たされる場合に限る:

- T1.1 で計測した **Agent cold-start 時間が 100ms 未満** (環境変数 `OAG_AGENT_COLDSTART_BUDGET_MS` で閾値を上書き可能)
- 計測手順: `time.perf_counter()` で `Agent(...).__aenter__()` 区間を 10 回計測し中央値を採用
- 100ms 以上なら長寿命 Agent 採用前提が崩れるため、Phase 2 のスコープを **再交渉**(設計再検討) し、ブレインストーミングに戻る

---

## 4. コンポーネント設計

### 4.1 TypeScript 側 (差分)

| モジュール | 主要 API / クラス | 変更内容 |
|---|---|---|
| `src/server.ts` | `createServer(backend)` | `POST /v1/chat/completions` で **Section 4.1.1 のヘッダ送信フェーズ** に従う。`stream:true` 検出時に SSE 応答へ移行、`JsonRpcClient` の chunk callback を SSE フレーム (`data: {...}\n\n`) として書き出し、最終 response 受信時に `data: [DONE]\n\n` を送出して end。`stream:false` は従来通り 1 発の JSON 応答。 |
| `src/jsonrpc.ts` | `JsonRpcClient` | コンストラクタに `onNotification?: (method, params) => void` を追加。受信メッセージ判別 (`"id" in msg ? response : notification`) を `parseMessage` で行い、Notification はリクエスト Pending Map とは別経路で dispatch。 |
| `src/jsonrpc.ts` | `streamingCall(method, params, onChunk): Promise<finalResult>` (新規) | 通常の `call()` に加え、進行中の chunk を `onChunk(delta)` で受け取れる API。内部的に request_id をマッチして Notification を流す。 |
| `src/backend.ts` | `PythonBackend` | 変更最小限。`call()` に加えて `streamingCall()` のラッパーを露出。 |
| `src/errors.ts` | `BackendResponseError`, `toOpenAIError()` | SDK 由来のエラーコード (新設 `-32010` 系) を OpenAI エラー形式 (`authentication_error`, `rate_limit_error`, 他) にマッピング。Phase 1 既存マッピングは維持。 |
| `src/types.ts` | 型定義 | OpenAI Streaming Chunk 型 (`ChatCompletionChunk`)、JSON-RPC Notification 型を追加。 |

### 4.2 Python 側 (差分)

| モジュール | 主要 API / 関数 | 変更内容 |
|---|---|---|
| `__main__.py` | `python -m opencode_antigravity` | 起動時 `GEMINI_API_KEY` (live mode のみ) / `ANTIGRAVITY_MODEL` / `OAG_BACKEND_MODE` を検証、必須が未設定なら即終了。 |
| `server.py` | `run(stdin, stdout, handlers)` | ハンドラ戻り値が `AsyncGenerator` か通常値かを判別。AsyncGenerator なら `yield` ごとに `format_notification("chat.completions.chunk", {request_id, delta})` を stdout に書き出し、generator 完了時の戻り値を `format_response(id, result)` として書き出す。 |
| `protocol.py` | `format_notification(method, params)` (新規) | JSON-RPC 2.0 Notification (id なし) の整形。1MB 制限と UTF-8/`\n` 区切りは送信側も検証。 |
| `handlers.py` | `chat_completions(params)` | `params` を Pydantic で検証。`AntigravityClient.stream_chat()` を呼び、token を yield。最後に `{finish_reason, usage, ...}` を return。`stream:false` のリクエストでも内部はストリーミングして全文集約後 `chat()` 風に return。 |
| `handlers.py` | `health()`, `echo()` | 変更なし。echo は疎通検証として残置。 |
| `antigravity_client.py` (新規) | `class AntigravityClient` | `start()`, `stop()`, `async stream_chat(messages) -> AsyncGenerator[str, None]`, `async chat(messages) -> str`。`Agent` をモジュールスコープで `__aenter__/__aexit__`。`Conversation` は `stream_chat` ごとに作成・破棄。 |
| `antigravity_client.py` | `class MockAntigravityClient` | テスト用モック。決定論的な token 列を yield。`OAG_BACKEND_MODE=mock` で起動時に選択。 |
| `errors.py` (新規) | `class SdkError(Exception)` 系 | SDK 例外を JSON-RPC エラーコードへマッピングする内部型。 |

### 4.1.1 SSE ヘッダ送信フェーズ (stream:true)

stream:true 要求のレスポンスは以下の **2 フェーズ** に分けて扱う。フェーズの境界はテスト#30/#31 のエッジケース判定基準と一致する。

| フェーズ | 範囲 | エラー時の返却形式 |
|---|---|---|
| **Phase A — Pre-dispatch** | リクエスト受信 → JSON ボディ解析 → Pydantic 検証 → Python 側へ `streamingCall` 発行する直前まで (= **HTTP ヘッダ未送信**) | HTTP **4xx + OpenAI 形式 JSON** (`{"error":{"type":..., "message":...}}`) |
| **Phase B — Streaming** | `streamingCall` を発行した直後に `Content-Type: text/event-stream` ヘッダを送出 → 最終 response 受信または例外発生まで (= **HTTP 200 ヘッダ送信済み**) | **SSE error frame** (`data: {"error":{...}}\n\n` → `data: [DONE]\n\n`) |

**実装規約:**

- Phase A の検証エラーは `BackendResponseError` ではなく HTTP レイヤの即時応答で処理し、SSE モードに切り替えない
- Phase B に入る境界は `streamingCall` を await する **直前** に `res.writeHead(200, {Content-Type: "text/event-stream", ...})` を呼ぶこと
- Phase B 内で発生した全ての例外 (SDK エラー、タイムアウト、Python クラッシュ等) は Section 6.2 の SSE error frame 形式で返す
- 「最初の chunk が届くまでヘッダ送信を遅延する」設計は **採用しない** (タイムアウトとの相互作用が複雑になるため)

### 4.3 OpenAI 互換 API のレスポンス形 (stream:true)

```text
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"gemini-2.5-pro","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"gemini-2.5-pro","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","model":"gemini-2.5-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

- 最初のチャンクで `delta.role: "assistant"` を 1 度だけ送出
- 以降のチャンクは `delta.content` のみ
- 最終チャンクで `finish_reason: "stop"` (もしくは `length` 等) を返却
- `data: [DONE]` で終端

#### 4.3.1 ChatCompletionChunk 組み立て責務

OpenAI 互換の `ChatCompletionChunk` (`id`, `object: "chat.completion.chunk"`, `model`, `choices[].delta`, `choices[].finish_reason`) は **TS 側 `server.ts` が組み立てる**。Python 側は内部 token / メタデータのみを返す。

| 流路 | Python が返すもの | TS が組み立てるもの |
|---|---|---|
| Notification (chunk ごと) | `{delta: {content: "..."} or {role: "assistant", content: ""}}` のみ | `id`, `object`, `model`, `choices[0].index`, `choices[0].finish_reason: null` をラップ |
| 最終 Response (1 回) | `{finish_reason: "stop", usage: {...}}` のみ (= **内部メタデータ**) | 同一 `id` / `model` で `choices[0].delta: {}`, `choices[0].finish_reason: "stop"` フレームを生成し、続けて `data: [DONE]\n\n` を送出 |
| stream:false の集約 | `{id, object: "chat.completion", model, choices[0].message, usage}` (= **完全な OpenAI レスポンス**) | そのまま 1 発の JSON 応答として返却 |

**根拠:** Python 側で chatcmpl 番号や `object` をフレームごとに組むと、TS 側で `id` の整合性 (全 chunk 同一 `id`) を担保するため Python に追加情報を渡す必要が生じ、責務分散が悪化する。stream:true 限定で **Python = 内容、TS = 包装** に分業する。

---

## 5. SSE / Notification プロトコル拡張

### 5.1 JSON-RPC メッセージフロー (chat.completions, stream:true)

```text
TS → Python (Request):
  {"jsonrpc":"2.0","id":"<uuid>","method":"chat.completions",
   "params":{"model":"gemini-2.5-pro","messages":[...],"stream":true}}

Python → TS (Notification, 0..N 回):
  {"jsonrpc":"2.0","method":"chat.completions.chunk",
   "params":{"request_id":"<uuid>","delta":{"content":"Hello"}}}

Python → TS (最終 Response, 1 回):
  {"jsonrpc":"2.0","id":"<uuid>",
   "result":{"finish_reason":"stop",
             "usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}}
```

> **重要:** 最終 Response の `result` には **内部メタデータ (`finish_reason`, `usage`) のみ** を含める。`id`, `object`, `model`, `choices` 等の OpenAI 互換フィールドは TS 側 `server.ts` が SSE フレーム組み立て時に付与する (Section 4.3.1)。
>
> **TS 側型整合:** `JsonRpcClient.streamingCall<T>()` の型パラメータ `T` は `{ finish_reason: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }` 固定とし、Python 側 `_stream_impl` の return shape と 1 対 1 で対応させる。

#### 5.1.1 Python 側で AsyncGenerator の最終 return 値を取得する手順

Python 標準の `async for` ループは AsyncGenerator の `return value` 文の値を **黙って破棄** する。最終 result を取得するには `__anext__()` を手動で呼び `StopAsyncIteration.value` を捕捉する以下のパターンを採用する:

```python
agen = handler(params)               # AsyncGenerator を返すハンドラ
final_result: dict = {}
try:
    while True:
        delta = await agen.__anext__()
        await write_notification(req_id, delta)   # yield ごとに Notification
except StopAsyncIteration as stop:
    final_result = stop.value or {}              # return 値 ({finish_reason, usage}) を取得
await write_response(req_id, final_result)        # 最終 Response (Section 5.1)
```

- `asend(None)` / `aclose()` / `for ... else` 経由の取得は **採用しない** (挙動が版依存・冗長)
- `final_result` が `None` の場合 (= ハンドラが `return` を省略) は `{}` フォールバックし、Section 4.3.1 の TS 側包装で `finish_reason: "stop"`, `usage: {}` を補完する

### 5.2 stream:false の挙動

- Python 側は内部的に同じ AsyncGenerator を実行するが、`server.py` の dispatch ロジックが `params.stream === False` を検知して **Notification を送信せず、内部で集約**してから 1 発の response を返す
- レスポンス形は Phase 1 と互換 (`id`, `object: "chat.completion"`, `choices[0].message`, `usage` 等) で、Python 側 `handlers._aggregate_impl` が **完全な OpenAI レスポンス dict** を直接返す (Section 4.3.1 参照)
- TS 側は従来通り `call()` で受け取る (`streamingCall()` は使わない)

#### 5.2.1 集約モードの memory bound とクリーンアップ

ストリーム長が無制限に伸びると Python ワーカの RSS が肥大化するため、集約パスには **明示的な上限** を設ける。

| 観点 | 規約 |
|---|---|
| 上限値 | 環境変数 `OAG_MAX_AGGREGATE_TOKENS` (既定 `8192`)。yield された delta 数 (= token 数の近似) で計上 |
| 超過時の挙動 | 集約中の generator を `await agen.aclose()` で即時終了 → `SdkApiError` (`-32013`) を raise し、`message` に "aggregation exceeded OAG_MAX_AGGREGATE_TOKENS (N=<上限>)" を含める |
| 例外時のクリーンアップ | 集約途中に SDK 例外が発生した場合も `await agen.aclose()` を **finally** で確実に呼ぶ。バッファ (`list[str]`) は GC に任せる (明示破棄不要) |
| return 値の取得 | Section 5.1.1 と同じ `__anext__()` + `StopAsyncIteration.value` パターン。集約モードでは `final_result` は破棄し、buffer の結合文字列を `choices[0].message.content` に格納 |
| TS 側影響 | TS 側は `call()` 経由で通常の `BackendResponseError` (`-32013`) を受け取り、`toOpenAIError()` で 502 `bad_gateway` を返す |

### 5.3 Notification の規約

| 規約 | 内容 |
|---|---|
| `method` | `"chat.completions.chunk"` 固定 |
| `params.request_id` | 親 request の id を必ず転写 (UUID v4) |
| `params.delta.content` | 追加された text token (空文字列なら省略) |
| `params.delta.role` | 最初の chunk のみ `"assistant"` を含める |
| サイズ | 1 Notification も 1MB 制限を守る (Python 側送信前検証) |
| 順序保証 | stdio が FIFO なので Python の yield 順 = TS 受信順 |

### 5.4 TS 側 Notification 受信ロジック

```text
parseMessage(line) →
  if ("id" in msg && ("result" in msg || "error" in msg)) → Response
  else if ("method" in msg && !("id" in msg))             → Notification
  else                                                     → ProtocolError
```

- Notification 受信時:
  - `params.request_id` を Pending Map から検索
  - 該当エントリに `onChunk` callback が登録されていれば呼び出し
  - 該当 id が存在しない (タイムアウト済み等) なら WARN ログのみで破棄
- 完了 response が届いた時点で Phase 1 と同じクリーンアップ順序 (delete → clearTimeout → resolve)

### 5.5 タイムアウト動作 (拡張)

| タイムアウト | 環境変数 | 既定値 | 用途 |
|---|---|---|---|
| 全体タイムアウト | `OAG_REQUEST_TIMEOUT_MS` | `60000` | リクエスト送信から最終 response 受信までの上限 |
| アイドルタイムアウト | `OAG_STREAM_IDLE_TIMEOUT_MS` | `30000` | 直近のチャンクまたは最終 response 受信から次のチャンクまでの上限 |

- どちらかが先に発火した時点で `BackendTimeoutError` で reject
- SSE 応答中であれば、Section 6.2 と同じ形式で `data: {"error":{...}}\n\n` を送出した後、`data: [DONE]\n\n` で終端して close (OpenAI 互換性確保のため `event:` フィールドは使わず `data:` フィールドのみで構成)
- HTTP ステータスは既に 200 で送信済みなので、SSE フレームでのエラー通知が唯一の手段

---

## 6. エラーハンドリング

### 6.1 SDK 例外 → JSON-RPC エラーコード → OpenAI エラー対応表

| 発生原因 | Python 側例外 | JSON-RPC コード | TS 内部例外 | HTTP | OpenAI error.type |
|---|---|---|---|---|---|
| SDK 認証失敗 | `AuthenticationError` | `-32010 SdkAuthError` | `BackendResponseError` | 401 | `authentication_error` |
| SDK レート制限 | `RateLimitError` | `-32011 SdkRateLimitError` | `BackendResponseError` | 429 | `rate_limit_error` |
| SDK モデル不存在 | `ModelNotFoundError` | `-32012 SdkModelError` | `BackendResponseError` | 400 | `invalid_request_error` |
| SDK 一般 API エラー | `ApiError` 他 | `-32013 SdkApiError` | `BackendResponseError` | 502 | `bad_gateway` |
| SDK タイムアウト | `TimeoutError` | `-32014 SdkTimeoutError` | `BackendResponseError` | 504 | `timeout` |
| SDK 接続失敗 | `ConnectionError` | `-32015 SdkConnectionError` | `BackendResponseError` | 502 | `bad_gateway` |
| Pydantic バリデーション | `ValueError` (既存) | `-32602 Invalid params` | `BackendResponseError` | 400 | `invalid_request_error` |
| ハンドラ内予期せぬ例外 | `Exception` (既存) | `-32603 Internal error` | `BackendResponseError` | 500 | `server_error` |
| Phase 1 既存エラー (Parse error, Invalid Request, Method not found, タイムアウト, クラッシュ, 永久失敗 等) | 既存 | 既存 | 既存 | 既存 | SPEC.md セクション 8.1 と同じ |

> SDK が実際に raise する例外名は Phase 2 着手時の SDK API 調査 (Section 11.1 参照) で確定させる。

### 6.2 ストリーミング中エラー (SSE 中) の扱い

- Python 側で AsyncGenerator 実行中に例外発生 → Generator を強制終了し、JSON-RPC error response (id 一致) を 1 発返す
- TS 側 jsonrpc.ts は通常の error response として受信、`BackendResponseError` を構築
- TS 側 server.ts (SSE 中継) はエラーを検知して以下を SSE で送出:

```text
data: {"error":{"type":"server_error","message":"..."}}

data: [DONE]
```

- HTTP ステータスは既に 200 で送信済みのため、エラー形は SSE body 内の OpenAI 互換 error JSON で表現
- SSE ストリームは `[DONE]` で正常終了させ、HTTP 接続を close

### 6.3 stream:false 中のエラー

Phase 1 と同じ。`toOpenAIError()` で HTTP ステータス + JSON エラー body を返却。

### 6.4 ハンドラ呼出し前のリクエスト検証エラー

- `stream` フィールドが boolean でない → `-32602 Invalid params` → 400
- `messages` 配列が空 → `-32602 Invalid params` → 400
- `model` が `ANTIGRAVITY_MODEL` と不一致 → `-32602 Invalid params` → 400 (エラーメッセージで許可モデルを返す)

### 6.5 ログ方針 (Phase 1 踏襲)

- Python 側: SDK 例外発生時、stderr に `logger.error()` で例外型と詳細を記録 (秘匿情報は除外)
- TS 側: `pino` で `{ err, request_id }` を error レベルで記録
- API キーや個人情報はログに残さない

---

## 7. テスト戦略

### 7.1 テストレイヤー

| レイヤー | フレームワーク | テスト対象 | SDK 扱い | 実行コマンド | CI 実行 |
|---|---|---|---|---|---|
| Python 単体 | pytest | `protocol.py`, `handlers.py`, `antigravity_client.py` | `MockAntigravityClient` | `uv run pytest tests/python/unit` | ✓ |
| Python 統合 | pytest | `server.py` を子プロセス起動、AsyncGenerator dispatch を stdio 経由で検証 | `MockAntigravityClient` | `uv run pytest tests/python/integration` | ✓ |
| Python E2E (live) | pytest | `antigravity_client.py` から実 Gemini API を呼ぶ | 実 SDK + 実 API キー | `uv run pytest tests/python/e2e_live -m live` | × (手動/nightly) |
| TS 単体 | vitest | `jsonrpc.ts` (Notification dispatch), `errors.ts` (SDK エラー変換) | N/A | `pnpm test:unit` | ✓ |
| TS 統合 | vitest | `backend.ts` から実 Python ワーカ起動 | `MockAntigravityClient` | `pnpm test:integration` | ✓ |
| E2E (mock) | vitest | `index.ts` サーバ起動、HTTP/SSE 経由で検証 | `MockAntigravityClient` | `pnpm test:e2e` | ✓ |
| E2E (live) | vitest | 同上、ただし実 SDK + 実 API | 実 SDK + 実 API キー | `pnpm test:e2e:live` | × (手動/nightly) |

### 7.2 MockAntigravityClient の差し替え方式

- 環境変数 `OAG_BACKEND_MODE` で切替: `"mock"` (既定) / `"live"` (実 SDK)
- `MockAntigravityClient` は決定論的な token 列を yield (例: 入力 `"hello"` → `["[mock] ", "hello"]` を 100ms 間隔で yield)
- 起動時 `__main__.py` で `OAG_BACKEND_MODE` を読み、`AntigravityClient` または `MockAntigravityClient` を選択

### 7.3 既存 21 テストケースの互換性

- Phase 1 の 21 ケースは `OAG_BACKEND_MODE=mock` で全て GREEN を維持
- `chat.completions` の出力文字列が `[echo] {input}` から `[mock] {input}` 形式に変わる可能性は許容し、必要なら test #7 の期待値を更新

### 7.4 新規受け入れテストケース (Phase 2 で 10 ケース追加、合計 31)

各ケースで **Input / Expected / Edge cases** を明示する。

#### Python 側 (4 ケース追加)

**22. `test_format_notification`**: Notification 整形検証
- **Input**: `format_notification(method="chat.completions.chunk", params={"request_id":"abc","delta":{"content":"x"}})`
- **Expected**: `'{"jsonrpc":"2.0","method":"chat.completions.chunk","params":{"request_id":"abc","delta":{"content":"x"}}}\n'` (id フィールドなし、UTF-8、末尾改行付き)
- **Edge cases**:
  - 1MB を超えるシリアライズ結果 → `JsonRpcInvalidRequestError` を raise
  - `params={}` (空 dict) → 正常に整形 (params フィールドは保持)
  - UTF-8 マルチバイト文字 (例: `"delta":{"content":"日本語"}`) → 正しいバイト長で整形

**23. `test_chat_completions_async_generator`**: AsyncGenerator として token を yield
- **Input**: `params={"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hello"}],"stream":True}`、`MockAntigravityClient` 注入
- **Expected**: ハンドラ呼び出しで AsyncGenerator が返り、yield 値が `[{"content":"[mock] "},{"content":"hello"}]` の順、Generator 完了時の戻り値が `{"finish_reason":"stop","usage":{...}}`
- **Edge cases**:
  - `messages` が空配列 → `ValueError` を raise (→ `-32602 Invalid params`)
  - Generator 実行中の例外発生 → Generator が `StopAsyncIteration` ではなく例外を伝播
  - `model` が `ANTIGRAVITY_MODEL` と不一致 → `ValueError` を raise

**24. `test_chat_completions_stream_false_aggregates`**: stream:false で内部集約
- **Input**: 同 23 ただし `"stream":False`
- **Expected**: 単一 dict (`{"id":"chatcmpl-...","object":"chat.completion","model":"...","choices":[{"index":0,"message":{"role":"assistant","content":"[mock] hello"},"finish_reason":"stop"}],"usage":{...}}`)、Notification は送信されない
- **Edge cases**:
  - `stream` フィールド省略 → `False` 扱いで集約モード
  - 空応答 (yield 0 回) → `choices[0].message.content` が空文字列、`finish_reason:"stop"`
  - `usage` の `completion_tokens` が yield 数と整合する (mock では便宜値で可)

**25. `test_antigravity_client_lifecycle`**: ライフサイクル検証
- **Input**: `MockAntigravityClient` インスタンス、`start()` → `stream_chat([...])` を 2 回 → `stop()`
- **Expected**: Agent `__aenter__` が 1 回のみ、各 `stream_chat()` で Conversation `__aenter__`/`__aexit__` が 1 セット、`stop()` で Agent `__aexit__` が 1 回
- **Edge cases (必須)**:
  - `start()` を呼ばずに `stream_chat()` → `RuntimeError`
  - `stop()` 後の `stream_chat()` → `RuntimeError`
  - 二重 `start()` → 冪等動作で固定 (`agent_enter_count == 1` を維持)
- **Edge cases (Nice-to-have / Phase 2 範囲外)**:
  - `stream_chat()` 実行中に外部から `stop()` → 進行中の Conversation を `__aexit__` で正常終了。**Phase 2 では実装任意**。実装する場合は `asyncio.Task.cancel()` ベースの非ブロッキング cleanup + `__aexit__` の冪等化 (二重呼び出し防止) を伴う。実装しない場合は Phase 2.5 の graceful cancellation タスクとして follow-up する

#### TS 単体 (2 ケース追加)

**26. `parses notification and dispatches to onChunk by request_id`**: Notification dispatch
- **Input**: NDJSON 行 `'{"jsonrpc":"2.0","method":"chat.completions.chunk","params":{"request_id":"r1","delta":{"content":"x"}}}\n'`、Pending Map に `r1` の `onChunk` callback が登録済み
- **Expected**: `onChunk` が `{"content":"x"}` で 1 回呼ばれる、Pending Map のエントリは削除されない (応答完了まで保持)
- **Edge cases**:
  - 同 request_id への複数 chunk が順序通り dispatch される
  - 最初の chunk のみ `delta.role:"assistant"` を含む
  - `params` が不正形式 → `ProtocolError` raise (callback は呼ばれない)

**27. `notification with unknown request_id is ignored with warning`**: 未知 ID の破棄
- **Input**: 同 26 ただし `params.request_id="unknown"` (Pending Map に未登録)
- **Expected**: `onChunk` 呼び出しなし、pino warn レベルで `{ event: "unknown notification id", request_id: "unknown" }` が出力、例外は発生しない
- **Edge cases**:
  - タイムアウト後に到着した遅延 Notification (id は元々登録されていたが既に delete 済み) → 同様に warn のみ
  - `params.request_id` が undefined/null → warn + 破棄
  - 空文字列 `request_id:""` → warn + 破棄

#### TS 統合 (2 ケース追加)

**28. `streamingCall round-trips chunks and final response`**: stdio 経由の往復
- **Input**: 実 Python ワーカ (`OAG_BACKEND_MODE=mock`) を起動、`backend.streamingCall("chat.completions", {messages:[{role:"user",content:"hi"}],stream:true}, onChunk)`
- **Expected**: `onChunk` が 1 回以上呼ばれた後、Promise が `{finish_reason:"stop",usage:{...}}` で resolve、Pending Map からエントリが delete 済み
- **Edge cases**:
  - 並行 2 つの `streamingCall()` (異なる request_id) が混線しない (各 onChunk が自分の id のみ受信)
  - Python プロセスが途中で `kill -9` された場合 → `BackendCrashedError` で reject、SSE 中継側もエラー伝播
  - 1MB を超える delta が Python 側から送出された場合 → Python 側送信前検証で例外、`-32603 Internal error` 応答

**29. `idle timeout fires when chunks stop arriving`**: アイドルタイムアウト
- **Input**: `OAG_STREAM_IDLE_TIMEOUT_MS=100` で起動、Python 側 mock を「500ms スリープ後に最初の chunk yield」モードに設定、`streamingCall()` 発行
- **Expected**: 約 100ms 後に `BackendTimeoutError` で reject、Pending Map から該当 id が delete 済み、`clearTimeout` 済み (リソースリークなし)
- **Edge cases**:
  - タイムアウト直後に遅延 chunk が届く → ケース 27 と同じく warn + 破棄
  - 全体タイムアウト (`OAG_REQUEST_TIMEOUT_MS`) より先にアイドルタイムアウトが発火するパターンと、その逆のパターンの両方を検証

#### E2E (2 ケース追加)

**30. `POST /v1/chat/completions with stream:true returns SSE stream with [DONE]`**: SSE 正常系
- **Input**: HTTP `POST /v1/chat/completions` with body `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"hi"}],"stream":true}`
- **Expected**:
  - HTTP ステータス `200`
  - `Content-Type: text/event-stream`
  - 1 個以上の `data: {<chat.completion.chunk JSON>}\n\n` フレーム
  - 最初のフレームの `delta.role:"assistant"`
  - 最終フレームの `finish_reason:"stop"`
  - 末尾に `data: [DONE]\n\n`
  - 全フレームの `delta.content` 結合 = mock の応答テキスト
- **Edge cases**:
  - クライアントが途中で connection を切断 → サーバ側で Generator を `__aexit__` で正常終了 (リソースリークなし)
  - HTTP/1.1 chunked transfer-encoding が正しく使われている
  - 不正な body (JSON でない、`messages` 欠落) → HTTP 400 + OpenAI 形式エラー JSON (SSE 開始前なのでステータスコードで返す)

**31. `POST /v1/chat/completions with stream:true and SDK error returns SSE error frame`**: SSE エラー系
- **Input**: Mock を「最初の chunk 送出後に例外を上げる」モードで起動 (Section 7.4.1 の **`_mock.fail_after_chunk` パラメータ拡張** 経由)、HTTP `POST` with `stream:true`
- **Expected**:
  - HTTP ステータス `200` (Phase B = SSE 開始済みのため。Section 4.1.1 参照)
  - 0 個以上の通常 chunk フレーム
  - `data: {"error":{"type":"server_error","message":"..."}}\n\n` フレーム 1 個
  - `data: [DONE]\n\n` で終端
  - HTTP 接続が close
  - Section 6.2 の形式と一致 (`event:` フィールドは使わない)
- **Edge cases**:
  - Phase A (Pre-dispatch) のエラー: ボディ JSON 不正 / `messages` 欠落 / `stream` フィールド型不正 等 → **HTTP 4xx + OpenAI 形式 JSON 本体** で返す (SSE モードに切り替えない、Section 4.1.1 参照)。**この経路は SSE 開始前のみ**
  - Phase B (Streaming) のエラー: chunk が 0 個でも SDK 例外が発生したら **SSE error frame** で返す (HTTP 200 は既に送信済み)。`Content-Length: 0` 状態の SSE になっても OpenAI クライアントは frame を読めば回復可能
  - エラー時の `Authentication` 系 (mock で `AuthenticationError` を模倣) → `error.type:"authentication_error"`
  - ネットワーク切断中にエラー発生 → サーバ側で例外を握り潰さず stderr に error ログ出力

### 7.4.1 Mock 用エラー注入規約

テスト#31 のエラー系再現は、別プロセス起動を避けるため **JSON-RPC params の拡張フィールド** を用いる。HTTP ヘッダ `X-Mock-Fail-After-Chunk` を server.ts が読み、`chat.completions` の params に `_mock: {fail_after_chunk: <int>}` を付加して Python へ転送する。`MockAntigravityClient` は params 内の `_mock` を読み、指定 chunk 数を yield した時点で `SdkApiError` 等を raise する。

| ヘッダ | params 拡張 | Mock 挙動 |
|---|---|---|
| `X-Mock-Fail-After-Chunk: 0` | `_mock.fail_after_chunk = 0` | chunk を 1 個も yield せずに `SdkApiError` を raise |
| `X-Mock-Fail-After-Chunk: 1` | `_mock.fail_after_chunk = 1` | 1 個 yield してから `SdkApiError` を raise |
| `X-Mock-Fail-Type: auth` | `_mock.fail_type = "auth"` | `SdkAuthError` を選択 (省略時 `SdkApiError`) |

- 本拡張は **mock mode 専用** で、live mode では `_mock` フィールドを **削除した上で** SDK に渡す
- 本番クライアントが `_mock` を送ってきた場合も live mode では無視するため、副作用は無い

### 7.5 Live テスト運用

- `pnpm test:e2e:live` および `tests/python/e2e_live/` 配下に集約
- pytest マーカー `@pytest.mark.live` で隔離 (`pytest -m "not live"` で CI 既定スキップ)
- 開発者は `GEMINI_API_KEY` を設定して手動実行
- **nightly ワークフロー**: `.github/workflows/ci.yml` に `schedule:` トリガー (UTC 18:00 = JST 03:00) を追加し、GitHub Actions の `secrets.GEMINI_API_KEY` を渡して 1 日 1 回 `pnpm test:e2e:live` を実行する。失敗は通知扱いとし、PR/master push の CI は引き続き mock のみで PASS 判定する

---

## 8. 設定パラメータ

### 8.1 環境変数一覧 (Phase 2 で新規)

| 変数 | 既定値 | 用途 | 必須 |
|---|---|---|---|
| `GEMINI_API_KEY` | (なし) | SDK 認証用。未設定なら Python ワーカ起動時に即エラー終了 | ✓ (live mode) |
| `ANTIGRAVITY_MODEL` | `gemini-2.5-pro` | Agent 起動時に固定するモデル名 | — |
| `OAG_BACKEND_MODE` | `mock` | `"mock"` または `"live"` | — |
| `OAG_REQUEST_TIMEOUT_MS` | `60000` | TS 側全体タイムアウト | — |
| `OAG_STREAM_IDLE_TIMEOUT_MS` | `30000` | TS 側 SSE アイドルタイムアウト | — |
| `OAG_MAX_AGGREGATE_TOKENS` | `8192` | Python `stream:false` 集約モードの token 数上限 (Section 5.2.1) | — |
| `OAG_AGENT_COLDSTART_BUDGET_MS` | `100` | Section 3.3.1 の代替案採用判定に用いる Agent cold-start 上限 | — |
| `OAG_MAX_RESTARTS` | `3` | (補助タスク) Python 自動再起動上限 | — |
| `OAG_BACKOFF_INITIAL_MS` | `1000` | (補助タスク) 再起動指数バックオフ初期値 | — |

> 再起動ポリシーの外部化 (`OAG_MAX_RESTARTS`, `OAG_BACKOFF_*`) は Phase 2 本体の作業範囲に含めず、独立した補助タスクとして任意時点で挿入する。

### 8.2 設定の読み取り順序

1. プロセス環境変数 (最優先)
2. `.env` ファイル (devcontainer 内で開発用、本番運用では使わない)
3. ハードコードされた既定値

`.env` 読み込みは任意機能とし、必須にはしない。

---

## 9. Migration パス (Phase 1 → Phase 2)

| 観点 | Phase 1 | Phase 2 |
|---|---|---|
| 既定の挙動 | echo 応答 | `OAG_BACKEND_MODE=mock` で同等の決定論応答 |
| 実 Gemini 接続 | 不可 | `OAG_BACKEND_MODE=live` + `GEMINI_API_KEY` 設定で有効 |
| `stream:true` | 501 Not Implemented | SSE で正常応答 |
| `stream:false` | 通常応答 | 通常応答 (互換) |
| OpenAI API 互換性 | 維持 | 維持 (拡張のみ) |
| `GET /healthz` レスポンス | `{status, python_restarts}` | `{status, python_restarts, backend_mode, model}` 拡張 |

- Phase 1 既存 21 テストはすべて維持
- OpenCode 側は無変更で動作する想定

---

## 10. リポジトリ構成への影響

```text
opencode-antigravity-plugin/
├── src/
│   ├── ...                       # Phase 1 既存
│   └── (jsonrpc.ts に streamingCall, server.ts に SSE 中継を追加 — 新規ファイルなし)
├── backend/src/opencode_antigravity/
│   ├── ...                       # Phase 1 既存
│   ├── antigravity_client.py     # 新規 (実 SDK + Mock を同梱)
│   └── errors.py                 # 新規 (SDK 例外 → JSON-RPC エラーコード変換)
└── tests/
    ├── ts/                       # 既存 + 新規 4 ケース
    ├── python/
    │   ├── unit/                 # 既存 + 新規
    │   ├── integration/          # 既存 + 新規
    │   └── e2e_live/             # 新規ディレクトリ (live SDK テスト)
```

---

## 11. 既知の不確定要素 (writing-plans 時にスパイクで確定)

1. **SDK の例外型名**: 表 6.1 の `AuthenticationError` 等は仮置き。実 API 調査で確定させる
2. **messages 配列の一括渡し API**: Section 3.3 の前提 (ステートレス・一括渡し) を成立させる SDK API が存在するかを確定させる。**Section 3.3.1 の優先順位表 (Conversation.chat → Agent.chat → history 引数) と選定基準 4 項目 (Streaming / エラー伝搬 / レイテンシ / SDK 安定性) に従って評価する**。代替フォールバック (リクエストごとに Agent 再起動) は Agent cold-start 計測値が `OAG_AGENT_COLDSTART_BUDGET_MS` (既定 100ms) 未満である場合に限り許容する。閾値超過時はブレインストーミングに戻る
3. **SDK の thinking/tool_call イベント型**: Phase 2 では使わないが、Phase 2.5/4 のためにストリームインターフェースの型は調査しておく
4. **harness binary の起動コスト**: 長寿命 Agent 採用の前提が崩れる規模 (例: 起動に 10 秒以上要する) なら設計再検討

これらは Phase 2 の writing-plans 段階で先頭タスクとして「SDK スパイク調査」を 1〜2 日確保し、その結果で設計を微修正する。

---

## 12. Phase 3 以降への申し送り

### 12.1 Phase 3 (OAuth/PKCE 認証) への申し送り

- **HTTP `Authorization` ヘッダ**: Phase 2 までは無視。Phase 3 で Bearer token 検証を導入し、未認証アクセスを 401 で拒否
- **API キー方式の扱い**: `GEMINI_API_KEY` 環境変数方式は Phase 3 で OAuth に移行後も「開発用フォールバック」として残置する想定
- **マルチユーザー対応**: Phase 2 までは単一ユーザー前提 (1 つの `GEMINI_API_KEY`)。マルチユーザー対応は Phase 3 で OAuth アカウント連携と組で導入

### 12.2 Phase 4 (MCP ブリッジ) への申し送り

- **SDK 内蔵の MCP 統合 (`McpStdioServer`)**: Phase 4 で活用し、OpenCode 側で登録された MCP サーバを Agent のツールとして自動公開する方向
- **Python 側ディレクトリ**: `backend/src/opencode_antigravity/mcp/` 配下に MCP モジュールを追加 (SPEC.md 10 節に既述)
- **OpenAI 互換 API での MCP 露出**: OpenAI Chat Completions API には MCP の概念がないため、`tool_calls` 拡張フィールドや独自エンドポイント (`POST /v1/mcp/...`) で露出する設計判断は Phase 4 着手時に決定

### 12.3 Phase 2 で意図的に範囲外とした機能

| 機能 | 範囲外の理由 | 将来の Phase |
|---|---|---|
| `tool_calls` の透過露出 | SDK の ToolCall ストリーム → OpenAI `tool_calls` 拡張のマッピングが OpenCode 側対応に依存 | Phase 2.5 または Phase 4 |
| Gemini Thinking (CoT) の `reasoning_content` 露出 | OpenAI 互換仕様外の拡張フィールド | Phase 2.5 |
| マルチモーダル (画像/音声/動画) | OpenAI API 仕様での content array 形式対応が必要 | Phase 2.5 または Phase 5 |
| セッション永続化 (`X-Session-Id`) | OpenAI 互換 API は stateless のため互換性を優先 | Phase 5 (任意) |
| `GET /v1/models` の動的列挙 | Phase 2 は 1 モデル固定 | Phase 5 (任意) |

### 12.4 補助タスク (任意時点で挿入可能)

- **再起動ポリシー外部化** (`OAG_MAX_RESTARTS`, `OAG_BACKOFF_*`): Phase 2 本体に含めず、独立 PR で挿入
- **プラグインのパッケージ化** (npm 配布、`opencode.jsonc` 自動登録): Phase 2 完了後、Phase 3 開始前に挟むのが自然

---

## 13. 受け入れ基準サマリ

Phase 2 の完了は以下のすべてが GREEN であることをもって判定する:

1. `pnpm verify` が Phase 1 既存 21 + Phase 2 新規 10 = **合計 31 ケース** すべて PASS (mock mode)
2. `pnpm test:e2e:live` の手動実行による PASS (実 Gemini API 経由) — **任意 (Nice-to-have)**。CI ブロッキングは Section 7.5 の nightly schedule (`GEMINI_API_KEY` 未設定時はジョブを skip) に委譲し、PR マージ自体のブロックとしない
3. `GET /healthz` が `backend_mode` と `model` を含むことを確認
4. SPEC.md セクション 10 の「Antigravity SDK 連携 (Phase 2)」と「SSE ストリーミング (Phase 2)」が「完了」に更新される
