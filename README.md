# opencode-antigravity-plugin

OpenAI 互換 HTTP を OpenCode から受け、Python の Antigravity ワーカへ stdio JSON-RPC で中継するハイブリッドプラグインです。

詳しいアーキテクチャや制御フロー、エラーハンドリングなどの設計については、[SPEC.md](SPEC.md) を参照してください。

---

## 開発環境のセットアップ

本プロジェクトは Devcontainer を使用した開発を前提としています。

1. VS Code で本リポジトリを開き、**「Reopen in Container」** を実行してコンテナを起動します。
2. コンテナ起動後、必要な依存関係が自動的にインストールされます。手動で同期する場合は以下のコマンドを実行してください。
   ```bash
   pnpm install && uv sync
   ```

---

## 動作確認・テストの実行

Devcontainer 内で以下のコマンドを使用してテストや検証を実行できます。

### 1. 全テストと静的解析の実行 (検証用)
```bash
pnpm verify
```
`pnpm verify` は以下のコマンドを一括実行します。
- Python の静的解析（lint） (`ruff check`)、コード整形は `ruff format` を使用
- Python の単体・結合テスト (`pytest`)
- TypeScript の単体テスト (`vitest run tests/ts --exclude ...`)
- TypeScript の結合テスト (`vitest run tests/ts/backend.test.ts`)
- E2E 統合テスト (`vitest run tests/ts/integration.test.ts`)

### 2. コンポーネントごとのテスト実行

- **TypeScript 単体テスト**:
  ```bash
  pnpm test:unit
  ```
- **TypeScript 結合テスト (PythonBackend ライフサイクル等)**:
  ```bash
  pnpm test:integration
  ```
- **E2E 統合テスト (HTTP サーバ疎通等)**:
  ```bash
  pnpm test:e2e
  ```
- **Python 単体・結合テスト**:
  ```bash
  pnpm test:python
  ```
- **Python 静的解析 (Ruff)**:
  ```bash
  pnpm lint:python
  ```

---

## サーバの起動

ローカルで HTTP サーバを起動して OpenCode から接続確認を行う場合：

```bash
# デフォルトで 127.0.0.1:11435 で Listen を開始します
pnpm build && node dist/src/index.js
```
または `tsx` を使用してビルドなしで起動できます。
```bash
npx tsx src/index.ts
```

起動ポートは環境変数 `PORT` から変更可能です。
```bash
PORT=8080 npx tsx src/index.ts
```
