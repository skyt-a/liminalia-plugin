/** Android・iOS アプリ書き出し（CLI 側）。 */
export const ENABLES = ["cli:build-mobile","build:android","build:ios"] as const;

export default {
  name: "build-mobile",
  enables: ENABLES,
} as const;
