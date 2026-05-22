# AGENTS.md — Developer Agent Guidelines

Welcome, AI Coding Assistant! This document provides the critical context, architecture constraints, development commands, and coding patterns for the `opencode-antigravity-plugin` project. Read this before modifying any code.

---

## 1. Project Context & Architecture

This plugin acts as a bridge between the **OpenCode** AI programming environment (which expects an OpenAI-compatible HTTP API) and the **Google Antigravity SDK** (which is written in Python).

### The Hybrid Architecture (Design A)
```text
[OpenCode]
   │ HTTP (OpenAI-compatible)
   ▼
[TypeScript: HTTP Server + Process Manager]
   │ stdio (NDJSON / JSON-RPC 2.0)
   ▼
[Python: stdio JSON-RPC Worker (MVP=echo)]
```

### Key Responsibilities
- **TypeScript (Frontend)**: Handles HTTP listening on `127.0.0.1:11435`, manages the Python subprocess lifecycle (spawning, crash detection, exponential backoff restart, permanent failure), handles call timeouts, and converts internal exceptions into OpenAI-compatible HTTP error responses.
- **Python (Worker Backend)**: Reads NDJSON line-by-line from `stdin`, validates the JSON-RPC envelope and payload using Pydantic, generates pure echo-style `chat.completions` responses, and writes them line-by-line to `stdout`.

---

## 2. Technical Stack

- **Frontend (TS)**: Node.js 24 (Active LTS), TypeScript 5.x, `pnpm` (package manager), `vitest` (testing), `pino` (structured logging).
- **Backend (Python)**: Python 3.13, `uv` (package/environment manager), `hatchling` (PEP 517 build backend using src layout), `pydantic` v2, `pytest`, `ruff` (linter).

---

## 3. Strict Rules & Constraints (Mental Model)

You **MUST** strictly adhere to the following architectural rules when editing the code.

### 3.1 No stdout Pollution in Python (CRITICAL)
- The communication channel between TS and Python is `stdin`/`stdout`.
- **Never** use `print()` or `pprint()` in Python source code (excluding tests), as it corrupts the JSON-RPC NDJSON stream.
- Always use `logger.info()`, `logger.warning()`, or `logger.error()`, which are configured to write exclusively to `sys.stderr`.
- Python's static analysis is configured with Ruff's **`T20`** selector (`T201` and `T203`) to block `print` statements.

### 3.2 1MB Message Size Limit
- A single NDJSON message must not exceed **1MB (1,048,576 bytes)** in either direction.
- **TS Send**: Throws an error before writing to stdio if the message exceeds 1MB.
- **Python Receive**: Validates the byte size of the line. If it exceeds 1MB, raises `JsonRpcInvalidRequestError` and returns a standard JSON-RPC `-32600` (Invalid Request) error response.

### 3.3 No Request Queueing During Restarts
- When the backend state is `starting` or `restarting` (during exponential backoff or initial startup), any incoming HTTP request must **not** be queued.
- Instead, immediately reject/throw `BackendCrashedError`, which maps to HTTP 503 with `"backend restarting, retry later: [details]"`.
- Queueing causes memory leak risk and complex timeout/restart race conditions.

### 3.4 Strict Map Cleanup Order (Timeout / Resolution)
- To prevent memory leaks, Promise double-resolution, or late-response corruption, follow this exact sequence:
  1. **Delete** the entry from the `pending` map first.
  2. **Clear** the timeout handle.
  3. **Resolve** or **Reject** the Promise.
- If a late response arrives after a timeout rejection, it will be safely ignored (logged as a warning: `unknown id`).

---

## 4. Development Workflow & Commands

All development tasks, testing, and linting must be executed **inside the Devcontainer**.

### The Verification Command
Run this command before committing to ensure everything is correct:
```bash
pnpm verify
```
This runs the Python linter, Python tests, TS unit tests, TS integration tests, and E2E tests.

### Granular Testing Commands
- **TypeScript Unit Tests**: `pnpm test:unit`
- **TypeScript Integration Tests**: `pnpm test:integration` (spawns real Python backend)
- **E2E Tests**: `pnpm test:e2e` (spawns HTTP server and validates end-to-end OpenAI completions)
- **Python Tests**: `pnpm test:python` (runs pytest)
- **Python Lint check**: `pnpm lint:python` (runs ruff check)

### Spawning the Server Manually
```bash
npx tsx src/index.ts
```

---

## 5. Code Style & Idioms

### TypeScript
- Use modern ESM imports (always suffix file imports with `.js` e.g., `import { X } from "./errors.js"`).
- Keep functions pure and delegate asynchronous state machines (like subprocess restarts) to `PythonBackend` via event emitters.
- Use `pino` for logging and structure it with `{ err }` or relevant context objects.

### Python
- Use Type Hints for all function signatures.
- Leverage Pydantic models for validation and parsing (`_ChatRequest.model_validate(params)`).
- When raising exceptions inside handlers, raise standard `ValueError` to let `server.py` automatically map it to `-32602` (Invalid params). Raise `Exception` (or other standard exceptions) to map to `-32603` (Internal error).

---

## 6. Git & PR Best Practices

- **Never merge PRs yourself**. Merging is strictly reserved for human operators.
- **Never commit directly to `master` branch**.
- Commit messages must follow Conventional Commits in Japanese (e.g., `feat(backend): ...`, `fix(errors): ...`).
- When defining a new implementation task, create an implementation plan first unless it is a trivial change.
