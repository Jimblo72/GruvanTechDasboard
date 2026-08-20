# Andelsverktyget (`andelsforsaljning.html`)

Genererar säljtexter, A3-skyltar och Mspecs-/Cowork-paket för andelslägenheter
(SkiStar Vacation Club) i **Åre, Sälen och Vemdalen**.

> **Detta repo är verktygets enda hem.** Fram till 2026-08-07 fanns en kopia även i
> `C:\dev\peakfast-verktyg`. De gled isär: dashboardens kopia låg fem veckor efter och
> deployade fel avgifter i månader utan att någon märkte det. Skapa inte en ny kopia —
> redigera filen här. Batch-data, handoffs och Mspecs-kartan bor kvar i `peakfast-verktyg`.

## Köra
Single-file HTML, ingen build, ingen server. Öppnas antingen på den deployade sajten
eller genom att dubbelklicka filen. Kräver **Chrome eller Edge** — Bildbank-fliken
använder File System Access API, som saknas i Firefox och Safari.

## Fem flikar
1. **Generera text** — kort/lång säljtext per objekt. Mall-version eller Claude AI
   (API-nyckel sparas i `localStorage`). Väljaren `#apt-type` styr hela verktyget.
2. **Bildbank** — bilder per lägenhetstyp via File System Access (drag&drop,
   thumbnails, IndexedDB-persistens). Skapar en undermapp per typ i bildbanksroten.
3. **Referensdata** — visa/redigera avgifter och fakta per typ (override i `localStorage`).
4. **A3-Skylt** — tryckfärdig PDF (420×297 mm), tre mallar.
5. **Bulk-import** — läser SkiStars PAKET-Excel, matchar rader mot lägenhetstyper,
   massgenererar texter + skyltar, exporterar Cowork/Mspecs-paket.

## Datamodell
- **`APT_DATA`** — enda källan för objektfakta per typnyckel (`av1-50`, `timmerbyn-1-46`…).
  ⚠️ Optionvärdena i dropdownen ÄR `APT_DATA`-nycklarna **och används som bildmappsnamn
  på disk**. Byt aldrig en nyckel utan att döpa om mappen i `AndelstextBilder\`.
- **`MSPECS_PROJECTS`** — BRF → Mspecs projekt-id/adress, för JSON-exporten.
- **`MSPECS_UPLOAD_ORDER`** + `sortByMspecsUploadOrder` — tvingar drönar-/översiktsbild
  först, till Mspecs "banner"-slot. Annars bränns svart padding (1568×698) in i jpegen.
- **`WEEK_INFO` / `SPECIAL_WEEK_MAP` / `normalizeWeeksStr` / `calcBrfMonthly`** — veckomodellen.
  Jul/nyår räknas ×1,5 för Åre Village, Vemdalen **och Sälen** (beslut 2026-06-30).

## Priser
Fältet **SkiStar listpris** och Excelns `insats` är **totalpriset för hela andelen**.
Pris per vecka som faktarutan visar är ett snitt. I SkiStars prislistor sätter
vinterveckan hela paketpriset — en sommarvecka på köpet kostar ofta ingenting extra.
Gör inte om snittet till ett "riktigt" veckopris utan en pristabell per vecka; någon
sådan finns inte i verktyget.

### Jul och nyår — två format i SkiStars listor
SkiStars prislistor (`…\Peak Fast\SkistarPrislistor\*.pdf`) beskriver julperioden på
**två olika sätt**, och skillnaden är inte kosmetisk:

- **Jul/Nyår-format** (TB5, Åre Village, SAK2): två sålda enheter, `JUL` och `NYÅR`,
  utan vecka 1. Fotnoten anger Jul = v.51 och Nyår = v.1, men i verktygets modell är
  Jul = v.51 och Nyår = **v.52** (se `SPECIAL_WEEK_MAP`).
- **Numrerat format** (TB1-3, TB4, Snötorget/ET): samma period säljs som tre numrerade
  veckor, v.51 + v.52 + v.1, till helt andra belopp.

Timmerbyn 4 och 5 har därför nästan identiska listor — 43 av veckorna för 113 kvm och
46 för 54 kvm är lika på kronan — men TB4:s v.51 är 232 000 kr medan TB5:s Jul är
539 000 kr. Fram till 2026-08-20 lånade TB5 hela TB4:s kolumn (`gen_veckopris.py`
mappade dem ihop), vilket gav TB5-objekt **mindre än halva** jul-priset. TB5 har nu egna kolumner i Excel-källan.

**Lärdomen:** anta aldrig att två hus delar prislista bara för att lågsäsongen matchar
— julveckorna är där husen skiljer sig, och där pengarna finns. Kontrollera mot husets
egen PDF.

Öppen fråga: om SkiStar har gått över till Jul/Nyår-indelningen för alla hus är
TB1-3-, TB4- och ET-listorna en äldre revision, och deras jul-priser är i så fall
för låga på samma sätt. Alla PDF:er är daterade 21 dec 2022. Kräver besked från SkiStar.

## Sökvägar utanför repot (OneDrive)
- Bildbanksrot, hårdkodad i `BILDBANK_ROT`:
  `…\Gruvan Tech AB\PeakFast verktyg\AndelstextBilder\<typnyckel>\`
- PAKET-Excel:
  `…\PeakFast verktyg\Skistar\Andelspaket\Paket som ligger hos Peak Fast 260428.xlsx`
  (flikar `PAKET ÅRE`, `PAKET SÄL`, `PAKET VEM`, `BRF AVG`)

## Relaterat i `C:\dev\peakfast-verktyg`
- `salen/` — data och deal-id för de 44 Sälen-objekten i Mspecs
- `MSPECS-KARTA.md` — hur Mspecs fylls i (fältnamn, batch-recept, fällor)
- `HANDOFF.md`, `HANDOFF_2026-08-07.md` — vad som gjorts och vad som är kvar

## Kvar att göra
- [ ] Bildbank: en-klicks mappimport (`webkitdirectory`) + ZIP-export av bildpaket.
- [ ] Förmånsraden "50 % rabatt på skidupplevelser i Åre" visas även för **Vemdalen**.
      Sälen har egen förmånstext sedan 2026-06-30, så den delen är löst. Kontrollera om
      Åre-raden stämmer för Vemdalen-ägare.
- [ ] Ska listpriset föreslås automatiskt i A3-skyltens prisfält? Det lämnas medvetet
      orört av autofyllningen idag.
