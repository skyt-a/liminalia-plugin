import type { StudioCommand, StudioPlugin } from "@liminalia/sdk/studio";
import { controller } from "./client/controller.ts";
import { mountPane } from "./client/pane.ts";
import { ACTION_LABELS, NEEDS_INSTRUCTION, type ActionId } from "./protocol.ts";

/**
 * AI 相談の制作画面側。シナリオ執筆のタブの右の欄に「AI 相談」を足し、決まった操作を「その他」のメニューにも並べる
 * （メニューから頼んだものも、結果は右の欄に出る）。@liminalia/studio は型だけを読む。
 */
// 指示の欄に書くことが要る操作（やりたいことから命令）は、右の欄からだけ頼む
const commands: StudioCommand[] = (Object.keys(ACTION_LABELS) as ActionId[]).filter((id) => !NEEDS_INSTRUCTION.includes(id)).map((id) => ({
  id: `ai-${id}`,
  title: `AI: ${ACTION_LABELS[id]}`,
  run: (ctx) => {
    const c = controller(ctx);
    if (c.running) return ctx.notify("AI が答えを作っているところです");
    void c.run("action", { action: id }).then(() => ctx.notify(`AI の「${ACTION_LABELS[id]}」が終わりました（右の欄の AI 相談）`));
  },
}));

const plugin: StudioPlugin = {
  name: "ai",
  panes: [{ id: "ai-consult", title: "AI 相談", mount: mountPane }],
  commands,
};

export default plugin;
