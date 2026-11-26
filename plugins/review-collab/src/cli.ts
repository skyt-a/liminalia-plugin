/** レビューコメント・校正ツール（CLI 側）。 */
export const ENABLES = ["studio:reviews","cli:prose","cli:script-export"] as const;

export default {
  name: "review-collab",
  enables: ENABLES,
} as const;
