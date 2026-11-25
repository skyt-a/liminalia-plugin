import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/** AI の接続先（ローカルの CLI）。 */
export interface Provider {
  id: "codex" | "agy";
  label: string;
  /** 版を出す引数（無ければ版は出さない）。 */
  versionArgs: readonly string[];
}

export const PROVIDERS: readonly Provider[] = [
  { id: "codex", label: "Codex", versionArgs: ["--version"] },
  { id: "agy", label: "Gemini（agy）", versionArgs: [] },
];

export function providerById(id: string): Provider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

export interface ResolvedBinary {
  path: string;
  candidates: string[];
  error: string;
}

export function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function clean(value: string | undefined): string {
  const candidate = String(value ?? "").trim();
  return candidate ? resolve(candidate.replace(/^~(?=\/|$)/, homedir())) : "";
}

/** ログインシェルの PATH（デスクトップ版から起こしたとき、mise などの PATH が入っていないため）。 */
let shellPath: string | null = null;
function loginShellPath(env: NodeJS.ProcessEnv = process.env): string {
  if (shellPath !== null) return shellPath;
  try {
    shellPath = String(execFileSync(env.SHELL || "/bin/zsh", ["-lc", 'printf "%s" "$PATH"'], { encoding: "utf8", timeout: 2500, stdio: ["ignore", "pipe", "ignore"], env }) || "").trim();
  } catch {
    shellPath = "";
  }
  return shellPath;
}

function inPath(name: string, env: NodeJS.ProcessEnv): string[] {
  return [env.PATH, loginShellPath(env)].flatMap((v) => String(v ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name)));
}

function miseCodex(): string[] {
  const root = join(homedir(), ".local", "share", "mise", "installs", "node");
  try {
    return readdirSync(root)
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .map((v) => join(root, v, "bin", "codex"));
  } catch {
    return [];
  }
}

/** agmsg などの、codex を包むだけのスクリプト（app-server を話せない）。 */
export function isShim(file: string): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) return false;
    const source = readFileSync(file, "utf8");
    return source.includes("AGMSG_CODEX_SHIM_WRAPPER") || source.includes("/agmsg/") || source.includes("codex-shim.sh");
  } catch {
    return false;
  }
}

export function resolveBinary(provider: Provider, env: NodeJS.ProcessEnv = process.env): ResolvedBinary {
  if (provider.id === "agy") {
    const candidates = [...new Set([clean(env.AGY_BIN), ...inPath("agy", env), join(homedir(), ".local", "bin", "agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"].filter(Boolean))];
    const found = candidates.find(isExecutable) ?? "";
    return { path: found, candidates, error: found ? "" : "agy が見つかりません。Antigravity の CLI を入れてログインしてから、接続し直してください。" };
  }
  const candidates = [
    ...new Set(
      [
        clean(env.CODEX_BIN),
        ...inPath("codex", env),
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        join(homedir(), ".local", "bin", "codex"),
        ...miseCodex(),
      ].filter(Boolean),
    ),
  ];
  const found = candidates.find((c) => isExecutable(c) && !isShim(c)) ?? "";
  return { path: found, candidates, error: found ? "" : "Codex の CLI が見つかりません（agmsg などの包むスクリプトは使えません）。Codex を入れてログインしてから、接続し直してください。" };
}

/** CLI を起こすときの環境（CLI のフォルダとログインシェルの PATH を足す）。 */
export function spawnEnvironment(binary: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dirs = [dirname(binary), ...String(env.PATH ?? "").split(delimiter), ...loginShellPath(env).split(delimiter)].filter(Boolean);
  return { ...env, PATH: [...new Set(dirs)].join(delimiter) };
}
