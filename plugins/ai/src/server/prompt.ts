import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ActionId, RunRequest } from "../protocol.ts";
import { ACTION_LABELS } from "../protocol.ts";

/** 作品の場所（開発サーバー側の ctx.root・ctx.paths から）。 */
export interface ProjectPaths {
  root: string;
  paths: { scenario: string; assets: string; data: string; cast: string };
}

/** 操作ごとの頼み方（LIMINAL Forge のものを .lim に合わせたもの）。 */
const INSTRUCTIONS: Record<ActionId, string> = {
  continue: "選んだ行の終わりから自然につながる短い続きを、今の人物像・語調・演出の決まりに合わせて提案してください。",
  polish: "選んだ行だけを対象に、意味・話者・事実関係を変えず、読みやすさと余韻が増すように推敲してください。",
  expand:
    "選んだ行を、直前・直後の流れ、人物像、語調、舞台に沿って自然に膨らませてください。簡潔すぎる会話には反応・間・言外の意図を、背景や情景には空間・光・音・匂い・身体の感覚など必要なものだけを補い、水増ししないでください。もとの出来事、発話の意図、視点、命令の行・台詞の話者・ラベルは保ってください。",
  scenery: "選んだ行の後ろに入れられる情景描写を提案してください。今のテンポを壊さず、五感と空間の把握を補ってください。",
  direction: "この場面に合う背景・立ち絵・表情・音・間の演出を、作品にある素材と、作品で使っている命令だけで提案してください。",
  command:
    "添えた指示に書いたやりたいことを、選んだ行の後ろに入れる命令の行（@…）で実現してください。「使える命令」に載っている命令と引数だけを使い、引数の名前・位置・型・時間の単位（ms・s）を守ってください。本文（台詞・地の文）は書かず、作品にない素材・人物は使わないでください。",
  consistency: "今の台本全体を、正本の資料と照らし合わせてください。人物、用語、事件、時系列、素材・命令の参照の矛盾を具体的に挙げてください。",
  akaire: "選んだ行を Akaire スキルの基準で全行監査し、必要な本文だけを校正してください。行の作りを保ち、命令の行・台詞の話者には触れないでください。",
};

export const AKAIRE_POLICY = [
  "Akaire の監査では、対象の本文を一行も飛ばさずに確かめます。",
  "見つけるものは、誤用、符牒・業界語の過密、言葉足らず、造語的な言い回し、時制・アスペクト・モダリティのずれ、同語・論点の反復、表記・語調の揺れの 7 分類です。",
  "分類の外でも、冗長さ、AI 的な抽象表現、弱い描写、人物の口調の不一致、場面のつなぎのぎこちなさを見逃しません。",
  "指摘は、修正必須、修正推奨、構造修正、意図確認の 4 段階に分けます。該当のない段階も「なし」と書きます。",
  "意味、事実関係、人物像、発話の意図を勝手に変えません。人物の口調は正本の資料と直前の文脈に従います。",
  "行数と行順は変えません。命令の行（@…）、ラベル（# …）、コメント（// …）、空行は一字も変えません。台詞の話者名も変えず、本文の中の {@…}・{click}・{br}・{= …} も同じ順で残します。",
  "校正案を当てたとは言わず、監査の報告の後に全文の校正案を出します。",
].join("\n");

/** .lim の書き方の要点（AI は Liminalia を知らないので、案の書式をこれに揃えてもらう）。 */
const LIM_PRIMER = [
  "台本は Liminalia の .lim 形式です。一行が一クリック。行頭で種類が決まります:",
  "- 話者名の直後に「『（( が続く行は台詞（例: `マユ「……来週になる前に」`）。話者名は作品に登録したものだけ",
  "- `@命令 位置引数 key=value` は命令（例: `@chara マユ smile at=left`、`@bg room.webp fade=500ms`）。時間には単位（ms・s）が要る",
  "- `# 名前` はラベル、`//` はコメント、空行は区切り、それ以外は地の文。地の文の字下げは全角空白",
  "- 本文の中: ルビ `{r 漢字|かんじ}`、行の途中のクリック待ち `{click}`、改行 `{br}`、本文の途中の命令 `{@chara マユ sad}`",
].join("\n");

