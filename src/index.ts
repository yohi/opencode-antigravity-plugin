import { PythonBackend } from "./backend.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const rawPort = process.env.PORT ?? "11435";
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(JSON.stringify({ level: "error", msg: "invalid port", port: rawPort }));
    process.exit(1);
  }

  const backend = new PythonBackend({
    pythonBin: process.env.PYTHON_BIN ?? "python",
    moduleName: "opencode_antigravity",
    cwd: process.cwd(),
    healthTimeoutMs: 5000,
    callTimeoutMs: 60_000,
    maxRestarts: 3,
    backoffMs: [1000, 2000, 4000],
  });
  await backend.start();

  const server = createServer(backend);

  server.once("error", async (err) => {
    console.error(JSON.stringify({ level: "error", msg: "server error", err: String(err) }));
    await backend.stop().catch(() => {});
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ level: "info", msg: "listening", port }));
  });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: "info", msg: "shutdown", signal: sig }));
    await new Promise<void>((r) => server.close(() => r()));
    await backend.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "startup failed", err: String(err) }));
  process.exit(1);
});
