# Åre Strand Holiday Club i andelsverktyget — analys och plan

Datum: 2026-09-15. Underlag: peakfast.se (Åre Strand-sidan), `D:\PeakFast\Föreningar\Åre Strand Blandat`
(36 objektsbeskrivningar + ~900 bilder), `D:\PeakFast\Föreningar\Åre sjö 1|10` (bilder),
`D:\PeakFast\Statistik Sålda objekt HH\Statistik.pdf` (HusmanHagberg Åre 2020–2025, 303 objekt),
Hemnets slutpriser för Åre Strand (113 lägenheter + 2 fritidshus, 2017–2026).

Datafilerna i den här mappen:

| Fil | Innehåll |
|---|---|
| `hh_are_strand.csv` | 61 Åre Strand-rader transkriberade ur HusmanHagberg-statistiken (din tid där, 2020–2025) |
| `hemnet_are_strand.csv` | 115 slutpriser från Hemnet, alla mäklare, 2017–2026 |
| `are_strand_affarer.csv` | sammanslagen, dubblettrensad datamängd: 132 affärer med enhet, veckor, typ, yta, avgift, pris, källa |
| `analys_strand.py` | skriptet som bygger datamängden och testar värderingsmodellen |

## 1. Svar på frågan: går det att göra samma upplägg som för SkiStar?

Ja, men inte som en kopia. Upplägget bär, men tre saker skiljer sig i grunden och styr designen.

1. **Produkten är en fast vecka i en namngiven lägenhet, inte en lägenhetstyp.** SkiStar-verktyget utgår från typ
   (Åre Village 1 · 50 kvm) och prislista per vecka. På Åre Strand är varje andel en specifik enhet (1A2, 19:1, 7B4)
   med en specifik vecka, och ingen prislista finns. Priset måste därför komma ur statistik, vilket är det du bad om.
2. **Ekonomin är enklare.** En andelsvecka kostar 260–400 kr/mån i avgift (Holiday Clubs veckoavgift via
   Ownership Services Sweden AB), ingen BRF-avgift × 1,5 vid jul, ingen städavgiftstrappa. HC Villas-paketen i hus 6
   (var sjätte vecka, 1 100–1 200 kr/mån) är en egen produkt.
3. **Säljargumenten är andra.** Hotell- och servicekänsla, restauranger, spa, strandläge mot Åresjön, RCI-byte till
   4 000 destinationer, promenadavstånd till byn. Inga SkiStar-förmåner. Texterna i de 36 objektsbeskrivningarna är
   färdigt råmaterial för ramen.

Slutsatsen är ett **syskonverktyg som delar kärnan** med andelsförsäljningen (textgenerering, språkregler, bild- och
Mspecs-flödet) men har egen datamodell och en värderingsdel i stället för prislista.

## 2. Så ser Åre Strand ut (datamodell)

Tre bostadsrättsföreningar, alla med Holiday Club som förvaltare:

| Förening | Hus | Enheter | Typer (boarea) | Byggår |
|---|---|---|---|---|
| Brf Åre Sjö 1 | hus 1–5 | 1A1–5B6 (hus, trapphus A/B, lgh 1–6) | 53–59 kvm 2 rok (hus 5), 63 kvm 2 rok, 76–81 kvm 3 rok, 90–95 kvm 3 rok, 111 kvm 4 rok | 2004–2009 |
| Brf Åre Sjö 1 | strandvillor 13–23 | 13:1–23:2 (parhus, två andelslägenheter per villa) | 95 kvm 3 rok (hus 14), 105 kvm (13:1), 118–125 kvm 4 rok med bastu, 8–10 bäddar | 2005–2008 |
| Brf Åre Sjö 7 | hus 6 | 6A1–6B3 | 78–81 kvm 3 rok, 112 kvm 4 rok; säljs mest som 1/6-paket | 2015 |
| Brf Åre Sjö 10 | hus 7 | 7A1–7B6 | 53 kvm 3 rok, 74 kvm 4 rok | 2018 |

Hus 8 är hela lägenheter (3–4 Mkr) och hör inte hit.

Enhetsbeteckningen är nyckeln i allt: `1A2` = hus 1, trapphus A, lägenhet 2. `19:1` = villa 19, lägenhet 1.
Hemnet, HusmanHagberg och dina mappar använder alla samma beteckning, med små stavningsvarianter (`5:B1`,
`18:02`, `3 A3`) som normaliseringen i skriptet redan hanterar.

## 3. Statistiken

### Täckning

| Källa | Rader | Period | Anmärkning |
|---|---|---|---|
| HusmanHagberg-listan (dina + Yvonnes) | 61 | 2020-02 – 2025-11 | 60 andelar + 1 hel lägenhet (8B4, utesluten) |
| Hemnet slutpriser | 115 | 2017-11 – 2026-09 | alla mäklare; 55 av HH-raderna finns även här |
| **Sammanslaget, unika** | **132** | | varav 101 enveckasaffärer, 6 tvåveckorsaffärer, 9 HC Villas-paket, 16 utan känd vecka |

