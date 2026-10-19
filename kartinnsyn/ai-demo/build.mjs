// Bygger Kartlab for ett eller alle områdene i areas.json.
//
//   node ai-demo/build.mjs [kristiansand|oslo|all]   (standard: all)
//
// For hvert område i ai-demo/dist/<område>/:
//   kartlab.html  siden slik den publiseres som Artifact på claude.ai
//   index.html    samme side som frittstående nettside (lokalt, Cloudflare Workers)
//   data/, fonts/ kartdata og glyfer
// I tillegg ai-demo/dist/index.html: startside med valg av by.
//
// Datagrunnlaget lages først med:  node ai-demo/scripts/prepare-data.mjs
import { build } from "vite";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const areas = JSON.parse(readFileSync(join(here, "areas.json"), "utf8"));
const allKeys = Object.keys(areas).filter((k) => !k.startsWith("_"));
const wanted = process.argv[2] ?? "all";
const keys = wanted === "all" ? allKeys : [wanted];
for (const k of keys) if (!areas[k]) throw new Error(`Ukjent område «${k}». Se areas.json.`);

// Artifacts serverer bare kjente web-filtyper, så binære PMTiles og glyfer
// pakkes som base64-tekst og dekodes i nettleseren.
const TILES = ["base", "transportation", "buildings", "places", "divisions"];
const JSONS = ["places.json", "buildings.json", "districts.geojson", "analysis.json"];

for (const k of keys) {
  const dataDir = join(here, areas[k].data);
  const missing = [...TILES.map((t) => `${t}.pmtiles`), ...JSONS].filter((f) => !existsSync(join(dataDir, f)));
  if (missing.length) {
    throw new Error(`Mangler data for ${k} i ${relative(process.cwd(), dataDir)}: ${missing.join(", ")}.\n` +
      `Kjør først: node ai-demo/scripts/prepare-data.mjs ${k}`);
  }
}

await build({
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: join(here, ".bundle"),
    emptyOutDir: true,
    minify: true,
    target: "es2022",
    lib: { entry: join(here, "src/app.ts"), formats: ["iife"], name: "Kartlab", fileName: () => "app.js" },
  },
});

const app = readFileSync(join(here, ".bundle/app.js"), "utf8").replace(/<\/script/gi, "<\\/script");
const css = readFileSync(join(here, "vendor/maplibre-gl-5.24.0.css"), "utf8");
const template = readFileSync(join(here, "page.html"), "utf8");
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const standalone = (body, lang = "nb") =>
  `<!doctype html>\n<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n${body}\n</body></html>\n`;

for (const key of keys) {
  const area = areas[key];
  const dataDir = join(here, area.data);
  const dist = join(here, "dist", key);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, "data"), { recursive: true });

  for (const t of TILES) writeFileSync(join(dist, "data", `${t}.pmtiles.txt`), readFileSync(join(dataDir, `${t}.pmtiles`)).toString("base64"));
  for (const f of JSONS) cpSync(join(dataDir, f), join(dist, "data", f));
  const total = [...TILES.map((t) => `${t}.pmtiles.txt`), ...JSONS].reduce((s, f) => s + statSync(join(dist, "data", f)).size, 0);

  const fields = {
    ...Object.fromEntries(Object.entries(area).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, esc(v)])),
    suggestions: area.suggestions.map(([q, label]) => `        <button type="button" data-q="${esc(q)}">${esc(label)}</button>`).join("\n"),
  };
  const config = JSON.stringify({ name: area.name, start: area.start, areaChip: area.areaChip, areaTitle: area.areaTitle }).replace(/</g, "\\u003c");
  // Plassholderne fylles i malen før CSS og JS settes inn, så koden aldri tolkes som mal.
  const page = template
    .replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (!(k in fields)) throw new Error(`Mangler ${k} for ${key} i areas.json`);
      return fields[k];
    })
    .replace("__TOTAL_BYTES__", String(total))
    .replace("/* MAPLIBRE_CSS */", () => css)
    .replace("/* APP_JS */", () => `window.KARTLAB_AREA = ${config};\n${app}`);
  writeFileSync(join(dist, "kartlab.html"), page);
  writeFileSync(join(dist, "index.html"), standalone(page));

  const fonts = { regular: "Noto Sans Regular", italic: "Noto Sans Italic" };
  for (const [dir, name] of Object.entries(fonts)) {
    const src = join(here, "..", "public", "fonts", name);
    mkdirSync(join(dist, "fonts", dir), { recursive: true });
    for (const f of readdirSync(src)) writeFileSync(join(dist, "fonts", dir, f.replace(".pbf", ".txt")), readFileSync(join(src, f)).toString("base64"));
  }
  console.log(`${area.name}: side ${(page.length / 1024).toFixed(0)} kB, data ${(total / 1e6).toFixed(1)} MB -> ${relative(process.cwd(), dist)}/`);
}

// Startside med valg av by (lister alle områder som er bygget).
const built = allKeys.filter((k) => existsSync(join(here, "dist", k, "index.html")));
const cards = built.map((k) => {
  const a = JSON.parse(readFileSync(join(here, areas[k].data, "analysis.json"), "utf8"));
  const n = (v) => Number(v).toLocaleString("nb-NO");
  return `<a class="card" href="${k}/">
      <span class="name">${esc(areas[k].name)}</span>
      <span class="meta">${n(a.antall.steder)} steder · ${n(a.antall.bygninger)} bygninger · ${a.antall.bydeler} ${esc(a.omradetype.split(" ")[0])}</span>
    </a>`;
}).join("\n    ");
writeFileSync(join(here, "dist", "index.html"), standalone(`<title>Kartlab</title>
<style>
:root { --bg: #eef2f4; --surface: #fff; --ink: #0f1d26; --muted: #56666f; --line: rgba(15,29,38,.12); --accent: #0b6e8a; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b131a; --surface: #121d25; --ink: #e5edf1; --muted: #93a5b0; --line: rgba(229,237,241,.12); --accent: #4fc0dd; color-scheme: dark; } }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 720px; margin: 0 auto; padding-block: 56px; padding-inline: 16px; }
h1 { font-size: 32px; margin: 0 0 6px; letter-spacing: -0.02em; }
p { color: var(--muted); margin: 0 0 24px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.card { display: flex; flex-direction: column; gap: 4px; padding: 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; text-decoration: none; color: inherit; }
.card:hover, .card:focus-visible { border-color: var(--accent); }
.name { font-size: 20px; font-weight: 700; color: var(--accent); }
.meta { font-size: 14px; color: var(--muted); }
small { display: block; margin-top: 24px; color: var(--muted); }
</style>
<main>
  <h1>Kartlab</h1>
  <p>Overture Maps-data analysert med Claude Code og DuckDB, vist med MapLibre. Velg by.</p>
  <div class="cards">
    ${cards}
  </div>
  <small>KI-chatten krever at siden åpnes som Artifact på claude.ai. Kartet og analysen virker overalt.</small>
</main>`));
console.log(`Startside: ${relative(process.cwd(), join(here, "dist", "index.html"))}`);
