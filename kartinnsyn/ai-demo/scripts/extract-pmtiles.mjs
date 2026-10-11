// Klipper ut et område fra Overtures PMTiles-arkiver i S3 og skriver små,
// selvstendige PMTiles v3-filer. Brukes fordi Artifact-sider bare kan lese
// filer som publiseres sammen med siden.
//
//   node extract-pmtiles.mjs <release> <minLon,minLat,maxLon,maxLat> <minZ> <maxZ> <utmappe> [tema...]
import { PMTiles, zxyToTileId } from "pmtiles";
import { gzipSync } from "node:zlib";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import { fromVectorTileJs } from "@maplibre/vt-pbf";
import { writeFileSync, mkdirSync } from "node:fs";

const [release, bboxArg, minZArg, maxZArg, outDir, ...themesArg] = process.argv.slice(2);
const [minLon, minLat, maxLon, maxLat] = bboxArg.split(",").map(Number);
const minZ = Number(minZArg);
const maxZ = Number(maxZArg);
const themes = themesArg.length ? themesArg : ["base", "transportation", "buildings", "places", "divisions"];
const ROOT = `https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/${release}/`;

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function varint(out, n) {
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

function serializeDirectory(entries) {
  const b = [];
  varint(b, entries.length);
  let last = 0;
  for (const e of entries) { varint(b, e.tileId - last); last = e.tileId; }
  for (const e of entries) varint(b, e.runLength);
  for (const e of entries) varint(b, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    varint(b, i > 0 && e.offset === prev.offset + prev.length ? 0 : e.offset + 1);
  });
  return gzipSync(Uint8Array.from(b));
}

function header(h) {
  const buf = Buffer.alloc(127);
  buf.write("PMTiles", 0, "ascii");
  buf.writeUInt8(3, 7);
  const u64 = (o, v) => buf.writeBigUInt64LE(BigInt(v), o);
  u64(8, h.rootOffset); u64(16, h.rootLength);
  u64(24, h.metaOffset); u64(32, h.metaLength);
  u64(40, 0); u64(48, 0);
  u64(56, h.dataOffset); u64(64, h.dataLength);
  u64(72, h.addressed); u64(80, h.entries); u64(88, h.contents);
  buf.writeUInt8(1, 96); // clustered
  buf.writeUInt8(2, 97); // intern komprimering: gzip
  buf.writeUInt8(2, 98); // flis-komprimering: gzip
  buf.writeUInt8(1, 99); // MVT
  buf.writeUInt8(minZ, 100); buf.writeUInt8(maxZ, 101);
  buf.writeInt32LE(Math.round(minLon * 1e7), 102); buf.writeInt32LE(Math.round(minLat * 1e7), 106);
  buf.writeInt32LE(Math.round(maxLon * 1e7), 110); buf.writeInt32LE(Math.round(maxLat * 1e7), 114);
  buf.writeUInt8(Math.min(maxZ, 13), 118);
  buf.writeInt32LE(Math.round(((minLon + maxLon) / 2) * 1e7), 119);
  buf.writeInt32LE(Math.round(((minLat + maxLat) / 2) * 1e7), 123);
  return buf;
}

// Felt kartet og agenten ikke bruker. Kildesporing beholdes der den vises i objektinfo.
const DROP = {
  base: ["sources", "source_tags", "cartography", "names", "version", "level"],
  transportation: ["sources", "connectors", "routes", "destinations", "prohibited_transitions", "access_restrictions", "level_rules", "subclass_rules", "width_rules", "names", "version", "rail_flags"],
  buildings: ["names", "version"],
  places: ["version"],
  divisions: ["sources", "hierarchies", "norms", "names", "capital_division_ids", "capital_of_divisions", "version"],
};

/** Dekoder flisa, fjerner felt og koder den på nytt som MVT. */
function slim(theme, bytes) {
  const drop = new Set(DROP[theme] ?? []);
  if (!drop.size) return bytes;
  const vt = new VectorTile(new Pbf(bytes));
  const layers = {};
  for (const [name, l] of Object.entries(vt.layers)) {
    layers[name] = {
      version: 2,
      name,
      extent: l.extent,
      length: l.length,
      feature(i) {
        const f = l.feature(i);
        const properties = {};
        for (const [k, v] of Object.entries(f.properties)) if (!drop.has(k)) properties[k] = v;
        return { type: f.type, id: f.id, extent: l.extent, properties, loadGeometry: () => f.loadGeometry() };
      },
    };
  }
  return fromVectorTileJs({ layers });
}

mkdirSync(outDir, { recursive: true });
for (const theme of themes) {
  const src = new PMTiles(ROOT + theme + ".pmtiles");
  const srcHeader = await src.getHeader();
  const meta = await src.getMetadata();
  const jobs = [];
  for (let z = Math.max(minZ, srcHeader.minZoom); z <= Math.min(maxZ, srcHeader.maxZoom); z++) {
    for (let x = lon2x(minLon, z); x <= lon2x(maxLon, z); x++) {
      for (let y = lat2y(maxLat, z); y <= lat2y(minLat, z); y++) jobs.push([z, x, y]);
    }
  }
  const tiles = [];
  for (let i = 0; i < jobs.length; i += 16) {
    const batch = await Promise.all(jobs.slice(i, i + 16).map(async ([z, x, y]) => {
      const r = await src.getZxy(z, x, y);
      return r ? { tileId: zxyToTileId(z, x, y), data: gzipSync(slim(theme, new Uint8Array(r.data)), { level: 9 }) } : null;
    }));
    tiles.push(...batch.filter(Boolean));
  }
  tiles.sort((a, b) => a.tileId - b.tileId);
  let offset = 0;
  const entries = tiles.map((t) => {
    const e = { tileId: t.tileId, offset, length: t.data.length, runLength: 1 };
    offset += t.data.length;
    return e;
  });
  const root = serializeDirectory(entries);
  const metaBytes = gzipSync(Buffer.from(JSON.stringify({ ...meta, description: `Overture ${release} ${theme}, utsnitt ${bboxArg}` })));
  const rootOffset = 127;
  const metaOffset = rootOffset + root.length;
  const dataOffset = metaOffset + metaBytes.length;
  if (rootOffset + root.length > 16384) throw new Error("Rotkatalogen er for stor; trenger bladkataloger");
  const file = Buffer.concat([
    header({ rootOffset, rootLength: root.length, metaOffset, metaLength: metaBytes.length, dataOffset, dataLength: offset, addressed: tiles.length, entries: tiles.length, contents: tiles.length }),
    root, metaBytes, ...tiles.map((t) => t.data),
  ]);
  writeFileSync(`${outDir}/${theme}.pmtiles`, file);
  console.log(`${theme}: ${tiles.length} fliser, ${(file.length / 1e6).toFixed(2)} MB`);
}
