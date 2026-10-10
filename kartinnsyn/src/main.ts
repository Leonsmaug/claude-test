import {
  addProtocol,
  AttributionControl,
  FullscreenControl,
  GeolocateControl,
  getVersion,
  LngLatBounds,
  Map as MlMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre 6 kjører fliseparsing i en ES-modul-worker; Vite bunter den som egen fil.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";
import "./app.css";
import { resolveOvertureRelease } from "./config";
import { download, exportGeoLibreProject } from "./geolibre";
import { featureTitle, renderFeatureInfo } from "./info";
import { MeasureTool } from "./measure";
import { geocode, parseCoordinates, searchLoadedPlaces, type SearchResult } from "./search";
import { DEFAULT_OVERLAYS, readHash, writeHash } from "./state";
import {
  BASEMAPS,
  composeStyle,
  isDarkBasemap,
  PLACE_GROUPS,
  QUERYABLE_LAYERS,
  sourceId,
  type MapState,
  type OverlayId,
} from "./style";

setWorkerUrl(maplibreWorkerUrl);

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// PMTiles-protokollen lar MapLibre lese fliser rett fra én fil i objektlagring.
const pmtiles = new Protocol({ metadata: true });
addProtocol("pmtiles", pmtiles.tile);

const OVERLAYS: { id: OverlayId; label: string; note: string }[] = [
  { id: "places", label: "Steder og virksomheter", note: "Overture Places · fra zoom 14" },
  { id: "buildings3d", label: "Bygninger i 3D", note: "Overture Buildings med høyder" },
  { id: "addresses", label: "Adresser", note: "Overture Addresses · fra zoom 17" },
  { id: "boundaries", label: "Administrative grenser", note: "Overture Divisions" },
  { id: "hillshade", label: "Terrengskygge", note: "Åpen høydemodell (AWS)" },
];

const prefersDark = matchMedia("(prefers-color-scheme: dark)");
const { view: initialView, partial } = readHash();

const state: MapState = {
  release: "",
  basemap: partial.basemap ?? (prefersDark.matches ? "overture-dark" : "overture-light"),
  overlays: partial.overlays ?? new Set(DEFAULT_OVERLAYS),
  terrain: partial.terrain ?? false,
  globe: partial.globe ?? false,
};

// ---------- Tema for grensesnittet ----------

type Theme = "light" | "dark";
function storedTheme(): Theme | null {
  try {
    const t = localStorage.getItem("kartinnsyn:theme");
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}
function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}
applyTheme(storedTheme() ?? (isDarkBasemap(state.basemap) || prefersDark.matches ? "dark" : "light"));

// ---------- Kart ----------

state.release = await resolveOvertureRelease();
$("#release").textContent = state.release;
$("#ml-version").textContent = getVersion();

const map = new MlMap({
  container: "map",
  style: await composeStyle(state),
  center: initialView.center,
  zoom: initialView.zoom,
  bearing: initialView.bearing,
  pitch: initialView.pitch,
  maxPitch: 85,
  hash: false,
  attributionControl: false,
  canvasContextAttributes: { antialias: true },
  cancelPendingTileRequestsWhileZooming: true,
});

map.addControl(new AttributionControl({ compact: true }), "bottom-right");
map.addControl(new NavigationControl({ visualizePitch: true, showZoom: true }), "top-right");
const geolocate = new GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: true,
  showAccuracyCircle: true,
});
map.addControl(geolocate, "top-right");
map.addControl(new FullscreenControl({ container: document.body }), "top-right");
map.addControl(new ScaleControl({ unit: "metric", maxWidth: 120 }), "bottom-left");

let styleSeq = 0;
let lastGoodBasemap = state.basemap;
async function refreshStyle() {
  const seq = ++styleSeq;
  try {
    const style = await composeStyle(state);
    if (seq !== styleSeq) return;
    map.setStyle(style, { diff: true });
    lastGoodBasemap = state.basemap;
    map.once("styledata", () => {
      measure.update();
      setSelection(selected);
    });
  } catch (err) {
    console.error(err);
    toast("Kunne ikke laste bakgrunnskartet. Prøv et annet.");
    // Vis det kartet som faktisk ligger i bruk.
    state.basemap = lastGoodBasemap;
    renderBasemaps();
  }
  syncControls();
  saveHash();
}

