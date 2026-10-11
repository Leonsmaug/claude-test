/**
 * Kartlab: kart + Claude som kjører som Artifact på claude.ai.
 *
 * Alt kjører i nettleseren. Claude nås gjennom plattformens `sample`-funksjon
 * (brukerens egen Claude-konto, ingen API-nøkkel), og får et sett verktøy som
 * er vanlige funksjoner i denne siden: søk, statistikk og styring av kartet.
 * Dataene er utsnitt fra Overture Maps som Claude Code har klargjort.
 */
import type * as GeoJSON from "geojson";
import type { ExpressionSpecification, GeoJSONSource, LayerSpecification, Map as MlMap, MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";
import { composeStyle, PLACE_GROUPS, type MapState } from "../../src/style";
import { renderFeatureInfo } from "../../src/info";
import { distance } from "../../src/measure";

declare const maplibregl: typeof import("maplibre-gl");
declare const pmtiles: typeof import("pmtiles");

// ---------- Plattform (claude.ai) ----------

type SampleTool = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: { signal: AbortSignal }) => unknown;
};
type SampleFn = ((input: string | { role: "user" | "assistant"; content: string }[], opts?: Record<string, unknown>) => Promise<{ text: string; truncated: boolean }>) & {
  limits(): Promise<{ tools?: { maxCount: number } }>;
};
type SampleError = { code: string; message: string; text?: string };
type DocSnap = { id: string; exists: boolean; data(): Record<string, unknown> | undefined };
type DB = {
  collection(p: string): {
    add(d: Record<string, unknown>): Promise<unknown>;
    doc(id: string): { delete(): Promise<void> };
    orderBy(f: string, d?: "asc" | "desc"): { limit(n: number): { onSnapshot(next: (s: { docs: DocSnap[] }) => void, err?: (e: { code: string }) => void): () => void } };
  };
};
type UserNs = {
  id(): Promise<string | null>;
  can(name: string): Promise<boolean | null>;
  profiles(ids: string[]): Promise<Record<string, { name: string; avatarUrl: string; isMe: boolean }>>;
};
type Downloads = { save(r: { filename: string; data: string | Blob }): Promise<{ status: string }> };
type ClaudeRuntime = { use(name: string): Promise<unknown> };
const runtime = (window as unknown as { claude?: ClaudeRuntime }).claude;
const use = <T>(name: string) => (runtime ? (runtime.use(name) as Promise<T | null>) : Promise.resolve(null));

/** Byspesifikk konfigurasjon som build.mjs legger inn fra areas.json. */
const AREA = (window as unknown as { KARTLAB_AREA: {
  name: string; areaChip: string; areaTitle: string;
  start: { center: [number, number]; zoom: number; pitch: number; bearing: number };
} }).KARTLAB_AREA;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const nf = (n: number, d = 0) => n.toLocaleString("nb-NO", { maximumFractionDigits: d });

// ---------- Faner ----------

for (const tab of document.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
  tab.addEventListener("click", () => selectTab(tab.id));
}
function selectTab(id: string) {
  for (const t of document.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const on = t.id === id;
    t.setAttribute("aria-selected", String(on));
    $(`#${t.getAttribute("aria-controls")}`).hidden = !on;
  }
  if (id === "t-kart") map?.resize();
}
const initialTab = { analyse: "t-analyse", skalering: "t-skala" }[location.hash.slice(1)];
if (initialTab) selectTab(initialTab);

// ---------- Data ----------

const DATA_FILES = ["base", "transportation", "buildings", "places", "divisions"] as const;

interface Place {
  name: string; cat: string | null; grp: string; lon: number; lat: number; conf: number;
  addr: string | null; web: string | null; phone: string | null; brand: string | null;
  status: string | null; datasets: string[]; bydel?: string;
}
interface Building {
  name: string | null; subtype: string | null; class: string | null; lon: number; lat: number;
  h: number | null; floors: number | null; area_m2: number | null; dataset: string | null; bydel?: string;
}
interface District {
  type: "Feature";
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  properties: { navn: string; km2: number; etikett: [number, number]; steder: number; servering: number; bygninger: number; snitthoyde: number | null; steder_per_km2: number };
}
interface Analysis {
  by: string; omradetype: string; omrader_metode: "polygoner" | "voronoi";
  release: string; bbox: number[]; antall: Record<string, number>;
  grupper: [string, number][]; toppkategorier: [string, number][];
  datasett_steder: [string, number][]; datasett_bygninger: [string, number][];
  hoydefordeling: [string, number][]; hoyeste: [string, number, number, number, boolean][];
  storste: [string, number, number, number][];
  bydeler: [string, number, number, number, number, number, number][];
  steg: { steg: string; sekunder: number | null; hurtigbuffer?: boolean }[];
}

const loadText = $("#load-text");
const loadBar = $("#load-bar");
let loadedBytes = 0;
const totalBytes = Number($("#loader").dataset.bytes) || 1;

async function fetchBytes(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loadedBytes += value.length;
    const pct = Math.min(100, (loadedBytes / totalBytes) * 100);
    loadBar.style.width = `${pct}%`;
    loadText.textContent = `Laster Overture-data … ${nf(loadedBytes / 1e6, 1)} av ${nf(totalBytes / 1e6, 0)} MB`;
  }
  return new Blob(parts as BlobPart[]);
}
async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await (await fetchBytes(url)).text()) as T;
}
function rowsToObjects<T>(t: { columns: string[]; rows: unknown[][] }): T[] {
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])) as T);
}

// Punkt-i-polygon for å knytte steder og bygninger til bydel.
function inRing(x: number, y: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(x: number, y: number, g: District["geometry"]) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
}

const protocol = new pmtiles.Protocol({ metadata: true });
maplibregl.addProtocol("pmtiles", protocol.tile);

/** Artifacts serverer ikke binærfiler, så PMTiles og glyfer ligger som base64-tekst. */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Glyfer: ett base64-tekstområde per fil, hentet når MapLibre ber om det.
const FONT_DIRS: Record<string, string> = { "Noto Sans Regular": "regular", "Noto Sans Italic": "italic" };
maplibregl.addProtocol("glyphs", async (params) => {
  const m = /^glyphs:\/\/([^/]+)\/(\d+-\d+)\.pbf$/.exec(params.url);
  const stack = m ? decodeURIComponent(m[1]).split(",")[0].trim() : "";
  const res = m ? await fetch(`fonts/${FONT_DIRS[stack] ?? "regular"}/${m[2]}.txt`).catch(() => null) : null;
  // Manglende tegnområder (f.eks. arabisk) gir tom glyf-fil i stedet for feil.
  return { data: res?.ok ? fromBase64(await res.text()).buffer : new ArrayBuffer(0) };
});

let places: Place[] = [];
let buildings: Building[] = [];
let districts: District[] = [];
let analysis: Analysis;

