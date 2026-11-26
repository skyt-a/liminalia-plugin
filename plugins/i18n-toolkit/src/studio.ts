import type { StudioPlugin } from "@liminalia/sdk/studio";

export const ENABLES = ["studio:i18n","cli:i18n"] as const;

const plugin: StudioPlugin = {
  name: "i18n-toolkit",
};

export default plugin;
