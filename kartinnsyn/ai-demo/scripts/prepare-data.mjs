// Lager datagrunnlaget for ett eller alle områdene i areas.json:
// PMTiles-utsnitt fra Overtures fliser og DuckDB-analyse av Overtures GeoParquet.
//
//   node ai-demo/scripts/prepare-data.mjs [kristiansand|oslo|all]
//
// Krever Node 20+ og Python med duckdb (`pip install duckdb`). Sett PYTHON for å
// velge tolk, og DUCKDB_EXT_DIR hvis DuckDB-utvidelsene ikke kan lastes ned.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const areas = JSON.parse(readFileSync(join(root, "areas.json"), "utf8"));
const { tiles, parquet } = areas._overture;
const wanted = process.argv[2] ?? "all";
const keys = Object.keys(areas).filter((k) => !k.startsWith("_") && (wanted === "all" || k === wanted));
if (!keys.length) throw new Error(`Ukjent område «${wanted}».`);

const run = (cmd, args) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
};

for (const key of keys) {
  const a = areas[key];
  const out = join(root, a.data);
  const bbox = a.bbox.join(",");
  run(process.execPath, [join(here, "extract-pmtiles.mjs"), tiles, bbox, "12", "14", out]);
  run(process.env.PYTHON ?? "python3", [
    join(here, "analyse.py"), "--release", parquet, "--by", a.name, "--bbox", bbox, "--omrader", a.omrader, "--out", out,
    ...(process.env.DUCKDB_EXT_DIR ? ["--extensions", process.env.DUCKDB_EXT_DIR] : []),
  ]);
}
