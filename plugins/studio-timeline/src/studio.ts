import type { StudioPlugin } from "@liminalia/sdk/studio";

export const ENABLES = ["studio:timeline"] as const;

const plugin: StudioPlugin = {
  name: "studio-timeline",
};

export default plugin;
