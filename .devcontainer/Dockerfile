FROM mcr.microsoft.com/devcontainers/python:3.13

# Node 24 (Active LTS) を NodeSource 経由で導入（features は使わず軽量化）
ARG NODE_VERSION=24

# pnpm + uv を導入
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm@9.15.9 \
    && pip install --no-cache-dir uv==0.11.15

# 動作ユーザは devcontainer 既定の vscode
USER vscode
WORKDIR /workspaces/opencode-antigravity-plugin
