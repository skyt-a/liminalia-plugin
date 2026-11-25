import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REASONING_EFFORTS, type AiSettings, type AiStatus, type Effort, type ModelInfo, type RunEvent, type RunRequest, type RunResult, type ResultSource } from "../protocol.ts";
import { AgyClient } from "./agy.ts";
import { AiError, type AiClient, type RawModel, type TurnHandle } from "./client.ts";
import { CodexClient } from "./codex.ts";
import { checkExpansion, checkProofread, extractLim, isText, lineKind, lintProposal, safeJson, withoutFence } from "./lim.ts";
import { akairePrompt, buildContext, commandGuide, CONSISTENCY_SCHEMA, DEVELOPER_INSTRUCTIONS, makePrompt, type CommandInfo, type Context, type ProjectPaths } from "./prompt.ts";
import { PROVIDERS, providerById, resolveBinary, spawnEnvironment } from "./providers.ts";

/** 一回の相談の上限（案と、その自己点検を合わせて）。 */
export const RUN_TIMEOUT = 5 * 60 * 1000;
/** 自己点検の上限。 */
const REVIEW_TIMEOUT = 60 * 1000;
/** モデルの一覧を覚えておく時間。 */
const MODELS_TTL = 60 * 1000;

const DEFAULT_SETTINGS: AiSettings = { provider: "codex", model: "", effort: "medium", serviceTier: "", references: ["data"] };

function efforts(model: RawModel | undefined): string[] {
  return (model?.supportedReasoningEfforts ?? []).map((e) => (typeof e === "string" ? e : (e.reasoningEffort ?? ""))).filter((e) => (REASONING_EFFORTS as readonly string[]).includes(e));
}

function effortFor(model: RawModel | undefined, wanted: string): string {
  const supported = efforts(model);
  if (supported.length === 0 || supported.includes(wanted)) return wanted;
  if (model?.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) return model.defaultReasoningEffort;
  return supported.includes("medium") ? "medium" : supported[0]!;
}

/** 自己点検は深く考えすぎない（高い深さなら medium に下げる）。 */
function reviewEffort(model: RawModel | undefined, wanted: string): string {
  return effortFor(model, ["high", "xhigh", "max", "ultra"].includes(wanted) ? "medium" : wanted);
}

function tiers(model: RawModel | undefined): ModelInfo["serviceTiers"] {
  const advertised = model?.serviceTiers?.length ? model.serviceTiers : (model?.additionalSpeedTiers ?? []);
  const seen = new Set<string>();
  return advertised
    .map((t) => (typeof t === "string" ? { id: t, name: t, description: "" } : { id: String(t.id ?? ""), name: String(t.name ?? t.id ?? ""), description: String(t.description ?? "") }))
    .filter((t) => t.id && !seen.has(t.id) && seen.add(t.id));
}

function tierFor(model: RawModel | undefined, wanted: string): string {
  const list = tiers(model);
  if (!wanted || list.length === 0) return "";
  if (list.some((t) => t.id === wanted)) return wanted;
  return list.some((t) => t.id === model?.defaultServiceTier) ? String(model?.defaultServiceTier) : "";
}

function execText(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => execFile(file, [...args], { encoding: "utf8", timeout: 5000, env }, (e, stdout) => resolve(e ? "" : String(stdout).trim())));
}

/**
 * AI 相談（LIMINAL Forge の AiService を Liminalia に移したもの）。接続先の CLI を一つ起こしておき、
 * 相談（会話は台本ごとに続ける）と決まった操作を流す。台本の案はかならず Akaire の自己点検を通してから返す。
 * 設定は stateDir の settings.json に覚える。
 */
/** エンジンの開発サーバー側の口（ctx.commands・ctx.check）。古いエンジンには無いので、あれば使う。 */
export interface EngineTools {
  commands?: () => CommandInfo[];
  check?: (file: string, text: string) => { severity: string; line: number; message: string; hint?: string }[];
}

export class AiService {
  /** エンジンの口（studio-server.ts が渡す）。 */
  engine: EngineTools = {};
  private client: AiClient | null = null;
  private clientProvider = "";
  private version = "";
  private binary = "";
  private models: RawModel[] = [];
  private modelsAt = 0;
  /** 台本 → 相談の会話。 */
  private readonly threads = new Map<string, string>();
  private readonly active = new Set<string>();
  private changing = false;
  private disposed = false;

