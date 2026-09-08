export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function field(
  label: string,
  control: HTMLElement,
  hint?: string,
): HTMLElement {
  const wrap = el("label", "dc-field");
  wrap.appendChild(el("span", "dc-field-label", label));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(el("span", "dc-field-hint", hint));
  return wrap;
}

export function input(
  type: string,
  value: string,
  onChange: (value: string) => void,
): HTMLInputElement {
  const node = el("input", "dc-input");
  node.type = type;
  node.value = value;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

/**
 * A date typed as YYYY-MM-DD, not a native picker.
 *
 * The native control splits the value into three segments and gives the year
 * the narrowest one, so changing 2024 to 2019, which is most of what anyone
 * does here, meant clicking a four-character target and then arrowing or
 * overtyping it. A plain text field in ISO order puts the year first, where
 * select-all and four keystrokes replaces it.
 *
 * The value is only reported once it parses and round-trips, so a half-typed
 * date cannot reach the analysis; until then the field is marked invalid and
 * left alone.
 */
export function dateInput(
  value: string,
  onChange: (value: string) => void,
): HTMLInputElement {
  const node = el("input", "dc-input dc-input-date");
  node.type = "text";
  node.value = value;
  node.placeholder = "YYYY-MM-DD";
  node.inputMode = "numeric";
  node.autocomplete = "off";
  node.spellcheck = false;
  node.setAttribute("aria-label", "Date, four-digit year, month, day");

  const settle = () => {
    const text = node.value.trim();
    if (isIsoDate(text)) {
      node.removeAttribute("aria-invalid");
      node.classList.remove("dc-input-invalid");
      if (text !== value) onChange(text);
    } else {
      node.setAttribute("aria-invalid", "true");
      node.classList.add("dc-input-invalid");
    }
  };
  node.addEventListener("change", settle);
  node.addEventListener("blur", settle);
  return node;
}

/** The same month and day, in another year. */
export function withYear(iso: string, year: number): string {
  return `${String(year).padStart(4, "0")}${iso.slice(4)}`;
}

/**
 * How many new years a window crosses, usually none.
 *
 * A window running 1 August to 1 September stays inside its year and returns
 * zero. One running 15 December to 15 January returns one, so moving the start
 * year carries the end date with it instead of folding the window shut.
 */
export function spanYears(start: string, end: string): number {
  return Number(end.slice(0, 4)) - Number(start.slice(0, 4));
}

/** True when the text is a real calendar date in YYYY-MM-DD. */
export function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * A year the operator steps or types, which moves a whole window at once.
 *
 * A reporting period is nearly always the same fortnight in two different
 * years, so the year is the field that actually changes and the month and day
 * are the ones that stay. Editing it once per window rather than once per date
 * halves the typing and removes the commonest slip, a pre window moved to the
 * new year while its end date is left in the old one.
 */
export function yearInput(
  value: number,
  onChange: (year: number) => void,
): HTMLInputElement {
  const node = el("input", "dc-input dc-input-year");
  node.type = "number";
  node.min = "2015";
  node.max = String(new Date().getUTCFullYear() + 1);
  node.step = "1";
  node.value = String(value);
  node.addEventListener("change", () => {
    const year = Number(node.value);
    if (Number.isInteger(year) && year >= 2015 && year <= Number(node.max)) {
      if (year !== value) onChange(year);
    } else {
      node.value = String(value);
    }
  });
  return node;
}

export function select(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el("select", "dc-input");
  for (const option of options) {
    const item = el("option", "", option.label);
    item.value = option.value;
    node.appendChild(item);
  }
  node.value = value;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  variant: "primary" | "secondary" = "secondary",
): HTMLButtonElement {
  const node = el("button", `dc-button dc-button-${variant}`, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

export function formatHectares(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes <= 0) return "under a minute";
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
