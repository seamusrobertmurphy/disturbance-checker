// Hover card and right-click menu for the rows of GeoLibre's Layers panel.
//
// GeoLibre v1.9.0 shows almost nothing about a layer in its panel. Hovering a
// name only says "Double-click to rename", right click does nothing, and the
// "i" button opens the layer's metadata as raw JSON. This file adds a card that
// appears after a short hover and a menu on right click, both listing the
// layer's folder, kind, source, copy date, feature count, zoom range, whether
// it is showing, and its service address.
//
// It is copied into apps/geolibre-desktop/src/components/panels/ and wired into
// LayerPanel.tsx by scripts/patch-layer-info.mjs before the app is built. One
// LayerInfoOverlay is rendered per panel, and each row reaches it through
// layerInfoRowProps, so the patch to GeoLibre's own file stays four lines.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import type { GeoLibreLayer } from "@geolibre/core";

export interface LayerInfoActions {
  zoom: () => void;
  toggle: () => void;
  metadata: () => void;
}

type Overlay =
  | {
      kind: "card";
      layer: GeoLibreLayer;
      group?: string;
      notes: string[];
      rect: { left: number; right: number; top: number; bottom: number };
    }
  | {
      kind: "menu";
      layer: GeoLibreLayer;
      group?: string;
      notes: string[];
      x: number;
      y: number;
      actions: LayerInfoActions;
    }
  | null;

const HOVER_DELAY_MS = 450;
const MARGIN = 8;

let setOverlay: Dispatch<SetStateAction<Overlay>> | null = null;
let hoverTimer: number | undefined;

function cancelHover() {
  window.clearTimeout(hoverTimer);
  hoverTimer = undefined;
}

function closeCard() {
  cancelHover();
  setOverlay?.((current) => (current?.kind === "card" ? null : current));
}

// A row can be wider than the panel, which then scrolls sideways, so the card is
// placed from the part of the row the panel actually shows.
function visibleRect(row: HTMLElement) {
  const box = row.getBoundingClientRect();
  const panel = row.closest("aside")?.getBoundingClientRect();
  return {
    left: panel ? Math.max(box.left, panel.left) : box.left,
    right: panel ? Math.min(box.right, panel.right) : box.right,
    top: box.top,
    bottom: box.bottom,
  };
}