let hashTimer = 0;
function saveHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    const c = map.getCenter();
    writeHash({ center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }, state);
  }, 250);
}
map.on("moveend", saveHash);
map.once("load", saveHash);

// Lastestripe øverst mens fliser hentes.
const progress = $("#progress");
map.on("dataloading", () => progress.classList.add("on"));
map.on("idle", () => progress.classList.remove("on"));

map.on("error", (e) => {
  const msg = String((e.error as Error | undefined)?.message ?? "");
  // Manglende enkeltfliser er normalt utenfor dekningsområdet; ikke støy for brukeren.
  if (/404|Not Found|AbortError/.test(msg)) return;
  console.warn(e.error);
});

// ---------- Panel og faner ----------

const panel = $("#panel");
const panelToggle = $("#panel-toggle");
function setPanel(open: boolean) {
  panel.classList.toggle("closed", !open);
  panelToggle.setAttribute("aria-expanded", String(open));
}
setPanel(innerWidth > 720);
panelToggle.addEventListener("click", () => setPanel(panel.classList.contains("closed")));
$(".grip").addEventListener("click", () => panel.classList.toggle("expanded"));

for (const tab of document.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      $(`#${t.getAttribute("aria-controls")}`).hidden = !on;
    }
  });
}

$("#theme-toggle").addEventListener("click", () => {
  const next: Theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem("kartinnsyn:theme", next);
  } catch {
    /* valgfritt */
  }
  // Følg med på kartet hvis brukeren står på en Overture-stil.
  if (state.basemap === "overture-light" || state.basemap === "overture-dark") {
    state.basemap = next === "dark" ? "overture-dark" : "overture-light";
    renderBasemaps();
    refreshStyle();
  }
});

function renderBasemaps() {
  const el = $("#basemaps");
  el.innerHTML = BASEMAPS.map(
    (b) => `
    <button role="radio" aria-checked="${b.id === state.basemap}" data-basemap="${b.id}" class="basemap bm-${b.id}">
      <span class="thumb" aria-hidden="true"></span>
      <span class="bm-label">${b.label}</span>
      <span class="bm-note">${b.note}</span>
    </button>`,
  ).join("");
}
$("#basemaps").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-basemap]");
  if (!btn) return;
  state.basemap = btn.dataset.basemap as MapState["basemap"];
  renderBasemaps();
  refreshStyle();
});

function renderOverlays() {
  $("#overlays").innerHTML = OVERLAYS.map(
    (o) => `
    <li>
      <label class="switch">
        <input type="checkbox" data-overlay="${o.id}" ${state.overlays.has(o.id) ? "checked" : ""} />
        <span class="track" aria-hidden="true"></span>
        <span class="sw-text"><span>${o.label}</span><small>${o.note}</small></span>
      </label>
    </li>`,
  ).join("");
  $("#legend").innerHTML =
    PLACE_GROUPS.map((g) => `<li><span class="dot" style="background:${g.color}"></span>${g.label}</li>`).join("") +
    `<li><span class="dot" style="background:#868e96"></span>Annet</li>`;
}
$("#overlays").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.dataset.overlay as OverlayId;
  if (input.checked) state.overlays.add(id);
  else state.overlays.delete(id);
  if (id === "buildings3d" && input.checked && map.getPitch() < 20) {
    map.easeTo({ pitch: 55, zoom: Math.max(map.getZoom(), 15.5), duration: 1200 });
  }
  refreshStyle();
});

renderBasemaps();
renderOverlays();

// ---------- Objektinfo ----------

const info = $("#info");
let selected: MapGeoJSONFeature | null = null;
let selectedAt: [number, number] | null = null;

function setSelection(f: MapGeoJSONFeature | null) {
  const src = map.getSource(sourceId(state, "selection")) as GeoJSONSource | undefined;
  src?.setData({
    type: "FeatureCollection",
    features: f ? [{ type: "Feature", properties: selectionProps(f), geometry: f.geometry }] : [],
  });
}