export const DEVELOPER_INSTRUCTIONS = [
  "あなたは Liminalia Studio（ビジュアルノベルの制作画面）に埋め込まれた、シナリオ相談の担当です。",
  "作品のフォルダのファイルは、文脈を確かめるための読み取り・一覧・検索だけができます。",
  "ファイルの作成・編集・削除、外部との通信、インストール、Git の操作、プロセスや設定を変えるコマンドは実行しません。",
  "書き手が反映のボタンを押すまで原稿は変わりません。変えたとは言わないでください。",
  "台本の案を出すときは、説明と分けて ```lim の囲みを一つだけ出してください。",
  "Akaire の校閲を頼まれた回では、使える Akaire スキルと示した監査基準を必ず使ってください。",
  "作品にない人物・表情・素材・命令を、あるものとして使わないでください。",
  "",
  LIM_PRIMER,
].join("\n");

export const CONSISTENCY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "issues"],
  properties: {
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "line", "title", "detail"],
        properties: {
          severity: { type: "string", enum: ["error", "warning", "info"] },
          line: { type: ["integer", "null"] },
          title: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
  },
} as const;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 24))}\n…（${text.length - max} 文字を省略）`;
}

interface CastFile {
  speakers?: string[];
  cast?: Record<string, { speaker?: string; appearances?: Record<string, { variants?: Record<string, unknown> }> }>;
}

function readCast(p: ProjectPaths): CastFile {
  try {
    return JSON.parse(readFileSync(p.paths.cast, "utf8")) as CastFile;
  } catch {
    return {};
  }
}

/** 作品の話者名（台詞の行の見分けに使う）。 */
export function speakersOf(p: ProjectPaths): string[] {
  const cast = readCast(p);
  return [...new Set([...(cast.speakers ?? []), ...Object.values(cast.cast ?? {}).flatMap((c) => (c.speaker ? [c.speaker] : []))])];
}

/** 素材のファイル（"種類/パス"）。 */
export function assetList(p: ProjectPaths): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(relative(p.paths.assets, full).split(sep).join("/"));
    }
  };
  walk(p.paths.assets);
  return out.sort();
}

/** 台本で使っている命令の名前（作品のほかの台本も含む）。 */
export function commandsUsed(p: ProjectPaths, text: string): Set<string> {
  const names = new Set<string>();
  const add = (t: string) => {
    for (const m of t.matchAll(/^[ \t]*@([a-z][a-z0-9-]*)/gm)) names.add(m[1]!);
    for (const m of t.matchAll(/\{@([a-z][a-z0-9-]*)/g)) names.add(m[1]!);
  };
  add(text);
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".lim")) add(readFileSync(full, "utf8"));
    }
  };
  walk(p.paths.scenario);
  return names;
}

/** 正本の資料（作品のフォルダからのパス。ファイルはその中身、フォルダは中のファイルの中身）。作品の外を指すものは読まない。 */
function readReferences(p: ProjectPaths, references: readonly string[], budget: number): { text: string; paths: string[] } {
  const files: string[] = [];
  const collect = (full: string) => {
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full).sort()) if (!name.startsWith(".")) collect(join(full, name));
    } else if (/\.(json|md|txt|lim|ya?ml)$/i.test(full)) files.push(full);
  };
  for (const ref of references) {
    const full = resolve(p.root, ref);
    const rel = relative(p.root, full);
    if (rel.startsWith("..")) continue;
    collect(full);
  }
  const per = files.length > 0 ? Math.max(800, Math.floor(budget / files.length)) : budget;
  const text = files.map((f) => `### ${relative(p.root, f).split(sep).join("/")}\n${clip(readFileSync(f, "utf8"), per)}`).join("\n");
  return { text: clip(text, budget), paths: files.map((f) => relative(p.root, f).split(sep).join("/")) };
}