Per typ: villa 118 kvm 48, lgh 74–81 kvm 35, lgh 53–59 kvm 15, lgh 111 kvm 11, lgh 90–95 kvm 11, paket 9, lgh 63 kvm 3.
Per år: 2019 9, 2020 13, 2021 25, 2022 11, 2023 7, 2024 14, 2025 28, 2026 24.

**Luckor:** PeakFasts egna affärer syns bara via Hemnet (20:1 v.14 250 000 kr och 6A4 500 000 kr i år). Ett Mspecs-utdrag
över dina sålda Åre Strand-objekt fyller den luckan och ger kontraktsdag och utgångspris. De 16 raderna utan vecka
(t.ex. "Åre Strand 21A", "22:2") kan bara du sätta vecka på. Booli har inte hämtats än; troligen samma affärer.

### Medianpris per typ och veckoklass (enveckasaffärer, alla år)

| Typ | Jul/nyår (51, 52, 1) | Sportlov (7–10) | Vinter (2–6) | Senvinter (11–13) | Vår (14–18) | Sommar (26–32) | Låg (övriga) |
|---|---|---|---|---|---|---|---|
| lgh 53–59 kvm | 125 tkr (4) | 115 tkr (7) | – | 115 tkr (1) | 45 tkr (1) | 44 tkr (1) | – |
| lgh 63 kvm | 125 tkr (3) | – | – | – | – | – | – |
| lgh 74–81 kvm | 160 tkr (11) | 145 tkr (5) | 60 tkr (3) | 140 tkr (3) | 70 tkr (7) | 75 tkr (1) | 50 tkr (1) |
| lgh 90–95 kvm | 260 tkr (3) | 180 tkr (2) | 150 tkr (1) | 182 tkr (2) | 177 tkr (2) | – | – |
| lgh 111 kvm | – | 200 tkr (3) | 137 tkr (4) | 182 tkr (2) | – | – | – |
| villa 118 kvm | 260 tkr (4) | 262 tkr (4) | 147 tkr (6) | 237 tkr (2) | 250 tkr (3) | 99 tkr (9) | 50 tkr (6) |

Antal inom parentes. HC Villas-paket (hus 6): 500–800 tkr, senast 610 och 700 tkr i feb 2025, 500 tkr i juni 2026.

### Första modelltestet

Multiplikativ modell på de 101 enveckasaffärerna: `pris = bas(typ) × veckofaktor(klass) × 0,976^(år − 2023)`.

| | Värde |
|---|---|
| Bas jul/nyår 2023 | 53–59 kvm 123 tkr · 63 kvm 128 tkr · 74–81 kvm 155 tkr · 90–95 kvm 238 tkr · 111 kvm 234 tkr · villa 118 kvm 278 tkr |
| Veckofaktor mot jul/nyår | sportlov 0,93 · senvinter 0,84 · vår 0,63 · vinter 0,50 · sommar 0,39 · låg 0,22 |
| Årsfaktor | −2,4 % per år (svag nedgång 2019–2026) |
| Träffsäkerhet | medianfel 14 %, 66 % av affärerna inom ±25 %, 90 % inom ±40 % |

Det räcker för ett **riktvärde med intervall**, inte för en punktvärdering. De största avvikelserna är enskilda
veckor som marknaden prissätter annorlunda än klassen (v.14 som påskvecka: 4B4 v.14 gick för 185 tkr mot modellens 94;
v.51 svagare än v.52; v.15–17 svagare än v.14). Veckoklasserna behöver därför förfinas till enskild vecka där
underlaget finns, och påsken flyttas mellan v.13–16 beroende på år.

## 4. Värderingsfunktionen — förslag

**Inmatning:** enhet (rullista ur katalogen, 60-talet enheter) + vecka (1–52). Typ, förening, yta, rum, bäddar och
avgift följer av enheten. Valfritt: säljarens utgångspris för jämförelse.

**Beräkning, tre lager som visas var för sig:**

1. **Direkta jämförelser.** Samma enhet och vecka (hittas i 6–8 fall), annars samma typ och samma vecka, annars samma
   typ och veckoklass. Visas som lista: datum, enhet, vecka, pris, mäklare, källa. Det är beviset mäklaren visar kunden.
2. **Modellvärde.** bas × veckofaktor × årsfaktor, uppdaterat till innevarande år. Visas med intervall ±25 %
   (det fångar två tredjedelar av affärerna) och en tydlig text om att det är ett statistiskt riktvärde.
