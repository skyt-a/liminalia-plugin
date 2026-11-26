import type { CommandPlugin } from "@liminalia/sdk";

export const ENABLES = ["std:chat","std:html","std:layer-text"] as const;

const plugin: CommandPlugin = {
  name: "std-ui-modes",
  apiVersion: 8,
  commands: [],
};

export default plugin;
