import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiError, cancelled, type AiClient, type RawModel, type ThreadParams, type TurnHandle, type TurnOptions, type TurnParams } from "./client.ts";

/** 既定のモデル。 */
const DEFAULT_MODEL = "gemini-3.8-flash-medium";

/**
 * Antigravity の CLI（agy）と話す。生成ごとに agy を起こし、stream-json で答えを受け取る。
 * 作品のフォルダは見せず、空のフォルダで動かす（渡すのは用意した文脈だけ）。会話の続きは agy の conversation id で繋ぐ。
 */
export class AgyClient implements AiClient {
  private readonly cwd = mkdtempSync(join(tmpdir(), "liminalia-agy-"));
  private readonly threads = new Map<string, { instructions: string; conversation: string }>();
  private readonly running = new Map<string, () => Promise<void>>();
  private disposed = false;

  constructor(
    private readonly executable: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async ensureStarted(): Promise<void> {
    if (this.disposed) throw new AiError("Gemini との接続は終わっています", "DISPOSED");
  }

  onExit(): void {
    // 生成ごとに起こすので、止まって困ることはない
  }

  async listModels(): Promise<RawModel[]> {
    await this.ensureStarted();
    const out = await new Promise<string>((resolve, reject) =>
      execFile(this.executable, ["models"], { cwd: this.cwd, env: this.env, timeout: 30000, maxBuffer: 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve(String(stdout)))),
    );
    const models = out.split(/\r?\n/).flatMap((line): RawModel[] => {
      const m = /^(gemini-\S+)\s+(.+)$/.exec(line);
      if (!m) return [];
      const effort = /-(low|medium|high)$/.exec(m[1]!)?.[1] ?? "medium";
      return [{ id: m[1]!, displayName: m[2]!, isDefault: m[1] === DEFAULT_MODEL, defaultReasoningEffort: effort, supportedReasoningEfforts: [effort] }];
    });
    if (models.length === 0) throw new AiError("agy で使える Gemini のモデルがありません", "AGY_MODELS");
    return models;
  }

  async readAccount(): Promise<{ needsLogin: boolean }> {
    return { needsLogin: false };
  }

  async startThread(params: ThreadParams): Promise<string> {
    await this.ensureStarted();
    const id = randomUUID();
    this.threads.set(id, { instructions: params.developerInstructions, conversation: "" });
    return id;
  }

  async startTurn(params: TurnParams, options: TurnOptions): Promise<TurnHandle> {
    await this.ensureStarted();
    const thread = this.threads.get(params.threadId);
    if (!thread) throw new AiError("相談をやり直してください", "AGY_THREAD", 409);
    if (this.running.has(params.threadId)) throw new AiError("この会話では別の生成が動いています", "TURN_BUSY", 409);
    const args = ["--model", params.model, "--mode", "plan", "--sandbox", "--input-format", "stream-json", "--output-format", "stream-json"];
    if (thread.conversation) args.push("--conversation", thread.conversation);
    if (params.outputSchema) args.push("--json-schema", JSON.stringify(params.outputSchema));
    const prompt = [
      thread.instructions,
      "ツールを使わず、以下の文脈だけから答えてください。ファイルの参照・作成・編集、コマンドの実行はしません。答えの本文をそのまま返してください。",
      ...params.input.map((i) => i.text),
    ].join("\n\n");
    const child = spawn(this.executable, args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let text = "";
    let itemId = "";
    let settled = false;
    let resolve!: (v: { text: string }) => void;
    let reject!: (e: Error) => void;
    const done = new Promise<{ text: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    };
    const finish = (error: Error | null, response = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.running.delete(params.threadId);
      if (error) {
        // 止めた・失敗した会話は途中の答えを持つことがあるので、続きにしない
        thread.conversation = "";
        reject(error);
      } else resolve({ text: response });
      stop();
    };
    const onLine = (line: string) => {
      if (!line.trim() || settled) return;
      let event: AgyEvent;
      try {
        event = JSON.parse(line) as AgyEvent;
      } catch {
        return finish(new AiError("agy から読めない答えが来ました", "AGY_PROTOCOL"));
      }
      if (event.event === "init") thread.conversation = event.conversation_id ?? "";
      if (event.event === "step_update") {
        const step = event.step_update ?? {};
        if (step.step_type === "agent_response" && step.text_delta) {
          const next = String(step.step_index);
          const reset = Boolean(itemId && itemId !== next);
          if (reset) text = "";
          itemId = next;
          text += step.text_delta;
          options.onDelta?.(step.text_delta, reset);
        } else if (step.step_type === "agent_thought") options.onProgress?.("reasoning");
      }
      if (event.event === "result") {
        const r = event.result ?? {};
        if (r.status !== "SUCCESS") return finish(new AiError(r.error?.message || r.response || "Gemini の生成に失敗しました", "AGY_FAILED"));
        thread.conversation = r.conversation_id ?? thread.conversation;
        const response = String(r.response ?? text);
        if (response !== text) options.onDelta?.(response, true);
        finish(null, response);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        onLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
    child.on("error", (e) => finish(e));
    child.stdin.on("error", (e) => finish(e));
    child.on("close", () => {
      if (buffer.trim()) onLine(buffer);
      finish(new AiError(`agy が答え終わる前に終わりました${stderr ? `: ${stderr.trim()}` : ""}`, "AGY_EXIT"));
    });
    const interrupt = async () => finish(cancelled());
    this.running.set(params.threadId, interrupt);
    const timer = setTimeout(() => finish(new AiError("Gemini の生成が時間切れになりました", "TIMEOUT", 504)), options.timeoutMs);
    child.stdin.end(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
    return { done, interrupt };
  }

  dispose(): void {
    this.disposed = true;
    for (const interrupt of this.running.values()) void interrupt();
    this.threads.clear();
    rmSync(this.cwd, { recursive: true, force: true });
  }
}

interface AgyEvent {
  event?: string;
  conversation_id?: string;
  step_update?: { step_type?: string; step_index?: number; text_delta?: string };
  result?: { status?: string; response?: string; conversation_id?: string; error?: { message?: string } };
}
