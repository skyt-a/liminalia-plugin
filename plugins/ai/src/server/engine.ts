import { AiError, cancelled, type AiClient, type RawModel, type ThreadParams, type TurnHandle, type TurnOptions, type TurnParams } from "./client.ts";

/**
 * エンジンの AI のエージェント（ctx.agents。Liminalia の口の版 6 から）を使う接続先。制作画面の「AI」と同じエージェント
 * （Claude Code、Codex、Antigravity などの ACP のエージェント）に、作者自身のログインのまま相談する。
 * エンジンは相談をファイルを書かせずに空のフォルダで動かすので、ここでは渡した文脈と指示だけを送り、答えの文を受け取る。
 *
 * 型は @liminalia/sdk を読まずにここに写す（エンジンの外に置いても動くように）。
 */

export interface EngineAgentOption {
  id: string;
  name: string;
  category?: string;
  current: string;
  choices: { value: string; name: string; description?: string }[];
  dependsOn?: { option: string; choices: Record<string, { value: string; name: string }[]>; current: Record<string, string> };
}

export interface EngineConsult {
  ask(prompt: string, o?: { onDelta?(delta: string): void; onThought?(): void; signal?: AbortSignal }): Promise<{ text: string; reason: string; error?: string }>;
  close(): Promise<void>;
}

export interface EngineAgents {
  list(): Promise<{ id: string; name: string; protocol: string }[]>;
  options(id: string): Promise<EngineAgentOption[]>;
  consult(id: string, o: { instructions: string; options?: Record<string, string> }): Promise<EngineConsult>;
}

/** エンジンのエージェントの接続先の id（設定に覚える形）。 */
export const ENGINE_PREFIX = "engine:";

/** 考える深さの項目（Codex と Claude は effort、Antigravity は thought_level など）。 */
export function effortOption(options: readonly EngineAgentOption[]): EngineAgentOption | undefined {
  return options.find((o) => o.id === "effort") ?? options.find((o) => /effort|reasoning|thought/i.test(o.id));
}

/** 選ばせる項目を、この欄のモデル・深さ・速さの形に直す。モデルの項目が無ければ「既定」一つ。 */
export function modelsFromOptions(options: readonly EngineAgentOption[]): RawModel[] {
  const model = options.find((o) => o.id === "model" || o.category === "model");
  const effort = effortOption(options);
  const tier = options.find((o) => o.id === "serviceTier");
  const efforts = (m: string) => (effort?.dependsOn?.choices[m] ?? effort?.choices ?? []).map((c) => c.value).filter(Boolean);
  const tiers = (m: string) => (tier?.dependsOn?.choices[m] ?? tier?.choices ?? []).filter((c) => c.value).map((c) => ({ id: c.value, name: c.name }));
  const list = model ? model.choices.filter((c) => c.value !== "") : [{ value: "", name: "既定" }];
  const current = model?.current || list[0]?.value || "";
  return list.map((c) => ({
    id: c.value,
    displayName: c.name,
    isDefault: c.value === current,
    supportedReasoningEfforts: efforts(c.value),
    defaultReasoningEffort: effort?.dependsOn?.current[c.value] ?? effort?.current ?? "",
    serviceTiers: tiers(c.value),
  }));
}

export class EngineAgentClient implements AiClient {
  private readonly threads = new Map<string, { instructions: string; model?: string; session: EngineConsult | null; options: Record<string, string> }>();
  private optionsCache: EngineAgentOption[] | null = null;
  private count = 0;
  private disposed = false;

  constructor(
    private readonly agents: EngineAgents,
    private readonly agentId: string,
  ) {}

  async ensureStarted(): Promise<void> {
    if (this.disposed) throw new AiError("AI との接続は終わっています", "DISPOSED");
  }

  onExit(): void {
    // エンジンが会話ごとにエージェントを起こすので、ここで見張るものは無い
  }

  async readAccount(): Promise<{ needsLogin: boolean }> {
    // ログインしていなければ、相談を始めたときにエンジンが理由を返す
    return { needsLogin: false };
  }

  private async options(): Promise<EngineAgentOption[]> {
    this.optionsCache ??= await this.agents.options(this.agentId);
    return this.optionsCache;
  }

  async listModels(): Promise<RawModel[]> {
    return modelsFromOptions(await this.options());
  }

  async startThread(params: ThreadParams): Promise<string> {
    const id = `e${++this.count}`;
    this.threads.set(id, { instructions: params.developerInstructions, ...(params.model ? { model: params.model } : {}), session: null, options: {} });
    return id;
  }

  async startTurn(params: TurnParams, options: TurnOptions): Promise<TurnHandle> {
    const thread = this.threads.get(params.threadId);
    if (!thread) throw new AiError("相談の会話がありません", "NO_THREAD");
    const known = await this.options();
    const wanted: Record<string, string> = {};
    const has = (id: string) => known.some((o) => o.id === id);
    if (params.model && has("model")) wanted.model = params.model;
    const effort = effortOption(known);
    if (params.effort && effort && [...effort.choices, ...Object.values(effort.dependsOn?.choices ?? {}).flat()].some((c) => c.value === params.effort)) wanted[effort.id] = params.effort;
    if (params.serviceTier && has("serviceTier")) wanted.serviceTier = params.serviceTier;
    // 会話は、モデルなどを変えたら作り直す（エージェントは始めるときに項目を決める）
    if (thread.session && JSON.stringify(thread.options) !== JSON.stringify(wanted)) {
      await thread.session.close().catch(() => undefined);
      thread.session = null;
    }
    if (!thread.session) {
      thread.session = await this.agents.consult(this.agentId, { instructions: thread.instructions, options: wanted });
      thread.options = wanted;
    }
    const session = thread.session;
    // 答えの形の指定（Codex の outputSchema）は、ほかのエージェントでは文で頼む
    const text = params.input.map((i) => i.text).join("\n\n") + (params.outputSchema ? `\n\n答えは、次の JSON Schema に合う JSON だけを返してください（前後に文を書かない）。\n${JSON.stringify(params.outputSchema)}` : "");
    const abort = new AbortController();
    let first = true;
    const timer = setTimeout(() => abort.abort(), options.timeoutMs);
    const done = session
      .ask(text, {
        signal: abort.signal,
        onDelta: (d) => {
          options.onDelta?.(d, first);
          first = false;
        },
        onThought: () => options.onProgress?.("reasoning"),
      })
      .then((r) => {
        clearTimeout(timer);
        if (r.reason === "cancelled") throw cancelled();
        if (r.reason === "failed") throw new AiError(r.error ?? "AI の相談が失敗しました", "ENGINE_FAILED", 502);
        if (r.reason === "refused") throw new AiError("AI が答えるのを断りました", "REFUSED", 422);
        return { text: r.text };
      });
    return {
      done,
      interrupt: async () => {
        abort.abort();
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.threads.values()) void t.session?.close().catch(() => undefined);
    this.threads.clear();
  }
}
