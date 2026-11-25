/**
 * 台本（.lim）の行の見分けと、AI の案の点検。エンジンの解析器は読まず（作品の外のプラグインなので）、行頭だけで見分ける。
 * 書式は Liminalia の docs/design/format.md の「3. 形式」。
 */

export type LineKind = "command" | "label" | "comment" | "empty" | "dialogue" | "prose";

/** 台詞の括弧。 */
const OPEN = ["「", "『", "（", "("];

/** 行の種類。speakers は作品の話者名（cast.json の speakers とキャストの speaker）。 */
export function lineKind(line: string, speakers: readonly string[]): LineKind {
  // 行頭の ASCII の空白とタブは字下げ（全角空白は本文）
  const s = line.replace(/^[ \t]+/, "");
  if (s === "") return "empty";
  if (s.startsWith("\\")) return "prose";
  if (s.startsWith("@")) return "command";
  if (s.startsWith("#")) return "label";
  if (s.startsWith("//")) return "comment";
  if (speakers.some((name) => s.startsWith(name) && OPEN.some((o) => s.startsWith(o, name.length)))) return "dialogue";
  return "prose";
}

export const isText = (kind: LineKind) => kind === "dialogue" || kind === "prose";

/** 台詞の話者名（台詞でなければ null）。 */
function speakerOf(line: string, speakers: readonly string[]): string | null {
  const s = line.replace(/^[ \t]+/, "");
  return [...speakers].sort((a, b) => b.length - a.length).find((name) => s.startsWith(name) && OPEN.some((o) => s.startsWith(o, name.length))) ?? null;
}

/** 本文の中の、流れにかかわる書き方（命令 {@…}・クリック待ち {click}・改行 {br}・値 {= …}）。飾り（ルビ・太字など）は直してよい。 */
function flowMarks(line: string): string[] {
  return line.match(/\{(?:@[^}]*|click|br|=[^}]*)\}/g) ?? [];
}

/** 案の中の ```lim の囲み（無ければ ```ks・言語なしの囲み）。無ければ ""。 */
export function extractLim(text: string): string {
  const m = /```(?:lim|liminalia|ks)?[ \t]*\r?\n([\s\S]*?)```/i.exec(text);
  return m ? m[1]!.replace(/\r\n/g, "\n").replace(/\n$/, "") : "";
}

/** 囲みを除いた説明。 */
export function withoutFence(text: string): string {
  return text.replace(/```(?:lim|liminalia|ks)?[ \t]*\r?\n[\s\S]*?```/i, "").trim();
}

/**
 * 校正の案が行の作りを保っているか（Akaire の約束）。行数と行順は同じ、命令・ラベル・コメント・空行は一字も変えず、
 * 台詞は話者を変えず、本文の中の命令・クリック待ちなどは同じ並びのまま。
 */
export function checkProofread(original: string, revised: string, speakers: readonly string[]): string[] {
  const a = original.split("\n");
  const b = revised.split("\n");
  if (a.length !== b.length) return [`行数が ${a.length} 行から ${b.length} 行に変わっています`];
  const errors: string[] = [];
  a.forEach((line, i) => {
    const kind = lineKind(line, speakers);
    const next = b[i]!;
    const n = i + 1;
    if (!isText(kind)) {
      if (line !== next) errors.push(`${n} 行目（${KIND_NAMES[kind]}）が変わっています`);
      return;
    }
    if (kind === "dialogue" && speakerOf(line, speakers) !== speakerOf(next, speakers)) errors.push(`${n} 行目の話者が変わっています`);
    else if (!isText(lineKind(next, speakers))) errors.push(`${n} 行目が本文でなくなっています`);
    else if (JSON.stringify(flowMarks(line)) !== JSON.stringify(flowMarks(next))) errors.push(`${n} 行目の本文の中の命令・クリック待ちが変わっています`);
  });
  return errors;
}

/** 膨らませた案が、もとの命令・ラベル・コメントの行と本文の中の命令を、同じ順で残しているか。 */
export function checkExpansion(original: string, revised: string, speakers: readonly string[]): string[] {
  const a = original.split("\n");
  const b = revised.split("\n");
  const errors: string[] = [];
  let at = 0;
  for (const line of a) {
    const kind = lineKind(line, speakers);
    if (isText(kind) || kind === "empty") continue;
    const found = b.indexOf(line, at);
    if (found < 0) errors.push(`もとの行が残っていません: ${line}`);
    else at = found + 1;
  }
  const before = a.flatMap((l) => (isText(lineKind(l, speakers)) ? flowMarks(l) : []));
  const after = b.flatMap(flowMarks);
  at = 0;
  for (const mark of before) {
    const found = after.indexOf(mark, at);
    if (found < 0) errors.push(`本文の中の ${mark} が残っていません`);
    else at = found + 1;
  }
  return errors;
}

/**
 * 案の点検（反映する前に見せる注意）。話者として登録していない名前の台詞の形・知らない命令・素材の無いファイル名。
 * commands は作品で使っている命令の名前、assets は素材のファイル（種類/パス）。
 */
export function lintProposal(lim: string, speakers: readonly string[], commands: ReadonlySet<string>, assets: ReadonlySet<string>): { line: number; message: string }[] {
  const out: { line: number; message: string }[] = [];
  lim.split("\n").forEach((line, i) => {
    const n = i + 1;
    const kind = lineKind(line, speakers);
    if (kind === "prose") {
      const m = /^[ \t]*([^\s「『（(　]{1,12})[「『（(].*[」』）)]$/.exec(line);
      if (m) out.push({ line: n, message: `話者に登録していない名前の台詞の形です: ${m[1]}` });
    }
    if (kind === "command") {
      const name = /^[ \t]*@([a-z][a-z0-9-]*)/.exec(line)?.[1];
      if (name && commands.size > 0 && !commands.has(name)) out.push({ line: n, message: `作品でまだ使っていない命令です: @${name}（lim reference で確かめてください）` });
    }
    for (const file of line.match(/[\w./-]+\.(?:png|jpe?g|webp|gif|mp3|ogg|m4a|wav|mp4|webm)\b/gi) ?? []) {
      if (assets.size > 0 && ![...assets].some((a) => a.endsWith(`/${file}`) || a === file)) out.push({ line: n, message: `素材にないファイルです: ${file}` });
    }
  });
  return out;
}

const KIND_NAMES: Record<LineKind, string> = { command: "命令の行", label: "ラベル", comment: "コメント", empty: "空行", dialogue: "台詞", prose: "地の文" };

/**
 * 構造化した答え（JSON）を読む。app-server が答えの項目をいくつか出すと JSON が `}{` で続くことがあるので、
 * 文字列の中の括弧を数えずに独立した JSON を拾い、最後のものを使う。
 */
export function safeJson(text: string): unknown {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(source);
  } catch {
    const docs: unknown[] = [];
    let start = -1;
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i]!;
      if (quote) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"') {
        quote = c;
        continue;
      }
      if (c === "{") {
        if (depth === 0) start = i;
        depth++;
        continue;
      }
      if (c !== "}" || depth === 0) continue;
      depth--;
      if (depth !== 0 || start < 0) continue;
      try {
        docs.push(JSON.parse(source.slice(start, i + 1)));
      } catch {
        // 読めないものは飛ばす
      }
      start = -1;
    }
    return docs.at(-1) ?? null;
  }
}
