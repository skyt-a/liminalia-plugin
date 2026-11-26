import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../src/protocol.ts";
import { modelsFromOptions, type EngineAgentOption, type EngineAgents } from "../src/server/engine.ts";
import { AiService } from "../src/server/service.ts";

/** エンジンの AI のエージェント（ctx.agents）を使う接続先。偽のエンジンで流す。 */

const TEXT = ["# start", "@bg room.webp", "窓の外では雨が上がりかけていた。", "マユ「……来週になる前に」", "景「ああ」"].join("\n");
let dir: string;

const CODEX: EngineAgentOption[] = [
  { id: "model", name: "Model", category: "model", current: "a", choices: [{ value: "a", name: "A" }, { value: "b", name: "B" }] },
  { id: "effort", name: "Effort", category: "model_config", current: "high", choices: [], dependsOn: { option: "model", choices: { a: [{ value: "low", name: "low" }, { value: "high", name: "high" }], b: [{ value: "medium", name: "medium" }] }, current: { a: "high", b: "medium" } } },
];
const AGY: EngineAgentOption[] = [
  { id: "model", name: "Model", category: "model", current: "g-high", choices: [{ value: "g-high", name: "G (High)" }, { value: "g-low", name: "G (Low)" }] },
  { id: "thought_level", name: "Thought", current: "high", choices: [{ value: "low", name: "low" }, { value: "high", name: "high" }] },
  { id: "mode", name: "Mode", category: "mode", current: "default", choices: [{ value: "default", name: "Default" }] },
];

function fakeEngine() {
  const calls: { id: string; options?: Record<string, string>; prompts: string[] }[] = [];
  const agents: EngineAgents = {
    list: async () => [{ id: "codex", name: "Codex", protocol: "codex" }, { id: "acp:antigravity", name: "Antigravity", protocol: "acp" }],
    options: async (id) => (id === "codex" ? CODEX : AGY),
    consult: async (id, o) => {
      const call = { id, ...(o.options ? { options: o.options } : {}), prompts: [] as string[] };
      calls.push(call);
      return {
        ask: async (prompt, a) => {
          call.prompts.push(prompt);
          const text = "説明\n\n```lim\nマユ「晴れたね」\n```";
          a?.onDelta?.(text);
          return { text, reason: "done" };
        },
        close: async () => undefined,
      };
    },
  };
  return { agents, calls };
}

async function collect(it: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "liminalia-ai-engine-"));
  mkdirSync(join(dir, "scenario"));
  mkdirSync(join(dir, "data"));
  mkdirSync(join(dir, "state"));
  writeFileSync(join(dir, "scenario", "start.lim"), TEXT);
  writeFileSync(join(dir, "cast.json"), JSON.stringify({ speakers: ["マユ", "景"], cast: {} }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = (agents: EngineAgents) => {
  const s = new AiService({ root: dir, paths: { scenario: join(dir, "scenario"), assets: join(dir, "assets"), data: join(dir, "data"), cast: join(dir, "cast.json") } }, () => join(dir, "state"));
  s.agents = agents;
  return s;
};

describe("エンジンのエージェント", () => {
  it("項目をモデル・深さの形に直す（深さがモデルに入っているものは深さを出さない）", () => {
    expect(modelsFromOptions(CODEX).map((m) => [m.id, m.isDefault, m.supportedReasoningEfforts])).toEqual([["a", true, ["low", "high"]], ["b", false, ["medium"]]]);
    expect(modelsFromOptions(AGY).map((m) => [m.id, m.supportedReasoningEfforts])).toEqual([["g-high", ["low", "high"]], ["g-low", ["low", "high"]]]);
  });

  it("接続先はエンジンの一覧になり、選んだモデルと深さで相談する", async () => {
    const { agents, calls } = fakeEngine();
    const s = make(agents);
    const status = await s.status();
    expect(status.providers.map((p) => p.id)).toEqual(["engine:codex", "engine:acp:antigravity"]);
    expect(status.connected).toBe(true);
    await s.updateSettings({ provider: "engine:codex", model: "b", effort: "medium" });
    const events = await collect(s.run({ id: "r1", mode: "action", action: "continue", file: "start", text: TEXT, from: 3, to: 4 }, new AbortController().signal));
    expect(events.some((e) => e.type === "result")).toBe(true);
    expect(calls[0]).toMatchObject({ id: "codex", options: { model: "b", effort: "medium" } });
  });

  it("Antigravity の深さ（thought_level）は、その項目の名前で渡す", async () => {
    const { agents, calls } = fakeEngine();
    const s = make(agents);
    await s.status();
    await s.updateSettings({ provider: "engine:acp:antigravity", model: "g-low", effort: "low" });
    await collect(s.run({ id: "r2", mode: "action", action: "continue", file: "start", text: TEXT, from: 3, to: 4 }, new AbortController().signal));
    expect(calls[0]).toMatchObject({ id: "acp:antigravity", options: { model: "g-low", thought_level: "low" } });
  });
});
