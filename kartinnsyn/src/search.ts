import type { Map as MlMap } from "maplibre-gl";
import { GEOCODER_URL } from "./config";

/**
 * Søk som kombinerer tre kilder, uten egen server:
 *  1. koordinater skrevet direkte inn (desimalgrader, begge rekkefølger),
 *  2. Overture-steder som allerede er lastet i kartutsnittet (helt lokalt),
 *  3. Photon-geokoderen (åpen kildekode, OpenStreetMap-data).
 */

export interface SearchResult {
  label: string;
  detail: string;
  center: [number, number];
  bbox?: [number, number, number, number];
  source: "koordinat" | "i kartet" | "OSM";
}

export function parseCoordinates(q: string): SearchResult | null {
  const m = q.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  let a = parseFloat(m[1].replace(",", "."));
  let b = parseFloat(m[2].replace(",", "."));
  // Norsk vane er «breddegrad, lengdegrad»; bytt om hvis første tall ikke kan være breddegrad.
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return {
    label: `${a.toFixed(5)}, ${b.toFixed(5)}`,
    detail: "Gå til koordinat (bredde, lengde)",
    center: [b, a],
    source: "koordinat",
  };
}

export function searchLoadedPlaces(map: MlMap, sourceId: string, q: string, limit = 5): SearchResult[] {
  if (!map.getSource(sourceId) || q.length < 2) return [];
  const needle = q.toLocaleLowerCase("nb-NO");
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const f of map.querySourceFeatures(sourceId, { sourceLayer: "place" })) {
    const name = String(f.properties?.["@name"] ?? "");
    if (!name || !name.toLocaleLowerCase("nb-NO").includes(needle)) continue;
    const id = String(f.properties?.id ?? name);
    if (seen.has(id) || f.geometry.type !== "Point") continue;
    seen.add(id);
    out.push({
      label: name,
      detail: String(f.properties?.basic_category ?? "sted").replace(/_/g, " "),
      center: f.geometry.coordinates as [number, number],
      source: "i kartet",
    });
    if (out.length >= limit) break;
  }
  return out;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | number | number[] | undefined> & { extent?: number[] };
}

export async function geocode(q: string, near: [number, number], signal: AbortSignal): Promise<SearchResult[]> {
  const url = new URL(GEOCODER_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "7");
  url.searchParams.set("lon", near[0].toFixed(4));
  url.searchParams.set("lat", near[1].toFixed(4));
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Geokoding feilet (${res.status})`);
  const data = (await res.json()) as { features: PhotonFeature[] };
  return data.features.map((f) => {
    const p = f.properties;
    const street = [p.street, p.housenumber].filter(Boolean).join(" ");
    const label = String(p.name ?? (street || p.city || "Ukjent"));
    const detail = [p.name ? street : "", p.postcode, p.city ?? p.county, p.country]
      .filter((v, i, a) => v && v !== label && a.indexOf(v) === i)
      .join(", ");
    const e = p.extent;
    return {
      label,
      detail,
      center: f.geometry.coordinates,
      bbox: e && e.length === 4 ? [e[0], e[3], e[2], e[1]] : undefined,
      source: "OSM",
    } satisfies SearchResult;
  });
}
