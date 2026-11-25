import type { StudioContext } from "@liminalia/sdk/studio";
import { ACTION_LABELS, type ActionId, type AiSettings, type AiStatus, type RunEvent, type RunRequest, type RunResult } from "../protocol.ts";

/** 欄に並べるもの。 */
export type Entry =
  | { kind: "message"; role: "user" | "assistant" | "error"; text: string }
  | { kind: "result"; request: RunRequest; result: RunResult; applied: boolean };

/** 生成中の様子。 */
export interface Running {
  id: string;
  label: string;
  phase: string;
  text: string;
}

/**
 * 相談の状態（台本ごとの履歴・生成中の様子・接続の様子）。右の欄と操作のメニューの両方から使うので、欄とは別に一つだけ持つ。
 * 履歴は制作画面を開いている間だけ覚える。
 */
export class Controller {
  status: AiStatus | null = null;
  statusError = "";
  running: Running | null = null;
  private abort: AbortController | null = null;
  private readonly histories = new Map<string, Entry[]>();
  private readonly listeners = new Set<() => void>();

  constructor(readonly ctx: StudioContext) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  history(file: string | null): Entry[] {
    if (!file) return [];
    let h = this.histories.get(file);
    if (!h) this.histories.set(file, (h = []));
    return h;
  }

  async refreshStatus(): Promise<void> {
    try {
      this.status = await this.ctx.server<AiStatus>("/status");
      this.statusError = "";
    } catch (e) {
      this.statusError = message(e);
    }
    this.changed();
  }

  async saveSettings(next: Partial<AiSettings>): Promise<void> {
    this.status = await this.ctx.server<AiStatus>("/settings", { body: next });
    this.statusError = "";
    this.changed();
  }

  /** 選んだ行（選んでいなければカーソルの行）。範囲の終わりが行の頭なら、その行は含めない。 */
  target(): { file: string; from: number; to: number; text: string } | null {
    const at = this.ctx.script.current();
    const text = this.ctx.script.text();
    if (!at || text === null) return null;
    if (!at.selection) return { file: at.file, from: at.line, to: at.line, text };
    const { from, to } = at.selection;
    const last = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
    return { file: at.file, from: from.line, to: last, text };
  }

  /** 相談か操作を流す。生成中なら何もしない。 */
  async run(mode: "chat" | "action", options: { action?: ActionId; message?: string; instruction?: string; replay?: RunRequest } = {}): Promise<void> {
    if (this.running) return;
    const t = this.target();
    if (!t && !options.replay) {
      this.ctx.notify("台本を開いてから相談してください");
      return;
    }
    const base = options.replay ?? { mode, file: t!.file, text: t!.text, from: t!.from, to: t!.to, ...(options.action ? { action: options.action } : {}), ...(options.message ? { message: options.message } : {}), ...(options.instruction ? { instruction: options.instruction } : {}) };
    // 別案は、そのときの本文で作り直す（選んだ行は同じ）
    const fresh = options.replay ? { ...base, text: this.ctx.script.text() ?? base.text } : base;
    const request: RunRequest = { ...fresh, id: crypto.randomUUID() } as RunRequest;
    const history = this.history(request.file);
    if (mode === "chat" && options.message) history.push({ kind: "message", role: "user", text: options.message });
    const label = request.mode === "chat" ? "相談" : ACTION_LABELS[request.action!];
    this.running = { id: request.id, label, phase: "", text: "" };
    this.abort = new AbortController();
    this.changed();
    try {
      for await (const ev of this.ctx.stream<RunEvent>("/run", { body: request, signal: this.abort.signal })) {
        if (!this.running) break;
        if (ev.type === "phase") this.running.phase = ev.message;
        else if (ev.type === "delta") this.running.text = ev.reset ? ev.delta : this.running.text + ev.delta;
        else if (ev.type === "result") {
          history.push(ev.result.type === "text" ? { kind: "message", role: "assistant", text: ev.result.text } : { kind: "result", request, result: ev.result, applied: false });
        } else if (ev.type === "cancelled") history.push({ kind: "message", role: "error", text: "生成を止めました" });
        this.changed();
      }
    } catch (e) {
      if (!this.abort?.signal.aborted) history.push({ kind: "message", role: "error", text: message(e) });
    } finally {
      this.running = null;
      this.abort = null;
      this.changed();
    }
  }

  stop(): void {
    this.abort?.abort();
  }

  /** 案を台本に当てる。insert なら選んだ行の後ろに足し、ほかは選んだ行と置き換える。 */
  apply(entry: Extract<Entry, { kind: "result" }>, how: "replace" | "insert"): void {
    const s = entry.result.source;
    const edit =
      how === "replace"
        ? { file: s.file, from: s.from, to: s.to, expect: s.expect, text: entry.result.lim }
        : // 足すときも、選んだ行がそのままかを確かめる（その行を同じ中身で書き直し、後ろに足す）
          { file: s.file, from: s.from, to: s.to, expect: s.expect, text: `${s.expect}\n${entry.result.lim}` };
    const r = this.ctx.script.apply([edit]);
    if (r.ok) {
      entry.applied = true;
      this.ctx.notify(how === "replace" ? "AI の案で置き換えました（⌘Z で戻せます）" : "AI の案を足しました（⌘Z で戻せます）");
    } else if (r.reason === "not-open") this.ctx.notify(`${s.file}.lim を開いてから反映してください`);
    else if (r.reason === "changed") this.ctx.notify("案を作った後に、その行が書き換えられています。もう一度作り直してください");
    else if (r.reason === "readonly") this.ctx.notify("この台本はまだ書き換えられません");
    else this.ctx.notify("反映できませんでした");
    this.changed();
  }

  discard(file: string, entry: Entry): void {
    const h = this.history(file);
    const i = h.indexOf(entry);
    if (i >= 0) h.splice(i, 1);
    this.changed();
  }

  async reset(file: string): Promise<void> {
    await this.ctx.server("/reset", { body: { file } });
    this.histories.set(file, []);
    this.changed();
  }
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

let shared: Controller | null = null;
/** 一つだけの状態（はじめて使う欄か操作の ctx で作る）。 */
export function controller(ctx: StudioContext): Controller {
  return (shared ??= new Controller(ctx));
}
