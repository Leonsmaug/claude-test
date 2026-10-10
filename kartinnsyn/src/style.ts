import type * as GeoJSON from "geojson";
import type {
  ExpressionSpecification,
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import { glyphsUrl, overtureUrl, SATELLITE_TILES, TERRAIN_TILES } from "./config";

/**
 * Hele kartstilen bygges i klienten fra tilstanden. Bakgrunnskartet tegnes rett
 * fra Overtures PMTiles-arkiver i objektlagring: ingen flisserver, ingen API-nøkkel.
 */

export type BasemapId = "overture-light" | "overture-dark" | "satellite" | "osm-liberty" | "osm-positron";
export type OverlayId = "buildings3d" | "places" | "addresses" | "boundaries" | "hillshade";

export interface MapState {
  release: string;
  basemap: BasemapId;
  overlays: Set<OverlayId>;
  terrain: boolean;
  globe: boolean;
}

export const BASEMAPS: { id: BasemapId; label: string; note: string; dark?: boolean }[] = [
  { id: "overture-light", label: "Overture lys", note: "Tegnet direkte fra Overture PMTiles" },
  { id: "overture-dark", label: "Overture mørk", note: "Samme data, mørk stil", dark: true },
  { id: "satellite", label: "Satellitt", note: "Sentinel-2 med Overture-veier og navn", dark: true },
  { id: "osm-liberty", label: "OpenStreetMap", note: "OpenFreeMap Liberty" },
  { id: "osm-positron", label: "OSM lys", note: "OpenFreeMap Positron" },
];

const OFM_STYLES: Partial<Record<BasemapId, string>> = {
  "osm-liberty": "https://tiles.openfreemap.org/styles/liberty",
  "osm-positron": "https://tiles.openfreemap.org/styles/positron",
};

export function basemapStyleUrl(id: BasemapId): string | undefined {
  return OFM_STYLES[id];
}

interface Palette {
  land: string;
  water: string;
  waterLine: string;
  waterLabel: string;
  forest: string;
  grass: string;
  park: string;
  developed: string;
  snow: string;
  rock: string;
  building: string;
  buildingLine: string;
  road: string;
  roadCasing: string;
  roadMajor: string;
  motorway: string;
  path: string;
  rail: string;
  boundary: string;
  label: string;
  labelHalo: string;
  labelMinor: string;
}

const LIGHT: Palette = {
  land: "#f4f2ec",
  water: "#a9d3ea",
  waterLine: "#8cc0dd",
  waterLabel: "#3c78a3",
  forest: "#d3e5c6",
  grass: "#e1ecd2",
  park: "#cfe7c1",
  developed: "#eceae4",
  snow: "#fbfcfd",
  rock: "#e4e1db",
  building: "#dcd7cf",
  buildingLine: "#c9c3ba",
  road: "#ffffff",
  roadCasing: "#d6d1c8",
  roadMajor: "#fff4cf",
  motorway: "#fcd9a2",
  path: "#b8ab9a",
  rail: "#a9a4a0",
  boundary: "#9a7fb5",
  label: "#2f3640",
  labelHalo: "rgba(255,255,255,0.9)",
  labelMinor: "#5c6670",
};

const DARK: Palette = {
  land: "#1b1f24",
  water: "#0f2a3d",
  waterLine: "#18405b",
  waterLabel: "#7fb3d5",
  forest: "#1f2b22",
  grass: "#212a21",
  park: "#22301f",
  developed: "#20242a",
  snow: "#2b3138",
  rock: "#25282c",
  building: "#2c323a",
  buildingLine: "#373e47",
  road: "#3a414b",
  roadCasing: "#14171b",
  roadMajor: "#4a515b",
  motorway: "#6a5a3c",
  path: "#4d5560",
  rail: "#4f555c",
  boundary: "#9b86c2",
  label: "#e3e7ec",
  labelHalo: "rgba(15,17,20,0.9)",
  labelMinor: "#a8b0ba",
};

const FONT = ["Noto Sans Regular"];
const FONT_BOLD = ["Noto Sans Regular"];
const FONT_ITALIC = ["Noto Sans Italic"];

const isPolygon: ExpressionSpecification = ["==", ["geometry-type"], "Polygon"];
const isLine: ExpressionSpecification = ["==", ["geometry-type"], "LineString"];
const isPoint: ExpressionSpecification = ["==", ["geometry-type"], "Point"];
const name: ExpressionSpecification = ["coalesce", ["get", "@name"], ""];

/** Overtures dokumenterte attribusjonskrav for kildene i datasettet. */
const OVERTURE_ATTRIBUTION =
  '<a href="https://overturemaps.org" target="_blank" rel="noopener">© Overture Maps Foundation</a> · ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap-bidragsytere</a>';

function overtureSource(release: string, theme: Parameters<typeof overtureUrl>[1]): SourceSpecification {
  return {
    type: "vector",
    url: `pmtiles://${overtureUrl(release, theme)}`,
    attribution: OVERTURE_ATTRIBUTION,
  };
}

const ROAD_WIDTH: Record<string, [number, number]> = {
  motorway: [1.2, 22],
  trunk: [1.1, 20],
  primary: [1, 18],
  secondary: [0.8, 16],
  tertiary: [0.7, 14],
  residential: [0.4, 11],
  living_street: [0.4, 10],
  unclassified: [0.4, 10],
  service: [0.3, 7],
  pedestrian: [0.3, 6],
  unknown: [0.3, 6],
};

function roadWidth(scale = 1): ExpressionSpecification {
  const byClass = (stop: 0 | 1): ExpressionSpecification =>
    [
      "match",
      ["get", "class"],
      ...Object.entries(ROAD_WIDTH).flatMap(([k, v]) => [k, v[stop] * scale]),
      (stop ? 6 : 0.3) * scale,
    ] as unknown as ExpressionSpecification;
  return ["interpolate", ["exponential", 1.6], ["zoom"], 6, byClass(0), 19, byClass(1)];
}

/** Bakgrunnskart fra Overture: arealdekke, vann, vei, bygninger og stedsnavn. */
function overtureBaseLayers(p: Palette, opts: { satellite: boolean }): LayerSpecification[] {
  const layers: LayerSpecification[] = [];
  const sat = opts.satellite;

  if (!sat) {
    layers.push(
      { id: "background", type: "background", paint: { "background-color": p.land } },
      {
        id: "land-cover",
        type: "fill",
        source: "base",
        "source-layer": "land_cover",
        maxzoom: 15,
        paint: {
          "fill-color": [
            "match",
            ["get", "subtype"],
            ["forest", "mangrove"], p.forest,
            ["grass", "shrub", "crop", "moss", "wetland"], p.grass,
            "snow", p.snow,
            "barren", p.rock,
            "urban", p.developed,
            p.land,
          ],
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.9, 13, 0.5, 15, 0],
        },
      },
      {
        id: "land",
        type: "fill",
        source: "base",
        "source-layer": "land",
        filter: ["all", isPolygon, ["has", "subtype"]],
        paint: {
          "fill-color": [
            "match",
            ["get", "subtype"],
            ["forest", "tree"], p.forest,
            ["grass", "shrub", "wetland"], p.grass,
            ["glacier", "snow"], p.snow,
            ["rock", "sand", "physical"], p.rock,
            p.land,
          ],
        },
      },
      {
        id: "land-use",
        type: "fill",
        source: "base",
        "source-layer": "land_use",
        filter: isPolygon,
        paint: {
          "fill-color": [
            "match",
            ["get", "subtype"],
            ["park", "recreation", "managed", "golf", "cemetery", "winter_sports"], p.park,
            ["agriculture", "horticulture"], p.grass,
            p.developed,
          ],
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 13, 0.85],
        },
      },
    );
  }

  layers.push(
    {
      id: "water",
      type: "fill",
      source: "base",
      "source-layer": "water",
      filter: isPolygon,
      paint: { "fill-color": p.water, "fill-opacity": sat ? 0 : 1 },
    },
    {
      id: "water-line",
      type: "line",
      source: "base",
      "source-layer": "water",
      filter: isLine,
      minzoom: 9,
      paint: {
        "line-color": sat ? "rgba(120,180,230,0.7)" : p.waterLine,
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 16, ["match", ["get", "subtype"], ["river", "canal"], 5, 1.5]],
      },
    },
  );

  if (!sat) {
    layers.push(
      {
        id: "pier",
        type: "fill",
        source: "base",
        "source-layer": "infrastructure",
        filter: ["all", isPolygon, ["in", ["get", "subtype"], ["literal", ["pier", "bridge", "quay"]]]],
        minzoom: 13,
        paint: { "fill-color": p.developed },
      },
      {
        id: "buildings-flat",
        type: "fill",
        source: "buildings",
        "source-layer": "building",
        minzoom: 13,
        paint: {
          "fill-color": p.building,
          "fill-outline-color": p.buildingLine,
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, 1],
        },
      },
    );
  }

  const roadFilter = (classes: string[]): ExpressionSpecification => [
    "all",
    ["==", ["get", "subtype"], "road"],
    ["in", ["get", "class"], ["literal", classes]],
  ];
  const minor = ["residential", "living_street", "unclassified", "service", "pedestrian", "unknown"];
  const major = ["primary", "secondary", "tertiary"];
  const highway = ["motorway", "trunk"];
  const paths = ["footway", "path", "steps", "cycleway", "track", "bridleway", "sidewalk", "crosswalk"];

  // Overture gir enkelte lavzoom-segmenter uten attributter; tegnes som tynne veier.
  layers.push({
    id: "road-generalized",
    type: "line",
    source: "transportation",
    "source-layer": "segment",
    filter: ["!", ["has", "subtype"]],
    maxzoom: 13,
    paint: {
      "line-color": sat ? "rgba(255,255,255,0.35)" : p.roadCasing,
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.2, 12, 0.8],
    },
  });

  layers.push(
    {
      id: "path",
      type: "line",
      source: "transportation",
      "source-layer": "segment",
      minzoom: 14,
      filter: roadFilter(paths),
      paint: {
        "line-color": sat ? "rgba(255,255,255,0.6)" : p.path,
        "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 19, 2.5],
        "line-dasharray": [2, 1.5],
      },
    },
    {
      id: "rail",
      type: "line",
      source: "transportation",
      "source-layer": "segment",
      minzoom: 8,
      filter: ["==", ["get", "subtype"], "rail"],
      paint: {
        "line-color": p.rail,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 18, 2.5],
        "line-dasharray": ["literal", [3, 2]],
      },
    },
  );

  for (const [group, classes, color, minzoom] of [
    ["minor", minor, p.road, 11],
    ["major", major, p.roadMajor, 7],
    ["highway", highway, p.motorway, 5],
  ] as const) {
    if (!sat) {
      layers.push({
        id: `road-${group}-casing`,
        type: "line",
        source: "transportation",
        "source-layer": "segment",
        minzoom,
        filter: roadFilter([...classes]),
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": p.roadCasing, "line-width": roadWidth(1.25), "line-gap-width": 0 },
      });
    }
    layers.push({
      id: `road-${group}`,
      type: "line",
      source: "transportation",
      "source-layer": "segment",
      minzoom,
      filter: roadFilter([...classes]),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": sat ? (group === "minor" ? "rgba(255,255,255,0.55)" : "rgba(255,226,150,0.85)") : color,
        "line-width": sat ? roadWidth(0.45) : roadWidth(),
      },
    });
  }

  return layers;
}