/** Høyde for 3D-markering av valgt bygning, samme regel som i stilen. */
function selectionProps(f: MapGeoJSONFeature): Record<string, number> {
  const p = f.properties ?? {};
  if (f.sourceLayer !== "building" && f.sourceLayer !== "building_part") return {};
  const h = typeof p.height === "number" ? p.height : (typeof p.num_floors === "number" ? p.num_floors : 2) * 3.2;
  return { h, b: typeof p.min_height === "number" ? p.min_height : 0 };
}

function showInfo(f: MapGeoJSONFeature, at: [number, number]) {
  selected = f;
  selectedAt = at;
  info.querySelector(".info-body")!.innerHTML = renderFeatureInfo(f);
  const z = Math.max(16, Math.round(map.getZoom()));
  info.querySelector<HTMLAnchorElement>(".osm-link")!.href =
    `https://www.openstreetmap.org/?mlat=${at[1].toFixed(6)}&mlon=${at[0].toFixed(6)}#map=${z}/${at[1].toFixed(5)}/${at[0].toFixed(5)}`;
  info.hidden = false;
  setSelection(f);
}

function hideInfo() {
  info.hidden = true;
  selected = null;
  setSelection(null);
}
info.querySelector(".close")!.addEventListener("click", hideInfo);
info.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const copy = t.closest<HTMLElement>("[data-copy]");
  if (copy) copyText(copy.dataset.copy!, "GERS-ID kopiert");
  if (t.closest('[data-action="zoom-feature"]') && selected) {
    const b = new LngLatBounds();
    const walk = (c: unknown): void => {
      if (typeof (c as number[])[0] === "number") b.extend(c as [number, number]);
      else (c as unknown[]).forEach(walk);
    };
    if ("coordinates" in selected.geometry) walk(selected.geometry.coordinates);
    if (b.isEmpty() && selectedAt) b.extend(selectedAt);
    map.fitBounds(b, { padding: 80, maxZoom: 18, duration: 900 });
  }
});

function queryableLayers() {
  return QUERYABLE_LAYERS.filter((id) => map.getLayer(id));
}

map.on("click", (e: MapMouseEvent) => {
  if (measure.active) return;
  const pad = 4;
  const feats = map.queryRenderedFeatures(
    [
      [e.point.x - pad, e.point.y - pad],
      [e.point.x + pad, e.point.y + pad],
    ],
    { layers: queryableLayers() },
  );
  const order = queryableLayers();
  feats.sort((a, b) => order.indexOf(a.layer.id) - order.indexOf(b.layer.id));
  if (feats[0]) showInfo(feats[0], [e.lngLat.lng, e.lngLat.lat]);
  else hideInfo();
});

// Pekerform og verktøytips ved hover (kun mus).
const hoverTip = document.createElement("div");
hoverTip.className = "hover-tip";
document.body.append(hoverTip);
map.on("mousemove", (e) => {
  updateCoords(e.lngLat.lng, e.lngLat.lat);
  if (measure.active) return;
  const f = map.queryRenderedFeatures(e.point, { layers: queryableLayers() })[0];
  map.getCanvas().style.cursor = f ? "pointer" : "";
  if (f && (f.layer.id.startsWith("places") || f.layer.id === "addresses")) {
    hoverTip.textContent = featureTitle(f);
    hoverTip.style.transform = `translate(${e.originalEvent.clientX + 14}px, ${e.originalEvent.clientY + 14}px)`;
    hoverTip.classList.add("on");
  } else hoverTip.classList.remove("on");
});
map.getCanvas().addEventListener("mouseleave", () => hoverTip.classList.remove("on"));

// ---------- Koordinater og status ----------

