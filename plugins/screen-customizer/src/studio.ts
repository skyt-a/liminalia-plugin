import type { StudioPlugin } from "@liminalia/sdk/studio";

export const ENABLES = ["studio:screens","cli:screens"] as const;

const plugin: StudioPlugin = {
  name: "screen-customizer",
};

export default plugin;