async function loadAll() {
  const tiles = DATA_FILES.map(async (t) => {
    const text = await (await fetchBytes(`data/${t}.pmtiles.txt`)).text();
    const bytes = fromBase64(text);
    protocol.add(new pmtiles.PMTiles(new pmtiles.FileSource(new File([bytes as BlobPart], `${t}.pmtiles`))));
  });
  const [p, b, d, a] = await Promise.all([
    fetchJson<{ columns: string[]; rows: unknown[][] }>("data/places.json"),
    fetchJson<{ columns: string[]; rows: unknown[][] }>("data/buildings.json"),
    fetchJson<{ features: District[] }>("data/districts.geojson"),
    fetchJson<Analysis>("data/analysis.json"),
    ...tiles,
  ]);
  places = rowsToObjects<Place>(p);
  buildings = rowsToObjects<Building>(b);
  districts = d.features;
  analysis = a;
  const assign = (o: { lon: number; lat: number; bydel?: string }) => {
    o.bydel = districts.find((f) => inPolygon(o.lon, o.lat, f.geometry))?.properties.navn;
  };
  places.forEach(assign);
  buildings.forEach(assign);
}

// ---------- Kart ----------

const prefersDark = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : prefersDark.matches;
};

type DistrictMetric = "steder_per_km2" | "servering_per_km2" | "snitthoyde" | "bygninger_per_km2";
const view = {
  places: true,
  buildings3d: true,
  heat: false,
  heightColor: false,
  districts: null as DistrictMetric | null,
  dark: isDark(),
};

const mapState = (): MapState => ({
  release: "",
  basemap: view.dark ? "overture-dark" : "overture-light",
  overlays: new Set([...(view.places ? ["places" as const] : []), ...(view.buildings3d ? ["buildings3d" as const] : []), "boundaries" as const]),
  terrain: false,
  globe: false,
  tileUrl: (t) => `pmtiles://${t}.pmtiles`,
  glyphs: "glyphs://{fontstack}/{range}.pbf",
});

let hits: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const METRIC_LABEL: Record<DistrictMetric, string> = {
  steder_per_km2: "Steder per km²",
  servering_per_km2: "Serveringssteder per km²",
  snitthoyde: "Snitthøyde bygninger (m)",
  bygninger_per_km2: "Bygninger per km²",
};

function districtData(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: districts.map((d) => ({
      ...d,
      properties: {
        ...d.properties,
        servering_per_km2: Math.round(d.properties.servering / d.properties.km2),
        bygninger_per_km2: Math.round(d.properties.bygninger / d.properties.km2),
      },
    })),
  };
}

async function buildStyle(): Promise<StyleSpecification> {
  const style = await composeStyle(mapState());
  // Kildene som ikke finnes i utsnittet fjernes (adresser og høydemodell).
  delete style.sources.addresses;
  delete style.sources.dem;

  style.sources.districts = { type: "geojson", data: districtData() };
  style.sources.placepts = {
    type: "geojson",
    data: { type: "FeatureCollection", features: places.map((p) => ({ type: "Feature", properties: { g: p.grp }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })) },
  };
  style.sources.hits = { type: "geojson", data: hits };
  // Ett etikettpunkt per område, også når området består av mange biter (øyer, nes).
  style.sources.districtlabels = {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: districtData().features.map((f) => ({ type: "Feature", properties: f.properties, geometry: { type: "Point", coordinates: (f.properties as District["properties"]).etikett } })),
    },
  };

  const layers = style.layers;
  const insertBefore = (id: string, ...ls: LayerSpecification[]) => {
    const i = layers.findIndex((l) => l.id === id);
    layers.splice(i < 0 ? layers.length : i, 0, ...ls);
  };

  if (view.districts) {
    const metric = view.districts;
    const values = districtData().features.map((f) => Number(f.properties?.[metric]) || 0);
    const max = Math.max(...values, 1);
    insertBefore(
      "road-generalized",
      {
        id: "districts-fill",
        type: "fill",
        source: "districts",
        paint: {
          "fill-color": ["interpolate", ["linear"], ["get", metric], 0, view.dark ? "#1b2b3a" : "#e8f1f6", max * 0.5, "#4a9cc4", max, "#d9480f"],
          "fill-opacity": 0.55,
        },
      },
      { id: "districts-line", type: "line", source: "districts", paint: { "line-color": view.dark ? "#cfe3ef" : "#1d4e66", "line-width": 1.2, "line-opacity": 0.7 } },
    );
    layers.push({
      id: "districts-label",
      type: "symbol",
      source: "districtlabels",
      layout: {
        "text-field": ["concat", ["get", "navn"], "\n", ["to-string", ["get", metric]]],
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
      },
      paint: { "text-color": view.dark ? "#f1f5f8" : "#10232e", "text-halo-color": view.dark ? "#0b1218" : "#ffffff", "text-halo-width": 1.6 },
    });
  }

  if (view.heat) {
    insertBefore("buildings-3d", {
      id: "heat",
      type: "heatmap",
      source: "placepts",
      maxzoom: 17,
      paint: {
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 11, 8, 15, 26],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 15, 1.4],
        "heatmap-opacity": 0.75,
        "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.2, "#2b83ba", 0.45, "#abdda4", 0.65, "#fdae61", 0.9, "#d7191c"],
      },
    });
  }

  if (view.heightColor) {
    for (const id of ["buildings-3d", "building-parts-3d"]) {
      const l = layers.find((x) => x.id === id) as { paint?: Record<string, unknown> } | undefined;
      if (l?.paint) {
        l.paint["fill-extrusion-color"] = [
          "interpolate", ["linear"], ["coalesce", ["get", "height"], ["*", ["coalesce", ["get", "num_floors"], 2], 3.2]],
          0, "#3b6fb6", 12, "#66b2a6", 25, "#f2c14e", 45, "#e8743b", 70, "#c0392b",
        ] as ExpressionSpecification;
      }
    }
  }

  layers.push(
    { id: "hits-halo", type: "circle", source: "hits", paint: { "circle-radius": 11, "circle-color": "#ff3b6b", "circle-opacity": 0.22 } },
    { id: "hits-circle", type: "circle", source: "hits", paint: { "circle-radius": 5.5, "circle-color": "#ff3b6b", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } },
    {
      id: "hits-label",
      type: "symbol",
      source: "hits",
      layout: { "text-field": ["get", "navn"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-max-width": 10, "text-optional": true },
      paint: { "text-color": view.dark ? "#ffd1dc" : "#a3123b", "text-halo-color": view.dark ? "#000" : "#fff", "text-halo-width": 1.6 },
    },
  );
  return style;
}

let map: MlMap;
/** Målt høyde, ellers estimert fra etasjer (3,2 m per etasje). */
const estHeight = (b: Building) => b.h ?? (b.floors != null ? Number((b.floors * 3.2).toFixed(1)) : null);

async function refresh() {
  map.setStyle(await buildStyle(), { diff: true });
  renderLayerControls();
}

function setHits(list: { lon: number; lat: number; navn: string }[]) {
  hits = {
    type: "FeatureCollection",
    features: list.map((p) => ({ type: "Feature", properties: { navn: p.navn }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })),
  };
  (map.getSource("hits") as GeoJSONSource | undefined)?.setData(hits);
}

function fitTo(points: { lon: number; lat: number }[], maxZoom = 16.5) {
  if (!points.length) return;
  if (points.length === 1) {
    map.flyTo({ center: [points[0].lon, points[0].lat], zoom: Math.max(map.getZoom(), 16), duration: 1200 });
    return;
  }
  const b = new maplibregl.LngLatBounds();
  points.forEach((p) => b.extend([p.lon, p.lat]));
  map.fitBounds(b, { padding: { top: 70, bottom: 70, left: chatWidth() + 50, right: 70 }, maxZoom, duration: 1200 });
}
function chatWidth() {
  return innerWidth > 860 ? $("#chat").getBoundingClientRect().width : 0;
}

// Lagkontroller i kartet
function renderLayerControls() {
  const el = $("#layer-controls");
  const chip = (key: string, label: string, on: boolean) =>
    `<button class="chip" data-layer="${key}" aria-pressed="${on}">${label}</button>`;
  el.innerHTML = [
    chip("places", "Steder", view.places),
    chip("buildings3d", "3D-bygg", view.buildings3d),
    chip("heightColor", "Høydefarger", view.heightColor),
    chip("heat", "Varmekart", view.heat),
    chip("districts", view.districts ? METRIC_LABEL[view.districts] : AREA.areaChip, !!view.districts),
  ].join("");
  $("#legend").innerHTML = view.districts
    ? `<strong>${METRIC_LABEL[view.districts]}</strong><span class="ramp"></span><small>lav → høy · Claude Code-analyse (DuckDB)</small>`
    : view.heightColor
      ? `<strong>Byggehøyde</strong><span class="ramp ramp-h"></span><small>0 → 70 m+ · Overture Buildings</small>`
      : PLACE_GROUPS.map((g) => `<span class="lg"><i style="background:${g.color}"></i>${g.label}</span>`).join("");
}
$("#layer-controls").addEventListener("click", (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>("[data-layer]")?.dataset.layer;
  if (!key) return;
  if (key === "districts") view.districts = view.districts ? null : "steder_per_km2";
  else if (key === "places" || key === "buildings3d" || key === "heat" || key === "heightColor") view[key] = !view[key];
  if (key === "buildings3d" && view.buildings3d && map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 900 });
  void refresh();
});