3. **Rekommenderat utgångspris.** Modellvärdet justerat mot de direkta jämförelserna (viktat: senaste tre åren tyngst,
   samma vecka tyngre än samma klass). Avrundat till närmaste 5 000 kr. Under tre jämförelser i typ-och-klass:
   varning "tunt underlag".

**Aldrig:** en siffra utan intervall och utan jämförelselistan. Verktyget ger ett riktvärde inför prissättning, det
är inte ett värderingsintyg. Texten i verktyget ska säga det.

**Datat lever i en fil**, `analys/are-strand/are_strand_affarer.csv` blir `js/data/arestrand-affarer.js`, append-only
med källa per rad. Nya affärer läggs till på två sätt: din egen sparas när du markerar ett paket som sålt i verktyget,
och Hemnet läses av kvartalsvis med samma browserflöde som i dag (113 rader tog en session). Modellparametrarna
räknas om i webbläsaren ur datat, ingen server behövs.

## 5. Text och bilder

- **Prompten:** samma `buildAndelsPrompt()` och `SPRAKREGLER` som andelsförsäljningen fick i dag, med en Åre
  Strand-ram i stället för SkiStar-ramen: fast vecka i namngiven enhet, Holiday Clubs veckoavgift och serviceavtal,
  restauranger/spa/strand, RCI, promenad till byn. Inga SVC-förmåner, ingen städtrappa.
- **Råmaterial:** de 36 objektsbeskrivningarna innehåller dina och Yvonnes färdiga texter per enhet. De blir
  exempeltexter per typ (villa, hus 1–5, hus 6-paket, hus 7) och faktakälla för katalogen (bäddar, bastu, balkong/altan,
  utsikt mot Renfjället eller Åresjön).
- **Bilder:** mapparna har 20–47 bilder per enhet, 2000 px, med beskrivande filnamn ("Altan med härlig vy mot
  Renfjället.jpg", "Exempelbild - Bastu.jpg"). Samma konvention som `AndelstextBilder\` kan användas: en mapp per
  enhet, "Exempelbild"-prefixet markerar typbilder som får återanvändas mellan enheter i samma hus.
  Mapparna i `Åre sjö 1` har hash-namn (Mspecs-export) och behöver döpas om eller sorteras för hand.

## 6. Arkitektur

- **Bryt ut kärnan** ur `andelsforsaljning.html` till `js/andels-core.js`: språkregler, promptbyggare, Claude-anropet,
  veckoinformationen (WEEK_INFO är återanvändbar rakt av), Mspecs-uppladdningen. Andelsförsäljningen använder samma
  fil, så det som hände med promptkopiorna inte upprepas.
- **Ny sida `arestrand.html`** i dashboarden med tre flikar: Objekt (enhet + vecka + fakta + bilder), Värdering
  (jämförelser, modellvärde, utgångspris), Text (generering + Mspecs). Egen datafil `js/data/arestrand-katalog.js`
  (enheterna) och `js/data/arestrand-affarer.js` (affärerna).
- **Inte** en fjärde destination inne i SkiStar-sidan: 43 SkiStar-beroenden i den koden (prislista, BRF × 1,5,
  städtrappa, SVC-texter, Mspecs-ordning) gör villkoren fler än vinsten.

## 7. Arbetsordning och omfattning

| Steg | Innehåll | Uppskattning |
|---|---|---|
| 0 | Du: Mspecs-utdrag över sålda Åre Strand-objekt, vecka på de 16 raderna utan, besked om paketen | din tid |
| 1 | Katalogen: alla enheter med typ, yta, rum, bäddar, avgift, förening, ur objektsbeskrivningarna + Hemnet | halv dag |
| 2 | Bryta ut `andels-core.js` och verifiera att andelsförsäljningen fungerar oförändrat | halv dag |
| 3 | Värderingen: datafil, modell i webbläsaren, jämförelselista, intervall, varningar; provkörning mot de 101 affärerna | en dag |
| 4 | Objekt- och textfliken med Åre Strand-ramen, bildmappar, Mspecs | en dag |
| 5 | Din provkörning på ett skarpt objekt (t.ex. 4B1 v.18 eller 23:1 v.26 ur 2026-listan) | din tid |

## 8. Beslut jag behöver från dig innan bygget

1. Egen sida `arestrand.html` med delad kärna (mitt förslag) eller inbyggt i SkiStar-sidan?
2. Ska HC Villas-paketen (hus 6) ingå i värderingen som egen produkt, eller lämnas utanför i första versionen?
3. Får jag ett Mspecs-utdrag över dina sålda Åre Strand-objekt? Utan det saknas PeakFast-tiden i statistiken.
4. Vill du att Hemnet-avläsningen ska vara en knapp i verktyget (browserflöde, halvautomatiskt) eller en rutin jag kör åt dig?
