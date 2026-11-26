import type { StudioPlugin } from "@liminalia/sdk/studio";

export const ENABLES = ["studio:reviews","cli:prose","cli:script-export"] as const;

const plugin: StudioPlugin = {
  name: "review-collab",
};

export default plugin;
