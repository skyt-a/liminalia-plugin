import type { CommandPlugin } from "@liminalia/sdk";

export const ENABLES = ["std:lighting","std:particles","std:manga","std:emote","std:effect","std:flipbook"] as const;

const plugin: CommandPlugin = {
  name: "std-fx",
  apiVersion: 8,
  commands: [],
};

export default plugin;
