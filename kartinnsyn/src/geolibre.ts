import type { Map as MlMap } from "maplibre-gl";
import { overtureUrl, type OvertureTheme } from "./config";
import { basemapStyleUrl, type MapState } from "./style";

/**
 * Eksporterer kartutsnittet som et GeoLibre-prosjekt (.geolibre.json).
 * Bruker GeoLibres egne pakker til å bygge prosjektet, så filen følger
 * prosjektformatet og åpnes direkte i GeoLibre (web, desktop eller Jupyter).
 * Pakkene lastes først når brukeren ber om eksport.
 */

const LAYERS: { theme: OvertureTheme; name: string; sourceLayers: string[]; color: string; when?: (s: MapState) => boolean }[] = [
  { theme: "buildings", name: "Overture – bygninger", sourceLayers: ["building"], color: "#b08968" },
  { theme: "transportation", name: "Overture – transport", sourceLayers: ["segment"], color: "#f08c00" },
  { theme: "places", name: "Overture – steder", sourceLayers: ["place"], color: "#e8590c", when: (s) => s.overlays.has("places") },
  { theme: "addresses", name: "Overture – adresser", sourceLayers: ["address"], color: "#5c7cfa", when: (s) => s.overlays.has("addresses") },
  { theme: "divisions", name: "Overture – administrative inndelinger", sourceLayers: ["division_boundary"], color: "#9a7fb5", when: (s) => s.overlays.has("boundaries") },
];

export async function exportGeoLibreProject(map: MlMap, state: MapState): Promise<void> {
  const [{ createEmptyProject, serializeProject }, { createPMTilesStoreLayer }] = await Promise.all([
    import("@geolibre/core"),
    import("@geolibre/map/pmtiles-layer"),
  ]);

  const c = map.getCenter();
  const b = map.getBounds();
  const project = createEmptyProject(`Kartinnsyn ${new Date().toLocaleDateString("nb-NO")}`, {
    // Overture-stilen bygges i klienten; GeoLibre får nærmeste åpne OSM-stil.
    basemapStyleUrl: basemapStyleUrl(state.basemap) ?? basemapStyleUrl("osm-liberty"),
    mapView: {
      center: [c.lng, c.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
    },
  });

  project.layers = LAYERS.filter((l) => !l.when || l.when(state)).map((l) =>
    createPMTilesStoreLayer({
      id: `overture-${l.theme}`,
      name: l.name,
      url: overtureUrl(state.release, l.theme),
      tileType: "vector",
      sourceLayers: l.sourceLayers,
      sourceLayerColors: Object.fromEntries(l.sourceLayers.map((s) => [s, l.color])),
    }),
  );

  const blob = new Blob([serializeProject(project)], { type: "application/json" });
  download(blob, "kartinnsyn.geolibre.json");
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
