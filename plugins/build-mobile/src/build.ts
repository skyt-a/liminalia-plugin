/** Android・iOS アプリ書き出し（書き出し・配信側）。 */
export const ENABLES = ["cli:build-mobile","build:android","build:ios"] as const;

export default {
  name: "build-mobile",
  enables: ENABLES,
} as const;
