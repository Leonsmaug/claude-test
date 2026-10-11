"""
Geodataanalyse av Overture Maps for Oslo sentrum med DuckDB.

Leser Overtures GeoParquet direkte fra S3 (kun radgruppene i utsnittet),
lagrer et lokalt uttrekk og lager datagrunnlaget for KI-kartet:

  data/places.json        alle steder (navn, kategori, posisjon, adresse ...)
  data/buildings.json     alle bygninger (sentroide, høyde, etasjer, areal ...)
  data/districts.geojson  bydeler klippet til utsnittet, med nøkkeltall
  data/analysis.json      sammendrag og kjøretider til presentasjonen

Kjør:  python analyse.py [--release 2026-09-23.0]
"""
import argparse, json, os, time
from pathlib import Path
import duckdb

BBOX = (10.68, 59.895, 10.83, 59.945)  # min lon, min lat, max lon, max lat
OUT = Path(__file__).resolve().parent.parent / "data"
CACHE = Path(os.environ.get("OVERTURE_CACHE", "/tmp/overture-cache"))

ap = argparse.ArgumentParser()
ap.add_argument("--release", default="2026-09-23.0")
ap.add_argument("--extensions", default=os.environ.get("DUCKDB_EXT_DIR"),
                help="mappe med httpfs/spatial hvis de ikke kan lastes ned automatisk")
args = ap.parse_args()
R = f"s3://overturemaps-us-west-2/release/{args.release}"

con = duckdb.connect()
for ext in ("httpfs", "spatial"):
    if args.extensions:
        con.execute(f"INSTALL '{args.extensions}/duckdb_extension_{ext}/extensions/v{duckdb.__version__}/{ext}.duckdb_extension'")
    else:
        con.execute(f"INSTALL {ext}")
    con.execute(f"LOAD {ext}")
# Overture-bøtta er offentlig: anonym tilgang.
con.execute("CREATE OR REPLACE SECRET anon (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2')")
if os.environ.get("HTTPS_PROXY"):
    con.execute(f"SET http_proxy='{os.environ['HTTPS_PROXY'].replace('http://', '')}'")
if os.environ.get("SSL_CERT_FILE") or Path("/root/.ccr/ca-bundle.crt").exists():
    con.execute(f"SET ca_cert_file='{os.environ.get('SSL_CERT_FILE', '/root/.ccr/ca-bundle.crt')}'")

steps = []
def step(label, sql, fetch=False):
    t = time.time()
    res = con.execute(sql)
    out = res.fetchall() if fetch else None
    steps.append({"steg": label, "sekunder": round(time.time() - t, 1)})
    print(f"{label}: {steps[-1]['sekunder']} s")
    return out

x0, y0, x1, y1 = BBOX
inside = f"bbox.xmin BETWEEN {x0} AND {x1} AND bbox.ymin BETWEEN {y0} AND {y1}"
CACHE.mkdir(parents=True, exist_ok=True)

def extract(name, path, where):
    f = CACHE / f"{args.release}-{name}.parquet"
    timing = f.with_suffix(".sekunder")
    label = "Hent " + {"places": "steder", "buildings": "bygninger", "districts_raw": "bydelsgrenser"}.get(name, name) + " fra S3 (GeoParquet)"
    if not f.exists():
        step(label, f"COPY (SELECT * FROM read_parquet('{R}/{path}/*') WHERE {where}) TO '{f}' (FORMAT parquet)")
        timing.write_text(str(steps[-1]["sekunder"]))
    else:
        # Lokalt uttrekk finnes: rapporter kjøretiden fra da det ble hentet fra S3.
        steps.append({"steg": label, "sekunder": float(timing.read_text()) if timing.exists() else None, "hurtigbuffer": True})
    con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_parquet('{f}')")

