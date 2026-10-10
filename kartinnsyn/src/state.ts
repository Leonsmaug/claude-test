import { DEFAULT_VIEW } from "./config";
import { BASEMAPS, type BasemapId, type MapState, type OverlayId } from "./style";

/**
 * Hele kartets tilstand ligger i URL-en (#-delen), så en lenke gjenskaper
 * nøyaktig samme visning. Ingen database eller sesjon på serversiden.
 */

const OVERLAY_IDS: OverlayId[] = ["buildings3d", "places", "addresses", "boundaries", "hillshade"];
export const DEFAULT_OVERLAYS: OverlayId[] = ["places", "boundaries"];

export interface ViewState {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export function readHash(): { view: ViewState; partial: Partial<Omit<MapState, "release">> } {
  const h = new URLSearchParams(location.hash.slice(1));
  const view: ViewState = { ...DEFAULT_VIEW };
  const m = h.get("kart")?.split("/").map(Number);
  if (m && m.length >= 3 && m.every(Number.isFinite)) {
    view.zoom = m[0];
    view.center = [m[2], m[1]];
    view.bearing = m[3] ?? 0;
    view.pitch = m[4] ?? 0;
  }
  const partial: Partial<Omit<MapState, "release">> = {};
  const bm = h.get("bakgrunn") as BasemapId | null;
  if (bm && BASEMAPS.some((b) => b.id === bm)) partial.basemap = bm;
  if (h.has("lag")) {
    partial.overlays = new Set(
      h.get("lag")!.split(",").filter((id): id is OverlayId => OVERLAY_IDS.includes(id as OverlayId)),
    );
  }
  if (h.has("terreng")) partial.terrain = h.get("terreng") === "1";
  if (h.has("globus")) partial.globe = h.get("globus") === "1";
  return { view, partial };
}

export function writeHash(view: ViewState, s: MapState) {
  const r = (n: number, d: number) => Number(n.toFixed(d));
  const kart = [r(view.zoom, 2), r(view.center[1], 5), r(view.center[0], 5)];
  if (view.bearing || view.pitch) kart.push(r(view.bearing, 1), r(view.pitch, 0));
  const h = new URLSearchParams();
  h.set("kart", kart.join("/"));
  h.set("bakgrunn", s.basemap);
  h.set("lag", [...s.overlays].join(","));
  if (s.terrain) h.set("terreng", "1");
  if (s.globe) h.set("globus", "1");
  // Skråstreker og komma trenger ikke koding; gir penere lenker.
  const hash = "#" + h.toString().replace(/%2F/g, "/").replace(/%2C/g, ",");
  if (hash !== location.hash) history.replaceState(null, "", hash);
}
