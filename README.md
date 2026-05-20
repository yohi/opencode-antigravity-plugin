# opencode-antigravity-plugin

OpenAI 互換 HTTP を OpenCode から受け、Python の Antigravity ワーカへ stdio JSON-RPC で中継するハイブリッドプラグイン。

## 開発

1. VS Code で本リポジトリを開き「Reopen in Container」を実行
2. devcontainer 内で `pnpm install && uv sync`
3. `pnpm verify` で全テスト実行

設計の詳細は `docs/superpowers/specs/2026-05-20-opencode-antigravity-plugin-mvp-design.md` を参照。