extract("places", "theme=places/type=place", inside)
extract("buildings", "theme=buildings/type=building", inside)
extract("districts_raw", "theme=divisions/type=division_area",
        f"bbox.xmin < {x1} AND bbox.xmax > {x0} AND bbox.ymin < {y1} AND bbox.ymax > {y0} "
        "AND country = 'NO' AND subtype IN ('macrohood', 'neighborhood')")

UTM = "ST_Transform(geometry, 'EPSG:4326', 'EPSG:25833', always_xy := true)"  # EUREF89 UTM 33

# Kategorigrupper som i kartet: første treff vinner.
GROUPS = [
    ("Mat og drikke", ["restaurant", "eatery", "cafe", "coffee", "bar", "pub", "bakery", "food_court", "brewery", "winery"]),
    ("Helse", ["clinic", "hospital", "pharmacy", "medical", "health", "dental", "doctor", "physician"]),
    ("Handel", ["_store", "shopping", "market", "supermarket", "mall"]),
    ("Kultur og utdanning", ["school", "college", "university", "library", "museum", "gallery", "education", "learning", "theatre", "theater", "music_venue", "arts", "historic", "worship", "cinema"]),
    ("Reise og overnatting", ["hotel", "lodging", "hostel", "travel", "transportation", "station", "airport", "parking"]),
    ("Natur, sport og fritid", ["park", "gym", "sport", "fitness", "playground", "beach", "trail", "golf", "swimming", "recreation"]),
    ("Tjenester og kontor", ["service", "office", "agency", "professional", "real_estate", "media", "attorney", "law_firm", "financial", "bank", "organization", "union", "consult"]),
]
group_sql = "CASE " + " ".join(
    "WHEN " + " OR ".join(f"contains(coalesce(basic_category, ''), '{m}')" for m in ms) + f" THEN '{g}'" for g, ms in GROUPS
) + " ELSE 'Annet' END"

step("Klassifiser steder", f"""
CREATE OR REPLACE TABLE p AS
SELECT id, names.primary AS name, basic_category AS cat, {group_sql} AS grp,
       round(ST_X(geometry), 6) AS lon, round(ST_Y(geometry), 6) AS lat,
       round(confidence, 2) AS conf, addresses[1].freeform AS addr,
       websites[1] AS web, phones[1] AS phone, brand.names.primary AS brand,
       operating_status AS status,
       list_distinct(list_transform(sources, s -> s.dataset)) AS datasets
FROM places WHERE names.primary IS NOT NULL""")

step("Beregn bygningsareal og høyder (UTM33)", f"""
CREATE OR REPLACE TABLE b AS
SELECT id, names.primary AS name, subtype, class,
       round(ST_X(ST_Centroid(geometry)), 6) AS lon, round(ST_Y(ST_Centroid(geometry)), 6) AS lat,
       round(height, 1) AS h, num_floors AS floors, round(ST_Area({UTM})) AS area_m2,
       sources[1].dataset AS dataset
FROM buildings WHERE NOT coalesce(is_underground, false)""")

step("Klipp bydeler til utsnittet og koble på nøkkeltall", f"""
CREATE OR REPLACE TABLE d AS
WITH clip AS (
  SELECT names.primary AS name, subtype,
         ST_Intersection(geometry, ST_MakeEnvelope({x0}, {y0}, {x1}, {y1})) AS geometry
  FROM districts_raw WHERE names.primary NOT IN ('Marka', 'Sørengutstikkeren')
), z AS (
  SELECT name, subtype, geometry, ST_Area({UTM}) / 1e6 AS km2 FROM clip WHERE NOT ST_IsEmpty(geometry)
)
SELECT z.name, z.subtype, round(z.km2, 3) AS km2, z.geometry,
  (SELECT count(*) FROM p WHERE ST_Contains(z.geometry, ST_Point(p.lon, p.lat))) AS steder,
  (SELECT count(*) FROM p WHERE p.grp = 'Mat og drikke' AND ST_Contains(z.geometry, ST_Point(p.lon, p.lat))) AS servering,
  (SELECT count(*) FROM b WHERE ST_Contains(z.geometry, ST_Point(b.lon, b.lat))) AS bygninger,
  (SELECT round(avg(h), 1) FROM b WHERE h IS NOT NULL AND ST_Contains(z.geometry, ST_Point(b.lon, b.lat))) AS snitthoyde
FROM z WHERE z.km2 > 0.05""")

