import { PythonBackend } from "./backend.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
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
  const port = Number(process.env.PORT ?? 11435);
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ level: "info", msg: "listening", port }));
  });

  const shutdown = async (sig: NodeJS.Signals) => {
    console.log(JSON.stringify({ level: "info", msg: "shutdown", signal: sig }));
    await new Promise<void>((r) => server.close(() => r()));
    await backend.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