export interface Context {
  text: string;
  lines: string[];
  selected: string;
  speakers: string[];
  commands: Set<string>;
  assets: Set<string>;
}

/** 頼む文脈。選んだ行（最優先）・前後・正本の資料・人物・素材・命令。 */
export function buildContext(p: ProjectPaths, req: RunRequest, references: readonly string[]): Context {
  const lines = req.text.replace(/\r\n/g, "\n").split("\n");
  const from = Math.max(1, Math.min(req.from, lines.length));
  const to = Math.max(from, Math.min(req.to, lines.length));
  const selected = lines.slice(from - 1, to).join("\n");
  const cast = readCast(p);
  const speakers = speakersOf(p);
  const assets = assetList(p);
  const commands = commandsUsed(p, req.text);
  const sections: string[] = [];
  const add = (title: string, body: string, limit: number) => {
    const v = clip(body, limit);
    if (v.trim()) sections.push(`## ${title}\n${v}`);
  };
  const scenarioPath = relative(p.root, join(p.paths.scenario, `${req.file}.lim`)).split(sep).join("/");
  add("対象", [`台本: ${scenarioPath}`, `選んだ行: ${from}-${to}`].join("\n"), 600);
  add("選んだ行（最優先）", selected, req.action === "consistency" ? 2000 : 5000);
  if (req.action === "consistency") add("今の台本全体", req.text, 12000);
  else {
    add("直前の文脈", lines.slice(0, from - 1).join("\n").slice(-6000), 6000);
    add("直後の文脈", lines.slice(to).join("\n").slice(0, 2000), 2000);
  }
  const refs = readReferences(p, references, 5000);
  add("正本の資料", refs.text, 5000);
  add("話者名", speakers.join("、"), 800);
  add(
    "キャスト（立ち絵の持ち主と、立ち絵セット（差分））",
    Object.entries(cast.cast ?? {})
      .map(([name, c]) => `${name}${c.speaker ? `（話者名 ${c.speaker}）` : ""}: ${Object.entries(c.appearances ?? {}).map(([a, v]) => `${a}(${Object.keys(v.variants ?? {}).join("/")})`).join(", ") || "立ち絵なし"}`)
      .join("\n"),
    2500,
  );
  add("作品で使っている命令", [...commands].sort().map((c) => `@${c}`).join(" "), 1200);
  add("素材", assets.join("\n"), 2500);
  add("必要なら読めるファイル", [scenarioPath, relative(p.root, p.paths.cast), ...refs.paths].join("\n"), 1600);
  return { text: clip(sections.join("\n\n"), 30000), lines, selected, speakers, commands, assets: new Set(assets) };
}

