import type { CommandPlugin } from "@liminalia/sdk";

export const ENABLES = ["std:investigate","std:map-choice","std:codex","std:hud"] as const;

const plugin: CommandPlugin = {
  name: "std-adventure",
  apiVersion: 8,
  commands: [],
};

export default plugin;