# ---------- Utdata ----------
OUT.mkdir(parents=True, exist_ok=True)

def rows(sql):
    cur = con.execute(sql)
    cols = [c[0] for c in cur.description]
    return cols, cur.fetchall()

cols, data = rows("SELECT name, cat, grp, lon, lat, conf, addr, web, phone, brand, status, datasets FROM p ORDER BY conf DESC")
# Noen kildenavn har ødelagte tegn (U+FFFD); de fjernes.
clean = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("\ufffd", "")
(OUT / "places.json").write_text(clean({"columns": cols, "rows": data}))

cols, data = rows("SELECT name, subtype, class, lon, lat, h, floors, area_m2, dataset FROM b")
(OUT / "buildings.json").write_text(clean({"columns": cols, "rows": data}))

feats = []
for name, subtype, km2, gj, steder, servering, bygg, snitt in con.execute(
    "SELECT name, subtype, km2, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geometry, 0.00005)), steder, servering, bygninger, snitthoyde FROM d ORDER BY steder DESC"
).fetchall():
    feats.append({"type": "Feature", "geometry": json.loads(gj), "properties": {
        "navn": name, "km2": km2, "steder": steder, "servering": servering, "bygninger": bygg,
        "snitthoyde": snitt, "steder_per_km2": round(steder / km2) if km2 else None}})
(OUT / "districts.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")))

summary = {
    "release": args.release,
    "bbox": BBOX,
    "kildedata": "s3://overturemaps-us-west-2/release/" + args.release,
    "antall": dict(zip(["steder", "bygninger", "bygninger_med_hoyde", "bydeler"], con.execute(
        "SELECT (SELECT count(*) FROM p), (SELECT count(*) FROM b), (SELECT count(h) FROM b), (SELECT count(*) FROM d)").fetchone())),
    "grupper": con.execute("SELECT grp, count(*) n FROM p GROUP BY 1 ORDER BY 2 DESC").fetchall(),
    "toppkategorier": con.execute("SELECT cat, count(*) n FROM p WHERE cat IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 12").fetchall(),
    "datasett_steder": con.execute("SELECT ds, count(*) FROM (SELECT unnest(datasets) ds FROM p) GROUP BY 1 ORDER BY 2 DESC").fetchall(),
    "datasett_bygninger": con.execute("SELECT coalesce(dataset, 'ukjent'), count(*) FROM b GROUP BY 1 ORDER BY 2 DESC").fetchall(),
    "hoydefordeling": con.execute("""SELECT CASE WHEN h < 10 THEN '0–10 m' WHEN h < 20 THEN '10–20 m' WHEN h < 30 THEN '20–30 m'
        WHEN h < 50 THEN '30–50 m' ELSE '50 m +' END k, count(*) FROM b WHERE h IS NOT NULL GROUP BY 1 ORDER BY min(h)""").fetchall(),
    "hoyeste": con.execute("SELECT coalesce(name, class, subtype, 'Bygning'), h, lon, lat FROM b WHERE h IS NOT NULL AND area_m2 >= 30 ORDER BY h DESC LIMIT 8").fetchall(),
    "bydeler": con.execute("SELECT name, km2, steder, servering, bygninger, snitthoyde, round(steder / km2) FROM d ORDER BY 7 DESC").fetchall(),
    "steg": steps,
}
(OUT / "analysis.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
for f in ["places.json", "buildings.json", "districts.geojson", "analysis.json"]:
    print(f, round((OUT / f).stat().st_size / 1e6, 2), "MB")
