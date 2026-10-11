"""
Geodataanalyse av Overture Maps for et byområde med DuckDB.

Leser Overtures GeoParquet direkte fra S3 (kun radgruppene i utsnittet),
lagrer et lokalt uttrekk og lager datagrunnlaget for KI-kartet:

  data/places.json        alle steder (navn, kategori, posisjon, adresse ...)
  data/buildings.json     alle bygninger (sentroide, høyde, etasjer, areal ...)
  data/districts.geojson  bydeler/områder klippet til utsnittet, med nøkkeltall
  data/analysis.json      sammendrag og kjøretider til presentasjonen

Områdeinndeling:
  --omrader polygoner  bruker Overtures bydelspolygoner (finnes f.eks. for Oslo)
  --omrader voronoi    lager områder rundt Overtures navngitte bydelspunkter
                       (nærmeste navn, beregnet i UTM33) og klipper bort vann.
                       Brukes der Overture mangler bydelsgrenser, f.eks. Kristiansand.

Kjør:
  python analyse.py --by Oslo --bbox 10.68,59.895,10.83,59.945 --omrader polygoner --out ../data
  python analyse.py --by Kristiansand --bbox 7.90,58.09,8.16,58.205 --omrader voronoi --out ../data-krs
"""
import argparse, json, os, time
from pathlib import Path
import duckdb

CACHE = Path(os.environ.get("OVERTURE_CACHE", "/tmp/overture-cache"))

ap = argparse.ArgumentParser()
ap.add_argument("--release", default="2026-09-23.0")
ap.add_argument("--by", default="Oslo")
ap.add_argument("--bbox", default="10.68,59.895,10.83,59.945", help="min lon,min lat,max lon,max lat")
ap.add_argument("--omrader", choices=["polygoner", "voronoi"], default="polygoner")
ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data"))
ap.add_argument("--extensions", default=os.environ.get("DUCKDB_EXT_DIR"),
                help="mappe med httpfs/spatial hvis de ikke kan lastes ned automatisk")
args = ap.parse_args()
R = f"s3://overturemaps-us-west-2/release/{args.release}"
BBOX = tuple(float(v) for v in args.bbox.split(","))
OUT = Path(args.out)
AREA_KEY = args.by.lower()

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
    f = CACHE / (f"{args.release}-{name}.parquet" if AREA_KEY == "oslo" else f"{args.release}-{AREA_KEY}-{name}.parquet")
    timing = f.with_suffix(".sekunder")
    label = "Hent " + {"places": "steder", "buildings": "bygninger", "districts_raw": "bydelsgrenser",
                       "district_points": "bydelspunkter", "water": "vannflater"}.get(name, name) + " fra S3 (GeoParquet)"
    if not f.exists():
        step(label, f"COPY (SELECT * FROM read_parquet('{R}/{path}/*') WHERE {where}) TO '{f}' (FORMAT parquet)")
        timing.write_text(str(steps[-1]["sekunder"]))
    else:
        # Lokalt uttrekk finnes: rapporter kjøretiden fra da det ble hentet fra S3.
        steps.append({"steg": label, "sekunder": float(timing.read_text()) if timing.exists() else None, "hurtigbuffer": True})
    con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_parquet('{f}')")

extract("places", "theme=places/type=place", inside)
extract("buildings", "theme=buildings/type=building", inside)
overlaps = f"bbox.xmin < {x1} AND bbox.xmax > {x0} AND bbox.ymin < {y1} AND bbox.ymax > {y0}"
if args.omrader == "polygoner":
    extract("districts_raw", "theme=divisions/type=division_area",
            f"{overlaps} AND country = 'NO' AND subtype IN ('macrohood', 'neighborhood')")
else:
    # Bydeler (macrohood) og tettsteder med folketall, men ikke selve byen.
    extract("district_points", "theme=divisions/type=division",
            f"{inside} AND country = 'NO' AND (subtype = 'macrohood' OR (subtype = 'locality' AND population IS NOT NULL)) "
            f"AND names.primary <> '{args.by}'")
    extract("water", "theme=base/type=water", f"{overlaps} AND subtype IN ('ocean', 'lake', 'reservoir', 'water', 'river')")

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

if args.omrader == "polygoner":
    step("Klipp bydeler til utsnittet", f"""
    CREATE OR REPLACE TABLE zones AS
    WITH c AS (
      SELECT names.primary AS name, ST_Intersection(geometry, ST_MakeEnvelope({x0}, {y0}, {x1}, {y1})) AS geometry
      FROM districts_raw WHERE names.primary NOT IN ('Marka', 'Sørengutstikkeren')
    )
    SELECT name, geometry, ST_PointOnSurface(geometry) AS label FROM c WHERE NOT ST_IsEmpty(geometry)""")
    AREA_TYPE = "bydeler"
