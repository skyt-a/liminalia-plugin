/**
 * 画面（./studio.ts）と開発サーバー側（./studio-server.ts）の受け渡し。口は ctx.server・ctx.stream で呼ぶ。
 *
 *   GET  /status    AiStatus（接続先・モデル・ログインの様子。はじめて呼ぶと CLI を起こす）
 *   POST /settings  AiSettings → AiStatus（接続先・モデル・推論の深さ・速度を変えて覚える）
 *   POST /run       RunRequest → RunEvent を一つずつ流す（画面がループを抜けると止める）
 *   POST /reset     { file } → { reset }（その台本の相談の続きを捨てる）
 *
 * 行は 1 から数える。
 */

export type ActionId = "continue" | "polish" | "expand" | "scenery" | "direction" | "command" | "consistency" | "akaire";

/** 決まった操作（画面のボタンと、制作画面の操作のメニューに出す）。 */
export const ACTION_LABELS: Record<ActionId, string> = {
  continue: "続きを提案",
  polish: "表現を磨く",
  expand: "この部分を膨らませる",
  scenery: "情景を足す",
  direction: "演出を提案",
  command: "やりたいことから命令",
  consistency: "整合性チェック",
  akaire: "シナリオを校正",
};

/** 指示の欄に書いたやりたいことが要る操作（メニューからは頼めない）。 */
export const NEEDS_INSTRUCTION: readonly ActionId[] = ["command"];

/** 案を、選んだ行と置き換える操作（ほかは選んだ行の後ろに足すのが既定で、置き換えもできる）。 */
export const REPLACE_ONLY: readonly ActionId[] = ["polish", "expand", "akaire"];

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Effort = (typeof REASONING_EFFORTS)[number];

export interface AiSettings {
  provider: string;
  model: string;
  effort: Effort;
  serviceTier: string;
  /** 正本として渡す資料（作品のフォルダからのパス。ファイルかフォルダ）。 */
  references: string[];
}

export interface ModelInfo {
  id: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  serviceTiers: { id: string; name: string; description: string }[];
}

export interface AiStatus {
  provider: { id: string; label: string };
  providers: { id: string; label: string }[];
  connected: boolean;
  /** CLI が見つかったか。 */
  available: boolean;
  binary: string;
  version: string;
  model: string;
  effort: string;
  serviceTier: string;
  references: string[];
  models: ModelInfo[];
  /** 繋がらない理由（ログインしていない・見つからないなど）。 */
  error: string;
}

export interface RunRequest {
  /** 実行ごとの id（画面が作る）。 */
  id: string;
  mode: "chat" | "action";
  action?: ActionId;
  /** 相談（mode が chat のとき）。 */
  message?: string;
  /** 操作に添える指示。 */
  instruction?: string;
  file: string;
  /** 編集中の本文（まだ保存していないものを含む）。 */
  text: string;
  /** 選んだ行（両端を含む）。 */
  from: number;
  to: number;
}

/** 案の出どころ。反映するときに、その行がまだ同じかを expect で確かめる。 */
export interface ResultSource {
  file: string;
  from: number;
  to: number;
  /** 選んだ行の、案を作ったときの中身（改行でつないだもの）。 */
  expect: string;
}

export interface Issue {
  severity: "error" | "warning" | "info";
  line: number | null;
  title: string;
  detail: string;
}

export interface RunResult {
  type: "text" | "lim" | "issues";
  /** 説明・答え（Markdown に近いもの）。 */
  text: string;
  /** 台本の案（type が lim のとき）。 */
  lim: string;
  issues: Issue[];
  /** 案の点検（書式・行の作りの崩れなど）。 */
  warnings: { line: number | null; message: string }[];
  akaire: { reviewed: boolean; automatic: boolean; changed: boolean } | null;
  source: ResultSource;
  model: string;
  effort: string;
}

export type RunEvent =
  | { type: "start"; id: string; source: ResultSource }
  | { type: "phase"; id: string; phase: string; message: string }
  | { type: "delta"; id: string; delta: string; reset: boolean }
  | { type: "result"; id: string; result: RunResult }
  | { type: "cancelled"; id: string };
