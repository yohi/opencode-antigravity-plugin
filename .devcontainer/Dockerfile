FROM mcr.microsoft.com/devcontainers/python:3.13

# uv を導入 (Node.js/pnpm は devcontainer features で導入)
RUN pip install --no-cache-dir uv==0.11.15

# 動作ユーザは devcontainer 既定の vscode
USER vscode
WORKDIR /workspaces/opencode-antigravity-plugin
