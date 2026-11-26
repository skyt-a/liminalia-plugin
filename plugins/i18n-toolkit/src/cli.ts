/** 多言語翻訳ツールキット（CLI 側）。 */
export const ENABLES = ["studio:i18n","cli:i18n"] as const;

export default {
  name: "i18n-toolkit",
  enables: ENABLES,
} as const;
