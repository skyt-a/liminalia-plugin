/** 他ツールシナリオ取り込み（CLI 側）。 */
export const ENABLES = ["cli:import-ink","cli:import-yarn","cli:import-renpy","cli:import-twine"] as const;

export default {
  name: "story-import",
  enables: ENABLES,
} as const;
