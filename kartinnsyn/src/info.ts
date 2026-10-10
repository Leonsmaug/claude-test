import type { MapGeoJSONFeature } from "maplibre-gl";
import { PLACE_GROUPS } from "./style";

/** Gjør Overture-attributter om til lesbar objektinfo. */

const LAYER_LABEL: Record<string, string> = {
  place: "Sted",
  address: "Adresse",
  building: "Bygning",
  building_part: "Bygningsdel",
  segment: "Transport",
  division: "Område",
  division_boundary: "Administrativ grense",
  water: "Vann",
  land_use: "Arealbruk",
  land: "Terreng",
  land_cover: "Arealdekke",
  infrastructure: "Infrastruktur",
};

const WORDS: Record<string, string> = {
  residential: "bolig",
  commercial: "næring",
  industrial: "industri",
  education: "utdanning",
  civic: "offentlig",
  religious: "religiøs",
  medical: "helse",
  outbuilding: "uthus",
  agricultural: "landbruk",
  transportation: "transport",
  entertainment: "underholdning",
  apartments: "leiligheter",
  house: "enebolig",
  office: "kontor",
  retail: "butikk",
  garage: "garasje",
  school: "skole",
  church: "kirke",
  road: "vei",
  rail: "jernbane",
  water: "vann",
  footway: "gangvei",
  cycleway: "sykkelvei",
  path: "sti",
  steps: "trapp",
  motorway: "motorvei",
  trunk: "stamvei",
  primary: "hovedvei",
  secondary: "fylkesvei",
  tertiary: "samlevei",
  service: "tjenestevei",
  living_street: "gatetun",
  pedestrian: "gågate",
  unclassified: "lokalvei",
  standard_gauge: "normalspor",
  subway: "T-bane",
  tram: "trikk",
  park: "park",
  river: "elv",
  lake: "innsjø",
  ocean: "hav",
  country: "land",
  region: "fylke/region",
  county: "kommune/fylke",
  locality: "tettsted",
  neighborhood: "nabolag",
  forest: "skog",
  tree: "tre",
};

