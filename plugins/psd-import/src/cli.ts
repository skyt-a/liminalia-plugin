/** PSD 立ち絵パーツ取り込み（CLI 側）。 */
export const ENABLES = ["cli:psd"] as const;

export default {
  name: "psd-import",
  enables: ENABLES,
} as const;
