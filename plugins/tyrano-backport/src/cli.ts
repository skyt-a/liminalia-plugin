/** TyranoScript への書き戻し（CLI 側）。 */
export const ENABLES = ["cli:backport"] as const;

export default {
  name: "tyrano-backport",
  enables: ENABLES,
} as const;
