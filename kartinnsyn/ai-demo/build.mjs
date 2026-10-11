// Bygger Kartlab som én Artifact-side med datafiler ved siden av.
//   node ai-demo/build.mjs [kristiansand|oslo]   ->  ai-demo/dist/<område>/
// Byspesifikk tekst og startvisning ligger i areas.json.
import { build } from "vite";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const areaKey = process.argv[2] ?? "kristiansand";
const area = JSON.parse(readFileSync(join(here, "areas.json"), "utf8"))[areaKey];
if (!area) throw new Error(`Ukjent område «${areaKey}». Se areas.json.`);
const dataDir = join(here, area.data);
const dist = join(here, "dist", areaKey);
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: join(here, ".bundle"),
    emptyOutDir: true,
    minify: true,
    target: "es2022",
    lib: { entry: join(here, "src/app.ts"), formats: ["iife"], name: "KartlabOslo", fileName: () => "app.js" },
  },
});

const app = readFileSync(join(here, ".bundle/app.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const css = readFileSync(join(here, "vendor/maplibre-gl-5.24.0.css"), "utf8");
// Artifacts serverer bare kjente web-filtyper, så binære PMTiles og glyfer
// pakkes som base64-tekst og dekodes i nettleseren.
const TILES = ["base", "transportation", "buildings", "places", "divisions"];
const JSONS = ["places.json", "buildings.json", "districts.geojson", "analysis.json"];
mkdirSync(join(dist, "data"));
for (const t of TILES) writeFileSync(join(dist, "data", `${t}.pmtiles.txt`), readFileSync(join(dataDir, `${t}.pmtiles`)).toString("base64"));
for (const f of JSONS) cpSync(join(dataDir, f), join(dist, "data", f));
const total = [...TILES.map((t) => `${t}.pmtiles.txt`), ...JSONS].reduce((s, f) => s + statSync(join(dist, "data", f)).size, 0);

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const fields = {
  ...Object.fromEntries(Object.entries(area).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, esc(v)])),
  suggestions: area.suggestions.map(([q, label]) => `        <button type="button" data-q="${esc(q)}">${esc(label)}</button>`).join("\n"),
};
const config = JSON.stringify({ name: area.name, start: area.start, areaChip: area.areaChip, areaTitle: area.areaTitle }).replace(/</g, "\\u003c");
// Plassholderne fylles i malen før CSS og JS settes inn, så koden aldri tolkes som mal.
const page = readFileSync(join(here, "page.html"), "utf8")
  .replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in fields)) throw new Error(`Mangler ${k} i areas.json`);
    return fields[k];
  })
  .replace("__TOTAL_BYTES__", String(total))
  .replace("/* MAPLIBRE_CSS */", () => css)
  .replace("/* APP_JS */", () => `window.KARTLAB_AREA = ${config};\n${app}`);
writeFileSync(join(dist, "kartlab.html"), page);

const fonts = { regular: "Noto Sans Regular", italic: "Noto Sans Italic" };
mkdirSync(join(dist, "fonts"));
for (const [dir, name] of Object.entries(fonts)) {
  const src = join(here, "..", "public", "fonts", name);
  mkdirSync(join(dist, "fonts", dir));
  for (const f of readdirSync(src)) writeFileSync(join(dist, "fonts", dir, f.replace(".pbf", ".txt")), readFileSync(join(src, f)).toString("base64"));
}
console.log(`Side: ${(page.length / 1024).toFixed(0)} kB, data: ${(total / 1e6).toFixed(1)} MB`);
