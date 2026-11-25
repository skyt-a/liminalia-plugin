import { defineStudioPlugin, type StudioContext } from "@liminalia/sdk/studio";

function mount(el: HTMLElement, ctx: StudioContext): void {
  const english = ctx.language === "en";
  const t = (ja: string, en: string) => english ? en : ja;
  const box = document.createElement("div");
  Object.assign(box.style, { padding: "20px", display: "grid", gap: "12px", maxWidth: "520px" });
  const info = document.createElement("p");
  info.textContent = t("Cloudflare Access で本人確認して、外出先からこのプロジェクトに接続します。Mac と Studio を起動したままにしてください。", "Connect to this project from outside using Cloudflare Access. Keep this computer and Studio running.");
  const result = document.createElement("div");
  const start = document.createElement("button"); start.type = "button"; start.className = "primary"; start.textContent = t("外出先から接続", "Connect remotely");
  const stop = document.createElement("button"); stop.type = "button"; stop.textContent = t("接続を終了", "Stop connection");
  const message = (e: unknown) => e instanceof Error ? e.message : String(e);
  start.onclick = () => {
    start.disabled = true;
    void ctx.server<{ url: string; qr: string }>("/start", { method: "POST" }).then(({ url, qr }) => {
      const image = document.createElement("img"); image.src = qr; image.alt = t("接続用 QR コード", "Connection QR code"); Object.assign(image.style, { display: "block", width: "min(100%, 320px)", background: "white" });
      const note = document.createElement("p"); note.textContent = t("QR コードは5分間有効で、1台だけ接続できます。", "The QR code expires in five minutes and pairs one device.");
      const link = document.createElement("input"); link.value = url; link.readOnly = true; link.style.width = "100%"; link.setAttribute("aria-label", t("接続 URL", "Connection URL"));
      result.replaceChildren(image, note, link); start.textContent = t("新しい QR コード", "New QR code");
    }).catch((e: unknown) => { result.textContent = message(e); }).finally(() => { start.disabled = false; });
  };
  stop.onclick = () => {
    stop.disabled = true;
    void ctx.server("/stop", { method: "POST" }).then(() => { result.textContent = t("接続を終了しました。", "Connection stopped."); start.textContent = t("外出先から接続", "Connect remotely"); }).catch((e: unknown) => { result.textContent = message(e); }).finally(() => { stop.disabled = false; });
  };
  box.append(info, start, stop, result); el.append(box);
}
export default defineStudioPlugin({ name: "remote-connect", views: [{ id: "remote-connect", title: "外出先から接続", titleEn: "Remote connection", mount }] });