function pretty(v: unknown): string {
  if (v == null || v === "") return "";
  const s = String(v);
  const t = WORDS[s] ?? s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function parse<T = unknown>(v: unknown): T | undefined {
  if (typeof v !== "string") return v as T;
  const s = v.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function safeUrl(u: string): string | null {
  try {
    const url = new URL(u.startsWith("http") ? u : `https://${u}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function featureTitle(f: MapGeoJSONFeature): string {
  const p = f.properties ?? {};
  const names = parse<{ primary?: string }>(p.names);
  if (p["@name"]) return String(p["@name"]);
  if (names?.primary) return names.primary;
  if (p.street || p.number) return `${p.street ?? ""} ${p.number ?? ""}${p.unit ? ` ${p.unit}` : ""}`.trim();
  return LAYER_LABEL[f.sourceLayer ?? ""] ?? "Objekt";
}

function placeGroup(cat: string): string | undefined {
  return PLACE_GROUPS.find((g) => g.match.some((m) => cat.includes(m)))?.label;
}

function osmLink(recordId: string): string | null {
  const m = /^([nwr])(\d+)/.exec(recordId);
  if (!m) return null;
  const kind = { n: "node", w: "way", r: "relation" }[m[1] as "n" | "w" | "r"];
  return `https://www.openstreetmap.org/${kind}/${m[2]}`;
}

export function renderFeatureInfo(f: MapGeoJSONFeature): string {
  const p = f.properties ?? {};
  const rows: [string, string][] = [];
  const add = (k: string, v: unknown, html = false) => {
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
    rows.push([k, html ? String(v) : esc(v)]);
  };

  const layer = f.sourceLayer ?? f.layer.id;
  const kind = LAYER_LABEL[layer] ?? pretty(layer);
  let subtitle = [pretty(p.subtype), pretty(p.class)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ");

  if (layer === "place") {
    const cat = String(p.basic_category ?? "");
    subtitle = [pretty(cat), placeGroup(cat)].filter(Boolean).join(" · ");
    const addr = parse<{ freeform?: string; postcode?: string; locality?: string }[]>(p.addresses)?.[0];
    if (addr) add("Adresse", [addr.freeform, [addr.postcode, addr.locality].filter(Boolean).join(" ")].filter(Boolean).join(", "));
    const phones = parse<string[]>(p.phones);
    if (phones?.length) add("Telefon", phones.map((t) => `<a href="tel:${esc(t)}">${esc(t)}</a>`).join("<br>"), true);
    const sites = parse<string[]>(p.websites) ?? [];
    const links = sites.map(safeUrl).filter((u): u is string => !!u);
    if (links.length)
      add("Nettsted", links.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname)}</a>`).join("<br>"), true);
    const brand = parse<{ names?: { primary?: string } }>(p.brand);
    add("Merkevare", brand?.names?.primary);
    if (typeof p.confidence === "number") add("Sikkerhet", `${Math.round(p.confidence * 100)} %`);
    if (p.operating_status && p.operating_status !== "open") add("Status", pretty(p.operating_status));
  }

  if (layer === "address") {
    add("Postnummer", [p.postcode, p.postal_city].filter(Boolean).join(" "));
    add("Bruksenhet", p.unit);
  }

  if (layer === "building" || layer === "building_part") {
    add("Høyde", typeof p.height === "number" ? `${p.height.toFixed(1)} m` : undefined);
    add("Etasjer", p.num_floors);
    add("Etasjer under bakken", p.num_floors_underground);
    add("Taktype", pretty(p.roof_shape));
    add("Fasade", pretty(p.facade_material));
    if (p.facade_color) add("Fasadefarge", `<span class="swatch" style="background:${esc(p.facade_color)}"></span>${esc(p.facade_color)}`, true);
  }

  if (layer === "segment") {
    const surface = parse<{ value?: string }[]>(p.road_surface)?.[0]?.value;
    add("Dekke", pretty(surface));
    const speed = parse<{ max_speed?: { value: number; unit: string } }[]>(p.speed_limits)?.[0]?.max_speed;
    if (speed) add("Fartsgrense", `${speed.value} ${speed.unit}`);
  }

  if (layer === "division" || layer === "division_area") {
    add("Land", p.country);
    if (typeof p.population === "number") add("Innbyggere", p.population.toLocaleString("nb-NO"));
    if (p.wikidata) add("Wikidata", `<a href="https://www.wikidata.org/wiki/${esc(p.wikidata)}" target="_blank" rel="noopener">${esc(p.wikidata)}</a>`, true);
  }

  if (p.wikidata && layer !== "division") {
    add("Wikidata", `<a href="https://www.wikidata.org/wiki/${esc(p.wikidata)}" target="_blank" rel="noopener">${esc(p.wikidata)}</a>`, true);
  }

  // Kildesporing: Overture slår sammen OSM, Meta, Microsoft, Esri m.fl.
  const sources = parse<{ dataset?: string; license?: string; record_id?: string }[]>(p.sources) ?? [];
  const uniq = new Map<string, string>();
  for (const s of sources) {
    if (!s.dataset || uniq.has(s.dataset)) continue;
    const link = s.dataset === "OpenStreetMap" && s.record_id ? osmLink(s.record_id) : null;
    const label = `${esc(s.dataset)}${s.license ? ` <small>(${esc(s.license)})</small>` : ""}`;
    uniq.set(s.dataset, link ? `<a href="${link}" target="_blank" rel="noopener">${label}</a>` : label);
  }
  if (uniq.size) add("Kilder", [...uniq.values()].join("<br>"), true);

  if (p.id) {
    add(
      "GERS-ID",
      `<button class="copy-id" data-copy="${esc(p.id)}" title="Kopier Overtures globale ID">${esc(String(p.id).slice(0, 13))}…</button>`,
      true,
    );
  }

  return `
    <div class="info-kind">${esc(kind)}</div>
    <h3 class="info-title">${esc(featureTitle(f))}</h3>
    ${subtitle ? `<div class="info-sub">${esc(subtitle)}</div>` : ""}
    ${rows.length ? `<dl class="info-rows">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
  `;
}