const coordsEl = $("#coords");
let lastCoord: [number, number] = initialView.center;
function updateCoords(lng: number, lat: number) {
  lastCoord = [lng, lat];
  coordsEl.textContent = `${lat.toFixed(5)}° N, ${lng.toFixed(5)}° Ø`;
}
coordsEl.addEventListener("click", () => copyText(`${lastCoord[1].toFixed(6)}, ${lastCoord[0].toFixed(6)}`, "Koordinat kopiert"));
const zoomEl = $("#zoom-level");
const updateZoom = () => (zoomEl.textContent = `z ${map.getZoom().toFixed(1)}`);
map.on("zoom", updateZoom);
updateCoords(...initialView.center);
updateZoom();

// ---------- Måling ----------

const measureBar = $("#measure-bar");
const measure = new MeasureTool(map, () => sourceId(state, "measure"), (summary) => {
  measureBar.hidden = summary === null;
  if (summary) measureBar.querySelector(".measure-text")!.innerHTML = summary;
});
measureBar.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
  if (a === "measure-undo") measure.undo();
  if (a === "measure-finish") measure.finish();
  if (a === "measure-stop") measure.stop();
});

// ---------- Verktøy ----------

function syncControls() {
  const pressed = (action: string, on: boolean) =>
    document.querySelector(`[data-action="${action}"]`)?.setAttribute("aria-pressed", String(on));
  pressed("toggle-3d", map.getPitch() > 5);
  pressed("toggle-terrain", state.terrain);
  pressed("toggle-globe", state.globe);
}
map.on("pitchend", syncControls);

function toggle3d() {
  const to3d = map.getPitch() < 5;
  if (to3d && !state.overlays.has("buildings3d")) {
    state.overlays.add("buildings3d");
    renderOverlays();
    refreshStyle();
  }
  map.easeTo({ pitch: to3d ? 60 : 0, bearing: to3d ? map.getBearing() || -20 : 0, duration: 1000 });
}

