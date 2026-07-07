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
4. **Bilagemedvetenhet:** läs PDF-bilagor (t.ex. signerat gåvobrev) så utkast inte föreslår redan gjorda steg. Lägg i **pollaren** (lång timeout), inte on-click (10s-gräns). Finns som task-chip.
5. Ev. tillbaka till Gemini-klassificering (`MAIL_CLASSIFY_PROVIDER=gemini`) när Googles kapacitet återhämtat sig.

## Driftlärdom
Tunga synkrona Netlify-funktioner (LLM + flera API-hopp) spränger **10-sekundersgränsen** → HTTP 502 med HTML-body. Håll on-click-vägen snabb (Haiku, minimal retry); lägg tungt arbete i pollaren (-lång timeout) eller separat på-begäran-funktion. Bakgrundsfunktion (-background) ger 15 min men returnerar 202 direkt = duger ej för on-click-UI som ska visa resultat.
