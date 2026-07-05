# Handoff: Granskningssystemet (AI-kodgranskning)

**Senast uppdaterad:** 2026-07-05
**Omfattning:** Mäklargruvan-piloten (prod) · Maklargruvan-PeakFast (edition) · GruvanTechDasboard (cockpit)

## TL;DR
Granskningssystemet är **spegel-komplett**. Tre AI-granskningsverktyg — **ai-review**, **kodstädning**, **UI-granskning** — kör på både produktions-piloten och PeakFast-editionen, och allt observeras samlat i dashboarden. Modellen: *deterministiskt verktyg hittar → Gemini tolkar*. Cockpiten läser resultat och triggar körningar. **Inget raderas eller auto-fixas — allt är rådgivande.**

## Arkitektur: motor vs cockpit
- **Motorn** bor i app-repona (pilot + peakfast) som GitHub Actions. Deterministiska verktyg (git-diff, knip, axe-core, Playwright) hittar; **Gemini `gemini-3.5-flash`** (fri nivå) tolkar. Resultat → PR-kommentar (ai-review) eller GitHub-issue (cleanup/ui-scan).
- **Cockpiten** = `GruvanTechDasboard` (single-file `index.html`, Netlify, lösenordsskyddad). All GitHub-åtkomst via server-side Netlify-funktioner (GH_TOKEN-proxy). Läser resultat, triggar körningar, visar en samlad granskningsöversikt.

## De tre verktygen

### 1. ai-review — diff-granskning
- **Vad:** skickar PR-diffen till Gemini, postar strukturerade fynd (severity, fil/rad, förslag) som PR-kommentar (upsert).
- **Var:** `scripts/ai-review.mjs` + `.github/workflows/ai-review.yml`. Kör på varje PR (`opened/synchronize/reopened`), skippar forkar. Icke-blockerande.
- **Status:** pilot ✓ · peakfast ✓

### 2. Kodstädning — knip + Gemini
- **Vad:** knip hittar oanvänd kod/exports/beroenden → git grep ger kontext → Gemini **klassificerar** (`dead` / `needless-export` / `maybe-dynamic` / `keep`). Raderar aldrig. → GitHub-issue (markör `<!-- gemini-cleanup-scan -->`).
- **Var:** `scripts/cleanup-scan.mjs` + `.github/workflows/cleanup.yml` + `knip.json`. Trigger: manuell dispatch + schemalagt **måndagar 06:00 UTC**.
- **CI-detaljer att känna till:**
  - `npm install --ignore-scripts` (INTE `npm ci` — lockfilen kan ha optional plattforms-deps → `EBADPLATFORM`; `--ignore-scripts` hoppar sharps native-bygge, behövs ej för knip).
  - `knip.json` har `ignoreDependencies: ["playwright", "axe-core"]` (de installeras `--no-save` i ui-scan-workflowen och är inte riktiga `package.json`-beroenden — annars flaggas de som olistat beroende i CI).
- **Status:** pilot ✓ (issue #7, 4 needless-export i `netlify/lib`) · peakfast ✓

### 3. UI-granskning — axe + Gemini multimodal
- **Vad:** Playwright renderar sidorna (`/`, `/sociala-medier.html`, `/text.html`) i desktop + mobil → axe-core = a11y (obegränsat) → skärmdump → Gemini multimodal = visuell bedömning. → GitHub-issue (markör `<!-- gemini-ui-scan -->`).
- **Var:** `scripts/ui-scan.mjs` + `.github/workflows/ui-scan.yml`. `TARGET_URL` = live-sajten. Trigger: manuell + **måndagar 07:00 UTC**.
- **⚠ Kvot:** fri Gemini-nivås BILD-kvot är mycket snäv (per-minut) → ui-scan är långsam (retry-backoff på 429) men kör klart. axe-halvan är obegränsad. Billing/Pro skulle göra bild-halvan smidig.
- **Status:** pilot ✓ (issue #8: 29 a11y + 11 visuella, `TARGET_URL=maklargruvan.netlify.app`) · peakfast ✓ (`TARGET_URL=maklargruvan-peakfast.netlify.app`)

## Dashboard-cockpiten
- **Samlad granskningsöversikt** (överst i *AI-granskning*-fliken): ett kort per granskningsrepo med öppna cleanup/ui-fynd, aggregat-pills, länk rakt till varje issue. Lazy-load + ↺ Uppdatera.
- **App-modal** (*Granskningar*-sektionen): ett block **per repo** med trigger-knappar (Kör UI-granskning / Kör kodstädning) + live-lista + status. Triggern **bevakar** resultatet — pollar issuet tills det uppdaterats, fräschar då korten och byter till "✓ klar".
- **Hälsobrickor** på app-korten: commit-ålder + öppna PR:ar + **summerade** granskningsfynd (över appens alla repon).
- **Flera repon per app:** `app.reviewRepos` (array, bakåtkompat med `reviewRepo`). `maklargruvan → ['maklargruvan-pilot', 'Maklargruvan-PeakFast']`. Nya appar: sätt bara `reviewRepos` i `APPS`.
- **Proxies (Netlify-funktioner):** `github-issues`, `github-prs`, `github-dispatch`, `github-commits`, `github-file`, `github-write` — alla server-side.

## Secrets & config
- **GEMINI_API_KEY:** repo-secret på pilot + peakfast (satt). Samma nyckel överallt; lokalt i `C:\dev\gemini-mcp\.env`.
- **Dashboardens GH_TOKEN:** Netlify env (produktions-scope, workflow-scope) → trigga-knapparna funkar live. OBS: deploy-**previews** saknar token → `github-issues` 404:ar där (bara previews; **prod funkar**).
- **Sätta en Actions-secret via API:** läs token ur `claude_desktop_config.json` + nyckel ur `.env` i ETT skript (aldrig echo) → GET repo-public-key → kryptera med libsodium `crypto_box_seal` → PUT `actions/secrets/{namn}`.

## Kvar / öppna trådar
- **Pilotens produktions-UI har fynd som redan är fixade i PeakFast** (PR #8 header-överlapp, PR #9 a11y) men som inte migrerat till prod än. ui-scan-issue #8 på piloten listar dem — fixarna väntar i peakfast på migration.
- **Öppna PR:ar att granska:** peakfast #8 (header), #9 (a11y). peakfast PR #16 var ett tidigare handoff-utkast → kan stängas (ersätts av detta dok).
- **Schemalagda körningar** (måndagar) håller issuen färska automatiskt; ingen manuell åtgärd krävs.

## Försiktighet (viktigt)
- **Piloten = produktion.** Migration pågår parallellt (reskin, bildmodul). Rör aldrig otrackade filer (`SYNC_PILOT_MIGRATION_PLAN.md`, `ARCHITECTURE_AUTH_BILLING.md`, `_template.html`). Grena alltid av `main`, merga inget på piloten utan Jimmys ja.
- **Skriv aldrig ut secrets** (GH_TOKEN, GEMINI_API_KEY) i chatt eller kod.
- Alla verktyg är **rådgivande** — inget raderas, mergas eller auto-fixas utan uttryckligt godkännande.

---
*Motor-sidans detaljer speglas i respektive app-repos scripts/workflows. Denna fil är den systemövergripande vyn från cockpiten.*