async function exportPng() {
  toast("Lager bilde …");
  await new Promise<void>((resolve) => {
    map.once("render", () => resolve());
    map.triggerRepaint();
  });
  const src = map.getCanvas();
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
  // Attribusjon må følge med bildet.
  const text = `© Overture Maps Foundation · © OpenStreetMap-bidragsytere · ${new Date().toLocaleDateString("nb-NO")}`;
  const s = devicePixelRatio;
  ctx.font = `${12 * s}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 16 * s;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(out.width - w, out.height - 22 * s, w, 22 * s);
  ctx.fillStyle = "#222";
  ctx.fillText(text, out.width - w + 8 * s, out.height - 7 * s);
  out.toBlob((blob) => blob && download(blob, `kartinnsyn-${new Date().toISOString().slice(0, 10)}.png`), "image/png");
}

async function share() {
  saveHash();
  await new Promise((r) => setTimeout(r, 300));
  const url = location.href;
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title: "Kartinnsyn", url });
      return;
    } catch {
      /* avbrutt, fall tilbake til kopiering */
    }
  }
  copyText(url, "Lenke til kartvisningen er kopiert");
}

const actions: Record<string, () => void> = {
  "measure-distance": () => (closeOnMobile(), measure.start("distance")),
  "measure-area": () => (closeOnMobile(), measure.start("area")),
  "toggle-3d": toggle3d,
  "toggle-terrain": () => {
    state.terrain = !state.terrain;
    if (state.terrain && map.getPitch() < 20) map.easeTo({ pitch: 60, duration: 1000 });
    refreshStyle();
  },
  "toggle-globe": () => {
    state.globe = !state.globe;
    if (state.globe && map.getZoom() > 5) map.flyTo({ zoom: 2.5, pitch: 0, duration: 1600 });
    refreshStyle();
  },
  locate: () => (closeOnMobile(), geolocate.trigger()),
  share: () => void share(),
  "export-png": () => void exportPng(),
  print: () => window.print(),
  "export-geolibre": () =>
    void exportGeoLibreProject(map, state)
      .then(() => toast("GeoLibre-prosjekt lastet ned. Åpne det i geolibre.app."))
      .catch((err) => (console.error(err), toast("Eksport til GeoLibre feilet"))),
};
$("#tab-verktoy").addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
  if (a && actions[a]) actions[a]();
});

function closeOnMobile() {
  if (innerWidth <= 720) setPanel(false);
}

// ---------- Søk ----------

const input = $<HTMLInputElement>("#search-input");
const list = $<HTMLUListElement>("#search-results");
let results: SearchResult[] = [];
let active = -1;
let abort: AbortController | null = null;
let searchTimer = 0;
let marker: Marker | null = null;

function renderResults(state: "ok" | "loading" | "error" = "ok") {
  if (!results.length && state === "ok" && input.value.trim().length < 2) {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    return;
  }
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
  const items = results.map(
    (r, i) => `
    <li role="option" id="sr-${i}" aria-selected="${i === active}" data-i="${i}">
      <span class="sr-label">${escapeHtml(r.label)}</span>
      <span class="sr-detail">${escapeHtml(r.detail)}</span>
      <span class="sr-src">${r.source}</span>
    </li>`,
  );
  if (state === "loading") items.push(`<li class="sr-status">Søker …</li>`);
  if (state === "error") items.push(`<li class="sr-status">Nettsøket svarte ikke. Viser bare treff i kartet.</li>`);
  if (state === "ok" && !results.length) items.push(`<li class="sr-status">Ingen treff</li>`);
  list.innerHTML = items.join("");
  input.setAttribute("aria-activedescendant", active >= 0 ? `sr-${active}` : "");
}

function runSearch() {
  const q = input.value.trim();
  abort?.abort();
  active = -1;
  const coord = parseCoordinates(q);
  const local = searchLoadedPlaces(map, sourceId(state, "places"), q);
  results = [...(coord ? [coord] : []), ...local];
  if (q.length < 3 || coord) return renderResults();
  renderResults("loading");
  abort = new AbortController();
  const c = map.getCenter();
  geocode(q, [c.lng, c.lat], abort.signal)
    .then((remote) => {
      results = [...local, ...remote];
      renderResults();
    })
    .catch((err) => {
      if ((err as Error).name !== "AbortError") renderResults("error");
    });
}

function choose(r: SearchResult) {
  list.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.value = r.label;
  input.blur();
  marker?.remove();
  marker = new Marker({ color: "#ff3b6b" }).setLngLat(r.center).addTo(map);
  closeOnMobile();
  if (r.bbox && r.bbox[0] !== r.bbox[2]) map.fitBounds(r.bbox, { padding: 60, maxZoom: 17, duration: 1400 });
  else map.flyTo({ center: r.center, zoom: Math.max(map.getZoom(), 17), duration: 1400 });
}

input.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 220);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!results.length) return;
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
    renderResults();
  } else if (e.key === "Enter") {
    const r = results[Math.max(active, 0)];
    if (r) choose(r);
  } else if (e.key === "Escape") {
    input.value = "";
    results = [];
    renderResults();
    marker?.remove();
    input.blur();
  }
});
list.addEventListener("mousedown", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
  if (li) {
    e.preventDefault();
    choose(results[Number(li.dataset.i)]);
  }
});
input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
input.addEventListener("focus", () => results.length && renderResults());

// ---------- Hurtigtaster ----------

document.addEventListener("keydown", (e) => {
  const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable]");
  if (e.key === "Escape") {
    if (measure.active) measure.stop();
    else if (!info.hidden) hideInfo();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") {
    e.preventDefault();
    input.focus();
  } else if (e.key === "m") measure.start("distance");
  else if (e.key === "a") measure.start("area");
  else if (e.key === "3") toggle3d();
});

// ---------- Hjelpere ----------

const toastEl = $("#toast");
let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("on"), 2600);
}

async function copyText(text: string, msg: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    prompt("Kopier:", text);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

syncControls();

// Lenker med ny #-del (f.eks. limt inn) skal flytte kartet.
addEventListener("hashchange", () => {
  const { view } = readHash();
  map.jumpTo({ center: view.center, zoom: view.zoom, bearing: view.bearing, pitch: view.pitch });
});

// Offline-støtte for appskallet (PWA). Kartfliser hentes alltid ferskt.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// Gjør kartet tilgjengelig for feilsøking i konsollen.
Object.assign(window, { kart: map, kartState: state });
