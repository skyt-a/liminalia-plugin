import type { StudioPlugin } from "@liminalia/sdk/studio";

export const ENABLES = ["studio:voices","cli:voice-script","cli:voice-lock"] as const;

const plugin: StudioPlugin = {
  name: "voice-production",
};

export default plugin;