// ---------- Objektinfo ved klikk ----------

const QUERY = ["hits-circle", "places", "places-label", "buildings-3d", "building-parts-3d", "buildings-flat", "districts-fill", "road-highway", "road-major", "road-minor", "path", "rail", "water", "land-use"];
function showInfo(f: MapGeoJSONFeature) {
  const card = $("#info");
  if (f.layer.id === "districts-fill") {
    const p = f.properties as District["properties"];
    card.querySelector(".info-body")!.innerHTML = `<div class="info-kind">${esc(AREA.areaTitle)} · ${esc(analysis.omradetype)}</div><h3 class="info-title">${esc(p.navn)}</h3>
      <dl class="info-rows"><dt>Areal</dt><dd>${nf(p.km2, 2)} km²</dd><dt>Steder</dt><dd>${nf(p.steder)}</dd><dt>Servering</dt><dd>${nf(p.servering)}</dd>
      <dt>Bygninger</dt><dd>${nf(p.bygninger)}</dd><dt>Snitthøyde</dt><dd>${p.snitthoyde ?? "–"} m</dd></dl>`;
  } else if (f.layer.id === "hits-circle") {
    card.querySelector(".info-body")!.innerHTML = `<div class="info-kind">Treff fra Claude</div><h3 class="info-title">${esc(f.properties?.navn)}</h3>`;
  } else {
    card.querySelector(".info-body")!.innerHTML = renderFeatureInfo(f);
  }
  card.hidden = false;
}
$("#info .close").addEventListener("click", () => ($("#info").hidden = true));

// ---------- Verktøy for Claude ----------

