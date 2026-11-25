import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent, RunRequest } from "../src/protocol.ts";
import type { AiClient, RawModel, TurnOptions, TurnParams } from "../src/server/client.ts";
import { AiError } from "../src/server/client.ts";
import { AiService } from "../src/server/service.ts";

/** AI 相談の流れ。CLI の代わりに、頼まれた文を覚えて決めた答えを返す偽物を使う。 */

const TEXT = ["# start", "@bg room.webp", "窓の外では雨が上がりかけていた。", "マユ「……来週になる前に」", "景「ああ」"].join("\n");

let dir: string;
let state: string;

/** 答えを順に返す偽物の CLI。answers が尽きたら止めるまで待つ。 */
class FakeClient implements AiClient {
  readonly prompts: string[] = [];
  readonly params: TurnParams[] = [];
  threads = 0;
  interrupted = 0;
  constructor(private readonly answers: string[]) {}
  async ensureStarted() {}
  async listModels(): Promise<RawModel[]> {
    return [{ id: "m1", displayName: "モデル1", isDefault: true, supportedReasoningEfforts: ["low", "medium", "high"] }];
  }
  async readAccount() {
    return { needsLogin: false };
  }
  async startThread() {
    return `t${++this.threads}`;
  }
  async startTurn(params: TurnParams, options: TurnOptions) {
    this.prompts.push(params.input[0]!.text);
    this.params.push(params);
    const answer = this.answers.shift();
    let reject!: (e: Error) => void;
    const done = new Promise<{ text: string }>((res, rej) => {
      reject = rej;
      if (answer !== undefined)
        setTimeout(() => {
          options.onDelta?.(answer, false);
          res({ text: answer });
        }, 1);
    });
    return {
      done,
      interrupt: async () => {
        this.interrupted++;
        reject(new AiError("生成を止めました", "CANCELLED"));
      },
    };
  }
  onExit() {}
  dispose() {}
}

function service(client: FakeClient): AiService {
  return new AiService({ root: dir, paths: { scenario: join(dir, "scenario"), assets: join(dir, "assets"), data: join(dir, "data"), cast: join(dir, "cast.json") } }, () => state, () => client, () => ({ path: "/bin/fake", candidates: [], error: "" }));
}

const request = (over: Partial<RunRequest>): RunRequest => ({ id: `r${Math.random()}`, mode: "action", action: "continue", file: "start", text: TEXT, from: 3, to: 4, ...over });

