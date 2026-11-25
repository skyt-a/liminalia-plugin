import { defineStudioServerPlugin, StudioServerError } from "@liminalia/sdk/studio-server";
import { findRunningStudio } from "@liminalia/sdk/studio-server";
import { remoteSharing } from "./remote.ts";

const remote = remoteSharing();
export default defineStudioServerPlugin({
  name: "remote-connect",
  routes: {
    "POST /start": async (_req, ctx) => {
      const running = await findRunningStudio(ctx.root);
      if (!running || running.pid !== process.pid) throw new StudioServerError(503, "この作品の Studio に接続できません。Studio を開き直してください。");
      const url = new URL(running.url);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new StudioServerError(403, "ローカルの Studio のみ接続できます。");
      return remote.start(Number(url.port));
    },
    "POST /stop": async () => { await remote.stop(); return { stopped: true }; },
  },
  dispose: () => remote.stop(),
});