function overtureLabelLayers(p: Palette): LayerSpecification[] {
  const halo = { "text-halo-color": p.labelHalo, "text-halo-width": 1.4, "text-halo-blur": 0.5 };
  const division = (subtypes: string[]): ExpressionSpecification => [
    "all",
    isPoint,
    ["in", ["get", "subtype"], ["literal", subtypes]],
  ];
  return [
    {
      id: "label-water",
      type: "symbol",
      source: "base",
      "source-layer": "water",
      minzoom: 11,
      filter: ["all", isPolygon, ["!=", name, ""]],
      layout: {
        "text-field": name,
        "text-font": FONT_ITALIC,
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 11, 16, 14],
        "text-max-width": 8,
      },
      paint: { "text-color": p.waterLabel, ...halo },
    },
    {
      id: "label-waterway",
      type: "symbol",
      source: "base",
      "source-layer": "water",
      minzoom: 13,
      filter: ["all", isLine, ["!=", name, ""]],
      layout: {
        "text-field": name,
        "text-font": FONT_ITALIC,
        "text-size": 11,
        "symbol-placement": "line",
      },
      paint: { "text-color": p.waterLabel, ...halo },
    },
    {
      id: "label-park",
      type: "symbol",
      source: "base",
      "source-layer": "land_use",
      minzoom: 14,
      filter: ["all", ["!=", name, ""], ["in", ["get", "subtype"], ["literal", ["park", "recreation", "cemetery"]]]],
      layout: { "text-field": name, "text-font": FONT_ITALIC, "text-size": 11, "text-max-width": 8 },
      paint: { "text-color": "#3f7a3a", ...halo },
    },
    {
      id: "label-road",
      type: "symbol",
      source: "transportation",
      "source-layer": "segment",
      minzoom: 13,
      filter: ["all", ["==", ["get", "subtype"], "road"], ["!=", name, ""]],
      layout: {
        "symbol-placement": "line",
        "text-field": name,
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 18, 14],
        "text-max-angle": 30,
      },
      paint: { "text-color": p.labelMinor, ...halo },
    },
    {
      id: "label-neighbourhood",
      type: "symbol",
      source: "divisions",
      "source-layer": "division",
      minzoom: 12,
      filter: division(["neighborhood", "macrohood"]),
      layout: {
        "text-field": name,
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 11, 16, 14],
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08,
        "text-max-width": 8,
        "symbol-sort-key": ["-", 0, ["coalesce", ["get", "@prominence"], 0]],
      },
      paint: { "text-color": p.labelMinor, ...halo },
    },
    {
      id: "label-locality",
      type: "symbol",
      source: "divisions",
      "source-layer": "division",
      minzoom: 5,
      filter: division(["locality", "localadmin"]),
      layout: {
        "text-field": name,
        "text-font": FONT_BOLD,
        "text-size": [
          "interpolate", ["linear"], ["zoom"],
          5, ["match", ["get", "class"], ["megacity", "city"], 12, 9],
          12, ["match", ["get", "class"], ["megacity", "city"], 20, "town", 16, 13],
        ],
        "text-max-width": 8,
        "symbol-sort-key": ["-", 0, ["coalesce", ["get", "@prominence"], 0]],
      },
      paint: { "text-color": p.label, ...halo },
    },
    {
      id: "label-region",
      type: "symbol",
      source: "divisions",
      "source-layer": "division",
      minzoom: 4,
      maxzoom: 9,
      filter: division(["region"]),
      layout: {
        "text-field": name,
        "text-font": FONT,
        "text-size": 12,
        "text-transform": "uppercase",
        "text-letter-spacing": 0.12,
        "text-max-width": 7,
      },
      paint: { "text-color": p.labelMinor, ...halo },
    },
    {
      id: "label-country",
      type: "symbol",
      source: "divisions",
      "source-layer": "division",
      maxzoom: 7,
      filter: division(["country"]),
      layout: {
        "text-field": name,
        "text-font": FONT_BOLD,
        "text-size": ["interpolate", ["linear"], ["zoom"], 2, 11, 6, 16],
        "text-max-width": 7,
        "symbol-sort-key": ["-", 0, ["coalesce", ["get", "@prominence"], 0]],
      },
      paint: { "text-color": p.label, ...halo },
    },
  ];
}

