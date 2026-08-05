import { button, clear, el } from "../panel/dom";
import {
  AUDIENCE_LABELS,
  AUDIENCE_ORDER,
  Guide,
  GUIDES,
  findGuide,
  guidesFor,
} from "./registry";

/**
 * The documentation library, shown either as an index of guides or as one open
 * guide. The same instance backs the toolbar menu and the panel's Help section,
 * so opening a specific guide from either place lands in the same view.
 */
export class HelpLibrary {
  private container: HTMLElement | null = null;
  private currentId: string | null = null;
  private filter = "";

  mount(container: HTMLElement): void {
    this.container = container;
    container.classList.add("dc-help");
    this.render();
  }

  destroy(): void {
    if (this.container) clear(this.container);
    this.container = null;
  }

  /** Pass null for the index. */
  open(guideId: string | null): void {
    this.currentId = guideId;
    this.filter = "";
    this.render();
  }

  private render(): void {
    if (!this.container) return;
    clear(this.container);

    const guide = this.currentId ? findGuide(this.currentId) : null;
    if (guide) this.renderGuide(this.container, guide);
    else this.renderIndex(this.container);
  }

  private renderIndex(root: HTMLElement): void {
    root.appendChild(
      el(
        "p",
        "dc-help-intro",
        "Guides for running disturbance checks, setting the tool up, and maintaining it.",
      ),
    );

    const search = el("input", "dc-input");
    search.type = "search";
    search.placeholder = "Search the guides";
    search.value = this.filter;
    search.addEventListener("input", () => {
      this.filter = search.value.trim().toLowerCase();
      this.renderResults(results);
    });
    root.appendChild(search);

    const results = el("div", "dc-help-results");
    root.appendChild(results);
    this.renderResults(results);
  }

  private renderResults(host: HTMLElement): void {
    clear(host);

    if (this.filter) {
      // Search the rendered text as well as the title, so a term appearing only
      // in the body of a guide still finds it.
      const matches = GUIDES.filter((guide) => {
        const haystack = `${guide.title} ${guide.summary} ${stripTags(guide.html)}`;
        return haystack.toLowerCase().includes(this.filter);
      });
      if (matches.length === 0) {
        host.appendChild(el("p", "dc-hint", "No guide mentions that."));
        return;
      }
      for (const guide of matches) host.appendChild(this.card(guide));
      return;
    }

    for (const audience of AUDIENCE_ORDER) {
      const guides = guidesFor(audience);
      if (guides.length === 0) continue;
      host.appendChild(el("h4", "dc-help-heading", AUDIENCE_LABELS[audience]));
      for (const guide of guides) host.appendChild(this.card(guide));
    }
  }

  private card(guide: Guide): HTMLElement {
    const card = el("button", "dc-help-card");
    card.type = "button";
    card.appendChild(el("span", "dc-help-card-title", guide.title));
    card.appendChild(el("span", "dc-help-card-summary", guide.summary));
    card.addEventListener("click", () => this.open(guide.id));
    return card;
  }

  private renderGuide(root: HTMLElement, guide: Guide): void {
    const nav = el("div", "dc-help-nav");
    nav.appendChild(button("← All guides", () => this.open(null)));
    root.appendChild(nav);

    const article = el("article", "dc-help-body");
    // The HTML is produced at build time from markdown in this repository. It
    // is not user input and contains no scripts.
    article.innerHTML = guide.html;

    // Cross-document links were rewritten to #doc:<id> at build time. Intercept
    // them so they switch guides instead of navigating the host page.
    article.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement | null)?.closest("a");
      if (!target) return;
      const href = target.getAttribute("href") ?? "";
      if (href.startsWith("#doc:")) {
        event.preventDefault();
        const [id] = href.slice(5).split("#");
        if (findGuide(id)) this.open(id);
        return;
      }
      if (href.startsWith("http")) {
        target.setAttribute("target", "_blank");
        target.setAttribute("rel", "noopener noreferrer");
      }
    });

    root.appendChild(article);
    root.scrollTop = 0;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}
