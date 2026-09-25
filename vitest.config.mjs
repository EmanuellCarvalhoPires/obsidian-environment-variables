import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // Same as esbuild's "text" loader in the plugin build: *.md imports become strings.
      name: "markdown-as-text",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith(".md")) return null;
        return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
