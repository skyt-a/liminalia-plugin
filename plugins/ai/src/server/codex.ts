import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AiError, cancelled, type AiClient, type RawModel, type ThreadParams, type TurnHandle, type TurnOptions, type TurnParams } from "./client.ts";

/** 要求の答えを待つ時間。 */
const REQUEST_TIMEOUT = 30000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Turn {
  threadId: string;
  turnId: string;
  items: Map<string, string>;
  order: string[];
  options: TurnOptions;
  resolve(value: { text: string }): void;
  reject(error: Error): void;
  cancelRequested: boolean;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** JSON の中のメッセージを取り出す（Codex のエラーは JSON の文字列のことがある）。 */
export function codexErrorMessage(value: unknown): string {
  const source = String(value ?? "").trim();
  if (!source) return "Codex の実行に失敗しました";
  if (!source.startsWith("{")) return source;
  try {
    const parsed = JSON.parse(source) as { error?: { message?: string; error?: { message?: string } }; message?: string };
    return parsed.error?.message || parsed.message || parsed.error?.error?.message || source;
  } catch {
    return source;
  }
}

/**
 * Codex の app-server（codex app-server。標準入出力で一行ずつの JSON-RPC）と話す。
 * スレッドは作品のフォルダを読むだけ（sandbox: read-only・承認なし）で始め、サーバーからの要求（承認・MCP）はすべて断る。
 */
export class CodexClient implements AiClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly turns = new Map<string, Turn>();
  private stderrTail = "";
  private disposed = false;
  private readonly exitListeners: (() => void)[] = [];

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.disposed) throw new AiError("Codex との接続は終わっています", "DISPOSED");
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  onExit(listener: () => void): void {
    this.exitListeners.push(listener);
  }

  private async start(): Promise<void> {
    this.buffer = "";
    this.stderrTail = "";
    const child = spawn(this.executable, ["app-server"], { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8000)));
    child.once("error", (e) => this.fail(e));
    child.once("exit", (code, signal) => {
      const detail = this.stderrTail.trim();
      this.fail(new AiError(`Codex の app-server が終わりました（${signal ?? code ?? 0}）${detail ? `: ${detail.split(/\r?\n/).slice(-2).join(" ")}` : ""}`, "CODEX_EXIT"));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.request("initialize", { clientInfo: { name: "liminalia-ai", title: "Liminalia AI", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    this.notify("initialized", {});
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) throw new AiError("Codex の app-server に繋がっていません", "CODEX_DISCONNECTED");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown = {}, timeoutMs = REQUEST_TIMEOUT): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AiError(`${method} が時間切れになりました`, "CODEX_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line) as Message);
      } catch {
        // 読めない行は捨てる
      }
    }
  }

  private onMessage(message: Message): void {
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(message.id);
      if (!p) return;
      this.pending.delete(message.id);
      if (message.error) p.reject(new AiError(codexErrorMessage(message.error.message ?? JSON.stringify(message.error)), "CODEX_REQUEST_FAILED"));
      else p.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // 承認なし・MCP なしで始めているので、サーバーからの要求は断る
      try {
        this.write({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
      } catch {
        // 繋がっていなければそのまま
      }
      return;
    }
    if (!message.method) return;
    const params = (message.params ?? {}) as Params;
    const turn = this.turns.get(params.threadId ?? params.thread?.id ?? "");
    if (!turn) return;
    switch (message.method) {
      case "turn/started":
        turn.turnId = params.turn?.id ?? turn.turnId;
        if (turn.cancelRequested) void this.interruptTurn(turn).catch(() => undefined);
        return;
      case "item/agentMessage/delta": {
        const delta = String(params.delta ?? "");
        const itemId = String(params.itemId ?? "agent-message");
        // 別の答えの項目に移ったら、画面の答えを作り直す
        const reset = turn.order.length > 0 && turn.order.at(-1) !== itemId;
        if (!turn.items.has(itemId)) turn.order.push(itemId);
        turn.items.set(itemId, `${turn.items.get(itemId) ?? ""}${delta}`);
        if (delta) turn.options.onDelta?.(delta, reset);
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        turn.options.onProgress?.("reasoning");
        return;
      case "model/safetyBuffering/updated":
        if (params.showBufferingUi) turn.options.onProgress?.("buffering");
        return;
      case "item/completed": {
        if (params.item?.type !== "agentMessage") return;
        const itemId = String(params.item.id ?? params.itemId ?? "agent-message");
        const final = String(params.item.text ?? "");
        const current = turn.items.get(itemId) ?? "";
        if (!turn.items.has(itemId)) turn.order.push(itemId);
        turn.items.set(itemId, final);
        if (final && final !== current) {
          if (final.startsWith(current)) turn.options.onDelta?.(final.slice(current.length), false);
          else turn.options.onDelta?.(final, true);
        }
        return;
      }
      case "error":
        if (params.willRetry) turn.options.onProgress?.("retry");
        else this.finish(turn, new AiError(codexErrorMessage(params.error?.message ?? params.message), "CODEX_TURN_FAILED"));
        return;
      case "turn/completed": {
        const status = params.turn?.status ?? "completed";
        if (turn.cancelRequested || status === "interrupted" || status === "cancelled") this.finish(turn, cancelled());
        else if (status === "failed") this.finish(turn, new AiError(codexErrorMessage(params.turn?.error?.message), "CODEX_TURN_FAILED"));
        else {
          // 答えの項目のうち、最後の空でないもの
          const last = [...turn.order].reverse().find((id) => (turn.items.get(id) ?? "").trim());
          this.finish(turn, null, { text: last ? turn.items.get(last)! : "" });
        }
        return;
      }
    }
  }

  private finish(turn: Turn, error: Error | null, value?: { text: string }): void {
    if (turn.done) return;
    turn.done = true;
    if (turn.timer) clearTimeout(turn.timer);
    this.turns.delete(turn.threadId);
    if (error) turn.reject(error);
    else turn.resolve(value!);
  }

  async listModels(): Promise<RawModel[]> {
    await this.ensureStarted();
    const models: RawModel[] = [];
    let cursor: string | null = null;
    do {
      const r = (await this.request("model/list", { cursor, includeHidden: false, limit: 100 })) as { data?: RawModel[]; nextCursor?: string | null } | null;
      for (const m of r?.data ?? []) if (!m.hidden) models.push(m);
      cursor = r?.nextCursor ?? null;
    } while (cursor);
    return models;
  }

  async readAccount(): Promise<{ needsLogin: boolean }> {
    await this.ensureStarted();
    const r = (await this.request("account/read", { refreshToken: false })) as { requiresOpenaiAuth?: boolean; account?: unknown } | null;
    return { needsLogin: Boolean(r?.requiresOpenaiAuth && !r.account) };
  }

  async startThread(params: ThreadParams): Promise<string> {
    await this.ensureStarted();
    const r = (await this.request("thread/start", {
      cwd: params.cwd,
      model: params.model,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      serviceTier: params.serviceTier,
      developerInstructions: params.developerInstructions,
      config: { mcp_servers: {} },
    })) as { thread?: { id?: string }; threadId?: string } | null;
    const id = r?.thread?.id ?? r?.threadId ?? "";
    if (!id) throw new AiError("Codex の会話を始められませんでした", "CODEX_THREAD");
    return id;
  }

  async startTurn(params: TurnParams, options: TurnOptions): Promise<TurnHandle> {
    await this.ensureStarted();
    if (this.turns.has(params.threadId)) throw new AiError("この会話では別の生成が動いています", "TURN_BUSY", 409);
    let resolve!: (v: { text: string }) => void;
    let reject!: (e: Error) => void;
    const done = new Promise<{ text: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const turn: Turn = { threadId: params.threadId, turnId: "", items: new Map(), order: [], options, resolve, reject, cancelRequested: false, done: false, timer: null };
    turn.timer = setTimeout(() => {
      turn.cancelRequested = true;
      void this.interruptTurn(turn).catch(() => undefined);
      this.finish(turn, new AiError(`生成が ${Math.max(1, Math.round(options.timeoutMs / 60000))} 分を超えたので止めました`, "TIMEOUT", 504));
    }, Math.max(1, options.timeoutMs));
    this.turns.set(params.threadId, turn);
    try {
      const r = (await this.request("turn/start", params)) as { turn?: { id?: string }; turnId?: string } | null;
      turn.turnId = r?.turn?.id ?? r?.turnId ?? turn.turnId;
      if (turn.cancelRequested) await this.interruptTurn(turn);
    } catch (e) {
      this.finish(turn, e as Error);
      throw e;
    }
    return {
      done,
      interrupt: () => {
        turn.cancelRequested = true;
        return this.interruptTurn(turn);
      },
    };
  }

  private async interruptTurn(turn: Turn): Promise<boolean> {
    if (turn.done || !turn.turnId) return false;
    try {
      await this.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId });
      return true;
    } catch (e) {
      if (turn.done) return false;
      throw e;
    }
  }

  private fail(error: Error): void {
    const child = this.child;
    this.child = null;
    child?.stdout.removeAllListeners();
    child?.stderr.removeAllListeners();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const t of [...this.turns.values()]) this.finish(t, error);
    if (!this.disposed) for (const l of this.exitListeners) l();
  }

  dispose(): void {
    this.disposed = true;
    const error = new AiError("Codex との接続を終えました", "DISPOSED");
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const t of [...this.turns.values()]) this.finish(t, error);
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    try {
      child.stdin.end();
      child.kill("SIGTERM");
    } catch {
      // 止まっていればそのまま
    }
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 1000).unref();
  }
}

interface Message {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface Params {
  threadId?: string;
  thread?: { id?: string };
  turn?: { id?: string; status?: string; error?: { message?: string } };
  delta?: string;
  itemId?: string;
  item?: { type?: string; id?: string; text?: string };
  showBufferingUi?: boolean;
  willRetry?: boolean;
  error?: { message?: string };
  message?: string;
}