/** Kategorier for Overture Places, avledet av `basic_category`. Første treff vinner. */
export const PLACE_GROUPS: { id: string; label: string; color: string; match: string[] }[] = [
  { id: "food", label: "Mat og drikke", color: "#e8590c", match: ["restaurant", "eatery", "cafe", "coffee", "bar", "pub", "bakery", "food_court", "brewery", "winery"] },
  { id: "health", label: "Helse", color: "#e03131", match: ["clinic", "hospital", "pharmacy", "medical", "health", "dental", "doctor", "physician"] },
  { id: "shop", label: "Handel", color: "#7048e8", match: ["_store", "shopping", "market", "supermarket", "mall"] },
  { id: "culture", label: "Kultur og utdanning", color: "#1971c2", match: ["school", "college", "university", "library", "museum", "gallery", "education", "learning", "theatre", "theater", "music_venue", "arts", "historic", "worship", "cinema"] },
  { id: "travel", label: "Reise og overnatting", color: "#0c8599", match: ["hotel", "lodging", "hostel", "travel", "transportation", "station", "airport", "parking"] },
  { id: "outdoor", label: "Natur, sport og fritid", color: "#2f9e44", match: ["park", "gym", "sport", "fitness", "playground", "beach", "trail", "golf", "swimming", "recreation"] },
];