function bboxNow() {
  const b = map.getBounds();
  return { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
}
function districtByName(name: string) {
  const q = name.toLocaleLowerCase("nb-NO").trim();
  return districts.find((d) => d.properties.navn.toLocaleLowerCase("nb-NO") === q) ?? districts.find((d) => d.properties.navn.toLocaleLowerCase("nb-NO").includes(q));
}
/** Område: "utsnitt" (det brukeren ser), "hele" (hele datasettet) eller et bydelsnavn. */
function areaFilter(omrade: unknown): { label: string; test: (o: { lon: number; lat: number; bydel?: string }) => boolean } {
  const a = String(omrade ?? "hele").trim();
  if (a === "utsnitt") {
    const b = bboxNow();
    return { label: "kartutsnittet", test: (o) => o.lon >= b.w && o.lon <= b.e && o.lat >= b.s && o.lat <= b.n };
  }
  if (!a || a === "hele") return { label: "hele datasettet", test: () => true };
  const d = districtByName(a);
  if (!d) throw new Error(`Fant ikke bydelen «${a}». Kjente bydeler: ${districts.map((x) => x.properties.navn).join(", ")}`);
  return { label: d.properties.navn, test: (o) => o.bydel === d.properties.navn };
}
function matchesGroup(p: Place, gruppe: unknown) {
  if (!gruppe) return true;
  const g = String(gruppe).toLocaleLowerCase("nb-NO");
  return p.grp.toLocaleLowerCase("nb-NO").includes(g);
}

let lastResult: { title: string; rows: Record<string, unknown>[] } | null = null;
let activity: (label: string) => void = () => {};
let addChart: (title: string, data: { etikett: string; verdi: number }[], unit?: string) => void = () => {};

function placeOut(p: Place, extra: Record<string, unknown> = {}) {
  return { navn: p.name, kategori: p.cat, gruppe: p.grp, adresse: p.addr, bydel: p.bydel ?? null, sikkerhet: p.conf, lon: p.lon, lat: p.lat, ...extra };
}

const TOOLS: SampleTool[] = [
  {
    name: "kartstatus",
    description: "Returnerer hva brukeren ser nå: senter, zoom, kartutsnitt (bbox), aktive lag og hvor mange steder og bygninger som ligger i utsnittet.",
    execute() {
      activity("Leser kartstatus");
      const c = map.getCenter();
      const inView = areaFilter("utsnitt");
      return {
        senter: [Number(c.lng.toFixed(5)), Number(c.lat.toFixed(5))],
        zoom: Number(map.getZoom().toFixed(1)),
        vinkel_grader: Math.round(map.getPitch()),
        bbox: bboxNow(),
        lag: { ...view },
        steder_i_utsnitt: places.filter(inView.test).length,
        bygninger_i_utsnitt: buildings.filter(inView.test).length,
      };
    },
  },
  {
    name: "sok_steder",
    description:
      "Søker i Overture Places (butikker, restauranter, kontorer m.m.). Filtrer på tekst (navn/merke/kategori), kategori (engelsk Overture basic_category, f.eks. 'pharmacy', 'cafe', 'restaurant'), gruppe (norsk gruppenavn), område, og avstand fra et punkt. Returnerer antall og inntil 'grense' treff. Treffene markeres automatisk i kartet.",
    inputSchema: {
      type: "object",
      properties: {
        tekst: { type: "string", description: "Fritekst i navn, merke eller kategori" },
        kategori: { type: "string", description: "Delstreng av Overture basic_category, f.eks. 'pharmacy', 'coffee', 'school'" },
        gruppe: { type: "string", enum: PLACE_GROUPS.map((g) => g.label).concat("Annet") },
        omrade: { type: "string", description: "'utsnitt', 'hele' eller et bydelsnavn. Standard 'hele'." },
        naer: {
          type: "object",
          description: "Bare steder innen radius_m meter fra punktet",
          properties: { lon: { type: "number" }, lat: { type: "number" }, radius_m: { type: "number" } },
          required: ["lon", "lat", "radius_m"],
        },
        min_sikkerhet: { type: "number", description: "0–1, standard 0.5" },
        grense: { type: "number", description: "Maks antall treff å returnere (standard 20, maks 60)" },
      },
    },
    execute(i) {
      const area = areaFilter(i.omrade);
      const text = String(i.tekst ?? "").toLocaleLowerCase("nb-NO");
      const cat = String(i.kategori ?? "").toLowerCase();
      const minConf = Number(i.min_sikkerhet ?? 0.5);
      const near = i.naer as { lon: number; lat: number; radius_m: number } | undefined;
      const lim = Math.min(Number(i.grense ?? 20) || 20, 60);
      activity(`Søker i ${nf(places.length)} steder${text ? ` etter «${text}»` : ""}${cat ? ` (${cat})` : ""} i ${area.label}`);
      let found = places
        .filter((p) => p.conf >= minConf && area.test(p) && matchesGroup(p, i.gruppe))
        .filter((p) => !cat || (p.cat ?? "").includes(cat))
        .filter((p) => !text || [p.name, p.brand, p.cat].some((v) => (v ?? "").toLocaleLowerCase("nb-NO").includes(text)))
        .map((p) => ({ p, d: near ? distance([near.lon, near.lat], [p.lon, p.lat]) : undefined }));
      if (near) found = found.filter((x) => x.d! <= Number(near.radius_m)).sort((a, b) => a.d! - b.d!);
      const out = found.slice(0, lim).map((x) => placeOut(x.p, x.d !== undefined ? { avstand_m: Math.round(x.d) } : {}));
      lastResult = { title: "steder", rows: found.map((x) => placeOut(x.p, x.d !== undefined ? { avstand_m: Math.round(x.d) } : {})) };
      setHits(out.map((o) => ({ lon: o.lon, lat: o.lat, navn: o.navn })));
      return { antall: found.length, omrade: area.label, viser: out.length, treff: out };
    },
  },
  {
    name: "statistikk",
    description:
      "Teller og grupperer data. tema 'steder' kan grupperes etter 'gruppe', 'kategori' eller 'bydel'; tema 'bygninger' etter 'subtype', 'bydel' eller 'hoydeklasse'. For 'bydel' får du også tetthet per km² og snitthøyde. Bruk denne for alle tall og sammenligninger.",
    inputSchema: {
      type: "object",
      properties: {
        tema: { type: "string", enum: ["steder", "bygninger"] },
        grupper_etter: { type: "string", enum: ["gruppe", "kategori", "bydel", "subtype", "hoydeklasse"] },
        omrade: { type: "string", description: "'utsnitt', 'hele' eller et bydelsnavn" },
        gruppe: { type: "string", description: "Bare steder i denne gruppen (norsk gruppenavn)" },
        kategori: { type: "string", description: "Bare steder der basic_category inneholder dette" },
        topp: { type: "number", description: "Antall rader (standard 15)" },
      },
      required: ["tema", "grupper_etter"],
    },
    execute(i) {
      const area = areaFilter(i.omrade);
      const by = String(i.grupper_etter);
      const top = Math.min(Number(i.topp ?? 15) || 15, 40);
      const counts = new Map<string, { n: number; hsum: number; hn: number }>();
      const add = (k: string, h?: number | null) => {
        const c = counts.get(k) ?? { n: 0, hsum: 0, hn: 0 };
        c.n++;
        if (typeof h === "number") (c.hsum += h), c.hn++;
        counts.set(k, c);
      };
      let total = 0;
      if (i.tema === "bygninger") {
        activity(`Teller ${nf(buildings.length)} bygninger etter ${by} i ${area.label}`);
        for (const b of buildings) {
          if (!area.test(b)) continue;
          total++;
          const h = estHeight(b);
          const k = by === "bydel" ? b.bydel ?? "utenfor områdene" : by === "hoydeklasse"
            ? h == null ? "ukjent høyde" : h < 10 ? "0–10 m" : h < 20 ? "10–20 m" : h < 30 ? "20–30 m" : h < 50 ? "30–50 m" : "50 m +"
            : b.subtype ?? "ukjent";
          add(k, h);
        }
      } else {
        activity(`Teller ${nf(places.length)} steder etter ${by} i ${area.label}`);
        const cat = String(i.kategori ?? "").toLowerCase();
        for (const p of places) {
          if (!area.test(p) || !matchesGroup(p, i.gruppe) || (cat && !(p.cat ?? "").includes(cat))) continue;
          total++;
          add(by === "bydel" ? p.bydel ?? "utenfor områdene" : by === "kategori" ? p.cat ?? "ukjent" : p.grp);
        }
      }
      const rows = [...counts.entries()]
        .map(([k, c]) => {
          const d = by === "bydel" ? districtByName(k) : undefined;
          return {
            verdi: k,
            antall: c.n,
            andel_prosent: Number(((c.n / Math.max(total, 1)) * 100).toFixed(1)),
            ...(d ? { per_km2: Math.round(c.n / d.properties.km2), km2_i_utsnitt: d.properties.km2 } : {}),
            ...(c.hn ? { snitthoyde_m: Number((c.hsum / c.hn).toFixed(1)) } : {}),
          };
        })
        .sort((a, b) => b.antall - a.antall)
        .slice(0, top);
      lastResult = { title: `statistikk-${i.tema}-${by}`, rows };
      return { tema: i.tema, omrade: area.label, totalt: total, rader: rows };
    },
  },
  {
    name: "bygninger",
    description: "Lister bygninger med høyde (målt, ellers estimert fra etasjer × 3,2 m), etasjer, fotavtrykk og område. Kan filtrere på område, minste høyde, minste fotavtrykk og subtype (residential, commercial, education …) og sortere etter høyde, areal eller etasjer. Konstruksjoner under 30 m² (master, skulpturer) utelates som standard. Treffene markeres i kartet.",
    inputSchema: {
      type: "object",
      properties: {
        omrade: { type: "string" },
        min_hoyde: { type: "number" },
        min_areal: { type: "number", description: "Minste fotavtrykk i m², standard 30" },
        subtype: { type: "string" },
        sorter: { type: "string", enum: ["hoyde", "areal", "etasjer"] },
        grense: { type: "number", description: "standard 10, maks 40" },
      },
    },
    execute(i) {
      const area = areaFilter(i.omrade);
      const sorter = String(i.sorter ?? "hoyde");
      const val = (b: Building) => (sorter === "areal" ? b.area_m2 : sorter === "etasjer" ? b.floors : estHeight(b));
      activity(`Ser på ${nf(buildings.length)} bygninger i ${area.label}`);
      const list = buildings
        .filter((b) => area.test(b) && (i.min_hoyde == null || (estHeight(b) ?? -1) >= Number(i.min_hoyde)) && (!i.subtype || b.subtype === i.subtype))
        .filter((b) => (b.area_m2 ?? 0) >= Number(i.min_areal ?? 30))
        .filter((b) => val(b) != null)
        .sort((a, b) => Number(val(b)) - Number(val(a)));
      const lim = Math.min(Number(i.grense ?? 10) || 10, 40);
      const out = list.slice(0, lim).map((b) => ({ navn: b.name ?? buildingLabel(b.class ?? b.subtype ?? "Bygning"), subtype: b.subtype, hoyde_m: estHeight(b), hoyde_estimert: b.h == null && b.floors != null, etasjer: b.floors, areal_m2: b.area_m2, bydel: b.bydel ?? null, lon: b.lon, lat: b.lat }));
      lastResult = { title: "bygninger", rows: out };
      setHits(out.map((o) => ({ lon: o.lon, lat: o.lat, navn: `${o.navn}${o.hoyde_m ? ` · ${o.hoyde_m} m` : ""}` })));
      return { antall_som_matcher: list.length, omrade: area.label, viser: out.length, bygninger: out };
    },
  },
  {
    name: "finn_sted",
    description: "Slår opp et navn (bydel, sted, bygning eller adresse) i datasettet og returnerer koordinater. Bruk før du flyr til eller måler avstand fra et sted brukeren nevner.",
    inputSchema: { type: "object", properties: { navn: { type: "string" } }, required: ["navn"] },
    execute(i) {
      const q = String(i.navn).toLocaleLowerCase("nb-NO");
      activity(`Slår opp «${i.navn}»`);
      const d = districtByName(q);
      // Eksakte navn først, så navn som starter med søket, så delvise treff.
      const rank = (n: string) => (n === q ? 0 : n.startsWith(q) ? 1 : 2);
      const ps = places
        .filter((p) => p.name.toLocaleLowerCase("nb-NO").includes(q) || (p.addr ?? "").toLocaleLowerCase("nb-NO").includes(q))
        .sort((a, b) => rank(a.name.toLocaleLowerCase("nb-NO")) - rank(b.name.toLocaleLowerCase("nb-NO")) || b.conf - a.conf)
        .slice(0, 6);
      const bs = buildings.filter((b) => (b.name ?? "").toLocaleLowerCase("nb-NO").includes(q)).slice(0, 4);
      if (!d && !ps.length && !bs.length) throw new Error(`Fant ikke «${i.navn}» i datasettet for ${AREA.name}. Bruk egne kunnskaper om koordinater om stedet ligger innenfor kartutsnittet.`);
      const center = (g: District["geometry"]) => {
        const ring = g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0];
        const xs = ring.map((c) => c[0]);
        const ys = ring.map((c) => c[1]);
        return { lon: (Math.min(...xs) + Math.max(...xs)) / 2, lat: (Math.min(...ys) + Math.max(...ys)) / 2 };
      };
      return {
        bydel: d ? { navn: d.properties.navn, ...center(d.geometry), km2_i_utsnitt: d.properties.km2 } : null,
        steder: ps.map((p) => placeOut(p)),
        bygninger: bs.map((b) => ({ navn: b.name, hoyde_m: b.h, lon: b.lon, lat: b.lat })),
      };
    },
  },
  {
    name: "vis_i_kart",
    description: "Styrer kartet: 'fly' til lon/lat/zoom (valgfri vinkel og retning), 'tilpass_treff' zoomer til siste treff, 'marker' setter egne punkter med navn, 'nullstill' fjerner markeringer.",
    inputSchema: {
      type: "object",
      properties: {
        handling: { type: "string", enum: ["fly", "tilpass_treff", "marker", "nullstill"] },
        lon: { type: "number" }, lat: { type: "number" }, zoom: { type: "number" },
        vinkel: { type: "number", description: "0–80 grader" }, retning: { type: "number" },
        punkter: { type: "array", items: { type: "object", properties: { lon: { type: "number" }, lat: { type: "number" }, navn: { type: "string" } }, required: ["lon", "lat"] } },
      },
      required: ["handling"],
    },
    execute(i) {
      const h = String(i.handling);
      if (h === "fly") {
        activity("Flytter kartet");
        map.flyTo({ center: [Number(i.lon), Number(i.lat)], zoom: Number(i.zoom ?? 15), pitch: i.vinkel != null ? Number(i.vinkel) : map.getPitch(), bearing: i.retning != null ? Number(i.retning) : map.getBearing(), duration: 1600 });
      } else if (h === "tilpass_treff") {
        activity("Zoomer til treffene");
        fitTo(hits.features.map((f) => ({ lon: (f.geometry as GeoJSON.Point).coordinates[0], lat: (f.geometry as GeoJSON.Point).coordinates[1] })));
      } else if (h === "marker") {
        const pts = ((i.punkter as { lon: number; lat: number; navn?: string }[]) ?? []).map((p) => ({ lon: Number(p.lon), lat: Number(p.lat), navn: String(p.navn ?? "") }));
        activity(`Markerer ${pts.length} punkter`);
        setHits(pts);
        fitTo(pts);
      } else {
        setHits([]);
      }
      return "ok";
    },
  },
  {
    name: "sett_lag",
    description: "Slår kartlag av og på: steder, bygninger_3d, varmekart (tetthet av steder), hoydefarger (bygninger farget etter høyde), bydelsanalyse (koropletkart: 'steder_per_km2', 'servering_per_km2', 'bygninger_per_km2', 'snitthoyde' eller 'av'), og tema 'lys'/'mork'.",
    inputSchema: {
      type: "object",
      properties: {
        steder: { type: "boolean" }, bygninger_3d: { type: "boolean" }, varmekart: { type: "boolean" }, hoydefarger: { type: "boolean" },
        bydelsanalyse: { type: "string", enum: ["steder_per_km2", "servering_per_km2", "bygninger_per_km2", "snitthoyde", "av"] },
        tema: { type: "string", enum: ["lys", "mork"] },
      },
    },
    async execute(i) {
      if (typeof i.steder === "boolean") view.places = i.steder;
      if (typeof i.bygninger_3d === "boolean") view.buildings3d = i.bygninger_3d;
      if (typeof i.varmekart === "boolean") view.heat = i.varmekart;
      if (typeof i.hoydefarger === "boolean") view.heightColor = i.hoydefarger;
      if (i.bydelsanalyse) view.districts = i.bydelsanalyse === "av" ? null : (i.bydelsanalyse as DistrictMetric);
      if (i.tema) view.dark = i.tema === "mork";
      activity("Endrer kartlag");
      if ((view.buildings3d || view.heightColor) && map.getPitch() < 20) map.easeTo({ pitch: 55, duration: 900 });
      if (view.districts && map.getZoom() > 13.5) map.easeTo({ zoom: 12.6, pitch: 0, duration: 900 });
      await refresh();
      return { lag: { ...view } };
    },
  },
  {
    name: "vis_diagram",
    description: "Tegner et stolpediagram i svaret til brukeren. Bruk når en sammenligning blir tydeligere som figur. Inntil 15 stolper.",
    inputSchema: {
      type: "object",
      properties: {
        tittel: { type: "string" },
        enhet: { type: "string" },
        data: { type: "array", items: { type: "object", properties: { etikett: { type: "string" }, verdi: { type: "number" } }, required: ["etikett", "verdi"] } },
      },
      required: ["tittel", "data"],
    },
    execute(i) {
      const data = ((i.data as { etikett: string; verdi: number }[]) ?? []).slice(0, 15).map((d) => ({ etikett: String(d.etikett), verdi: Number(d.verdi) || 0 }));
      addChart(String(i.tittel ?? ""), data, i.enhet ? String(i.enhet) : undefined);
      return "Diagrammet vises i svaret.";
    },
  },
];

