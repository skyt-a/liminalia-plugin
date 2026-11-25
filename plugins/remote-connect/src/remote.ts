import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import httpProxy from "http-proxy";
import QRCode from "qrcode";

/** Cloudflare Access を必須とする外部接続。設定・認証情報は作品ではなくユーザー領域に置く。 */
export interface RemoteConfig { hostname: string; tunnel: string; credentialsFile: string; team: string; audience: string; }
export const remoteConfigPath = () => join(homedir(), ".liminalia-studio", "remote.json");
function loadConfig(): RemoteConfig {
  let config: RemoteConfig;
  try { config = JSON.parse(readFileSync(remoteConfigPath(), "utf8")) as RemoteConfig; }
  catch { throw new Error("外出先からの接続はまだ設定されていません。Cloudflare Access の設定が必要です。"); }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(config.hostname ?? "") || !/^[0-9a-f-]{36}$/i.test(config.tunnel ?? "") || !config.credentialsFile || !/^[a-z0-9-]+$/i.test(config.team ?? "") || !/^[a-f0-9]{64}$/i.test(config.audience ?? "")) throw new Error("外出先からの接続設定が不完全です。");
  return config;
}

export function remoteSharing(options: { config?: RemoteConfig; launch?: (configFile: string, tunnel: string) => ChildProcess } = {}): { start(localPort: number): Promise<{ url: string; qr: string }>; stop(): Promise<void> } {
  let server: Server | undefined;
  let child: ChildProcess | undefined;
  let proxy: httpProxy | undefined;
  let dir: string | undefined;
  let hostname = "";
  let pair = "";
  let expires = 0;
  const sessions = new Set<string>();
  const sockets = new Set<Socket>();
  const secret = () => randomBytes(32).toString("hex");
  const stop = async () => {
    pair = ""; sessions.clear();
    const proc = child; child = undefined;
    if (proc && proc.exitCode === null) { proc.kill("SIGTERM"); await new Promise<void>((resolve) => { const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 3000); proc.once("exit", () => { clearTimeout(timer); resolve(); }); }); }
    for (const socket of sockets) socket.destroy();
    const active = server; server = undefined;
    proxy?.close(); proxy = undefined;
    if (active) await new Promise<void>((resolve) => active.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  };
  const start = async (localPort: number) => {
    if (!server) {
      const config = options.config ?? loadConfig(); hostname = config.hostname.toLowerCase();
      try {
        const p = httpProxy.createProxyServer({ target: `http://127.0.0.1:${localPort}`, ws: true, changeOrigin: true }); proxy = p;
        p.on("proxyReq", (out, req) => { if (req.headers.origin) out.setHeader("origin", `http://127.0.0.1:${localPort}`); });
        p.on("proxyReqWs", (out, req) => { if (req.headers.origin) out.setHeader("origin", `http://127.0.0.1:${localPort}`); });
        p.on("error", (_e, _req, res) => { if ("writeHead" in res && !res.headersSent) res.writeHead(502).end(); else res.destroy(); });
        const valid = (req: import("node:http").IncomingMessage) => req.headers.host === hostname && (!req.headers.origin || req.headers.origin === `https://${hostname}`);
        const authorized = (req: import("node:http").IncomingMessage) => sessions.has((req.headers.cookie ?? "").split(/;\s*/).find((v) => v.startsWith("liminalia_remote="))?.slice(17) ?? "");
        const s = createServer((req, res) => {
          if (!valid(req)) { res.writeHead(403).end(); return; }
          const url = new URL(req.url ?? "/", `https://${hostname}`);
          if (req.method === "GET" && url.pathname === "/__remote/pair") {
            const token = url.searchParams.get("token") ?? "";
            if (!pair || Date.now() > expires || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(pair))) { res.writeHead(403).end("Pairing link expired"); return; }
            pair = ""; const session = secret(); sessions.add(session);
            res.writeHead(303, { "Set-Cookie": `liminalia_remote=${session}; HttpOnly; Secure; SameSite=Lax; Path=/`, Location: "/__liminalia/studio?lan=1", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).end(); return;
          }
          if (!authorized(req) || url.pathname.startsWith("/__remote/") || url.pathname.startsWith("/__lan/")) { res.writeHead(403).end(); return; }
          p.web(req, res);
        });
        s.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
        s.on("upgrade", (req, socket, head) => { if (!valid(req) || !authorized(req)) { socket.destroy(); return; } p.ws(req, socket, head); });
        await new Promise<void>((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", () => { s.off("error", reject); resolve(); }); }); server = s;
        const port = (s.address() as { port: number }).port;
        dir = mkdtempSync(join(tmpdir(), "liminalia-tunnel-"));
        const configFile = join(dir, "config.json");
        // JSON は YAML の一部。Access の JWT を cloudflared が検証できない場合は転送されない。
        writeFileSync(configFile, JSON.stringify({ tunnel: config.tunnel, "credentials-file": config.credentialsFile, ingress: [{ hostname, service: `http://127.0.0.1:${port}`, originRequest: { access: { required: true, teamName: config.team, audTag: [config.audience] } } }, { service: "http_status:404" }] }), { mode: 0o600 });
        const proc = options.launch ? options.launch(configFile, config.tunnel) : spawn("cloudflared", ["tunnel", "--no-autoupdate", "--config", configFile, "run", config.tunnel], { stdio: ["ignore", "ignore", "pipe"] }); child = proc;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error("Cloudflare への接続が時間内に確立しませんでした。")); }, 25000);
          const cleanup = () => { clearTimeout(timer); proc.off("error", onError); proc.off("exit", onExit); proc.stderr?.off("data", onData); };
          const onError = () => { cleanup(); reject(new Error("cloudflared を起動できませんでした。")); };
          const onExit = () => { cleanup(); reject(new Error("Cloudflare トンネルを起動できませんでした。設定と認証情報を確認してください。")); };
          const onData = (chunk: Buffer) => { if (chunk.toString().includes("Registered tunnel connection")) { cleanup(); resolve(); } };
          proc.once("error", onError); proc.once("exit", onExit); proc.stderr?.on("data", onData);
        });
        // 接続後もログを読み捨て、標準エラーのバッファが詰まってトンネルが止まらないようにする。
        proc.stderr?.resume();
        proc.once("exit", () => { if (child === proc) void stop(); });
      } catch (e) { await stop(); throw e; }
    }
    pair = secret(); expires = Date.now() + 5 * 60_000;
    const url = `https://${hostname}/__remote/pair?token=${pair}`;
    return { url, qr: await QRCode.toDataURL(url, { margin: 2, width: 320 }) };
  };
  return { start, stop };
}
