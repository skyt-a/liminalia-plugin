import type { StudioPlugin } from "@liminalia/sdk/studio";

export const ENABLES = ["studio:variables","studio:breakpoints"] as const;

const plugin: StudioPlugin = {
  name: "debug-tools",
};

export default plugin;