export function akairePrompt(target: string, context: Context, options: { automatic: boolean; instruction?: string }): string {
  return [
    "Akaire スキルを必ず使い、次の台本を納品前に監査してください。Akaire スキルを読めるならその手順を優先し、以下の基準もすべて満たしてください。",
    options.automatic ? "これは AI が直前に作った案の、必ず行う自己点検です。点検していない案をそのまま返してはいけません。" : "これは書き手が選んだ原稿の校正の依頼です。選んだ行の外は変えません。",
    "",
    "## Akaire の監査基準",
    AKAIRE_POLICY,
    options.instruction ? `\n## 添えた指示\n${options.instruction}` : "",
    "",
    "## 参照する文脈",
    context.text,
    "",
    "## 校閲する台本",
    "```lim",
    target,
    "```",
    "",
    "## 出し方",
    "修正必須、修正推奨、構造修正、意図確認の順に監査の結果を短く報告し、その後に全文の校正案を ```lim の囲み一つで返してください。",
    "囲みの中は対象と同じ行数・行順にし、変えてよいのは本文だけです。指摘がなくても囲みを省かないでください。",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function makePrompt(req: RunRequest, context: Context): string {
  const instruction = (req.instruction ?? "").trim();
  if (req.mode === "chat") {
    return ["次の作品の文脈を踏まえて、シナリオ制作の相談に答えてください。", "台本の案を返すときだけ ```lim の囲みを使ってください。", "", context.text, "", "## 相談", (req.message ?? "").trim()].join("\n");
  }
  const action = req.action!;
  if (action === "akaire") return akairePrompt(context.selected, context, { automatic: false, ...(instruction ? { instruction } : {}) });
  const output =
    action === "consistency"
      ? "示した JSON の形で答え、問題がなければ issues を空の配列にしてください。line は台本の行番号です。"
      : action === "command"
        ? "入れる命令の行だけを ```lim の囲みで返し、その前に何をする行かを短く説明してください。囲みの中には命令の行（と必要ならコメント）だけを書きます。"
        : action === "expand"
        ? "選んだ行とそのまま置き換えられる完成稿を ```lim の囲みで返し、その前に補ったものを短く説明してください。囲みの中は省略せず、選んだ行の全部と足した行を書きます。行は増やせますが、命令の行・台詞の話者・ラベル・コメントは一字も変えず、同じ順で残してください。"
        : "そのまま入れられる案を ```lim の囲みで返し、その前に意図を短く説明してください。囲みの中には台本だけを書きます。";
  return [`操作: ${ACTION_LABELS[action]}`, INSTRUCTIONS[action], instruction ? `添えた指示: ${instruction}` : "", output, "", context.text].filter(Boolean).join("\n");
}

/** エンジンが渡す命令の仕様（開発サーバー側の ctx.commands() の形のうち、手引きに使うところ）。 */
export interface CommandInfo {
  name: string;
  summary: string;
  positional: readonly string[];
  params: Readonly<Record<string, { type: { kind: string; values?: readonly string[]; folder?: string }; default?: string; required?: boolean; doc?: string }>>;
  example: string;
  keywords?: readonly string[];
}

/** 文字の 2 字ずつの組（やりたいことと命令の説明の近さを測る）。 */
function bigrams(text: string): Set<string> {
  const t = text.toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * やりたいことに近い命令の仕様を、AI に渡す手引きにする（近いものは引数まで、ほかは名前と説明の頭だけ）。
 * 近さは、やりたいことの言葉（keywords）が指示に含まれるか、指示と説明の 2 字の組がどれだけ重なるかで測る。
 */
export function commandGuide(commands: readonly CommandInfo[], wish: string, detailed = 12): string {
  const w = bigrams(wish);
  const lower = wish.toLowerCase();
  const scored = commands.map((c) => {
    let score = 0;
    for (const k of c.keywords ?? []) if (lower.includes(k.toLowerCase())) score += 10;
    if (lower.includes(c.name)) score += 10;
    for (const g of bigrams(`${c.summary} ${(c.keywords ?? []).join(" ")}`)) if (w.has(g)) score += 1;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const near = scored.filter((x) => x.score > 0).slice(0, detailed).map((x) => x.c);
  const detail = near.map((c) => {
    const params = Object.entries(c.params).map(([n, p]) => {
      const pos = c.positional.indexOf(n);
      const type = p.type.kind === "enum" && p.type.values ? p.type.values.join("|") : p.type.kind === "asset" ? `素材（${p.type.folder ?? ""}）` : p.type.kind;
      return `  - ${pos >= 0 ? `${n}（${pos + 1} 番目。名前を付けずに書く）` : `${n}=`} ${type}${p.required ? "（必須）" : p.default !== undefined ? `（既定 ${p.default}）` : ""} ${p.doc ?? ""}`;
    });
    return [`### @${c.name}`, c.summary, `例: ${c.example}`, ...params].join("\n");
  });
  const others = commands.filter((c) => !near.includes(c)).map((c) => `@${c.name}: ${c.summary.split(/[。（(]/)[0]}`);
  return [...detail, "", "### そのほかの命令（使うなら説明どおりの引数で）", ...others].join("\n");
}
