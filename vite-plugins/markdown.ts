import type { Plugin } from "vite";
import { marked } from "marked";

// Renders imported .md files to HTML at build time, so the documentation panel
// ships no markdown parser and costs nothing at runtime. The same files stay
// readable on GitHub, which is the point of keeping the library in markdown
// rather than authoring HTML by hand.

/**
 * Cross-document links are rewritten from `earth-engine-setup.md` to
 * `#doc:earth-engine-setup`, which the panel intercepts to switch guides rather
 * than navigating the host page. Anchors within a document and absolute URLs
 * are left alone.
 */
function rewriteLinks(html: string): string {
  return html.replace(
    /href="(?!https?:|#|mailto:)([^"]*?)\.md(#[^"]*)?"/g,
    (_match, path: string, hash: string | undefined) => {
      const id = path.split("/").pop() ?? path;
      return `href="#doc:${id}${hash ?? ""}"`;
    },
  );
}

export function markdownPlugin(): Plugin {
  return {
    name: "tuvsud-markdown-to-html",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".md")) return null;
      const rendered = marked.parse(code, { async: false, gfm: true });
      const html = rewriteLinks(rendered as string);
      return {
        code: `export default ${JSON.stringify(html)};`,
        map: null,
      };
    },
  };
}
