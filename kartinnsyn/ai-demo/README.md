# Kartlab – kart med Claude innebygd

En privat demo som kjører som **Artifact på claude.ai**. Kartet viser Kristiansand by
(eller sentrale Oslo) fra Overture Maps, og et chatpanel lar deg spørre Claude på norsk. Claude bruker verktøy som
kjører i selve siden: søk i steder, statistikk, bygningslister, oppslag, diagrammer og
styring av kartet. Spørsmålene går på hver brukers egen Claude-konto. Det trengs ingen
API-nøkkel og ingen server.

Fanene:

1. **Kart og KI**: kart, chat, delte funn mellom kolleger og nedlasting av treff (CSV/GeoJSON).
2. **Claude Code-analysen**: hva Claude Code gjorde, med de faktiske tallene og kjøretidene.
3. **100 brukere**: arkitektur og innføringsplan for en organisasjon.

## Slik lages den

Byspesifikk tekst, startvisning og eksempelspørsmål ligger i `areas.json`.

```bash
# Kristiansand by (Overture har ikke bydelsgrenser her: områder lages rundt navngitte bydelspunkter)
node ai-demo/scripts/extract-pmtiles.mjs 2026-09-23.1 7.90,58.09,8.16,58.205 12 14 ai-demo/data-krs
python ai-demo/scripts/analyse.py --by Kristiansand --bbox 7.90,58.09,8.16,58.205 --omrader voronoi --out ai-demo/data-krs
node ai-demo/build.mjs kristiansand     # -> ai-demo/dist/kristiansand/

# Sentrale Oslo (bruker Overtures bydelspolygoner)
node ai-demo/scripts/extract-pmtiles.mjs 2026-09-23.1 10.68,59.895,10.83,59.945 12 14 ai-demo/data
python ai-demo/scripts/analyse.py --by Oslo --bbox 10.68,59.895,10.83,59.945 --omrader polygoner --out ai-demo/data
node ai-demo/build.mjs oslo             # -> ai-demo/dist/oslo/
```

En ny by legges til med et nytt utsnitt, en kjøring av analysen og en oppføring i `areas.json`.

### Datakvalitet som analysen avdekket

I Kristiansand har bare 20 av 40 835 bygninger målt høyde i Overture, mot 15 188 av
33 423 i sentrale Oslo. Der målt høyde mangler, brukes etasjer × 3,2 m (3 861 bygninger
i Kristiansand har etasjer). Claude får beskjed om dette og sier fra når svar bygger på
estimerte høyder.

`ai-demo/dist/<område>/` publiseres som Artifact med kapabilitetene `sample` (spør Claude),
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