else:
    # Nærmeste-navn-områder: Voronoi i UTM33 (meter, ikke grader), tilbake til WGS84, minus vann.
    step("Lag områder rundt bydelspunkter (Voronoi i UTM33) og klipp bort vann", f"""
    CREATE OR REPLACE TABLE zones AS
    WITH pts AS (
      SELECT names.primary AS name, ST_Transform(geometry, 'EPSG:4326', 'EPSG:25833', always_xy := true) AS g
      FROM district_points
    ), cells AS (
      SELECT unnest(ST_Dump(ST_VoronoiDiagram(ST_Collect(list(g))))).geom AS cell FROM pts
    ), named AS (
      SELECT pts.name, ST_Transform(cells.cell, 'EPSG:25833', 'EPSG:4326', always_xy := true) AS geometry,
             ST_Transform(pts.g, 'EPSG:25833', 'EPSG:4326', always_xy := true) AS label
      FROM cells JOIN pts ON ST_Contains(cells.cell, pts.g)
    ), land AS (
      SELECT ST_Difference(ST_MakeEnvelope({x0}, {y0}, {x1}, {y1}),
                           ST_Union_Agg(ST_MakeValid(geometry))) AS geometry
      FROM water WHERE ST_GeometryType(geometry) IN ('POLYGON', 'MULTIPOLYGON')
    )
    SELECT named.name, ST_Intersection(named.geometry, land.geometry) AS geometry, named.label FROM named, land""")
    AREA_TYPE = "områder (nærmeste bydelsnavn)"

step("Koble steder og bygninger til områdene", f"""
CREATE OR REPLACE TABLE d AS
WITH z AS (
  SELECT name, geometry, label, ST_Area({UTM}) / 1e6 AS km2 FROM zones WHERE NOT ST_IsEmpty(geometry)
)
SELECT z.name, round(z.km2, 3) AS km2, z.geometry, round(ST_X(z.label), 5) AS lx, round(ST_Y(z.label), 5) AS ly,
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
for name, km2, gj, lx, ly, steder, servering, bygg, snitt in con.execute(
    "SELECT name, km2, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geometry, 0.00005)), lx, ly, steder, servering, bygninger, snitthoyde FROM d ORDER BY steder DESC"
).fetchall():
    feats.append({"type": "Feature", "geometry": json.loads(gj), "properties": {
        "navn": name, "km2": km2, "etikett": [lx, ly], "steder": steder, "servering": servering, "bygninger": bygg,
        "snitthoyde": snitt, "steder_per_km2": round(steder / km2) if km2 else None}})
(OUT / "districts.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")))

summary = {
    "by": args.by,
    "omradetype": AREA_TYPE,
    "release": args.release,
    "bbox": BBOX,
    "kildedata": "s3://overturemaps-us-west-2/release/" + args.release,
    "omrader_metode": args.omrader,
    "antall": dict(zip(["steder", "bygninger", "bygninger_med_hoyde", "bygninger_med_etasjer", "bydeler"], con.execute(
        "SELECT (SELECT count(*) FROM p), (SELECT count(*) FROM b), (SELECT count(h) FROM b), (SELECT count(floors) FROM b), (SELECT count(*) FROM d)").fetchone())),
    "grupper": con.execute("SELECT grp, count(*) n FROM p GROUP BY 1 ORDER BY 2 DESC").fetchall(),
    "toppkategorier": con.execute("SELECT cat, count(*) n FROM p WHERE cat IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 12").fetchall(),
    "datasett_steder": con.execute("SELECT ds, count(*) FROM (SELECT unnest(datasets) ds FROM p) GROUP BY 1 ORDER BY 2 DESC").fetchall(),
    "datasett_bygninger": con.execute("SELECT coalesce(dataset, 'ukjent'), count(*) FROM b GROUP BY 1 ORDER BY 2 DESC").fetchall(),
    # Målt høyde, ellers estimert fra etasjer (3,2 m per etasje).
    "hoydefordeling": con.execute("""WITH e AS (SELECT coalesce(h, floors * 3.2) AS he FROM b)
        SELECT CASE WHEN he < 10 THEN '0–10 m' WHEN he < 20 THEN '10–20 m' WHEN he < 30 THEN '20–30 m'
        WHEN he < 50 THEN '30–50 m' ELSE '50 m +' END k, count(*) FROM e WHERE he IS NOT NULL GROUP BY 1 ORDER BY min(he)""").fetchall(),
    "hoyeste": con.execute("""SELECT coalesce(name, class, subtype, 'Bygning'), round(coalesce(h, floors * 3.2), 1), lon, lat, h IS NULL
        FROM b WHERE coalesce(h, floors * 3.2) IS NOT NULL AND area_m2 >= 30 ORDER BY 2 DESC LIMIT 8""").fetchall(),
    "storste": con.execute("SELECT coalesce(name, class, subtype, 'Bygning'), area_m2, lon, lat FROM b ORDER BY area_m2 DESC LIMIT 8").fetchall(),
    "bydeler": con.execute("SELECT name, km2, steder, servering, bygninger, snitthoyde, round(steder / km2) FROM d ORDER BY 7 DESC").fetchall(),
    "steg": steps,
}
(OUT / "analysis.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
for f in ["places.json", "buildings.json", "districts.geojson", "analysis.json"]:
    print(f, round((OUT / f).stat().st_size / 1e6, 2), "MB")