  constructor(
    private readonly project: ProjectPaths,
    private readonly stateDir: () => string,
    /** テストで CLI の代わりを差し込む。 */
    private readonly makeClient: (provider: string, executable: string, env: NodeJS.ProcessEnv) => AiClient = (provider, executable, env) =>
      provider === "agy" ? new AgyClient(executable, env) : new CodexClient(executable, project.root, env),
    private readonly resolve: typeof resolveBinary = resolveBinary,
  ) {}

  settings(): AiSettings {
    const file = join(this.stateDir(), "settings.json");
    let stored: Partial<AiSettings> = {};
    try {
      if (existsSync(file)) stored = JSON.parse(readFileSync(file, "utf8")) as Partial<AiSettings>;
    } catch {
      // 読めなければ既定
    }
    return {
      provider: providerById(String(stored.provider)) ? String(stored.provider) : DEFAULT_SETTINGS.provider,
      model: String(stored.model ?? ""),
      effort: (REASONING_EFFORTS as readonly string[]).includes(String(stored.effort)) ? (stored.effort as Effort) : DEFAULT_SETTINGS.effort,
      serviceTier: String(stored.serviceTier ?? ""),
      references: Array.isArray(stored.references) ? stored.references.filter((r): r is string => typeof r === "string") : DEFAULT_SETTINGS.references,
    };
  }

  private async ensureClient(provider = this.settings().provider): Promise<AiClient> {
    if (this.disposed) throw new AiError("AI との接続は終わっています", "DISPOSED");
    if (this.client && this.clientProvider !== provider) {
      if (this.active.size > 0) throw new AiError("生成中は接続先を変えられません", "BUSY", 409);
      this.drop();
    }
    if (this.client) {
      await this.client.ensureStarted();
      return this.client;
    }
    const p = providerById(provider)!;
    const found = this.resolve(p);
    if (!found.path) throw new AiError(found.error, "NOT_FOUND", 503);
    const env = spawnEnvironment(found.path);
    this.binary = found.path;
    this.version = p.versionArgs.length > 0 ? await execText(found.path, p.versionArgs, env) : "";
    const client = this.makeClient(p.id, found.path, env);
    client.onExit(() => {
      if (this.client === client) this.drop(false);
    });
    this.client = client;
    this.clientProvider = p.id;
    try {
      await client.ensureStarted();
    } catch (e) {
      if (this.client === client) this.drop();
      throw e;
    }
    return client;
  }

  /** 今の接続を捨てる（会話・モデルの一覧も）。 */
  private drop(dispose = true): void {
    if (dispose) this.client?.dispose();
    this.client = null;
    this.clientProvider = "";
    this.threads.clear();
    this.models = [];
    this.modelsAt = 0;
  }

  private async listModels(provider = this.settings().provider, force = false): Promise<RawModel[]> {
    if (!force && this.clientProvider === provider && this.models.length > 0 && Date.now() - this.modelsAt < MODELS_TTL) return this.models;
    const client = await this.ensureClient(provider);
    this.models = await client.listModels();
    this.modelsAt = Date.now();
    return this.models;
  }

  private async requireLogin(client: AiClient): Promise<void> {
    if ((await client.readAccount()).needsLogin) throw new AiError("Codex にログインしていません。ターミナルで codex login を実行してから、接続し直してください。", "NOT_LOGGED_IN", 401);
  }