function placeColor(): ExpressionSpecification {
  const cat: ExpressionSpecification = ["coalesce", ["get", "basic_category"], ""];
  const cases: unknown[] = [];
  for (const g of PLACE_GROUPS) {
    cases.push(["any", ...g.match.map((m) => ["in", m, cat])], g.color);
  }
  return ["case", ...cases, "#868e96"] as unknown as ExpressionSpecification;
}

function overlayLayers(state: MapState, p: Palette): LayerSpecification[] {
  const out: LayerSpecification[] = [];
  const halo = { "text-halo-color": p.labelHalo, "text-halo-width": 1.4 };

  if (state.overlays.has("hillshade")) {
    out.push({
      id: "hillshade",
      type: "hillshade",
      source: "dem",
      paint: {
        "hillshade-exaggeration": 0.35,
        "hillshade-shadow-color": p === DARK ? "#000000" : "#5a5040",
        "hillshade-highlight-color": "#ffffff",
      },
    });
  }

  if (state.overlays.has("boundaries")) {
    out.push({
      id: "boundary",
      type: "line",
      source: "divisions",
      "source-layer": "division_boundary",
      filter: ["!=", ["get", "is_land"], false],
      layout: { "line-join": "round" },
      paint: {
        "line-color": p.boundary,
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          2, ["match", ["get", "subtype"], "country", 1, "region", 0.5, 0.3],
          10, ["match", ["get", "subtype"], "country", 3, "region", 2, 1.2],
        ],
        "line-dasharray": ["literal", [4, 2]],
        "line-opacity": 0.85,
      },
    });
  }

  if (state.overlays.has("buildings3d")) {
    const height: ExpressionSpecification = [
      "coalesce",
      ["get", "height"],
      ["*", ["coalesce", ["get", "num_floors"], 2], 3.2],
    ];
    const color: ExpressionSpecification = [
      "to-color",
      ["get", "facade_color"],
      [
        "match", ["get", "subtype"],
        "residential", p === DARK ? "#3b4552" : "#e6ddd0",
        "commercial", p === DARK ? "#3d4a5c" : "#d8dde6",
        ["education", "civic", "religious", "medical"], p === DARK ? "#4b4258" : "#e4d7e6",
        "industrial", p === DARK ? "#45403a" : "#ddd6c9",
        p === DARK ? "#38404a" : "#e2ddd6",
      ],
    ];
    out.push(
      {
        id: "buildings-3d",
        type: "fill-extrusion",
        source: "buildings",
        "source-layer": "building",
        minzoom: 14,
        filter: ["all", ["!=", ["get", "has_parts"], true], ["!=", ["get", "is_underground"], true]],
        paint: {
          "fill-extrusion-color": color,
          "fill-extrusion-height": height,
          "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.92,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      {
        id: "building-parts-3d",
        type: "fill-extrusion",
        source: "buildings",
        "source-layer": "building_part",
        minzoom: 14,
        filter: ["!=", ["get", "is_underground"], true],
        paint: {
          "fill-extrusion-color": color,
          "fill-extrusion-height": height,
          "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.92,
        },
      },
    );
  }

  if (state.overlays.has("addresses")) {
    out.push({
      id: "addresses",
      type: "symbol",
      source: "addresses",
      "source-layer": "address",
      minzoom: 17,
      layout: {
        // Kun husnummer; bruksenheter (H0505) ville gjort kartet uleselig.
        "text-field": ["coalesce", ["get", "number"], ""],
        "text-font": FONT,
        "text-size": 10,
        "text-padding": 2,
      },
      paint: { "text-color": p.labelMinor, ...halo },
    });
  }

  if (state.overlays.has("places")) {
    out.push(
      {
        id: "places",
        type: "circle",
        source: "places",
        "source-layer": "place",
        minzoom: 14,
        filter: [">=", ["coalesce", ["get", "confidence"], 1], 0.5],
        paint: {
          "circle-color": placeColor(),
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2.5, 18, 6],
          "circle-stroke-color": p === DARK ? "#111" : "#fff",
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 18, 1.5],
        },
      },
      {
        id: "places-label",
        type: "symbol",
        source: "places",
        "source-layer": "place",
        minzoom: 16.5,
        filter: ["all", ["!=", name, ""], [">=", ["coalesce", ["get", "confidence"], 1], 0.75]],
        layout: {
          "text-field": name,
          "text-font": FONT,
          "text-size": 11,
          "text-anchor": "top",
          "text-offset": [0, 0.7],
          "text-max-width": 9,
          "text-optional": true,
          "symbol-sort-key": ["-", 0, ["coalesce", ["get", "confidence"], 0]],
        },
        paint: { "text-color": placeColor(), ...halo },
      },
    );
  }

  return out;
}