export function layerInfoRowProps(
  layer: GeoLibreLayer,
  group: string | undefined,
  notes: string[],
  actions: LayerInfoActions,
) {
  return {
    onMouseEnter: (event: ReactMouseEvent<HTMLElement>) => {
      const row = event.currentTarget;
      cancelHover();
      hoverTimer = window.setTimeout(() => {
        // An open menu stays open while the pointer crosses other rows.
        setOverlay?.((current) =>
          current?.kind === "menu"
            ? current
            : { kind: "card", layer, group, notes, rect: visibleRect(row) },
        );
      }, HOVER_DELAY_MS);
    },
    onMouseLeave: closeCard,
    onMouseDown: closeCard,
    onDragStart: closeCard,
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      cancelHover();
      setOverlay?.({
        kind: "menu",
        layer,
        group,
        notes,
        x: event.clientX,
        y: event.clientY,
        actions,
      });
    },
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Attribution strings are often HTML links, and only their words are shown.
function plain(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

const KINDS: Record<string, string> = {
  wms: "Map image service",
  wmts: "Map tile service",
  xyz: "Map tiles",
  raster: "Raster image",
  cog: "Cloud-optimised GeoTIFF",
  pmtiles: "Vector tiles (PMTiles)",
  geojson: "Vector features",
  vector: "Vector tiles",
};

export function layerAddress(layer: GeoLibreLayer): string | undefined {
  const tiles = layer.source?.tiles;
  return (
    text(layer.metadata?.serviceUrl) ??
    text(layer.source?.url) ??
    text(layer.sourcePath) ??
    (Array.isArray(tiles) ? text(tiles[0]) : undefined)
  );
}

function zoomRange(layer: GeoLibreLayer): string | undefined {
  const min = count(layer.source?.minzoom);
  const max = count(layer.source?.maxzoom);
  if (min !== undefined && max !== undefined) return `Draws at zoom ${min} to ${max}`;
  if (min !== undefined) return `Draws at zoom ${min} and closer`;
  if (max !== undefined) return `Draws at zoom ${max} and wider`;
  return undefined;
}

function facts(layer: GeoLibreLayer, group?: string): [string, string][] {
  const rows: [string, string | undefined][] = [
    ["Folder", group],
    ["Kind", KINDS[layer.type] ?? layer.type],
    [
      "Source",
      (() => {
        const source = text(layer.source?.attribution) ?? text(layer.metadata?.attribution);
        return source ? plain(source) : undefined;
      })(),
    ],
    ["Copied on", text(layer.metadata?.snapshotDate)],
    [
      "Features",
      (() => {
        const n = count(layer.metadata?.featureCount);
        return n === undefined ? undefined : n.toLocaleString("en-US");
      })(),
    ],
    ["Zoom", zoomRange(layer)],
    [
      "Showing",
      layer.visible ? `Yes, at ${Math.round(layer.opacity * 100)}% opacity` : "No",
    ],
    ["Address", layerAddress(layer)],
  ];
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}

function Facts({ layer, group, notes }: { layer: GeoLibreLayer; group?: string; notes: string[] }) {
  const description = text(layer.metadata?.description);
  return (
    <>
      <div className="break-words text-sm font-semibold leading-snug">{layer.name}</div>
      {description && <p className="mt-1 text-muted-foreground">{description}</p>}
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {facts(layer, group).map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={label === "Address" ? "break-all" : "break-words"}>{value}</dd>
          </Fragment>
        ))}
      </dl>
      {notes.map((note) => (
        <p key={note} className="mt-2 text-[11px] text-muted-foreground">
          {note}
        </p>
      ))}
    </>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

export function LayerInfoOverlay() {
  const [overlay, setState] = useState<Overlay>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOverlay = setState;
    return () => {
      if (setOverlay === setState) setOverlay = null;
      cancelHover();
    };
  }, []);

  // Place the box beside the row, or at the pointer for the menu, then pull it
  // back inside the window. On a narrow screen the card drops below the row.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!overlay || !box) {
      setPosition(null);
      return;
    }
    const { width, height } = box.getBoundingClientRect();
    const right = window.innerWidth - width - MARGIN;
    const bottom = window.innerHeight - height - MARGIN;
    let left: number;
    let top: number;
    if (overlay.kind === "card") {
      const row = overlay.rect;
      left = row.right + MARGIN;
      top = row.top;
      if (left > right) left = row.left - width - MARGIN;
      if (left < MARGIN) {
        left = row.left;
        top = row.bottom + 4;
      }
    } else {
      left = overlay.x > right ? overlay.x - width : overlay.x;
      top = overlay.y > bottom ? overlay.y - height : overlay.y;
    }
    setPosition({ left: clamp(left, MARGIN, right), top: clamp(top, MARGIN, bottom) });
  }, [overlay]);

  // A hidden element cannot take focus, so the menu is focused once placed.
  useEffect(() => {
    if (overlay?.kind === "menu" && position) {
      boxRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    }
  }, [overlay, position]);

  useEffect(() => {
    if (!overlay) return;
    const close = () => setState(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // The card is placed from its row, so scrolling the panel leaves it
    // pointing at the wrong row. The menu sits at the pointer and stays put,
    // because opening it can itself scroll the panel.
    const onScroll = overlay.kind === "card" ? close : undefined;
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    if (onScroll) document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      if (onScroll) document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [overlay]);

  if (!overlay) return null;

  const style = {
    left: position?.left ?? 0,
    top: position?.top ?? 0,
    visibility: position ? ("visible" as const) : ("hidden" as const),
  };
  const box =
    "fixed z-50 w-80 max-w-[calc(100vw-16px)] rounded-md border bg-popover text-xs text-popover-foreground shadow-md";

  if (overlay.kind === "card") {
    return createPortal(
      <div
        ref={boxRef}
        role="tooltip"
        data-testid="layer-info-card"
        className={`${box} pointer-events-none px-3 py-2`}
        style={style}
      >
        <Facts layer={overlay.layer} group={overlay.group} notes={overlay.notes} />
      </div>,
      document.body,
    );
  }

  const { layer, actions } = overlay;
  const address = layerAddress(layer);
  const web = address && /^https?:\/\//i.test(address) ? address : undefined;
  const run = (action: () => void) => () => {
    setState(null);
    action();
  };
  const items: { label: string; onSelect: () => void }[] = [
    { label: "Zoom to layer", onSelect: run(actions.zoom) },
    { label: layer.visible ? "Hide layer" : "Show layer", onSelect: run(actions.toggle) },
    ...(web
      ? [
          {
            label: "Open source in a new tab",
            onSelect: run(() => window.open(web, "_blank", "noopener,noreferrer")),
          },
        ]
      : []),
    ...(address
      ? [
          {
            label: "Copy address",
            onSelect: run(() => void navigator.clipboard?.writeText(address)),
          },
        ]
      : []),
    { label: "All metadata", onSelect: run(actions.metadata) },
  ];

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };

  return createPortal(
    <div
      ref={boxRef}
      role="menu"
      aria-label={`${layer.name} information`}
      data-testid="layer-info-menu"
      className={box}
      style={style}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="border-b px-3 py-2">
        <Facts layer={layer} group={overlay.group} notes={[]} />
      </div>
      <div className="p-1">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
            onClick={item.onSelect}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
