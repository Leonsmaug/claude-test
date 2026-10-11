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

## Kjør den

| Hvor | Lenke | KI-chat |
| --- | --- | --- |
| claude.ai (privat Artifact) | [Kristiansand](https://claude.ai/artifact/28thskcBQKJSz3KG78nB1m) · [Oslo](https://claude.ai/artifact/DyJRAYwSfmNBETUERWvkK1) | Ja, på hver brukers Claude-konto |
| GitHub Pages | `<pages-adresse>/kartlab/` (bygges av arbeidsflyten ved push til `main`) | Nei, kart og analyse |
| Lokalt | `npm run kartlab` → http://localhost:4180/ | Nei, kart og analyse |

### Lokalt, fra en fersk kopi av repoet

```bash
cd kartinnsyn
npm install
pip install duckdb                 # Python 3.10+
npm run kartlab:data               # henter og analyserer Overture for alle byer (ca. 5 min)
npm run kartlab                    # bygger begge byene og åpner startsiden
```

`npm run kartlab:data -- kristiansand` lager data for én by. Byspesifikke innstillinger
(utsnitt, områdemetode, tekster, startvisning og eksempelspørsmål) og hvilke Overture-utgaver
som brukes, ligger i `areas.json`.

### Slik lages dataene

`scripts/prepare-data.mjs` kjører to steg per by:

1. `extract-pmtiles.mjs` klipper byen ut av Overtures PMTiles i S3 (zoom 12–14) og fjerner felt kartet ikke trenger.
2. `analyse.py` analyserer Overtures GeoParquet med DuckDB. Med `--omrader polygoner` brukes Overtures
   bydelsgrenser (Oslo). Med `--omrader voronoi` lages områder rundt navngitte bydelspunkter i UTM33,
   minus vann (Kristiansand, der Overture mangler bydelsgrenser).

En ny by legges til med en oppføring i `areas.json`, `npm run kartlab:data -- <by>` og `npm run kartlab:build`.

### Publisering

- **claude.ai:** `ai-demo/dist/<by>/kartlab.html` publiseres som Artifact med `data/` og `fonts/` som
  vedlagte filer og kapabilitetene `sample`, `db`, `user` og `downloads`.
- **GitHub Pages:** `.github/workflows/kartinnsyn-pages.yml` lager dataene (cachet mellom kjøringer),
  bygger begge byene og legger dem under `kartlab/` ved siden av kartinnsynet.

### Datakvalitet som analysen avdekket

I Kristiansand har bare 20 av 40 835 bygninger målt høyde i Overture, mot 15 188 av
33 423 i sentrale Oslo. Der målt høyde mangler, brukes etasjer × 3,2 m (3 861 bygninger
i Kristiansand har etasjer). Claude får beskjed om dette og sier fra når svar bygger på
estimerte høyder.

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
