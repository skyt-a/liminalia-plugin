import type { StudioContext, StudioViewInstance } from "@liminalia/sdk/studio";
import { ACTION_LABELS, NEEDS_INSTRUCTION, REPLACE_ONLY, type ActionId, type AiSettings, type Effort, type RunResult } from "../protocol.ts";
import { controller, message, type Controller, type Entry } from "./controller.ts";
import { STYLE } from "./style.ts";

type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;

/** 要素を作る（制作画面の h と同じ使い方の小さなもの）。 */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}

const EFFORT_NAMES: Record<string, string> = { none: "なし", minimal: "最小", low: "浅い", medium: "ふつう", high: "深い", xhigh: "とても深い", max: "最大", ultra: "限界まで" };

function injectStyle(): void {
  if (document.getElementById("liminalia-ai-style")) return;
  document.head.append(h("style", { id: "liminalia-ai-style" }, STYLE));
}

/**
 * シナリオ執筆のタブの右の欄の「AI 相談」。書いている台本の選んだ行（無ければカーソルの行）を対象に、
 * 決まった操作か自由な相談を頼み、案は置き換え・足す・別案・破棄を選ぶ。反映は ctx.script.apply（⌘Z で戻せる）。
 */
export function mountPane(el: HTMLElement, ctx: StudioContext): StudioViewInstance {
  injectStyle();
  const c = controller(ctx);
  const root = h("div", { class: "lai" });
  el.append(root);

  const statusLine = h("div", { class: "lai-status" });
  const settings = h("div", { class: "lai-settings", hidden: true });
  const target = h("div", { class: "lai-target" });
  const actions = h(
    "div",
    { class: "lai-actions" },
    ...(Object.keys(ACTION_LABELS) as ActionId[]).map((id) =>
      h(
        "button",
        {
          type: "button",
          class: "ghost",
          "data-action": id,
          title: NEEDS_INSTRUCTION.includes(id) ? "下の欄にやりたいこと（例: 画面を揺らしてから暗転）を書いてから押す" : "",
          onclick: () => {
            // やりたいことが要る操作で欄が空なら、送らずに欄へ案内する
            if (NEEDS_INSTRUCTION.includes(id) && !input.value.trim()) {
              input.placeholder = "やりたいことを書いてから、もう一度「やりたいことから命令」を押してください（例: 画面を揺らしてから暗転）";
              input.focus();
              return;
            }
            void c.run("action", { action: id, ...instruction() });
          },
        },
        ACTION_LABELS[id],
      ),
    ),
  );
  const feed = h("div", { class: "lai-feed" });
  const input = h("textarea", { class: "lai-input", rows: "2", placeholder: "相談を書く（⌘Enter で送る）。操作のボタンを押すと、ここに書いたものを指示として添えます" });
  const send = h("button", { type: "button", class: "primary", onclick: () => submit() }, "送る");
  const stop = h("button", { type: "button", class: "ghost", onclick: () => c.stop() }, "止める");
  const reset = h("button", { type: "button", class: "ghost", title: "この台本の相談の続きを捨てて、新しく始める", onclick: () => void resetChat() }, "やり直す");
  root.append(statusLine, settings, target, actions, feed, input, h("div", { class: "lai-row" }, reset, h("span", { class: "lai-spacer" }), stop, send));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  /** 操作に添える指示（欄に書いたもの。送ったら空にする）。 */
  function instruction(): { instruction?: string } {
    const text = input.value.trim();
    if (!text) return {};
    input.value = "";
    return { instruction: text };
  }

  function submit(): void {
    const text = input.value.trim();
    if (!text || c.running) return;
    input.value = "";
    void c.run("chat", { message: text });
  }

  async function resetChat(): Promise<void> {
    const t = c.target();
    if (!t || c.running) return;
    try {
      await c.reset(t.file);
    } catch (e) {
      ctx.notify(message(e));
    }
  }

  function renderStatus(): void {
    const s = c.status;
    statusLine.replaceChildren(
      h("span", { class: `lai-dot ${s?.connected ? "on" : c.status || c.statusError ? "off" : ""}` }),
      h("span", { class: "lai-status-text" }, !s ? (c.statusError ? `繋がりません: ${c.statusError}` : "接続を確かめています…") : s.connected ? `${s.provider.label}・${s.models.find((m) => m.id === s.model)?.displayName ?? s.model}・${EFFORT_NAMES[s.effort] ?? s.effort}` : `${s.provider.label}: ${s.error || "繋がっていません"}`),
      h("button", { type: "button", class: "ghost", title: "接続し直す", onclick: () => void c.refreshStatus() }, "↻"),
      h("button", { type: "button", class: "ghost", title: "接続先・モデル・資料", onclick: () => toggleSettings() }, "設定"),
    );
  }

  function toggleSettings(): void {
    settings.hidden = !settings.hidden;
    if (!settings.hidden) renderSettings();
  }

  function renderSettings(): void {
    const s = c.status;
    if (!s) {
      settings.replaceChildren(h("p", {}, "接続の様子を読み込み中です"));
      return;
    }
    const provider = h("select", {}, ...s.providers.map((p) => h("option", { value: p.id, ...(p.id === s.provider.id ? { selected: true } : {}) }, p.label)));
    const model = h("select", {});
    const effort = h("select", {});
    const tier = h("select", {});
    // 一覧は今の接続先のモデルだけなので、別の接続先を選んだらモデルは既定にする（保存もそう送る）
    const models = () => (provider.value === s.provider.id ? s.models : []);
    const listModels = () => {
      model.replaceChildren(h("option", { value: "" }, "既定"), ...models().map((m) => h("option", { value: m.id, ...(m.id === s.model ? { selected: true } : {}) }, m.displayName)));
    };
    const fill = () => {
      const m = models().find((x) => x.id === model.value) ?? models().find((x) => x.isDefault);
      const list = m?.supportedReasoningEfforts.length ? m.supportedReasoningEfforts : ["low", "medium", "high"];
      effort.replaceChildren(...list.map((e) => h("option", { value: e, ...(e === s.effort ? { selected: true } : {}) }, EFFORT_NAMES[e] ?? e)));
      tier.replaceChildren(h("option", { value: "" }, "ふつう"), ...(m?.serviceTiers ?? []).map((t) => h("option", { value: t.id, ...(t.id === s.serviceTier ? { selected: true } : {}) }, t.name)));
      tier.disabled = !m?.serviceTiers.length;
    };
    model.addEventListener("change", fill);
    provider.addEventListener("change", () => {
      listModels();
      fill();
    });
    listModels();
    fill();
    const refs = h("input", { type: "text", value: s.references.join(", "), placeholder: "data, docs/characters" });
    const save = h(
      "button",
      {
        type: "button",
        class: "primary",
        onclick: async () => {
          const next: Partial<AiSettings> = {
            provider: provider.value,
            model: provider.value === s.provider.id ? model.value : "",
            effort: effort.value as Effort,
            serviceTier: tier.value,
            references: refs.value.split(/[,、\n]/).map((r) => r.trim()).filter(Boolean),
          };
          save.disabled = true;
          try {
            await c.saveSettings(next);
            settings.hidden = true;
          } catch (e) {
            ctx.notify(message(e));
          } finally {
            save.disabled = false;
          }
        },
      },
      "保存",
    );
    const field = (label: string, control: HTMLElement) => h("label", { class: "lai-field" }, h("span", {}, label), control);
    settings.replaceChildren(
      ...[
      field("接続先", provider),
      field("モデル", model),
      field("推論の深さ", effort),
      field("速度", tier),
      field("正本の資料（作品のフォルダからのパス）", refs),
      s.binary ? h("p", { class: "lai-hint" }, `${s.binary}${s.version ? `（${s.version}）` : ""}`) : null,
      h("div", { class: "lai-row" }, h("span", { class: "lai-spacer" }), save),
      ].filter((n) => n !== null),
    );
  }

  function renderTarget(): void {
    const t = c.target();
    target.textContent = t ? `${t.file}.lim の ${t.from === t.to ? `${t.from} 行目` : `${t.from}〜${t.to} 行目`}を対象にします` : "台本を開くと相談できます";
  }

  function renderFeed(): void {
    const t = c.target();
    const history = c.history(t?.file ?? null);
    const items: Node[] = [];
    if (history.length === 0 && !c.running) items.push(h("p", { class: "lai-welcome" }, "選んだ行（無ければカーソルの行）と正本の資料をもとに相談できます。AI は台本を直接は変えません。"));
    for (const entry of history) items.push(entry.kind === "message" ? messageView(entry) : resultView(entry, t?.file ?? ""));
    if (c.running) {
      items.push(
        h(
          "div",
          { class: "lai-msg assistant pending" },
          h("div", { class: "lai-phase" }, `${c.running.label}: ${c.running.phase || "始めています…"}`),
          c.running.text ? h("div", { class: "lai-text" }, c.running.text) : null,
        ),
      );
    }
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    feed.replaceChildren(...items);
    if (atBottom || c.running) feed.scrollTop = feed.scrollHeight;
    for (const b of actions.querySelectorAll("button")) (b as HTMLButtonElement).disabled = Boolean(c.running) || !t;
    send.disabled = Boolean(c.running) || !t;
    stop.hidden = !c.running;
    reset.disabled = Boolean(c.running) || !t;
  }

  function messageView(entry: Extract<Entry, { kind: "message" }>): HTMLElement {
    return h("div", { class: `lai-msg ${entry.role}` }, h("div", { class: "lai-text" }, entry.text));
  }

  function resultView(entry: Extract<Entry, { kind: "result" }>, file: string): HTMLElement {
    const r: RunResult = entry.result;
    const action = entry.request.action;
    const kind = r.type === "issues" ? "整合性チェック" : action ? ACTION_LABELS[action] : "案";
    const card = h(
      "article",
      { class: `lai-card${entry.applied ? " applied" : ""}` },
      h("header", {}, h("b", {}, kind), r.akaire?.reviewed ? h("span", { class: "lai-badge" }, "校閲済み") : null, h("span", { class: "lai-meta" }, `${r.source.from === r.source.to ? `${r.source.from} 行目` : `${r.source.from}〜${r.source.to} 行目`}・${r.model}`)),
      r.text ? h("div", { class: "lai-text" }, r.text) : null,
    );
    if (r.type === "issues") {
      card.append(
        r.issues.length === 0
          ? h("p", { class: "lai-hint" }, "矛盾は見つかりませんでした")
          : h(
              "ul",
              { class: "lai-issues" },
              ...r.issues.map((i) =>
                h(
                  "li",
                  { class: i.severity },
                  i.line ? h("button", { type: "button", class: "ghost lai-line", onclick: () => ctx.openScript(r.source.file, i.line!) }, `${i.line} 行目`) : null,
                  h("b", {}, i.title),
                  h("div", {}, i.detail),
                ),
              ),
            ),
      );
    }
    if (r.lim) card.append(h("pre", { class: "lai-lim" }, r.lim));
    if (r.warnings.length > 0) card.append(h("ul", { class: "lai-warnings" }, ...r.warnings.map((w) => h("li", {}, `${w.line ? `${w.line} 行目: ` : ""}${w.message}`))));
    const buttons = h("div", { class: "lai-row" });
    if (r.lim) {
      const replaceOnly = action ? REPLACE_ONLY.includes(action) : false;
      if (!replaceOnly) buttons.append(h("button", { type: "button", class: "primary", disabled: entry.applied, onclick: () => c.apply(entry, "insert") }, entry.applied ? "反映済み" : "後ろに足す"));
      buttons.append(h("button", { type: "button", class: replaceOnly ? "primary" : "ghost", disabled: entry.applied, onclick: () => c.apply(entry, "replace") }, entry.applied && replaceOnly ? "反映済み" : "置き換える"));
    }
    if (entry.request.mode === "action") buttons.append(h("button", { type: "button", class: "ghost", disabled: Boolean(c.running), onclick: () => void c.run("action", { replay: entry.request }) }, "別案"));
    buttons.append(h("span", { class: "lai-spacer" }), h("button", { type: "button", class: "ghost", onclick: () => c.discard(file, entry) }, "消す"));
    card.append(buttons);
    return card;
  }

  const render = () => {
    renderStatus();
    renderTarget();
    renderFeed();
  };
  c.onChange(render);
  ctx.script.onChange(() => {
    renderTarget();
    renderFeed();
  });
  render();
  if (!c.status) void c.refreshStatus();
  return {
    show: () => {
      render();
      if (!c.status?.connected) void c.refreshStatus();
    },
  };
}