/** Interne lag for måling og markering av valgt objekt. */
function utilityLayers(state: MapState): LayerSpecification[] {
  const extrude: LayerSpecification[] = state.overlays.has("buildings3d")
    ? [
        {
          id: "selection-3d",
          type: "fill-extrusion",
          source: "selection",
          filter: ["all", isPolygon, ["has", "h"]],
          paint: {
            "fill-extrusion-color": "#ff3b6b",
            "fill-extrusion-height": ["+", ["get", "h"], 0.5],
            "fill-extrusion-base": ["coalesce", ["get", "b"], 0],
            "fill-extrusion-opacity": 0.75,
          },
        },
      ]
    : [];
  return [
    ...extrude,
    {
      id: "selection-fill",
      type: "fill",
      source: "selection",
      filter: isPolygon,
      paint: { "fill-color": "#ff3b6b", "fill-opacity": 0.18 },
    },
    {
      id: "selection-line",
      type: "line",
      source: "selection",
      paint: { "line-color": "#ff3b6b", "line-width": 3 },
    },
    {
      id: "selection-point",
      type: "circle",
      source: "selection",
      filter: isPoint,
      paint: { "circle-color": "#ff3b6b", "circle-radius": 9, "circle-opacity": 0.35, "circle-stroke-color": "#ff3b6b", "circle-stroke-width": 2 },
    },
    {
      id: "measure-fill",
      type: "fill",
      source: "measure",
      filter: isPolygon,
      paint: { "fill-color": "#1c7ed6", "fill-opacity": 0.15 },
    },
    {
      id: "measure-line",
      type: "line",
      source: "measure",
      filter: ["!", isPoint],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#1c7ed6", "line-width": 3, "line-dasharray": [2, 1] },
    },
    {
      id: "measure-point",
      type: "circle",
      source: "measure",
      filter: isPoint,
      paint: { "circle-color": "#fff", "circle-radius": 5, "circle-stroke-color": "#1c7ed6", "circle-stroke-width": 2.5 },
    },
  ];
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function commonSources(state: MapState): Record<string, SourceSpecification> {
  const r = state.release;
  return {
    base: overtureSource(r, "base"),
    transportation: overtureSource(r, "transportation"),
    buildings: overtureSource(r, "buildings"),
    divisions: overtureSource(r, "divisions"),
    places: overtureSource(r, "places"),
    addresses: overtureSource(r, "addresses"),
    dem: {
      type: "raster-dem",
      tiles: [TERRAIN_TILES],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 15,
      attribution: '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles (AWS Open Data)</a>',
    },
    selection: { type: "geojson", data: EMPTY },
    measure: { type: "geojson", data: EMPTY },
  };
}

const remoteStyleCache = new Map<string, Promise<StyleSpecification>>();

function fetchStyle(url: string): Promise<StyleSpecification> {
  let p = remoteStyleCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Kunne ikke hente kartstil (${r.status})`);
      return r.json();
    });
    p.catch(() => remoteStyleCache.delete(url));
    remoteStyleCache.set(url, p);
  }
  return p;
}

export function isDarkBasemap(id: BasemapId): boolean {
  return BASEMAPS.find((b) => b.id === id)?.dark === true;
}

/** Setter sammen komplett MapLibre-stil fra tilstanden. */
export async function composeStyle(state: MapState): Promise<StyleSpecification> {
  const p = state.basemap === "overture-dark" ? DARK : LIGHT;
  const overlays = overlayLayers(state, state.basemap === "satellite" ? DARK : p);
  const sources = commonSources(state);
  let style: StyleSpecification;

  const remote = basemapStyleUrl(state.basemap);
  if (remote) {
    const base = structuredClone(await fetchStyle(remote));
    // Overture-kildene får egne navn for ikke å kollidere med OpenFreeMap sine.
    const prefixed = Object.fromEntries(Object.entries(sources).map(([k, v]) => [`ov-${k}`, v]));
    const mapSource = (l: LayerSpecification): LayerSpecification =>
      "source" in l && typeof l.source === "string" ? ({ ...l, source: `ov-${l.source}` } as LayerSpecification) : l;
    // OpenFreeMap har egne bygningslag; skjul dem når Overture 3D er på.
    const baseLayers = state.overlays.has("buildings3d")
      ? base.layers.filter((l) => !/building/.test(l.id))
      : base.layers;
    style = {
      ...base,
      sources: { ...base.sources, ...prefixed },
      layers: [...baseLayers, ...overlays.map(mapSource), ...utilityLayers(state).map(mapSource)],
    };
    if (state.terrain) style.terrain = { source: "ov-dem", exaggeration: 1.4 };
  } else {
    const sat = state.basemap === "satellite";
    const baseLayers = overtureBaseLayers(sat ? DARK : p, { satellite: sat });
    const labels = overtureLabelLayers(sat ? DARK : p);
    if (sat) {
      sources.satellite = {
        type: "raster",
        tiles: [SATELLITE_TILES],
        tileSize: 256,
        maxzoom: 17,
        attribution:
          '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless – EOX IT Services GmbH</a> (inneholder modifiserte Copernicus Sentinel-data 2024)',
      };
      baseLayers.unshift(
        { id: "background", type: "background", paint: { "background-color": "#0b1a24" } },
        { id: "satellite", type: "raster", source: "satellite", paint: { "raster-saturation": -0.1, "raster-contrast": 0.05 } },
      );
    }
    style = {
      version: 8,
      name: "Kartinnsyn – Overture",
      glyphs: glyphsUrl(),
      sources,
      layers: [...baseLayers, ...overlays, ...labels, ...utilityLayers(state)],
    };
    if (state.terrain) style.terrain = { source: "dem", exaggeration: 1.4 };
  }

  style.projection = { type: state.globe ? "globe" : "mercator" };
  style.sky = isDarkBasemap(state.basemap)
    ? { "sky-color": "#0b1020", "horizon-color": "#1d2a44", "fog-color": "#0b1020", "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 0] }
    : { "sky-color": "#9cc8f0", "horizon-color": "#e6f0fa", "fog-color": "#ffffff", "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 10, 0] };
  return style;
}

/** Kilde-id i den aktive stilen (OpenFreeMap-stiler får prefiks). */
export function sourceId(state: MapState, id: string): string {
  return basemapStyleUrl(state.basemap) ? `ov-${id}` : id;
}

/** Lag som kan klikkes for objektinfo, i prioritert rekkefølge. */
export const QUERYABLE_LAYERS = [
  "places",
  "places-label",
  "addresses",
  "buildings-3d",
  "building-parts-3d",
  "buildings-flat",
  "road-highway",
  "road-major",
  "road-minor",
  "path",
  "rail",
  "label-locality",
  "label-neighbourhood",
  "water",
  "water-line",
  "land-use",
  "land",
  "boundary",
];
