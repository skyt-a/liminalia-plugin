import type { CommandPlugin } from "@liminalia/sdk";

export const ENABLES = ["core:commerce"] as const;

const plugin: CommandPlugin = {
  name: "store-commerce",
  apiVersion: 8,
  commands: [],
};

export default plugin;
