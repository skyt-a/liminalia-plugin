/** 画面パーツと CSS 編集（CLI 側）。 */
export const ENABLES = ["studio:screens","cli:screens"] as const;

export default {
  name: "screen-customizer",
  enables: ENABLES,
} as const;
