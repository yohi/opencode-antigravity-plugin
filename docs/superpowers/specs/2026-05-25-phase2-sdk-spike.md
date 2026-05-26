# Phase 2 SDK スパイク調査結果

## 1. SDK の例外型 (設計書 表 6.1 の確定)

調査対象: `google-antigravity==0.1.0`

| 役割 | 仮置き | 実 SDK での型名 |
|---|---|---|
| 認証失敗 | `AuthenticationError` | `google.antigravity.types.AntigravityConnectionError` |
| レート制限 | `RateLimitError` | `google.genai.errors.ClientError` または `google.antigravity.types.AntigravityConnectionError` 経由の可能性あり |
| モデル不存在 | `ModelNotFoundError` | `google.genai.errors.ClientError` または `google.antigravity.types.AntigravityConnectionError` 経由の可能性あり |
| API 一般エラー | `ApiError` | `google.genai.errors.APIError` / `ClientError` / `ServerError` |
| タイムアウト | `TimeoutError` | `google.antigravity.types.AntigravityConnectionError` 経由の可能性あり |
| 接続失敗 | `ConnectionError` | `google.antigravity.types.AntigravityConnectionError` |

実測では、ダミー API キーでの最小 `Agent.chat("hello")` は以下として伝播した。

```text
google.antigravity.types.AntigravityConnectionError:
Agent execution terminated due to error. ("request failed (code 400): API key not valid. Please pass a valid API key.")
```

公開 API として直接確認できた Antigravity SDK 独自例外は以下の 2 種類だった。

- `google.antigravity.types.AntigravityConnectionError`
- `google.antigravity.types.AntigravityValidationError`

`google-genai` 依存側には以下の例外型が存在する。

- `google.genai.errors.APIError`
- `google.genai.errors.ClientError`
- `google.genai.errors.ServerError`
- `google.genai.errors.UnknownApiResponseError`
- `google.genai.errors.FunctionInvocationError`
- `google.genai.errors.UnsupportedFunctionError`
- `google.genai.errors.UnknownFunctionCallArgumentError`

## 2. messages 配列の一括渡し API (設計書 Section 3.3 / 3.3.1)

採用 API: **該当なし。Phase 2 設計の再検討が必要。**

| 候補 | Streaming | エラー伝搬 | レイテンシ | SDK 安定性 | 採否 |
|---|---|---|---|---|---|
| `Conversation.chat(messages=[...])` | ✅ `ChatResponse.chunks` は `AsyncIterator` | ✅ 例外は呼出側へ伝播 | ❌ `messages` 引数なし。`prompt` は `str` / media / list of content primitives | ❌ `Conversation` は top-level export なし。`google.antigravity.conversation.conversation.Conversation` は private 寄り | 不採用 |
| `Agent.chat(messages=[...])` | ✅ `ChatResponse.chunks` は `AsyncIterator` | ✅ 例外は呼出側へ伝播 | ❌ `messages` 引数なし。`Agent.chat(prompt)` のみ | ✅ `google.antigravity.Agent` として公開 | 不採用 |
| `history` 引数経由 | ✅ `ChatResponse.chunks` は `AsyncIterator` | ✅ 例外は呼出側へ伝播 | ❌ `Conversation.chat(prompt, **kwargs)` には `**kwargs` があるが、実装先の `LocalConnection.send(prompt)` は `history` を受け取らない | ❌ 公開された安定 API として確認できない | 不採用 |

確認した主要シグネチャ:

```python
Agent.__init__(self, config: google.antigravity.connections.connection.AgentConfig)
Agent.chat(self, prompt: str | Image | Document | Audio | Video | list[str | Image | Document | Audio | Video]) -> ChatResponse
Conversation.chat(self, prompt: Content | None = None, **kwargs: Any) -> ChatResponse
LocalConnection.send(self, prompt: Content | None) -> None
ChatResponse.chunks -> AsyncIterator[StreamChunk | ToolCall | ToolResult]
ChatResponse.text(self) -> str
```

### 採用理由

採用できる API はなかった。`google-antigravity==0.1.0` の公開入口は `Agent.chat(prompt)` で、OpenAI Chat Completions の `messages: [{role, content}, ...]` を role 付き履歴として 1 回で渡す API は確認できなかった。

`Conversation` クラス自体は `google.antigravity.conversation.conversation.Conversation` に存在するが、`google.antigravity.__init__` から公開されておらず、設計書の SDK 安定性基準を満たさない。また、`Conversation.chat(prompt, **kwargs)` は `**kwargs` を受け付けるが、ローカル実装 `LocalConnection.send(prompt)` は `history` などを受け付けないため、history 経由の一括渡しも成立しない。

### 判定結果

| ケース | 条件 | 判定 | 遷移先 |
|---|---|---|---|
| (1) 候補採用 | いずれかの候補が 4 項目すべて ✅ | NO | — |
| (2) フォールバック採用 | 3 候補すべて ❌ かつ Agent cold-start median < `OAG_AGENT_COLDSTART_BUDGET_MS` (100ms) | NO | — |
| (3) 実装不可 | 3 候補すべて ❌ かつ Agent cold-start median >= `OAG_AGENT_COLDSTART_BUDGET_MS` (100ms) | YES | ブレインストーミングへ戻る |

### 代替フォールバック採用判断

- Agent cold-start `1012.6ms` < `OAG_AGENT_COLDSTART_BUDGET_MS` (100ms): **NO**

## 3. thinking / tool_call イベント (将来 Phase 用調査)

- ストリームインターフェース型: `ChatResponse.chunks -> AsyncIterator[StreamChunk | ToolCall | ToolResult]`
- `ChatResponse.thoughts -> AsyncIterator[str]`
- `ChatResponse.tool_calls -> AsyncIterator[ToolCall]`
- Phase 2 では thinking / tool_call は未使用とする。

## 4. harness binary 起動コスト

`GEMINI_API_KEY` 未設定では `AntigravityValidationError` により起動前に停止するため、起動コスト測定は非空のダミー API キーで実施した。実 API 呼び出しは行わず、`Agent(LocalAgentConfig(...)).__aenter__()` / `__aexit__()` 区間のみを計測した。

```text
model=gemini-2.5-pro
median=1012.6ms
p95=3183.5ms
raw=['3184', '3513', '1934', '567', '790', '774', '1037', '759', '989', '1992']
```

- Agent cold-start (10 回計測の中央値): `1012.6ms` / p95: `3183.5ms`
- 長寿命 Agent 採用の妥当性: **要再検討** (`median >= 100ms` → ブレインストーミングへ戻る)

## 5. 調査コマンドと補足

`uv pip install --no-deps google-antigravity` では `mcp` 依存が欠落し、`import google.antigravity` が失敗した。

```text
ModuleNotFoundError: No module named 'mcp'
```

そのため、SDK スパイクのために一時的に依存込みで以下を実行した。

```bash
uv pip install google-antigravity
```

この依存追加は調査環境の `.venv` に限定し、`pyproject.toml` には反映しない。Phase 2 本体の依存定義は後続タスクで行う。
