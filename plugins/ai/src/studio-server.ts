import type { StudioServerContext, StudioServerPlugin } from "@liminalia/sdk/studio-server";
import type { AiSettings, RunRequest } from "./protocol.ts";
import { AiError } from "./server/client.ts";
import { AiService } from "./server/service.ts";

/**
 * AI 相談の開発サーバー側。エンジンが AI のエージェントの口（ctx.agents）を持っていればそれを使い、無ければ接続先の CLI（Codex・agy）を
 * 自前で起こす。相談と決まった操作を流す。口は ./protocol.ts。
 * @liminalia/studio は型だけを読む（作品の外に置いても、エンジンを読まずに動くように）。
 */
let service: AiService | null = null;

function aiService(ctx: StudioServerContext): AiService {
  service ??= new AiService({ root: ctx.root, paths: ctx.paths }, () => ctx.stateDir());
  // 命令の仕様と検査は、エンジンが口を持っていれば使う（古いエンジンでは無い）
  const engine = ctx as Partial<Pick<StudioServerContext, "commands" | "check">>;
  // AI のエージェントは、エンジンが口を持っていれば（口の版 6 から）それを使う。無ければ自前で Codex と agy を起こす
  const agents = (ctx as { agents?: unknown }).agents;
  service.agents = agents && typeof agents === "object" ? (agents as AiService["agents"]) : null;
  service.engine = {
    ...(typeof engine.commands === "function" ? { commands: () => engine.commands!.call(ctx) } : {}),
    ...(typeof engine.check === "function" ? { check: (file: string, text: string) => engine.check!.call(ctx, file, text) } : {}),
  };
  return service;
}

function isRunRequest(v: unknown): v is RunRequest {
  const r = v as Partial<RunRequest> | null;
  return (
    !!r &&
    typeof r.id === "string" &&
    (r.mode === "chat" || r.mode === "action") &&
    typeof r.file === "string" &&
    typeof r.text === "string" &&
    Number.isInteger(r.from) &&
    Number.isInteger(r.to)
  );
}

const plugin: StudioServerPlugin = {
  name: "ai",
  routes: {
    "GET /status": (_req, ctx) => aiService(ctx).status(),
    "POST /settings": async (req, ctx) => aiService(ctx).updateSettings((await req.json<Partial<AiSettings>>()) ?? {}),
    "POST /run": async (req, ctx) => {
      const body = await req.json();
      if (!isRunRequest(body)) throw new AiError("id・mode・file・text・from・to を送ってください", "INVALID", 400);
      return aiService(ctx).run(body, req.signal);
    },
    "POST /reset": async (req, ctx) => {
      const body = await req.json<{ file?: unknown }>();
      if (typeof body?.file !== "string") throw new AiError("file を送ってください", "INVALID", 400);
      return { reset: aiService(ctx).reset(body.file) };
    },
  },
  dispose() {
    service?.dispose();
    service = null;
  },
};

export default plugin;