// ---------- Chat ----------

type Turn = { role: "user" | "assistant"; content: string };
const turns: Turn[] = [];
const log = $("#messages");
const form = $<HTMLFormElement>("#ask");
const input = $<HTMLTextAreaElement>("#q");
const sendBtn = $<HTMLButtonElement>("#send");
const stopBtn = $<HTMLButtonElement>("#stop");
let sample: SampleFn | null = null;
let toolsOk = false;
let ctl: AbortController | null = null;

function rules() {
  const a = analysis;
  const pct = (n: number) => `${nf((n / Math.max(a.antall.bygninger, 1)) * 100, 1)} %`;
  const areaNote = a.omrader_metode === "voronoi"
    ? `${a.antall.bydeler} områder laget rundt Overtures navngitte bydelspunkter (nærmeste navn, uten vann). Overture har ikke offisielle bydelsgrenser her, så si «området rundt X», ikke «bydelen X», og nevn at grensene er tilnærmet.`
    : `${a.antall.bydeler} bydeler fra Overture, klippet til kartutsnittet.`;
  return `Du er en geodata-analytiker innebygd i kartappen «Kartlab ${AREA.name}». Svar på norsk bokmål.

DATA (Overture Maps ${a.release}, utsnitt av ${AREA.name}: lon ${a.bbox[0]}–${a.bbox[2]}, lat ${a.bbox[1]}–${a.bbox[3]}):
- ${nf(a.antall.steder)} steder (Overture Places: Meta, Foursquare, Microsoft m.fl.) med kategori, gruppe, adresse, sikkerhet (0–1) og område.
- ${nf(a.antall.bygninger)} bygninger (OpenStreetMap og Microsoft) med fotavtrykk i m² (UTM33) og område. Bare ${nf(a.antall.bygninger_med_hoyde)} (${pct(a.antall.bygninger_med_hoyde)}) har målt høyde og ${nf(a.antall.bygninger_med_etasjer)} (${pct(a.antall.bygninger_med_etasjer)}) har antall etasjer; ellers estimeres høyde som etasjer × 3,2 m. Si fra når et svar bygger på estimerte eller manglende høyder.
- Områder: ${areaNote} Navn: ${districts.map((d) => d.properties.navn).join(", ")}. I verktøyene heter feltet «bydel».
- Grupper: ${PLACE_GROUPS.map((g) => g.label).join(", ")}, Annet.

SLIK JOBBER DU:
- Bruk verktøyene for alle tall. Ikke gjett eller finn på tall, steder eller adresser.
- Når svaret handler om steder eller bygninger: la dem bli markert i kartet (sok_steder og bygninger gjør det) og bruk vis_i_kart med 'tilpass_treff' så brukeren ser dem.
- Bruk sett_lag når et kartlag gjør svaret tydeligere (områdeanalyse via 'bydelsanalyse', varmekart, 3D, høydefarger), og vis_diagram for sammenligninger med 3+ verdier.
- «Her», «i kartet» eller «det jeg ser» betyr omrade 'utsnitt'. Ellers bruk hele datasettet.
- Svar kort og konkret: 2–6 setninger eller en kort punktliste, med tallene. Si fra om begrensninger (utsnittet dekker bare deler av ${AREA.name}; Overture-data kan mangle eller ha feil kategori).
- Skriv ikke koordinater i svaret med mindre brukeren ber om det.`;
}

