import type { CommandPlugin } from "@liminalia/sdk";

export const ENABLES = ["std:staff-roll","std:chapter","std:keyframe","std:layer-camera","std:chara-motion"] as const;

const plugin: CommandPlugin = {
  name: "std-cinematic",
  apiVersion: 8,
  commands: [],
};

export default plugin;
