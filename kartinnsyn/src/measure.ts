import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from "maplibre-gl";
import type { Feature, FeatureCollection } from "geojson";

/** Måling av avstand og areal på jordkula (haversine og sfærisk polygonareal). */

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function distance(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function area(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
  }
  return Math.abs((sum * R * R) / 2);
}

export const fmtLength = (m: number) =>
  m >= 1000 ? `${(m / 1000).toLocaleString("nb-NO", { maximumFractionDigits: 2 })} km` : `${Math.round(m).toLocaleString("nb-NO")} m`;

export const fmtArea = (m2: number) =>
  m2 >= 1e6
    ? `${(m2 / 1e6).toLocaleString("nb-NO", { maximumFractionDigits: 2 })} km²`
    : m2 >= 1e4
      ? `${(m2 / 1e3).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} daa`
      : `${Math.round(m2).toLocaleString("nb-NO")} m²`;

export type MeasureMode = "distance" | "area";

export class MeasureTool {
  private points: [number, number][] = [];
  private cursor: [number, number] | null = null;
  mode: MeasureMode | null = null;
  done = false;

  constructor(
    private map: MlMap,
    private sourceId: () => string,
    private onChange: (summary: string | null) => void,
  ) {
    map.on("click", this.onClick);
    map.on("mousemove", this.onMove);
    map.on("dblclick", this.onDblClick);
  }

  get active() {
    return this.mode !== null;
  }

  start(mode: MeasureMode) {
    this.mode = mode;
    this.points = [];
    this.done = false;
    this.map.doubleClickZoom.disable();
    this.map.getCanvas().style.cursor = "crosshair";
    this.update();
  }

  stop() {
    this.mode = null;
    this.points = [];
    this.cursor = null;
    this.map.doubleClickZoom.enable();
    this.map.getCanvas().style.cursor = "";
    this.update();
  }

  finish() {
    this.done = true;
    this.cursor = null;
    this.map.getCanvas().style.cursor = "";
    this.update();
  }

  undo() {
    this.points.pop();
    this.done = false;
    this.update();
  }

  /** Data til stilens "measure"-kilde, slik at målingen overlever bytte av bakgrunnskart. */
  geojson(): FeatureCollection {
    const pts = this.cursor && !this.done ? [...this.points, this.cursor] : this.points;
    const features: Feature[] = this.points.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }));
    if (this.mode === "area" && pts.length >= 3) {
      features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] } });
    } else if (pts.length >= 2) {
      features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: pts } });
    }
    return { type: "FeatureCollection", features };
  }

  private summary(): string | null {
    if (!this.mode) return null;
    const pts = this.cursor && !this.done ? [...this.points, this.cursor] : this.points;
    if (this.mode === "distance") {
      if (pts.length < 2) return "Klikk i kartet for å starte måling";
      let d = 0;
      for (let i = 1; i < pts.length; i++) d += distance(pts[i - 1], pts[i]);
      return `Avstand: <strong>${fmtLength(d)}</strong>`;
    }
    if (pts.length < 3) return "Klikk minst tre punkter for å måle areal";
    let perim = 0;
    for (let i = 0; i < pts.length; i++) perim += distance(pts[i], pts[(i + 1) % pts.length]);
    const a = area(pts);
    const main = a >= 1e6 ? fmtArea(a) : `${Math.round(a).toLocaleString("nb-NO")} m²`;
    const daa = a >= 1e3 && a < 1e6 ? ` · ${(a / 1000).toLocaleString("nb-NO", { maximumFractionDigits: 1 })} daa` : "";
    return `Areal: <strong>${main}</strong>${daa} · omkrets ${fmtLength(perim)}`;
  }

  update() {
    const src = this.map.getSource(this.sourceId()) as GeoJSONSource | undefined;
    src?.setData(this.geojson());
    this.onChange(this.summary());
  }

  private onClick = (e: MapMouseEvent) => {
    if (!this.mode || this.done) return;
    this.points.push([e.lngLat.lng, e.lngLat.lat]);
    this.update();
  };

  private onDblClick = (e: MapMouseEvent) => {
    if (!this.mode || this.done) return;
    e.preventDefault();
    this.finish();
  };

  private onMove = (e: MapMouseEvent) => {
    if (!this.mode || this.done || !this.points.length) return;
    this.cursor = [e.lngLat.lng, e.lngLat.lat];
    this.update();
  };
}
