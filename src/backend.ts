import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcClient } from "./jsonrpc.js";
import {
  BackendCrashedError,
  BackendPermanentlyFailedError,
} from "./errors.js";

export type BackendState = "starting" | "ready" | "restarting" | "permanently_failed" | "stopped";

export interface PythonBackendOptions {
  pythonBin: string;
  moduleName: string;
  cwd: string;
  healthTimeoutMs: number;
  callTimeoutMs: number;
  maxRestarts: number;
  backoffMs: number[]; // length === maxRestarts
}

export class PythonBackend extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private client: JsonRpcClient | null = null;
  private state: BackendState = "stopped";
  private isRestarting = false;
  private _restartCount = 0;
  private generation = 0;
  private stdoutBuf = "";

  constructor(private readonly opts: PythonBackendOptions) {
    super();
  }

  get currentState(): BackendState {
    return this.state;
  }

  get restartCount(): number {
    return this._restartCount;
  }

  get pid(): number {
    return this.proc?.pid ?? -1;
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      return Promise.reject(new Error(`Cannot start from state: ${this.state}`));
    }
    this.state = "starting";
    try {
      this.spawnAndWire();
      await this.waitForHealthy();
      this.state = "ready";
      this.emit("ready");
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async call(method: string, params: unknown): Promise<unknown> {
    if (this.state === "permanently_failed") {
      throw new BackendPermanentlyFailedError();
    }
    if (this.state !== "ready" || this.client === null) {
      throw new BackendCrashedError(`backend not ready (state=${this.state})`);
    }
    return this.client.call(method, params, { timeoutMs: this.opts.callTimeoutMs });
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    this.generation++; // invalidate existing handlers
    if (this.proc) {
      this.proc.kill("SIGTERM");
      await this.waitProcExit(3000);
      if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGKILL");
    }
    this.proc = null;
    this.client = null;
  }

  private spawnAndWire(): void {
    this.stdoutBuf = "";
    this.generation++;
    const currentGen = this.generation;
    const proc = spawn(this.opts.pythonBin, ["-m", this.opts.moduleName], {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        PYTHONPATH: `${process.env.PYTHONPATH ?? ""}${process.env.PYTHONPATH ? ":" : ""}${this.opts.cwd}/backend/src`,
      },
    });
    this.proc = proc;
    this.client = new JsonRpcClient({
      write: (line) => proc.stdin.write(line),
      warn: (msg) => console.warn(`[backend] ${msg}`),
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      if (this.generation !== currentGen) return;
      this.onStdoutChunk(chunk);
    });
    proc.once("exit", (code, signal) => {
      if (this.generation !== currentGen) return;
      this.onProcExit(code, signal);
    });
    proc.on("error", (err) => {
      if (this.generation !== currentGen) return;
      if (this.state === "stopped") return;
      const error = new BackendCrashedError(`python spawn error: ${err.message}`);
      this.client?.rejectAll(error);
      this.proc = null;
      this.client = null;
      void this.attemptRestart();
    });
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line.trim().length === 0) continue;
      this.client?.handleInboundLine(line);
    }
  }

  private async waitForHealthy(): Promise<void> {
    if (this.client === null) throw new BackendCrashedError("client missing during health");
    await this.client.call("health", {}, { timeoutMs: this.opts.healthTimeoutMs });
  }

  private onProcExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.state === "stopped") return; // intentional stop
    const err = new BackendCrashedError(
      `python exited code=${code} signal=${signal}`,
    );
    this.client?.rejectAll(err);
    this.proc = null;
    this.client = null;
    void this.attemptRestart();
  }

  private async attemptRestart(): Promise<void> {
    if (this.isRestarting || this.state === "stopped" || this.state === "permanently_failed") {
      return;
    }
    this.isRestarting = true;
    this.state = "restarting";
    this.emit("restarting");
    if (this._restartCount >= this.opts.maxRestarts) {
      this.state = "permanently_failed";
      this.isRestarting = false;
      this.emit("permanently_failed");
      return;
    }
    const wait = this.opts.backoffMs[this._restartCount] ?? 4000;
    this._restartCount += 1;
    await new Promise((r) => setTimeout(r, wait));

    if (this.state === "stopped" || this.state === "permanently_failed") {
      this.isRestarting = false;
      return;
    }

    try {
      this.spawnAndWire();
      await this.waitForHealthy();
      this.state = "ready";
      this.isRestarting = false;
      this.emit("ready");
    } catch {
      if (this.proc) {
        this.proc.kill("SIGKILL");
      }
      this.proc = null;
      this.client = null;
      this.isRestarting = false;
      void this.attemptRestart();
    }
  }

  private waitProcExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.proc) return resolve();
      const t = setTimeout(resolve, timeoutMs);
      this.proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
