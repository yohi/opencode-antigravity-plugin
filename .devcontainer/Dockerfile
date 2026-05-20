FROM mcr.microsoft.com/devcontainers/python:3.13

# Node 24 (Active LTS) を導入
ARG NODE_VERSION=24

# NodeSource の GPG キーを検証・保存し、APT リポジトリを明示的に登録
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && mkdir -p /usr/share/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm@9.15.9 \
    && pip install --no-cache-dir uv==0.11.15 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 動作ユーザは devcontainer 既定の vscode
USER vscode
WORKDIR /workspaces/opencode-antigravity-plugin
