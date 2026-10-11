// Bygger Kartlab Oslo som én Artifact-side med datafiler ved siden av.
//   node ai-demo/build.mjs   ->  ai-demo/dist/
import { build } from "vite";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
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
for (const t of TILES) writeFileSync(join(dist, "data", `${t}.pmtiles.txt`), readFileSync(join(here, "data", `${t}.pmtiles`)).toString("base64"));
for (const f of JSONS) cpSync(join(here, "data", f), join(dist, "data", f));
const total = [...TILES.map((t) => `${t}.pmtiles.txt`), ...JSONS].reduce((s, f) => s + statSync(join(dist, "data", f)).size, 0);

const page = readFileSync(join(here, "page.html"), "utf8")
  .replace("/* MAPLIBRE_CSS */", () => css)
  .replace("/* APP_JS */", () => app)
  .replace("__TOTAL_BYTES__", String(total));
writeFileSync(join(dist, "kartlab-oslo.html"), page);

const fonts = { regular: "Noto Sans Regular", italic: "Noto Sans Italic" };
mkdirSync(join(dist, "fonts"));
for (const [dir, name] of Object.entries(fonts)) {
  const src = join(here, "..", "public", "fonts", name);
  mkdirSync(join(dist, "fonts", dir));
  for (const f of readdirSync(src)) writeFileSync(join(dist, "fonts", dir, f.replace(".pbf", ".txt")), readFileSync(join(src, f)).toString("base64"));
}
console.log(`Side: ${(page.length / 1024).toFixed(0)} kB, data: ${(total / 1e6).toFixed(1)} MB`);
