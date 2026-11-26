/** TyranoScript 移行・書き戻し（CLI 側）。 */
export const ENABLES = ["cli:import","cli:backport","studio:import-banner"] as const;

export default {
  name: "tyrano-import",
  enables: ENABLES,
} as const;
