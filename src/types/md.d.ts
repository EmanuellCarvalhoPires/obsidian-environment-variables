// Markdown files are bundled as plain text (esbuild loader "text"; vitest.config.mjs does the same in tests).
declare module "*.md" {
  const text: string;
  export default text;
}
