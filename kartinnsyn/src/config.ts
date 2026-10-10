/** Sentral konfigurasjon. Alt er statiske, åpne kilder uten API-nøkler. */

/** Overture publiserer hele datasettet som PMTiles i en åpen S3-bøtte med CORS. */
export const OVERTURE_BUCKET = "https://overturemaps-extras-us-west-2.s3.amazonaws.com";

/** Brukes hvis automatisk oppslag av nyeste utgave feiler. */
export const OVERTURE_FALLBACK_RELEASE = "2026-09-23.1";

export const OVERTURE_THEMES = [
  "base",
  "buildings",
  "transportation",
  "divisions",
  "places",
  "addresses",
] as const;
export type OvertureTheme = (typeof OVERTURE_THEMES)[number];

export function overtureUrl(release: string, theme: OvertureTheme): string {
  return `${OVERTURE_BUCKET}/tiles/${release}/${theme}.pmtiles`;
}

/** Selvhostede glyfer (Noto Sans, SIL OFL) slik at etiketter fungerer uten tredjepart. */
export function glyphsUrl(): string {
  // URL() ville prosentkodet {plassholderne}, så bare basen løses opp.
  return `${new URL("fonts/", document.baseURI).href}{fontstack}/{range}.pbf`;
}

/** Åpen høydemodell (Terrarium-koding) fra AWS Open Data. */
export const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/** Skyfri Sentinel-2-mosaikk fra EOX (CC BY-NC-SA 4.0). */
export const SATELLITE_TILES =
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg";

/** Photon er en åpen kildekode-geokoder basert på OpenStreetMap. */
export const GEOCODER_URL = "https://photon.komoot.io/api/";

export const DEFAULT_VIEW = { center: [10.7522, 59.9139] as [number, number], zoom: 13, bearing: 0, pitch: 0 };

const RELEASE_CACHE_KEY = "kartinnsyn:overture-release";
const RELEASE_CACHE_MS = 12 * 60 * 60 * 1000;

/**
 * Finner nyeste Overture-utgave ved å liste bøtta direkte (S3 ListObjectsV2 er
 * åpen for CORS). Ingen server eller indeks trengs, bare objektlagringen.
 */
export async function resolveOvertureRelease(): Promise<string> {
  const forced = new URLSearchParams(location.search).get("release");
  if (forced && /^\d{4}-\d{2}-\d{2}\.\d+$/.test(forced)) return forced;

  try {
    const cached = JSON.parse(localStorage.getItem(RELEASE_CACHE_KEY) ?? "null");
    if (cached && Date.now() - cached.t < RELEASE_CACHE_MS) return cached.release;
  } catch {
    /* lagring er valgfri */
  }

  try {
    const res = await fetch(`${OVERTURE_BUCKET}/?list-type=2&delimiter=/&prefix=tiles/`, {
      signal: AbortSignal.timeout(4000),
    });
    const xml = new DOMParser().parseFromString(await res.text(), "application/xml");
    const releases = [...xml.querySelectorAll("CommonPrefixes > Prefix")]
      .map((n) => n.textContent?.replace(/^tiles\/|\/$/g, "") ?? "")
      .filter((r) => /^\d{4}-\d{2}-\d{2}\.\d+$/.test(r))
      .sort(compareReleases);
    const latest = releases.at(-1);
    if (latest) {
      try {
        localStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify({ release: latest, t: Date.now() }));
      } catch {
        /* lagring er valgfri */
      }
      return latest;
    }
  } catch (err) {
    console.warn("Fant ikke nyeste Overture-utgave, bruker reserve", err);
  }
  return OVERTURE_FALLBACK_RELEASE;
}

function compareReleases(a: string, b: string): number {
  const [da, na] = a.split(".");
  const [db, nb] = b.split(".");
  return da === db ? Number(na) - Number(nb) : da < db ? -1 : 1;
}
