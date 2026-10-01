# Handoff: AI-granskningspanelen (Externt öga 2 / OpenRouter)

**Datum:** 2026-08-24
**Omfattning:** dashboardens granskningspanel — `index.html` + `netlify/functions/ai-review*.js` + `lib/openrouter.js`
**Status:** 🟡 **413-fixen byggd 2026-09-28 — väntar på skarp provkörning.** Läs "Nästa steg" först.

> Detta dokument gäller **panelen i dashboarden** (rollerna Arkitekt / Kodgranskare /
> UI-kritiker / Externt öga / Externt öga 2). CI-motorn i app-repona — ai-review,
> kodstädning, UI-granskning — är ett annat system och beskrivs i
> `HANDOFF_GRANSKNINGSSYSTEM.md`. De två rör inte varandra.

---

## Nästa steg (börja här)

1. Deploya och kör **Externt öga 2** på `planritningar.html`. Läs svaret med skepsis
   (se "Den obesvarade frågan" nedan).
2. Titta i `data/review-jobs/` i datarepot: `external2.json` ska ha `status: done`
   och `external2.input.json` ska vara nollad (`status: förbrukad`).
3. Enqueue-svaret innehåller `ms` — se i nätverksfliken hur nära Netlifys 10 s en
   stor fil ligger. Lokalt mot simulerat API är det försumbart; i drift är det en
   GitHub-commit på upp till ~700 KB.

## 413-felet och hur det löstes

Rollen gav `HTTP 413` när en normalstor fil granskades. Bakgrundsfunktioner anropas
asynkront och Netlify kapar begäran vid **256 KB** (synkrona får 6 MB).
`planritningar.html` är ~250 000 tecken, så kroppen med systemprompten gick över.

Koden åker nu inte i bakgrundsfunktionens kropp:

```
klient ──POST { jobId, agentId, system, code, context }──▶ ai-review-enqueue.js  (SYNKRON, 6 MB)
                                                             └─ skriver data/review-jobs/<roll>.input.json
klient ──POST { jobId, agentId }──────────────────────────▶ ai-review-background.js
                                                             ├─ läser indatafilen, kräver att jobId stämmer
                                                             ├─ skriver data/review-jobs/<roll>.json
                                                             └─ nollar indatafilen (bara om den fortfarande är vår)
klient ◀──pollar──────────────────────────────────────────  ai-review-result.js
```

**Avvikelse från den ursprungliga ritningen:** den lät enqueue anropa
bakgrundsfunktionen via `process.env.URL`. Det fungerar inte här — sajten är
lösenordsskyddad och skyddet gäller även funktionsadresserna, så ett anrop mellan
funktioner får 401 och dör tyst (samma fälla som SEO-verktyget, se `seo-queue.js`).
Därför gör **klienten** båda anropen; webbläsaren har lösenordskakan.

Övriga detaljer:
- Indata läses med `readJsonFileRaw` (`lib/store.js`). Vanliga `readJsonFile` får
  innehållet base64-kodat, och GitHub lämnar det fältet tomt för filer över 1 MB.
- GitHubs contents-API kan leverera förra versionen strax efter en skrivning.
  Bakgrundsjobbet läser därför om upp till 4 gånger (1,5 s paus) innan ett
  felaktigt jobId räknas som fel.
- Startas en ny granskning av samma roll medan en gammal kör, får den gamla
  felet "Indatafilen tillhör ett annat jobb" om den inte hunnit läsa — den nya
  jobbets kod skrivs aldrig över.

---

## Vad som finns och fungerar

| Fil | Roll |
|---|---|
| `netlify/functions/lib/openrouter.js` | anropet, modellkedjan, felmeddelandena — **delad** av synkron och asynkron väg. Ändra kedjan HÄR. |
| `netlify/functions/ai-review.js` | synkrona vägen (Claude / Gemini / OpenRouter). Räknar deadline, delegerar till biblioteket. |
| `netlify/functions/ai-review-enqueue.js` | synkron: tar emot koden och lägger den i datarepot före bakgrundsjobbet. |
| `netlify/functions/ai-review-background.js` | asynkron granskning, 15 min, effort `high`. Får bara `{ jobId, agentId }` och läser koden själv. |
| `netlify/functions/ai-review-result.js` | läser tillbaka resultatet som bakgrundsjobbet skrev. |
| `index.html` | rollerna i `AGENTS`, `korSynkrongranskning()`, `korBakgrundsgranskning()`. |

Rollerna Arkitekt, Kodgranskare och UI-kritiker (Claude) samt Externt öga
(Gemini) är **opåverkade och fungerar**. Allt nedan gäller bara Externt öga 2.

### Miljövariabler (Netlify)

```
OPENROUTER_API_KEY           satt
OPENROUTER_MODEL             valfri — förstahandsval, förval i koden
OPENROUTER_FALLBACK_MODELS   valfri — komma-separerad reservlista
OPENROUTER_REASONING_EFFORT  valfri — synkrona vägen, förval low
OPENROUTER_BG_REASONING_EFFORT   valfri — bakgrunden, förval high
OPENROUTER_TIMEOUT_MS        valfri — HELA synkronanropet, förval 8500
OPENROUTER_BG_TIMEOUT_MS     valfri — bakgrunden, förval 240000
```

Netlify-variabler slår igenom **först vid ny deploy**.

---

## Fällor som kostade tid (läs innan du felsöker)

