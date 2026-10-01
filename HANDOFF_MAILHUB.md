# Handoff — Mail-hub (Qaxio/Gruvan Dashboard)

Status per 2026-07-07. Mail-hubben är **live och bevisad** på https://gruvantechdashboard.netlify.app/ (fliken "Mail-hub"). Detta dokument = var vi står och vad som är kvar att slipa.

## Vad den gör
Läser inkorgen på **jimmy@peakfast.se** via Microsoft Graph → klassificerar varje mejl → genererar ett svarsutkast i Jimmys röst → skapar det som ett **oskickat utkast i Outlook-tråden**. **Skickar aldrig.** Jimmy granskar och skickar själv.

## Arkitektur
Statisk `index.html` + zero-dependency Netlify-funktioner (Node 20, raw fetch, CommonJS). Persistens = JSON i GitHub via GH_TOKEN-proxy (ingen DB).
- `netlify/functions/lib/graph.js` — client-credentials-token + graphFetch
- `netlify/functions/lib/triage.js` — klassificera + generera utkast + createReply/PATCH
- `netlify/functions/lib/store.js` — GitHub-JSON-persistens
- `netlify/functions/mail-fetch.js` — läser inkorgslistan
- `netlify/functions/mail-triage.js` — POST {messageId}, on-click-triage (skapar alltid utkast)
- `netlify/functions/mail-poll.js` — schemalagd (var 10:e min via netlify.toml), torrläge default
- `netlify/functions/mail-learn-style.js` — läser skickade mejl, destillerar stilprofil → data/mail-style.json
- `netlify/functions/mail-queue.js` — läser godkännandekön

Mergade PR:ar: **#16** (bygge), **#17** (Haiku-utkast + fix 502/timeout), **#18** (klassificering→Claude Haiku via tool-use), **#19** (stilinlärning).

