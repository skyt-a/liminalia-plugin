import type { StudioPlugin } from "@liminalia/sdk/studio";

export const ENABLES = ["cli:import","cli:backport","studio:import-banner"] as const;

const plugin: StudioPlugin = {
  name: "tyrano-import",
};

export default plugin;