**`models`-arrayen får ha max 3 poster.** Fler ger `400: 'models' array must
have 3 items or fewer`. Kapningen ligger i `lib/openrouter.js` så den inte kan
glömmas på ett av anropsställena.

**Bakgrundsfunktioner: 256 KB in.** Synkrona: 6 MB. Det var hela 413-felet — därför går koden via `ai-review-enqueue.js`.

**Netlifys synkrona tidstak är 10 s** och går **inte** att höja i `netlify.toml`.
26 s finns på Pro men Netlifys support måste aktivera det per sajt.

**Budgeten måste räknas från funktionens ingång, inte från fetch.** En fast
fetch-budget gav 504 två gånger: kallstart och parsning hade redan ätit flera
sekunder innan timern startade.

**`HTTP 504` = Netlifys timeout, inte en felaktig nyckel.** En felaktig nyckel
ger 401 på under en sekund. Två nycklar provades i onödan för att panelens
feltext gissade "fel API-nyckel" vid varje fel. Feltexter som gissar orsak är
aktivt skadliga — de skickar felsökningen åt fel håll.

**`HTTP 429 "rate-limited upstream"` = leverantörens kapacitet, inte din kvot.**

**Funktionsfilerna är CommonJS, roten är `"type": "module"`.** Sedan 2026-10-01
avbryter Netlify bygget för sådant (`zisi_error_cjs_in_esm_scope`: "is a CommonJS
module, but the closest 'package.json' declares type module"). Därför finns
`netlify/functions/package.json` med `"type": "commonjs"` — ta inte bort den.
Funktionerna går nu också att `require()` direkt lokalt.

---

## Modellvalet — och varför det är det som betyder något

`stealth/ox-alpha` var utgångspunkten men **har aldrig svarat en enda gång** i
skarp drift; den 429:ar. Den ligger inte kvar i förvalet.

Första reservurvalet gick på *tillgänglighet inom tidstaket* och landade i
`nvidia/nemotron-3.5-lightning:free` — 3B aktiva parametrar av 30B, nvidias
genomströmningsmodell. Den levererade en granskning av `planritningar.html` som
lät kunnig och välstrukturerad. **Alla tre "Priority Fixes" var falska**,
verifierade mot koden:

- *UID-hanteringen kan nollställas mellan våningar* — `Math.max(maxUid, uid)`
  efter varje `bumpUid` finns just för det, och raden ovanför är en kommentar
  som beskriver exakt den risken.
- *`restoreState` desynkar floors-arrayen* — `f` **är** `floors[curFloor]`, så
  `f.plan = s.plan` ÄR uppdateringen. `snapState()` klonar redan.
- *`fitBgToPlan` förvränger proportionerna* — en och samma skala på båda axlarna
  är precis det som BEVARAR dem. Fem rader kommentar ovanför förklarar varför
  snittet valdes framför `max(sx,sy)`. Granskaren rapporterade motsatsen till
  vad koden gör.

**Slutsatsen som styr allt annat i det här bygget: tidstaket var kvalitetstaket.**
Att välja modell efter fart tvingar fram en modell som inte kan spåra ett
antagande genom en stor fil — och en granskare som med självförtroende hittar på
buggar är sämre än ingen: den kostar mer tid än den sparar och förstör
tilltron till de riktiga fynden.

Kedjan är därför ordnad efter **aktiva parametrar**, inte svarstid:

| Modell | Aktiva/totalt | Kontext |
|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 55B / 550B | 1M |
| `z-ai/glm-5.2:free` | — (projektnivå-mjukvaruteknik) | 1M |
| `thinkingmachines/inkling:free` | 41B / 975B | 262k |

Z.ai är det bolag communityn pekat ut som `ox-alpha`s upphov, så `glm-5.2` är
sannolikt samma familj — fast namngiven och utan stealth-skörheten.

Andra dugliga kandidater för `OPENROUTER_FALLBACK_MODELS`:
`poolside/laguna-s-2.1:free` (kodagent, 70,2 % Terminal-Bench 2.1, 8B aktiva).

Prompten för Externt öga 2 har en **spärr mot obevisade fynd**: fyndet måste
citeras och spåras genom omgivande kod *och kommentarer* innan det får
rapporteras, tomt svar är uttryckligen ett respekterat svar, och referat av vad
koden gör är förbjudet. Samma sorts spärr som ui-scan fick efter det falska
"avklippt hjälptext"-fyndet. **Den har aldrig testats skarpt** — 413 kom emellan.

---

## Den obesvarade frågan

413 är löst (2026-09-28). Kvar är det som faktiskt avgör om rollen är värd
att ha: **ger 55 miljarder aktiva parametrar med hög tankenivå en granskning värd
att läsa?**

Det har aldrig kunnat mätas. Varje försök hittills har begränsats av
plattformen, inte av modellen. Nu när enqueue-vägen finns: kör
`planritningar.html` och läs med skepsis. Håller den påhittade buggar även då är
svaret att fri kodgranskning på OpenRouter inte bär — och det är värt att veta i
stället för att fortsätta justera.

---

## Datapolicy (gäller alltid)

OpenRouter anger att prompt och svar **behålls av leverantören** (används ej för
träning). Skicka bara kod dit — **aldrig kundmail, persondata** eller annat som
hör hemma i mail-/triage-flödena. Det står också i rollens beskrivning i UI:t,
eftersom det är där man klistrar in.