function md(s: string) {
  // Liten markdown: avsnitt, punktlister, fet og kursiv skrift.
  const lines = esc(s).split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => list && (out.push(`</${list}>`), (list = null));
  for (const l of lines) {
    const ul = /^\s*[-*•]\s+(.*)/.exec(l);
    const ol = /^\s*\d+[.)]\s+(.*)/.exec(l);
    const h = /^#{1,4}\s+(.*)/.exec(l);
    if (ul || ol) {
      const t = ul ? "ul" : "ol";
      if (list !== t) close(), out.push(`<${t}>`), (list = t);
      out.push(`<li>${(ul ?? ol)![1]}</li>`);
    } else if (h) close(), out.push(`<h4>${h[1]}</h4>`);
    else if (l.trim()) close(), out.push(`<p>${l}</p>`);
    else close();
  }
  close();
  return out.join("").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

function bubble(role: "user" | "assistant", html = "") {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = role === "assistant" ? `<div class="steps"></div><div class="charts"></div><div class="body">${html}</div><div class="msg-actions" hidden></div>` : `<div class="body">${html}</div>`;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function chartHtml(title: string, data: { etikett: string; verdi: number }[], unit?: string) {
  const max = Math.max(...data.map((d) => d.verdi), 1);
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption>${data
    .map((d) => `<div class="bar-row"><span class="bar-label">${esc(d.etikett)}</span><span class="bar-track"><span class="bar" style="width:${(d.verdi / max) * 100}%"></span></span><span class="bar-val">${nf(d.verdi, 1)}${unit ? ` ${esc(unit)}` : ""}</span></div>`)
    .join("")}</figure>`;
}

const ERR: Record<string, string> = {
  not_granted: "Claude er ikke tillatt for denne siden. Tillat bruk av Claude i dialogen, eller via sidens tillatelser.",
  sampling_disabled: "Claude er ikke tilgjengelig for kontoen eller organisasjonen din.",
  rate_limited: "Du har nådd en grense for bruk akkurat nå. Prøv igjen om litt.",
  session_expired: "Økten er utløpt. Logg inn på claude.ai på nytt.",
  refused: "Claude ville ikke svare på dette spørsmålet. Prøv å formulere det annerledes.",
  prompt_too_large: "Samtalen er blitt for lang. Start en ny samtale.",
  tools_unavailable: "Denne visningen kan ikke la Claude bruke kartverktøyene.",
};

async function ask(question: string) {
  if (!sample || !question.trim() || ctl) return;
  $("#suggestions").hidden = true;
  bubble("user", esc(question));
  const el = bubble("assistant", `<p class="thinking">Tenker …</p>`);
  const steps = el.querySelector<HTMLElement>(".steps")!;
  const charts = el.querySelector<HTMLElement>(".charts")!;
  const body = el.querySelector<HTMLElement>(".body")!;
  activity = (label) => {
    steps.insertAdjacentHTML("beforeend", `<span class="step">${esc(label)}</span>`);
    log.scrollTop = log.scrollHeight;
  };
  addChart = (title, data, unit) => {
    charts.insertAdjacentHTML("beforeend", chartHtml(title, data, unit));
  };
  lastResult = null;
  const c = map.getCenter();
  const userTurn = `${question}\n\n[Kart nå: senter ${c.lng.toFixed(4)}, ${c.lat.toFixed(4)}, zoom ${map.getZoom().toFixed(1)}, vinkel ${Math.round(map.getPitch())}°]`;
  turns.push({ role: "user", content: userTurn });
  ctl = new AbortController();
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  try {
    const history = turns.slice(-12);
    const res = await sample([{ role: "user", content: rules() }, ...(history[0]?.role === "assistant" ? history.slice(1) : history)], {
      cache: false,
      signal: ctl.signal,
      ...(toolsOk ? { tools: TOOLS } : {}),
      onText: ({ text }: { text: string }) => {
        body.innerHTML = md(text);
        log.scrollTop = log.scrollHeight;
      },
    });
    body.innerHTML = md(res.text) + (res.truncated ? `<p class="note">Svaret ble avkortet. Spør gjerne om mindre om gangen.</p>` : "");
    turns.push({ role: "assistant", content: res.text });
    addActions(el, question, res.text);
  } catch (err) {
    const e = err as SampleError;
    turns.pop();
    if (e.code === "refused") body.innerHTML = "";
    else body.innerHTML = e.text ? md(e.text) : "";
    if (e.code !== "cancelled") body.insertAdjacentHTML("beforeend", `<p class="note">${esc(ERR[e.code] ?? "Noe gikk galt underveis. Prøv igjen.")}</p>`);
    if (["not_granted", "sampling_disabled", "tools_unavailable"].includes(e.code)) disableChat(ERR[e.code]);
  } finally {
    ctl = null;
    sendBtn.hidden = false;
    stopBtn.hidden = true;
    input.focus();
  }
}

function disableChat(msg: string) {
  $("#chat-status").textContent = msg;
  $("#chat-status").hidden = false;
  form.querySelectorAll("textarea, button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value;
  input.value = "";
  void ask(q);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
stopBtn.addEventListener("click", () => ctl?.abort());
$("#suggestions").addEventListener("click", (e) => {
  const q = (e.target as HTMLElement).closest<HTMLElement>("[data-q]")?.dataset.q;
  if (q) void ask(q);
});
$("#new-chat").addEventListener("click", () => {
  ctl?.abort();
  turns.length = 0;
  log.innerHTML = "";
  $("#suggestions").hidden = false;
  setHits([]);
});

// ---------- Del funn med kolleger (db) og last ned treff (downloads) ----------

let db: DB | null = null;
let user: UserNs | null = null;
let myId: string | null = null;
let downloads: Downloads | null = null;

function addActions(el: HTMLElement, question: string, answer: string) {
  const bar = el.querySelector<HTMLElement>(".msg-actions")!;
  const result = lastResult;
  const btns: string[] = [];
  if (db && myId) btns.push(`<button data-act="share">Del med kolleger</button>`);
  if (downloads && result?.rows.length) btns.push(`<button data-act="csv">Last ned tabell (CSV)</button>`);
  if (downloads && result?.rows.some((r) => "lon" in r)) btns.push(`<button data-act="geojson">Last ned treff (GeoJSON)</button>`);
  if (!btns.length) return;
  bar.innerHTML = btns.join("");
  bar.hidden = false;
  bar.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === "share") {
        btn.disabled = true;
        const c = map.getCenter();
        await db!.collection("funn").add({
          sporsmal: question.slice(0, 500),
          svar: answer.slice(0, 4000),
          av: myId,
          tid: new Date().toISOString(),
          kart: { lon: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() },
          lag: { ...view },
          treff: hits.features.slice(0, 60).map((f) => ({ navn: f.properties?.navn, c: (f.geometry as GeoJSON.Point).coordinates })),
        });
        btn.textContent = "Delt";
      } else if (act === "csv" && result) {
        const cols = [...new Set(result.rows.flatMap((r) => Object.keys(r)))];
        const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const csv = [cols.join(";"), ...result.rows.map((r) => cols.map((k) => cell(r[k])).join(";"))].join("\n");
        await downloads!.save({ filename: `kartlab-${result.title}.csv`, data: "﻿" + csv });
      } else if (act === "geojson" && result) {
        const fc = {
          type: "FeatureCollection",
          features: result.rows.filter((r) => "lon" in r).map((r) => {
            const { lon, lat, ...props } = r as Record<string, unknown>;
            return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [lon, lat] } };
          }),
        };
        await downloads!.save({ filename: `kartlab-${result.title}.geojson.json`, data: JSON.stringify(fc) });
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "declined") btn.textContent = act === "share" ? "Kunne ikke dele" : "Nedlasting ikke tilgjengelig";
    }
  });
}

async function initShared() {
  [db, user, downloads] = await Promise.all([use<DB>("db"), use<UserNs>("user"), use<Downloads>("downloads")]);
  myId = (await user?.id()) ?? null;
  const panel = $("#shared");
  if (!db) return;
  panel.hidden = false;
  db.collection("funn").orderBy("tid", "desc").limit(30).onSnapshot(
    async (snap) => {
      const docs = snap.docs.filter((d) => d.exists);
      const ids = [...new Set(docs.map((d) => String(d.data()?.av ?? "")).filter(Boolean))];
      const people = user && ids.length ? await user.profiles(ids) : {};
      $("#shared-count").textContent = String(docs.length);
      $("#shared-list").innerHTML = docs.length
        ? docs.map((d) => {
            const v = d.data()!;
            const p = people[String(v.av)];
            const when = new Date(String(v.tid)).toLocaleString("nb-NO", { dateStyle: "short", timeStyle: "short" });
            return `<li data-id="${esc(d.id)}">
              <div class="who"><img src="${esc(p?.avatarUrl ?? "")}" alt="" width="20" height="20"><span class="nm"></span><time>${esc(when)}</time></div>
              <p class="sq"></p>
              <div class="row"><button data-go="${esc(d.id)}">Vis i kartet</button>${v.av === myId ? `<button data-del="${esc(d.id)}" class="ghost">Slett</button>` : ""}</div>
            </li>`;
          }).join("")
        : `<li class="empty">Ingen delte funn ennå. Trykk «Del med kolleger» under et svar fra Claude.</li>`;
      // Navn og spørsmål er andres tekst: settes som textContent.
      for (const li of $("#shared-list").querySelectorAll<HTMLElement>("li[data-id]")) {
        const v = docs.find((d) => d.id === li.dataset.id)!.data()!;
        li.querySelector(".nm")!.textContent = people[String(v.av)]?.name || "En kollega";
        li.querySelector(".sq")!.textContent = String(v.sporsmal ?? "");
      }
      sharedDocs = new Map(docs.map((d) => [d.id, d.data()!]));
    },
    () => (panel.hidden = true),
  );
}
let sharedDocs = new Map<string, Record<string, unknown>>();
$("#shared-list").addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const go = t.closest<HTMLElement>("[data-go]")?.dataset.go;
  const del = t.closest<HTMLElement>("[data-del]")?.dataset.del;
  if (go) {
    const v = sharedDocs.get(go);
    if (!v) return;
    Object.assign(view, v.lag ?? {}, { dark: view.dark });
    await refresh();
    const k = v.kart as { lon: number; lat: number; zoom: number; pitch: number; bearing: number };
    map.flyTo({ center: [k.lon, k.lat], zoom: k.zoom, pitch: k.pitch, bearing: k.bearing, duration: 1400 });
    setHits(((v.treff as { navn: string; c: [number, number] }[]) ?? []).map((h) => ({ navn: h.navn, lon: h.c[0], lat: h.c[1] })));
    selectTab("t-kart");
    log.insertAdjacentHTML("beforeend", `<div class="msg assistant shared-answer"><div class="body"><p class="eyebrow">Delt funn</p><p class="sq"></p>${md(String(v.svar ?? ""))}</div></div>`);
    (log.lastElementChild!.querySelector(".sq") as HTMLElement).textContent = String(v.sporsmal ?? "");
    $("#suggestions").hidden = true;
    log.scrollTop = log.scrollHeight;
  } else if (del && db) {
    await db.collection("funn").doc(del).delete().catch(() => {});
  }
});

// ---------- Analyse-fanen (resultatene fra Claude Code) ----------

/** Bygninger uten navn har bare en engelsk Overture-klasse; vis den på norsk. */
const CLASS_NO: Record<string, string> = {
  apartments: "Boligblokk", house: "Bolig", industrial: "Industribygg", warehouse: "Lagerbygg", commercial: "Næringsbygg",
  retail: "Butikkbygg", office: "Kontorbygg", hospital: "Sykehus", school: "Skole", residential: "Boligbygg",
  church: "Kirke", university: "Universitet", civic: "Offentlig bygg", hotel: "Hotell", parking: "Parkeringshus",
};
const buildingLabel = (n: string) => CLASS_NO[n] ?? n;

function renderAnalysis() {
  const a = analysis;
  $("#k-steder").textContent = nf(a.antall.steder);
  $("#k-bygg").textContent = nf(a.antall.bygninger);
  $("#k-hoyde").textContent = nf(a.antall.bygninger_med_hoyde);
  $("#k-etasjer").textContent = nf(a.antall.bygninger_med_etasjer);
  $("#k-tid").textContent = `${nf(a.steg.reduce((s, x) => s + (x.sekunder ?? 0), 0), 0)} s`;
  $("#release-a").textContent = a.release;
  const bars = (rows: [string, number][], unit = "") => {
    const max = Math.max(...rows.map((r) => r[1]));
    return rows.map(([k, v]) => `<div class="bar-row"><span class="bar-label">${esc(k)}</span><span class="bar-track"><span class="bar" style="width:${(v / max) * 100}%"></span></span><span class="bar-val">${nf(v)}${unit}</span></div>`).join("");
  };
  $("#a-grupper").innerHTML = bars(a.grupper);
  $("#a-hoyde").innerHTML = bars(a.hoydefordeling);
  $("#a-kilder").innerHTML = bars(a.datasett_steder.filter(([k]) => k !== "Overture"));
  $("#a-bydeler tbody").innerHTML = a.bydeler
    .map(([n, km2, st, se, by, h, dens]) => `<tr><th scope="row">${esc(n)}</th><td>${nf(km2, 2)}</td><td>${nf(st)}</td><td>${nf(se)}</td><td>${nf(by)}</td><td>${h ?? "–"}</td><td><strong>${nf(dens)}</strong></td></tr>`)
    .join("");
  $("#a-steg").innerHTML = a.steg.map((s) => `<li><span>${esc(s.steg)}</span><span class="t">${s.sekunder == null ? "fra hurtigbuffer" : s.sekunder < 0.1 ? "< 0,1 s" : `${nf(s.sekunder, 1)} s`}</span></li>`).join("");
  $("#a-hoyeste").innerHTML = a.hoyeste.map(([n, h, , , est]) => `<li><span>${esc(buildingLabel(n))}</span><span class="t">${nf(h)} m${est ? "*" : ""}</span></li>`).join("");
  $("#a-storste").innerHTML = a.storste.map(([n, m2]) => `<li><span>${esc(buildingLabel(n))}</span><span class="t">${nf(m2)} m²</span></li>`).join("");
}

// ---------- Oppstart ----------

async function start() {
  try {
    await loadAll();
  } catch (err) {
    console.error(err);
    loadText.textContent = "Kunne ikke laste kartdataene. Last siden på nytt.";
    return;
  }
  renderAnalysis();
  map = new maplibregl.Map({
    container: "map",
    style: await buildStyle(),
    center: AREA.start.center,
    zoom: AREA.start.zoom,
    maxBounds: [[analysis.bbox[0] - 0.03, analysis.bbox[1] - 0.015], [analysis.bbox[2] + 0.03, analysis.bbox[3] + 0.015]],
    minZoom: 11.5,
    maxZoom: 19,
    pitch: AREA.start.pitch,
    bearing: AREA.start.bearing,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  map.on("load", () => $("#loader").remove());
  map.on("click", (e) => {
    const layers = QUERY.filter((id) => map.getLayer(id));
    const f = map.queryRenderedFeatures([[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], { layers });
    f.sort((a, b) => layers.indexOf(a.layer.id) - layers.indexOf(b.layer.id));
    if (f[0]) showInfo(f[0]);
    else $("#info").hidden = true;
  });
  map.on("mousemove", (e) => {
    const layers = QUERY.filter((id) => map.getLayer(id));
    map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers }).length ? "pointer" : "";
  });
  prefersDark.addEventListener("change", () => {
    view.dark = isDark();
    void refresh();
  });
  renderLayerControls();

  sample = await use<SampleFn>("sample");
  if (!sample) {
    disableChat("Åpne siden på claude.ai og logg inn for å spørre Claude. Kartet og analysen virker uten.");
  } else {
    const limits = await sample.limits().catch(() => null);
    toolsOk = !!limits?.tools;
    if (!toolsOk) $("#chat-status").textContent = "Claude svarer, men denne visningen kan ikke la Claude styre kartet.";
    $("#chat-status").hidden = toolsOk;
  }
  void initShared();
}
void start();
