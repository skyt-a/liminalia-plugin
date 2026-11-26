/** Steam・itch.io 配信とパッチ（CLI 側）。 */
export const ENABLES = ["cli:publish","cli:pack","cli:patch","cli:update-manifest","cli:update-key","build:stores"] as const;

export default {
  name: "publish-stores",
  enables: ENABLES,
} as const;