## Modeller & viktiga env-flaggor (i Netlify)
- Klassificering + utkast: **`claude-haiku-4-5-20251001`** (env `MAIL_CLASSIFY_MODEL` / `MAIL_DRAFT_MODEL`)
- `MAIL_CLASSIFY_PROVIDER` — default `anthropic`; sätt `gemini` för gammal Gemini-väg (opt-in fallback)
- `MAIL_AUTODRAFT` — **default OFF (torrläge)**: pollaren klassificerar+köar men skapar INGA utkast. Sätt `true` för auto-utkast var 10:e min.
- `MAILBOX_USER` — default jimmy@peakfast.se
- Secrets satta: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GH_TOKEN`

## Azure-app: "Qaxio Mail Hub"
Single tenant. Behörighet **Mail.ReadWrite (Application)** med admin-consent. INGEN Mail.Send (utkast går ändå — skicka omöjligt = säkerhetsdesign). Klienthemlighet giltig t.o.m. 2028-07-06.

## Bevisat i skarp test (Chrome, med Jimmy)
- Graph läser inkorgen ✓
- Klassificering rätt: "Re: Gåvobrev Åre Strand 4B4" → Support 95% ✓
- Stilinlärning körd 1 gång → data/mail-style.json fylld från 25 skickade mejl (fångade "gärna", "Hej [Namn]" utan komma, öppen avslutning) ✓
- Utkast skapas i Outlook, inget skickas ✓
- Robust felhantering (Gemini 503 + timeout fångades utan att skapa utkast) ✓
- Två test-utkast ligger i Gåvobrev-tråden i Outlook — **Jimmy kan radera dem**.

## KVAR att slipa (prioriterat)
1. **Utkast-tonen (VIKTIGAST).** Jimmys feedback: utkasten är för proaktiva. Regler:
   - Default = **kort artig bekräftelse** (mottaget + välkommen att höra av sig). Inget mer.
   - Ge **instruktioner/nästa steg BARA om avsändaren uttryckligen frågar** efter något.
   - Upprepa **inte** instruktioner som redan getts i Jimmys tidigare mejl (syns citerat i tråden).
   - Ingen onödig återberättelse (t.ex. "Jag ser att du mailade det vidare från Kurt-Olof" = bort).
   - Nästa kodpass: skärp `draftSystemFor` i `lib/triage.js` — lägg till ett steg som avgör om mejlet faktiskt ställer en fråga; om inte → bara bekräftelse. Stilprofilen är redan bra; det som saknas är **återhållsamhet i innehållet**.
2. **Slå på `MAIL_AUTODRAFT=true`** när Jimmy litar på tonen.
3. **Säkerhetshärda:** Exchange Application Access Policy → begränsa Azure-appen till bara Jimmys brevlåda (kräver mailaktiverad grupp med bara Jimmy).
4. ~~**Bilagemedvetenhet**~~ — byggd 2026-09-29 (`lib/attachments.js`). Pollern läser upp till 2 PDF-bilagor (≤ 5 MB) per mejl med Claude och lägger en kort sammanfattning i kontexten för klassning + utkast, märkt som data. Kön visar vilka bilagor som lästes. Bara i pollern, inte on-click. Tidsbudget: bilagor läses bara under körningens första 12 s. Modell via `MAIL_ATTACHMENT_MODEL` (default Haiku 4.5). **Verkar först när pollern slås på igen.**
5. Ev. tillbaka till Gemini-klassificering (`MAIL_CLASSIFY_PROVIDER=gemini`) när Googles kapacitet återhämtat sig.

## Driftlärdom
Tunga synkrona Netlify-funktioner (LLM + flera API-hopp) spränger **10-sekundersgränsen** → HTTP 502 med HTML-body. Håll on-click-vägen snabb (Haiku, minimal retry); lägg tungt arbete i en bakgrundsfunktion eller begränsa det med tidsbudget i pollern.
⚠️ Rättelse 2026-09-29: pollern har INTE lång timeout — **schemalagda Netlify-funktioner har 30 s totalt**. Tidigare kunde en körning med flera nya mejl spränga taket, och då skrevs varken kön eller lastSeen. **Löst samma dag** med tidsbudget i `mail-poll.js`: inget nytt mejl påbörjas efter 16 s (resten tas nästa körning, äldst först), lastSeen flyttas per färdigt mejl, och ett hårt stopp vid 24 s skriver det som hunnits även om ett anrop hänger. Loggen visar `deferred`, `hardStop` och `ms`.
En bakgrundsfunktion (15 min) går INTE att starta från pollern: lösenordsskyddet gäller även funktionsadresserna, så anropet får 401 (samma fälla som SEO och AI-granskning). Bakgrundsfunktion (-background) ger 15 min men returnerar 202 direkt = duger ej för on-click-UI som ska visa resultat.

## Objektsunderlag ur mejl (steg 1, 2026-09-29)
Knappen **📋 Objektsunderlag** på mejl i inkorgen och kön sammanställer säljare + objektfakta ur hela tråden och PDF-bilagorna.
- `netlify/functions/objekt-underlag-kalla.js` hämtar tråd + PDF:er (max 4 st, 3,5 MB totalt) och **sparar ingenting**.
- `js/objektsunderlag.js` tolkar i webbläsaren direkt mot Claude (Opus 5.5, strukturerad JSON) med nyckeln `af_apikey` — samma som Åre Strand-/andelsverktyget. Därför gäller inte 10 s-gränsen, och personuppgifter lagras aldrig på servern.
- Underlaget ligger i `sessionStorage` (försvinner med fliken) och kan rensas. Varje fält visar källa och markeras om det är osäkert.
- Spår: **Åre Strand** → "Öppna i Åre Strand-verktyget" (enhet/vecka/pris förifyllt), **SkiStar** → "Öppna i andelsverktyget" (lägenhetstyp matchas på område + kvm + BRF), **övrigt** → "Kopiera till Mäklargruvan" (utan säljare).
- Överlämning till verktygen via `localStorage.pf_prefill` = `{ verktyg, data, skapad }`: bara objektfakta, raderas vid läsning, ignoreras efter 10 min.
- **Steg 2 (2026-09-29): 📦 Mspecs-paket.** Knappen i underlaget bygger ett textpaket som klistras in i Claude i Chrome (Jimmys inloggade Chrome): uppdrag + regler (exakt ett nytt objekt, rör inget annat, vänta på PUT 200, fråga vid oklarhet, kontrollista), var objektet skapas (SkiStar Åre/Sälen → projektet; Åre Strand/övriga SkiStar → fråga; övrigt → eget uppdrag), OBJEKTDATA som `ng-model → värde` för fält kartan känner och `efterEtikett` för resten, säljare, och hela `MSPECS-KARTA.md` (hämtas live från gruvan-dashboard-data via `github-file` — kartan är enda källan). Byggs i webbläsaren, går till urklipp, sparas inte.
- **Luckor i kartan** (Claude i Chrome ombeds rapportera ng-models så kartan kan kompletteras): säljare/kontakter på uppdrag, projekt-ID för Åre Strand (och Vemdalen), objektskategori-id för villa/fritidshus/tomt, fastighetsfält (fastighetsbeteckning, tomtarea).
- **Steg 3 (2026-09-29): säljtexter.** Texterna skrivs i de befintliga textmotorerna. Öppnat från ett underlag (`pf_prefill.data.underlagId`) visar Åre Strand-/andelsverktygets resultat knappen **↩ Skicka texterna till objektsunderlaget** (`js/andels-core.js`), som lägger `{ underlagId, kort, lang, skapad }` i `localStorage.pf_texter`. Dashboardfliken tar emot via `storage`-eventet, visar texterna (redigerbara, räknare mot 300/4000) och Mspecs-paketet fyller `object.sellingTextSubject/sellingTextShort/sellingText`. Övriga objekt: klistra in texterna från Mäklargruvan. Markdown-betoning tas bort; för långa texter fylls inte i (paketet säger åt Claude att fråga).

## Inkorg 30 dagar, sökning och matchning av mejl (2026-10-01)
- **Inkorgen** visar de senaste **30 dagarna** (`mail-fetch?dagar=30`, max 90), nyast först. Hämtas sidvis à 100 via `@odata.nextLink` med tak 600 mejl och 7 s tidsbudget (`truncated` säger om fler finns). Tidigare visades bara de 25 senaste.
- **Sökning.** Fältet ovanför listan filtrerar direkt bland de hämtade mejlen (alla ord måste finnas i ämne, avsändare eller förhandsvisning). Enter, "🔎 Sök i hela brevlådan" eller snabbknapparna (Åre Strand, Holiday Club, SkiStar, Andelsrätt, Gåvobrev) söker i **alla mappar och all tid** via Graphs `$search` (`mail-fetch?q=`). Det söker även i brödtext och bilagenamn. Högst 100 träffar, sorterade på datum. `$search` kan inte kombineras med `$filter`/`$orderby`.
- **Matcha mejl i Objektsunderlaget.** Ett underlag kan bygga på upp till 3 trådar (`objekt-underlag-kalla` tar `messageIds`). Knappen "＋ Matcha med annat mejl" föreslår en sökning, för Åre Strand `Holiday Club <enhet>`. Valda mejl följer med vid omtolkning och kan tas bort med ✕. PDF-bilagorna (max 6) fördelas turvis mellan trådarna, så att utdraget inte trängs ut.
- **Tolkningen** märker trådarna (TRÅD 1, TRÅD 2 …). **Holiday Clubs utdrag är auktoritativt för andelens fakta och för ägaren.** Kundens mejl gäller för kontaktuppgifter och önskemål. Avvikelser blir `osaker` och hamnar i "Att notera". **Ägarkontroll:** stämmer inte ägaren i utdraget med säljaren hamnar det först i "Att notera".
