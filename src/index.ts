import { PythonBackend } from "./backend.js";
import { createServer } from "./server.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const rawPort = process.env.PORT ?? "11435";
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    logger.error({ port: rawPort }, "invalid port");
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
    logger.error({ err }, "server error");
    await backend.stop().catch(() => {});
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info({ port }, "listening");
  });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal: sig }, "shutdown");
    await new Promise<void>((r) => server.close(() => r()));
    await backend.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "startup failed");
  process.exit(1);
});
