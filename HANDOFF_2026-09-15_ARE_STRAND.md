# Handoff 2026-09-15 — Åre Strand-verktyget

## Läge
Byggt och pushat (commit d0aa56e på main). Jimmy har inte provkört än.

- `arestrand.html` — § 05, fyra flikar: Objekt & värdering, Text, Bilder, Statistik. Kopplad i index.html (nav, kort, sektion med iframe, appregistret `t_arestrand`).
- `js/andels-core.js` — kärnan som delas med andelsforsaljning.html: SPRAKREGLER (kopia av Mäklargruvans REGLER), WEEK_INFO, `anropaClaudeTvaTexter`, `renderResult`, API-nyckel, `getMaklarInfo`. Andelsförsäljningen laddar samma fil; provkörd efter utbrytningen.
- `js/arestrand-vardering.js` — modellen (log-OLS i webbläsaren) + jämförelser i tre nivåer + sammanvägning. Intervall ±25 %, varning under tre direkta jämförelser.
- `js/data/arestrand-katalog.js` (65 enheter) och `js/data/arestrand-affarer.js` (134 affärer). Genereras av `analys/are-strand/…` — redigera hellre csv:n och generera om än att handpilla i JS-filen.
- `netlify/functions/hemnet-slutpriser.js` — läser Hemnets `__NEXT_DATA__`. **Cloudflare stoppar Nodes TLS-avtryck lokalt** (curl med samma headers får 200). Om den även nekas från Netlify: knappen faller tillbaka på "Klistra in från Hemnet" (markera allt på slutprissidan, kopiera, klistra in) — provkört, samma tolkning.

## Gör detta först
1. Öppna dashboarden → Åre Strand → välj t.ex. 19:1 v.15 och 7A4 v.52. Kontrollera att riktvärde, intervall och jämförelselistan känns rimliga mot vad du vet.
2. Statistik → "Hämta nya slutpriser från Hemnet". Får du 502/403: använd klistra-in-vägen. Rapportera vilket som hände så vet vi om Netlify-funktionen ska vara kvar.
3. Text → Generera med Claude AI på ett skarpt objekt. Samma API-nyckel som i andelsförsäljningen (`af_apikey`).
4. Bilder → Anslut mapp → `D:\PeakFast\Föreningar\Åre Strand Blandat`.

## Kända gränser
- Ingen skylt och ingen Mspecs-paketexport än (finns i andelsförsäljningen, ej portat).
- Veckofaktorn är per klass, inte per vecka. Påskveckan (v.13–16) och v.51 mot v.52 är kända avvikelser.
- Mspecs-utdraget täckte bara 2026. Äldre år saknas i PeakFast-tiden om de finns.
- "21A" i HH-listan gick inte att knyta till en enhet och är utelämnad ur katalogen.
- Lokalt tillagda affärer bor i webbläsarens localStorage (`as_affarer_extra`) tills "Ladda ner datafil" körs och filen läggs i repot.

## Underlag
`analys/are-strand/PLAN_ARE_STRAND_2026-09-15.md` — analysen, statistiktabellen, besluten.
