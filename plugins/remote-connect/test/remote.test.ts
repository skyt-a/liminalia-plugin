import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { describe, expect, it } from "vitest";
import { remoteSharing } from "../src/remote.ts";

const get = (url: string, headers: Record<string, string>) => new Promise<{ status: number; cookie: string }>((resolve, reject) => {
  const req = request(url, { headers }, (res) => { res.resume(); res.once("end", () => resolve({ status: res.statusCode ?? 0, cookie: res.headers["set-cookie"]?.[0] ?? "" })); });
  req.on("error", reject); req.end();
});

describe("remote sharing", () => {
  it("requires Cloudflare Access and one-use pairing, rejects other origins, and stops the tunnel", async () => {
    const local = createServer((_req, res) => res.end("studio"));
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    let config: any;
    const remote = remoteSharing({
      config: { hostname: "studio.example.com", tunnel: "11111111-1111-1111-1111-111111111111", credentialsFile: "/tmp/test.json", team: "example", audience: "a".repeat(64) },
      launch: (file) => {
        config = JSON.parse(readFileSync(file, "utf8"));
        return spawn(process.execPath, ["-e", 'console.error("Registered tunnel connection");setInterval(()=>{},1000)'], { stdio: ["ignore", "ignore", "pipe"] });
      },
    });
    try {
      const pairing = await remote.start((local.address() as { port: number }).port);
      expect(config.ingress[0].originRequest.access).toEqual({ required: true, teamName: "example", audTag: ["a".repeat(64)] });
      const address = config.ingress[0].service as string;
      const path = new URL(pairing.url).pathname + new URL(pairing.url).search;
      const headers = { host: "studio.example.com" };
      expect((await get(address, headers)).status).toBe(403);
      expect((await get(address + path, { ...headers, origin: "https://evil.example" })).status).toBe(403);
      const linked = await get(address + path, headers);
      expect(linked.status).toBe(303);
      const cookie = linked.cookie;
      expect(cookie).toContain("Secure");
      expect((await get(address + path, headers)).status).toBe(403);
      expect((await get(address, { ...headers, cookie })).status).toBe(200);
      expect((await get(address + "/__lan/control", { ...headers, cookie })).status).toBe(403);
      await remote.stop();
      await expect(get(address, { ...headers, cookie })).rejects.toThrow();
    } finally { await remote.stop(); await new Promise<void>((resolve) => local.close(() => resolve())); }
  });
});
