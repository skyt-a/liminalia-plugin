/** CI 自動テスト・クラッシュ解析（CLI 側）。 */
export const ENABLES = ["cli:test","cli:reach","cli:playtest","cli:crash"] as const;

export default {
  name: "ci-testing",
  enables: ENABLES,
} as const;
