# Kartlab Oslo – kart med Claude innebygd

En privat demo som kjører som **Artifact på claude.ai**. Kartet viser sentrale Oslo fra
Overture Maps, og et chatpanel lar deg spørre Claude på norsk. Claude bruker verktøy som
kjører i selve siden: søk i steder, statistikk, bygningslister, oppslag, diagrammer og
styring av kartet. Spørsmålene går på hver brukers egen Claude-konto. Det trengs ingen
API-nøkkel og ingen server.

Fanene:

1. **Kart og KI**: kart, chat, delte funn mellom kolleger og nedlasting av treff (CSV/GeoJSON).
2. **Claude Code-analysen**: hva Claude Code gjorde, med de faktiske tallene og kjøretidene.
3. **100 brukere**: arkitektur og innføringsplan for en organisasjon.

## Slik lages den

```bash
# 1. Klipp Oslo ut av Overtures PMTiles i S3 (z12–14) og fjern felt kartet ikke bruker
node ai-demo/scripts/extract-pmtiles.mjs 2026-09-23.1 10.68,59.895,10.83,59.945 12 14 ai-demo/data

# 2. Analyser Overtures GeoParquet med DuckDB (httpfs + spatial)
pip install duckdb
python ai-demo/scripts/analyse.py --release 2026-09-23.0

# 3. Bygg siden (én HTML-fil + data som base64-tekst og glyfer)
node ai-demo/build.mjs        # -> ai-demo/dist/
```

`ai-demo/dist/` publiseres som Artifact med kapabilitetene `sample` (spør Claude),
`db` (delte funn), `user` (navn på kolleger) og `downloads` (nedlasting).

Artifact-sider kan bare lese filer som publiseres sammen med siden, og bare vanlige
web-filtyper. Derfor ligger kartflisene som utsnitt, pakket som base64-tekst, og leses med
`pmtiles.FileSource` i nettleseren.

## Filer

- `src/app.ts`: kart, chat og verktøyene Claude får (`sok_steder`, `statistikk`, `bygninger`, `finn_sted`, `vis_i_kart`, `sett_lag`, `vis_diagram`, `kartstatus`).
- `page.html`: sideoppsett og design for de tre fanene.
- `scripts/extract-pmtiles.mjs`: PMTiles v3-klipper skrevet for denne demoen.
- `scripts/analyse.py`: DuckDB-analysen mot Overture GeoParquet.
- `build.mjs`: setter sammen Artifact-siden.

Kartstilen og objektinfoen deles med hovedappen (`../src/style.ts`, `../src/info.ts`).