async function collect(it: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const fence = (lim: string, note = "説明") => `${note}\n\n\`\`\`lim\n${lim}\n\`\`\``;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-ai-"));
  state = join(dir, ".liminalia", "plugins", "ai");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(dir, "scenario"));
  mkdirSync(join(dir, "assets", "bgimage"), { recursive: true });
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "scenario", "start.lim"), TEXT);
  writeFileSync(join(dir, "assets", "bgimage", "room.webp"), "");
  writeFileSync(join(dir, "data", "notebook.json"), JSON.stringify({ マユ: "高校生。新聞部" }));
  writeFileSync(join(dir, "cast.json"), JSON.stringify({ speakers: ["景"], cast: { マユ: { speaker: "マユ", appearances: { default: { variants: { normal: {}, sad: {} } } } } } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("AI 相談", () => {
  it("案は Akaire の自己点検を通してから返し、選んだ行と案を作ったときの中身を出どころに持つ", async () => {
    const client = new FakeClient([fence("マユは顔を上げた。"), fence("マユは顔を上げる。", "修正推奨: 時制をそろえました")]);
    const events = await collect(service(client).run(request({}), new AbortController().signal));
    expect(events[0]).toMatchObject({ type: "start", source: { file: "start", from: 3, to: 4, expect: "窓の外では雨が上がりかけていた。\nマユ「……来週になる前に」" } });
    const result = events.find((e) => e.type === "result")!;
    expect(result).toMatchObject({ result: { type: "lim", lim: "マユは顔を上げる。", akaire: { reviewed: true, automatic: true, changed: true }, model: "m1" } });
    expect(client.prompts).toHaveLength(2);
    // 文脈: 選んだ行・正本の資料・話者・キャスト・素材・使っている命令
    expect(client.prompts[0]).toContain("## 選んだ行（最優先）\n窓の外では雨が上がりかけていた。");
    expect(client.prompts[0]).toContain("data/notebook.json");
    expect(client.prompts[0]).toContain("マユ（話者名 マユ）: default(normal/sad)");
    expect(client.prompts[0]).toContain("bgimage/room.webp");
    expect(client.prompts[0]).toContain("@bg");
    expect(client.prompts[1]).toContain("```lim\nマユは顔を上げた。\n```");
  });

  it("校正は行の作りを保たない案を出さない（話者の書き換え・行数の違い）", async () => {
    const run = (answer: string) => collect(service(new FakeClient([answer])).run(request({ action: "akaire" }), new AbortController().signal));
    await expect(run(fence("窓の外では雨が上がりかけていた。\n景「……来週になる前に」"))).rejects.toMatchObject({ code: "AKAIRE_FAILED", status: 422 });
    await expect(run(fence("窓の外では雨が上がっていた。"))).rejects.toMatchObject({ code: "AKAIRE_FAILED" });
    const ok = await run(fence("窓の外では、雨が上がりかけていた。\nマユ「……来週になる前に」"));
    expect(ok.find((e) => e.type === "result")).toMatchObject({ result: { akaire: { reviewed: true, automatic: false, changed: true } } });
  });

  it("膨らませた案は、もとの命令の行を同じ順で残す", async () => {
    const req = request({ action: "expand", from: 2, to: 3 });
    await expect(collect(service(new FakeClient([fence("雨が上がる。\n窓の外。")])).run(req, new AbortController().signal))).rejects.toMatchObject({ code: "EXPANSION_INVALID" });
  });

  it("磨くのは本文だけの行", async () => {
    await expect(collect(service(new FakeClient([])).run(request({ action: "polish", from: 1, to: 3 }), new AbortController().signal))).rejects.toMatchObject({ status: 400 });
  });

  it("相談は台本ごとに会話を続け、やり直すと新しい会話にする", async () => {
    const client = new FakeClient(["答え1", "答え2", "答え3"]);
    const s = service(client);
    const chat = (message: string) => collect(s.run(request({ mode: "chat", message }), new AbortController().signal));
    expect((await chat("どう思う？")).find((e) => e.type === "result")).toMatchObject({ result: { type: "text", text: "答え1" } });
    await chat("ほかには？");
    expect(client.threads).toBe(1);
    expect(s.reset("start")).toBe(true);
    await chat("もう一度");
    expect(client.threads).toBe(2);
  });

  it("整合性チェックは構造化した答えを issues にする", async () => {
    const client = new FakeClient([JSON.stringify({ summary: "一つ", issues: [{ severity: "warning", line: 4, title: "呼び方", detail: "…" }] })]);
    const events = await collect(service(client).run(request({ action: "consistency" }), new AbortController().signal));
    expect(client.params[0]!.outputSchema).toBeDefined();
    expect(events.find((e) => e.type === "result")).toMatchObject({ result: { type: "issues", text: "一つ", issues: [{ line: 4 }] } });
  });

  it("止めると生成を止め、cancelled で終わる", async () => {
    const client = new FakeClient([]);
    const abort = new AbortController();
    const events: RunEvent[] = [];
    for await (const e of service(client).run(request({}), abort.signal)) {
      events.push(e);
      if (e.type === "phase" && e.phase === "generating") setTimeout(() => abort.abort(), 5);
    }
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
    expect(client.interrupted).toBe(1);
  });

  it("設定を覚え、使えないモデルは断る", async () => {
    const s = service(new FakeClient([]));
    const status = await s.updateSettings({ effort: "high", references: ["data", "docs"] });
    expect(status).toMatchObject({ connected: true, model: "m1", effort: "high", references: ["data", "docs"] });
    await expect(s.updateSettings({ model: "nosuch" })).rejects.toMatchObject({ status: 400 });
  });
  it("やりたいことから命令: 近い命令の仕様を渡し、検査の誤りは一度だけ直させ、命令だけの案は Akaire にかけない", async () => {
    const client = new FakeClient([fence("@quake tim=500ms"), fence("@quake time=500ms\n@mask fade=1s")]);
    const s = service(client);
    const checked: string[] = [];
    s.engine = {
      commands: () => [
        { name: "quake", summary: "画面を揺らす", positional: [], params: { time: { type: { kind: "duration" }, default: "300ms", doc: "揺れる長さ" } }, example: "@quake time=300ms", keywords: ["揺らす"] },
        { name: "mask", summary: "画面を覆う（暗転）", positional: [], params: {}, example: "@mask fade=1s", keywords: ["暗転"] },
        { name: "bgm", summary: "BGM を流す", positional: ["file"], params: {}, example: "@bgm a.ogg" },
      ],
      check: (_file, text) => {
        checked.push(text);
        const lines = text.split("\n");
        return lines.flatMap((l, i) => (l.includes("tim=") ? [{ severity: "error", line: i + 1, message: "引数 tim はありません", hint: "time" }] : []));
      },
    };
    const events = await collect(s.run(request({ action: "command", instruction: "画面を揺らしてから暗転" }), new AbortController().signal));
    const result = events.find((e) => e.type === "result")!;
    expect(result).toMatchObject({ result: { type: "lim", lim: "@quake time=500ms\n@mask fade=1s", akaire: null, warnings: [] } });
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[0]).toContain("### @quake");
    expect(client.prompts[0]).toContain("time= duration（既定 300ms） 揺れる長さ");
    expect(client.prompts[0]!.indexOf("### @quake")).toBeLessThan(client.prompts[0]!.indexOf("@bgm"));
    expect(client.prompts[1]).toContain("案の 1 行目: 引数 tim はありません（time）");
    // 選んだ行（3〜4 行目）の後ろに入れた台本で検査する
    expect(checked[0]!.split("\n")[4]).toBe("@quake tim=500ms");
  });

  it("やりたいことから命令は、指示が無ければ頼まない", async () => {
    await expect(collect(service(new FakeClient([])).run(request({ action: "command" }), new AbortController().signal))).rejects.toMatchObject({ status: 400 });
  });
});
