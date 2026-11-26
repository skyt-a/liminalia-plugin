/** ボイス収録・一括管理（CLI 側）。 */
export const ENABLES = ["studio:voices","cli:voice-script","cli:voice-lock"] as const;

export default {
  name: "voice-production",
  enables: ENABLES,
} as const;