  async status(): Promise<AiStatus> {
    const s = this.settings();
    const p = providerById(s.provider)!;
    const found = this.resolve(p);
    const base: AiStatus = {
      provider: { id: p.id, label: p.label },
      providers: PROVIDERS.map(({ id, label }) => ({ id, label })),
      connected: false,
      available: Boolean(found.path),
      binary: found.path,
      version: "",
      model: s.model,
      effort: s.effort,
      serviceTier: s.serviceTier,
      references: s.references,
      models: [],
      error: found.error,
    };
    if (!found.path) return base;
    try {
      const client = await this.ensureClient();
      await this.requireLogin(client);
      const models = await this.listModels();
      const selected = models.find((m) => m.id === s.model) ?? models.find((m) => m.isDefault) ?? models[0];
      return {
        ...base,
        connected: true,
        binary: this.binary,
        version: this.version,
        model: selected?.id ?? s.model,
        effort: selected ? effortFor(selected, s.effort) : s.effort,
        serviceTier: selected ? tierFor(selected, s.serviceTier) : s.serviceTier,
        models: models.map((m) => ({
          id: m.id,
          displayName: m.displayName || m.id,
          isDefault: Boolean(m.isDefault),
          defaultReasoningEffort: m.defaultReasoningEffort || "medium",
          supportedReasoningEfforts: efforts(m),
          serviceTiers: tiers(m),
        })),
        error: "",
      };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async updateSettings(next: Partial<AiSettings>): Promise<AiStatus> {
    if (this.active.size > 0 || this.changing) throw new AiError("生成中か、接続先を変えているところです", "BUSY", 409);
    this.changing = true;
    try {
      const current = this.settings();
      const provider = providerById(String(next.provider ?? current.provider));
      if (!provider) throw new AiError("知らない接続先です", "INVALID", 400);
      const references = Array.isArray(next.references) ? next.references.map(String).filter(Boolean) : current.references;
      // 接続先を変えたときは、まず繋がるかを確かめる（繋がらなくても接続先は覚える）
      let models: RawModel[] = [];
      try {
        models = await this.listModels(provider.id);
      } catch {
        models = [];
      }
      const model = String(next.model ?? (provider.id === current.provider ? current.model : ""));
      if (model && models.length > 0 && !models.some((m) => m.id === model)) throw new AiError("使えないモデルです", "INVALID", 400);
      const selected = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0];
      const wanted = String(next.effort ?? current.effort);
      if (!(REASONING_EFFORTS as readonly string[]).includes(wanted)) throw new AiError("推論の深さが正しくありません", "INVALID", 400);
      const effort = effortFor(selected, wanted) as Effort;
      const serviceTier = tierFor(selected, String(next.serviceTier ?? current.serviceTier));
      writeFileSync(join(this.stateDir(), "settings.json"), `${JSON.stringify({ provider: provider.id, model, effort, serviceTier, references } satisfies AiSettings, null, 2)}\n`);
    } finally {
      this.changing = false;
    }
    return this.status();
  }

  /** 台本の相談の続きを捨てる。 */
  reset(file: string): boolean {
    return this.threads.delete(file);
  }

  /** 相談か操作を一つ流す。signal が止まったら生成を止める。 */
  async *run(req: RunRequest, signal: AbortSignal): AsyncGenerator<RunEvent> {
    if (this.changing) throw new AiError("接続先を変え終わるまでお待ちください", "BUSY", 409);
    if (!req.id || this.active.has(req.id)) throw new AiError("実行の id がないか、もう使われています", "INVALID", 400);
    if (req.mode === "chat" && !(req.message ?? "").trim()) throw new AiError("相談の内容を書いてください", "INVALID", 400);
    if (req.mode === "action" && !req.action) throw new AiError("操作がありません", "INVALID", 400);

    const s = this.settings();
    const context = buildContext(this.project, req, s.references);
    const commands = this.engine.commands?.() ?? [];
    // 作品で使える命令はすべて「知っている命令」にする（まだ使っていない標準の命令を、案の警告にしない）
    for (const c of commands) context.commands.add(c.name);
    if (req.action === "command") {
      if (!(req.instruction ?? "").trim()) throw new AiError("やりたいことを指示の欄に書いてください（例: 画面を揺らしてから暗転）", "INVALID", 400);
      if (commands.length > 0) context.text = `${context.text}\n\n## 使える命令（やりたいことに近いものから）\n${commandGuide(commands, req.instruction ?? "")}`;
    }
    const from = Math.max(1, Math.min(req.from, context.lines.length));
    const to = Math.max(from, Math.min(req.to, context.lines.length));
    checkSelection(req, context, from, to);
    const source: ResultSource = { file: req.file, from, to, expect: context.selected };

    // 生成の差分と途中の様子は、待っている間に画面へ流す
    const queue: RunEvent[] = [];
    let wake: (() => void) | null = null;
    const emit = (e: RunEvent) => {
      queue.push(e);
      wake?.();
    };
    let handle: TurnHandle | null = null;
    const stop = () => void handle?.interrupt().catch(() => undefined);
    signal.addEventListener("abort", stop);
    this.active.add(req.id);
    let finished = false;
    let failure: unknown = null;
    void this.generate(req, s, context, source, emit, (h) => {
      handle = h;
      if (signal.aborted) stop();
    })
      .then(
        () => (finished = true),
        (e: unknown) => {
          finished = true;
          failure = e;
        },
      )
      .finally(() => wake?.());
    try {
      yield { type: "start", id: req.id, source };
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (finished) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      if (failure) {
        if (signal.aborted || (failure as AiError).code === "CANCELLED") {
          yield { type: "cancelled", id: req.id };
          return;
        }
        if (req.mode === "chat" && (failure as AiError).code === "CODEX_EXIT") this.threads.delete(req.file);
        throw failure;
      }
    } finally {
      signal.removeEventListener("abort", stop);
      if (!finished) stop();
      this.active.delete(req.id);
    }
  }

  /** 案を選んだ行の後ろに入れた台本をエンジンで検査し、案の中の誤りを返す（行は案の中で 1 から）。エンジンの口が無ければ空。 */
  private checkInserted(req: RunRequest, context: Context, to: number, lim: string): { line: number; message: string; hint?: string }[] {
    if (!this.engine.check) return [];
    const added = lim.split("\n");
    const text = [...context.lines.slice(0, to), ...added, ...context.lines.slice(to)].join("\n");
    return this.engine
      .check(req.file, text)
      .filter((d) => d.severity === "error" && d.line > to && d.line <= to + added.length)
      .map((d) => ({ line: d.line - to, message: d.message, ...(d.hint ? { hint: d.hint } : {}) }));
  }

  private async generate(req: RunRequest, s: AiSettings, context: Context, source: ResultSource, emit: (e: RunEvent) => void, setHandle: (h: TurnHandle) => void): Promise<void> {
    const id = req.id;
    const to = source.to;
    const deadline = Date.now() + RUN_TIMEOUT;
    const phase = (phase: string, message: string) => emit({ type: "phase", id, phase, message });
    phase("connecting", `${providerById(s.provider)!.label} に接続しています…`);
    const client = await this.ensureClient();
    await this.requireLogin(client);
    const models = await this.listModels();
    const model = models.find((m) => m.id === s.model) ?? models.find((m) => m.isDefault) ?? models[0];
    if (!model) throw new AiError("使える AI のモデルがありません", "NO_MODEL", 503);
    const effort = effortFor(model, s.effort);
    const serviceTier = tierFor(model, s.serviceTier);

    let threadId = req.mode === "chat" ? (this.threads.get(req.file) ?? "") : "";
    if (!threadId) {
      phase("thread", "相談を用意しています…");
      threadId = await client.startThread({ cwd: this.project.root, model: model.id, ...(serviceTier ? { serviceTier } : {}), developerInstructions: DEVELOPER_INSTRUCTIONS });
      if (req.mode === "chat") this.threads.set(req.file, threadId);
    }
    phase("generating", ["high", "xhigh", "max", "ultra"].includes(effort) ? "深く考えて答えを作っています…" : "答えを作っています…");
    let reasoning = false;
    const turn = await client.startTurn(
      {
        threadId,
        input: [{ type: "text", text: makePrompt(req, context) }],
        model: model.id,
        effort,
        ...(serviceTier ? { serviceTier } : {}),
        ...(req.action === "consistency" ? { outputSchema: CONSISTENCY_SCHEMA } : {}),
      },
      {
        timeoutMs: Math.max(1, deadline - Date.now()),
        onDelta: (delta, reset) => emit({ type: "delta", id, delta, reset }),
        onProgress: (kind) => {
          if (kind === "reasoning" && !reasoning) {
            reasoning = true;
            phase("reasoning", "文脈を読んで、組み立てを考えています…");
          } else if (kind === "buffering") phase("buffering", "答えを確かめています…");
          else if (kind === "retry") phase("retry", "一時的な問題のため、やり直しています…");
        },
      },
    );
    setHandle(turn);
    let result = buildResult((await turn.done).text, req, context, source);
    if (result.type === "lim" && req.action === "expand") {
      const errors = checkExpansion(context.selected, result.lim, context.speakers);
      if (errors.length > 0) throw new AiError(`膨らませた案が、もとの命令・話者・ラベルを保てませんでした（${errors.slice(0, 3).join("、")}）。もう一度お試しください。`, "EXPANSION_INVALID", 422);
    }
    if (result.type === "lim" && req.action === "command") {
      // 命令だけの案は Akaire の校閲（本文の校正）にかけず、エンジンの検査に通す。誤りがあれば一度だけ直させる
      let errors = this.checkInserted(req, context, to, result.lim);
      if (errors.length > 0 && Date.now() < deadline) {
        phase("checking", "検査で見つかった誤りを直しています…");
        const fix = await client.startTurn(
          {
            threadId,
            input: [{ type: "text", text: ["いまの案を Liminalia の検査にかけたら、次の誤りが出ました。直した命令の行だけを ```lim の囲みで返してください。", ...errors.map((e) => `- 案の ${e.line} 行目: ${e.message}${e.hint ? `（${e.hint}）` : ""}`)].join("\n") }],
            model: model.id,
            effort,
            ...(serviceTier ? { serviceTier } : {}),
          },
          { timeoutMs: Math.max(1, deadline - Date.now()) },
        );
        setHandle(fix);
        const fixed = buildResult((await fix.done).text, req, context, source);
        if (fixed.type === "lim") {
          result = fixed;
          errors = this.checkInserted(req, context, to, result.lim);
        }
      }
      result = { ...result, warnings: [...result.warnings, ...errors.map((e) => ({ line: e.line, message: `検査: ${e.message}` }))] };
    }
    const commandOnly = result.type === "lim" && result.lim.split("\n").every((l) => ["command", "comment", "empty"].includes(lineKind(l, context.speakers)));
    if (result.type === "lim" && req.action === "akaire") result = finishProofread(result, context.selected, context, false, "");
    else if (result.type === "lim" && !(req.action === "command" && commandOnly)) {
      // 案はかならず Akaire の自己点検を通す
      const remaining = Math.min(REVIEW_TIMEOUT, deadline - Date.now());
      if (remaining <= 0) throw new AiError("生成と校閲が 5 分を超えたので止めました", "TIMEOUT", 504);
      emit({ type: "delta", id, delta: "", reset: true });
      phase("akaire", "案を校閲しています…");
      const rEffort = reviewEffort(model, effort);
      const review = await client.startTurn(
        { threadId, input: [{ type: "text", text: akairePrompt(result.lim, context, { automatic: true }) }], model: model.id, effort: rEffort, ...(serviceTier ? { serviceTier } : {}) },
        { timeoutMs: remaining },
      );
      setHandle(review);
      const reviewed = buildResult((await review.done).text, { ...req, action: "akaire" }, context, source);
      result = finishProofread(reviewed, result.lim, context, true, result.text);
    }
    emit({ type: "result", id, result: { ...result, model: model.id, effort } });
  }

  dispose(): void {
    this.disposed = true;
    this.drop();
  }
}

/** 操作が選んだ行に求めるもの（磨く・膨らませる・校正は本文を含む行）。 */
function checkSelection(req: RunRequest, context: Context, from: number, to: number): void {
  if (req.mode !== "action") return;
  const kinds = context.lines.slice(from - 1, to).map((l) => lineKind(l, context.speakers));
  if (req.action === "polish" && !kinds.every((k) => isText(k) || k === "empty")) throw new AiError("地の文か台詞だけの行を選んでください", "SELECTION", 400);
  if ((req.action === "expand" || req.action === "akaire") && !kinds.some(isText)) throw new AiError("本文を含む行を選んでください", "SELECTION", 400);
}

function buildResult(raw: string, req: RunRequest, context: Context, source: ResultSource): RunResult {
  const base: RunResult = { type: "text", text: raw.trim(), lim: "", issues: [], warnings: [], akaire: null, source, model: "", effort: "" };
  const structured = safeJson(raw) as { summary?: unknown; issues?: unknown } | null;
  if (req.action === "consistency" || (structured && Array.isArray(structured.issues))) {
    if (structured && Array.isArray(structured.issues)) return { ...base, type: "issues", text: String(structured.summary ?? ""), issues: structured.issues as RunResult["issues"] };
    return { ...base, type: "issues", warnings: [{ line: null, message: "整合性の結果を読み取れませんでした（答えをそのまま出しています）" }] };
  }
  const lim = extractLim(raw);
  if (!lim) return base;
  return { ...base, type: "lim", text: withoutFence(raw), lim, warnings: lintProposal(lim, context.speakers, context.commands, context.assets) };
}

/** 校閲の結果が行の作りを保っていれば、校閲済みの案にする。保てていなければ、点検していない案を出さずに止める。 */
function finishProofread(candidate: RunResult, original: string, context: Context, automatic: boolean, proposal: string): RunResult {
  const fail = (why: string) => new AiError(`${why} 校閲していない案は出していません。もう一度お試しください。`, "AKAIRE_FAILED", 422);
  if (candidate.type !== "lim" || !candidate.lim) throw fail("校閲した全文を受け取れませんでした。");
  const errors = checkProofread(original, candidate.lim, context.speakers);
  if (errors.length > 0) throw fail(`校閲結果が行の作りを保てませんでした（${errors.slice(0, 3).join("、")}）。`);
  const review = candidate.text.trim() || "全行を監査し、校正案を確かめました。";
  return {
    ...candidate,
    text: automatic ? [proposal.trim() ? `### 案の意図\n${proposal.trim()}` : "", `### 校閲結果\n${review}`].filter(Boolean).join("\n\n") : review,
    akaire: { reviewed: true, automatic, changed: original !== candidate.lim },
  };
}
