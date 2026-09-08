// Markdown files in docs/ are rendered to HTML at build time by
// vite-plugins/markdown.ts and imported as strings.
declare module "*.md" {
  const html: string;
  export default html;
}

/**
 * Source files imported as text with Vite's ?raw suffix.
 *
 * The panel shows the imagery and index code from the files that actually run,
 * so what a reader is shown cannot drift from what produced their numbers.
 */
declare module "*?raw" {
  const source: string;
  export default source;
}
