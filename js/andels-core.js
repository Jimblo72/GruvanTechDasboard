/* ═══════════════════════════════════════════════════════════════════════════
   andels-core.js — det som andelsverktygen delar.

   Används av andelsforsaljning.html (SkiStar Vacation Club) och arestrand.html
   (Åre Strand Holiday Club). Här bor: språkreglerna, veckoinformationen,
   Claude-anropet, resultatrenderingen och de små hjälparna kring API-nyckel
   och mäklarinfo. Det som är specifikt för en destination (datamodell,
   prislista, avgiftsräkning, promptram) bor i respektive sida.

   Bakgrund: prompten låg tidigare i två kopior i samma fil och gled isär.
   Ett ställe att underhålla — det är hela poängen med den här filen.
   ═══════════════════════════════════════════════════════════════════════════ */

// ── VECKOR — kategorier och USP per destination ───────────────
const WEEK_INFO = {
  // JUL & NYÅR — högsäsong med 1,5× BRF
  51:{ type:'jul',    label:'Julvecka',         usp:'Julmagi i fjällen — snösäkra spår, värmande eldar och vintermys' },
  52:{ type:'nyar',   label:'Nyårsvecka',       usp:'Fira nyår med fjällvy och fyrverkerier över byn' },
  1: { type:'nyar',   label:'Nyårsvecka',       usp:'Nyårsfirande och trettondagsledigt — lugn vecka efter julruschen' },

  // EFTERJUL — uppbyggande säsong
  2: { type:'efterjul', label:'Vintervecka',    usp:'Lugn vecka med stabilt skidföre och korta liftköer' },
  3: { type:'efterjul', label:'Vintervecka',    usp:'Prisvärd snösäker vecka i fjällen' },
  4: { type:'efterjul', label:'Vintervecka',    usp:'Stabilt vinterföre och få besökare' },
  5: { type:'efterjul', label:'Vintervecka',    usp:'Bästa skidföret är här — strax före sportlovstider' },
  6: { type:'efterjul', label:'Vintervecka',    usp:'Stabilt skidföre inför sportlovsperioden' },

  // SPORTLOV — högsäsong, regional
  7: { type:'sportlov', region:'Norrland',                  label:'Sportlov v.7',  usp:'Sportlovsvecka för Norrland — fjällen i full säsong' },
  8: { type:'sportlov', region:'Mellansverige',             label:'Sportlov v.8',  usp:'Sportlovsvecka för Mellansverige — en av årets mest eftertraktade veckor' },
  9: { type:'sportlov', region:'Stockholm/Uppland',         label:'Sportlov v.9',  usp:'Sportlovsvecka för Stockholm — fullt pistsystem och pulserande by' },
  10:{ type:'sportlov', region:'Skåne/Halland/Blekinge',    label:'Sportlov v.10', usp:'Sportlovsvecka för södra Sverige — snöfest i fjällen' },

  // SENVINTER — fullt pistsystem, sol
  11:{ type:'senvinter', label:'Senvinter',     usp:'Lugn vecka efter sportlovet — fullt pistsystem och solljus' },
  12:{ type:'senvinter', label:'Senvinter',     usp:'Marssol över fjällen — perfekt skidvecka' },
  13:{ type:'senvinter', label:'Senvinter',     usp:'Solskidning med långa dagar och stabilt snödjup' },

  // VÅRVINTER / PÅSK — sol, värme och bra snö
  14:{ type:'varvinter', label:'Vårvintervecka',                       usp:'Vårvinter med långa solljusa skiddagar' },
  15:{ type:'varvinter', label:'Vårvintervecka (kan vara påsk)',       usp:'Vårvinter i fjällen — påsken infaller ofta här' },
  16:{ type:'varvinter', label:'Vårvintervecka (kan vara påsk)',       usp:'Säsongens sista snöveckor med vårens första värme' },
  17:{ type:'varvinter', label:'Säsongsavslutning',                    usp:'Bland säsongens sista skidveckor — sol, värme och snö' },
  18:{ type:'varvinter', label:'Säsongsavslutning',                    usp:'Sista skidveckan innan sommarsäsongen tar vid' },

  // SERVICE / MELLANSÄSONG
  19:{ type:'service',   label:'Servicevecka' },
  20:{ type:'service',   label:'Servicevecka' },

  // FÖRSOMMAR
  21:{ type:'forsommar', label:'Försommar',     usp:'Försommar i fjällen — vandring, fågelliv och ljusa nätter' },
  22:{ type:'forsommar', label:'Försommar',     usp:'Försommar med långa kvällar och blommande fjäll' },
  23:{ type:'forsommar', label:'Försommar',     usp:'Försommar med vandringsleder och fiske i fjällsjöar' },
  24:{ type:'forsommar', label:'Försommar',     usp:'Försommar med midsommarmagi i sikte' },
  25:{ type:'midsommar', label:'Midsommarvecka', usp:'Midsommar med fjällvy, ljusa nätter och fjälltradition' },

  // SOMMAR — peak
  26:{ type:'sommar',    label:'Sommarvecka',   usp:'Sommar i fjällen — bad i fjällsjöar, vandring och cykling' },
  27:{ type:'sommar',    label:'Sommarvecka',   usp:'Högsommar — vandring, cykling och fjällaktiviteter' },
  28:{ type:'sommar',    label:'Sommar – peak', usp:'Bland Sveriges mest populära fjällsommarveckor' },
  29:{ type:'sommar',    label:'Sommar – peak', usp:'Peak sommarvecka — vandring, paddling, cykel och fiske' },
  30:{ type:'sommar',    label:'Sommar – peak', usp:'Peak sommarvecka — semesterhögtid i fjällen' },
  31:{ type:'sommar',    label:'Sommar – peak', usp:'Peak sommarvecka — fjällvyer i sitt bästa skick' },
  32:{ type:'sommar',    label:'Sommar – peak', usp:'Sista sommarpeak-veckan innan skolstart' },

  // SENSOMMAR / TIDIG HÖST
  33:{ type:'sensommar', label:'Sensommar',     usp:'Sensommar med varma dagar och lugnare fjäll' },
  34:{ type:'sensommar', label:'Sensommar',     usp:'Lugn sensommarvecka — bär, svamp och vandring' },
  35:{ type:'sensommar', label:'Sensommar',     usp:'Sensommar med första höstfärgerna' },

  // HÖST
  36:{ type:'host',      label:'Höst',          usp:'Färgsprakande höst i fjällen — bär, svamp och vandring' },
  37:{ type:'host',      label:'Höst',          usp:'Höst med klar luft och magiska solnedgångar' },
  38:{ type:'host',      label:'Höst',          usp:'Höstvecka för ren fjällupplevelse i lugn miljö' },
  39:{ type:'host',      label:'Höst',          usp:'Höst med fjällens vackraste färgprakt' },
  40:{ type:'host',      label:'Höst',          usp:'Sen höst — fjällro och ren luft' },
  41:{ type:'host',      label:'Höst',          usp:'Höstvecka inför säsongspaus' },

  // HÖSTLOV
  42:{ type:'hostlov',   label:'Höstlov',       usp:'Höstlov i fjällen — familjeaktiviteter och naturäventyr' },
  43:{ type:'hostlov',   label:'Höstlov',       usp:'Höstlov med fjällvy och utomhusliv' },
  44:{ type:'hostlov',   label:'Höstlov',       usp:'Höstlov för södra Sverige — sista höstveckan' },

  // FÖRVINTER — uppbyggnad inför säsong
  45:{ type:'forvinter', label:'Förvinter' },
  46:{ type:'forvinter', label:'Förvinter' },
  47:{ type:'forvinter', label:'Säsongsstart', usp:'Säsongsstart i fjällen — nya pister och färre besökare' },
  48:{ type:'forvinter', label:'Tidig vinter', usp:'Tidig vintersäsong med pisterna i full beredskap' },
  49:{ type:'forvinter', label:'Tidig vinter', usp:'Tidig vinter — bästa läget för säsongspremiär' },
  50:{ type:'forvinter', label:'Tidig vinter', usp:'Tidig vintervecka strax före jul — snö och stämning' },
};


function renderResult({ shortText, longText, charsShort }) {
  const lengthClass = charsShort >= 260 && charsShort <= 300 ? 'length-ok' : 'length-warn';
  const lengthLabel = charsShort >= 260 && charsShort <= 300 ? 'OK' : 'JUSTERA';

  document.getElementById('results').innerHTML = `
    <div class="result-tabs">
      <button class="result-tab active" onclick="switchResultTab('long', this)">Lång variant</button>
      <button class="result-tab" onclick="switchResultTab('short', this)">Kort <span class="length-badge ${lengthClass}">${charsShort}/300 · ${lengthLabel}</span></button>
    </div>
    <div class="result-content" id="result-long">
      <div class="result-meta">
        <span>LÅNG VARIANT · ${longText.length} TECKEN</span>
        <button class="copy-btn" onclick="copyText(\`${longText.replace(/`/g,'\\`').replace(/\$/g,'\\$')}\`)">Kopiera</button>
      </div>
      <div class="result-text">${longText.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--accent);font-weight:500">$1</strong>').replace(/\*(.+?)\*/g, '<em style="color:var(--text-dim);font-style:italic">$1</em>')}</div>
    </div>
    <div class="result-content" id="result-short" style="display:none;">
      <div class="result-meta">
        <span>KORT VARIANT · ${charsShort}/300 TECKEN <span class="length-badge ${lengthClass}">${lengthLabel}</span></span>
        <button class="copy-btn" onclick="copyText(\`${shortText.replace(/`/g,'\\`').replace(/\$/g,'\\$')}\`)">Kopiera</button>
      </div>
      <div class="result-text result-text-short">${shortText}</div>
    </div>`;
}

function switchResultTab(variant, btn) {
  document.querySelectorAll('.result-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('result-long').style.display = variant === 'long' ? 'block' : 'none';
  document.getElementById('result-short').style.display = variant === 'short' ? 'block' : 'none';
}

function copyText(text) {
  navigator.clipboard.writeText(text);
  event.target.textContent = 'Kopierat ✓';
  setTimeout(() => event.target.textContent = 'Kopiera', 1500);
}


function getMaklarInfo(){
  var s=localStorage.getItem('pf_maklarinfo');
  if(s){try{return JSON.parse(s);}catch(e){}}
  return{mNamn:"Jimmy Blomgren",mTel:"070-788 57 00",mEmail:"jimmy@peakfast.se",mWeb:"www.peakfast.se",mTitel:"Registrerad Fastighetsmäklare"};
}


// ── Claude API
function getApiKey(){return localStorage.getItem('af_apikey')||"";}
function saveApiKey(){
  var k=document.getElementById("apiKeyInput");if(!k)return;
  localStorage.setItem('af_apikey',k.value.trim());
  document.getElementById("apiPanel").style.display='none';
  document.getElementById("apiKeyStatus").textContent="✓ API-nyckel sparad";
  setTimeout(function(){document.getElementById("apiKeyStatus").textContent="";},2500);
}
function showApiPanel(){
  var p=document.getElementById("apiPanel");
  if(p){p.style.display=p.style.display==='none'?'block':'none';}
  var k=getApiKey();if(k){var i=document.getElementById("apiKeyInput");if(i)i.value=k;}
}


/* ── Språkregler, delade med Mäklargruvan ─────────────────────────────────
   KOPIA av regelblocket REGLER i buildPrompt() i maklargruvan-pilot
   (public/text.html), hämtad 2026-09-15. Originalet bor där och slipas
   mot mäklarnas granskning; ändra helst där och kopiera hit igen.

   Medvetet UTELÄMNAT från Mäklargruvan: dispositionen i tre delar,
   rundvandringen, stilexemplen och förbudet mot avgift/pris i löptexten —
   för en andelsrätt är avgiften, städavgiften och veckorna själva
   produkten, och lägenhetstyperna har ingen planlösning att vandra i.
   Två regler är anpassade: exemplen med "erbjuder"/"bjuder in" är borta
   (orden är förbjudna i andelstexterna) och benämningsregeln talar om
   andel och vecka i stället för bostadsrätt. */
var SPRAKREGLER = `\n\nVIKTIGT – språk och trohet mot underlaget:
- Använd ENBART fakta som finns i underlaget ovan. Hitta INTE på mått, material, rum, utrustning eller egenskaper som inte står där.
- Återge fakta med korrekt fackterminologi och exakta benämningar: skriv t.ex. "badrum" när det är badrum (aldrig "dusch"/"duschar" som ersättning) och blanda inte ihop begrepp. Skriv "våningsplan" om antal plan (inte "nivåer"). Skriv inte "fjällhus" eller "fjällboende" – använd hellre "fritidshus i fjällen", "boende i fjällen" eller "ditt eget boende i fjällen". Skriv ut låga antal i bokstäver i löpande text (t.ex. "sex rum", "fyra sovrum", "tre plan") och var konsekvent – men mått, årtal och ytor skrivs med siffror (t.ex. "81 kvm", "2008"). Versalisera inte vanliga substantiv mitt i mening (skriv "byliften", "skidleden" – inte "Byliften").
- Beskriv konkret vad som FINNS (rum, ytor, material, läge), men texten FÅR vara varm och säljande – särskilt i inledningen och den korta texten (t.ex. "ett härligt läge", "en härlig altan", "ett av byns bästa lägen", "byliften tar dig direkt upp i systemet"). Lägg dig på samma värmenivå som en välskriven svensk mäklarannons — varmare än en faktatext, men aldrig påklistrad. Uttryck som "för den som uppskattar" och "läget är svårslaget" är genrespråk och GÅR BRA när de har täckning i underlaget. Det som ska bort är tomma överord utan förankring: skriv inte "bokstavligen" eller "löser sig av sig självt", och avsluta inte med innehållslösa omdömen ("en fastighet med kvalitet och potential").
- Varje värmande formulering måste bära KONKRET innehåll. Skriv inte om "en känsla" utan att säga vilken, och skriv inte att något "sätter tonen", "tar vara på läget", "tar andan ur dig" eller "ger utsikten en plats att njutas från" — det är omdömen utan innehåll, inte värme. TESTET: stryk meningen och se efter om någon uppgift försvann. Försvann ingenting ska meningen bort. Värme skapas av konkreta saker (braskaminen, kvällssolen på altanen, skidbod med torkskåp), aldrig av ord om känslor.
- Beskriv ett rum som en YTA eller PLATS med en egenskap — inte som ett påstående om vad det "är": skriv "en social yta som blir en naturlig samlingspunkt efter en lång dag i backarna", inte "det är naturligt familjens och gästernas samlingspunkt". Förankra gärna scenen i ett konkret ögonblick, men bara ett sådant som underlaget bär.
- MÄKLARSPRÅK, inte byggteknik. Skriv "vitmålad trappa" — inte "trappa med vita vangstycken och trästeg". Skriv "braskamin med skiffervägg" — inte "braskamin med accentvägg i skiffer". Skriv "räcke i trä" och lämna spjälornas riktning därhän. Regeln: bygg- och inredningstermer som en spekulant inte använder ska bort, även när de står i underlaget.
- UTSIKT skrivs "utsikt ÖVER" när blicken går ut över ett landskap — "utsikt över fjället", "utsikt över sjön" — och gärna med ett enkelt adjektiv ("härlig utsikt över fjäll och sjö"). "Utsikt mot" används bara om en enskild riktning eller ett enskilt föremål.
- RUMSANTAL skrivs på mäklarvis: "sex rum och kök", aldrig bara "sex rum". Andra uppgifter (bäddar, plan) läggs som egna led — "sex rum och kök med tolv bäddar på två våningsplan" — och radas inte upp som om de vore rum.
- Stapla inte detaljer på samma sak. När en uppgift redan är sagd, säg den inte en gång till i annan form, och upprepa inte samma inledande konstruktion i en uppräkning ("ett med balkong … och ett med panoramafönster" blir "ett med balkong … och ett med panoramafönster från golv till tak" bara om båda leden bär ny information — annars skriv andra ledet kort).
- Välj vardagliga värdeord framför tekniska: "härlig utsikt" hellre än "direkt utblick", "utgång till altanen" hellre än "altanen utanför". Och låt de konkreta sakerna FÅ sitt enkla adjektiv — "fin utsikt mot Åreskutan", "generös hall", "ljust allrum" — hellre än att nämnas naket ("utsikt mot Åreskutan"). Det är där värmen ska sitta, inte i stora ord om känslor. Sätt måttet i en naturlig prepositionsfras: bostaden har "en boarea på" så och så många kvm, eller är helt enkelt "på" så många kvm. Skriv det ALDRIG som objekt till "omfattar" och sätt aldrig ordet boarea efter kvadratmetertalet.
- Håll det enkelt när det räcker: "med plats för alla" är bättre än "rymligt nog för ett helt kompisgäng". Upprepa inte målgruppen i varje stycke; nämn den en gång.
- PLACERA INTE UT saker i förhållande till varandra om underlaget inte säger var de ligger. Står det bara att det finns en altan får du skriva "utgång till altanen" — inte "altanen utanför allrummet". Rumsplacering är en sakuppgift, inte en formulering.
- Skriv "ski in/ski out TILL" (dit man faktiskt tar sig), inte "ski in/ski out mot". Samma sak med andra närhetsuttryck: man kommer TILL backen, inte mot den.
- Använd det konkreta vardagsordet för det som ligger NÄRA bostaden, och spara det abstrakta systemordet till HELHETEN. Skriv "ski in/ski out till Björnens backar" — inte "mot Björnens skidsystem" — och låt systemordet beteckna hela anläggningen: "som tar dig smidigt ut i hela Åres skidsystem". Samma princip överallt: "bussen stannar utanför porten" hellre än "goda kollektivtrafikförbindelser".
- Bind hellre ihop en fortsättning med en RELATIVSATS än med tankstreck och en ny huvudsats: "... till Björnens backar SOM tar dig ut i hela Åres skidsystem" läser bättre än "... till Björnens backar — därifrån tar du dig ut i ...". Skriv "hela" om helheten, inte "övriga".
- Tilltala läsaren direkt med "du" (eller "ni" om texten redan gör det) — så skriver nio av tio riktiga annonser: "här bor du", "möts du av", "tar du dig". Skriv inte om bostaden i tredje person hela vägen.
- Skriv FLYTANDE prosa på korrekt svenska med varierad meningsbyggnad – inte stolpiga, staplade fragment och inga syftningsfel. Undvik upprepningar och att samma sak sägs flera gånger, och var konsekvent (motsäg dig inte, t.ex. om antal rum eller badrum). Språkkvaliteten är viktig: texten ska kunna publiceras utan efterredigering.
- Lägg INTE till värdeord, garantier, superlativ eller JÄMFÖRELSER med andra objekt som saknar stöd i underlaget. Förbjudet är alltså inte bara "garanterar", "helt unikt" och "bäst i området", utan även mjukare komparativer som "ett av de rymligare i området", "ovanligt stor för sin storlek" eller "sällsynt läge" — du vet inget om de andra objekten. Beskriv bostaden som den är; läsaren gör jämförelsen själv. Förfina eller tolka inte neutrala fakta – återge dem som de står: "dränerad och helisolerad grund" (inte "väl underhållen grund"), "biarea" (inte "påbyggd biarea"), "murstock med skorsten" (inte "eldstad").
- Skilj på det som FINNS och det som är PLANERAT. En planerad eller kommande åtgärd får ALDRIG skrivas som redan utförd, och hitta aldrig på ett "ytterligare"/"kompletterande" som saknas i underlaget. Står det "fiber installeras sommaren 2026" är fiber alltså INTE indraget i dag – skriv då att fiber installeras sommaren 2026, punkt.
- Kalla bostaden vid namn: skriv "lägenheten" eller "bostaden" – inte "bostadsrätten" och inte "andelsrätten" som namn på själva bostaden. Det som säljs är andelen och veckorna, så "andel", "andelsvecka" och "vecka" används om DET – inte som benämning på lägenheten i varje mening. Blanda inte två benämningar i samma mening.
- Förklara inte bort etablerade begrepp – de bär redan sin betydelse. "Ski in/ski out" säger i sig att man åker till och från dörren; skriv därför inte att läget dessutom ligger "intill backen" eller att systemet är "ihopkopplat med" resten av anläggningen. Vill du säga mer ska det TILLFÖRA något, t.ex. vart man tar sig vidare: "med ski in/ski out – och från Björnens backar tar du dig smidigt vidare ut i Åresystemet".
- Skriv "högt läge" – inte "högt beläget" och inte heller bara "högt i ...". Substantivet läge ska stå kvar: "Högt läge i Åre Björnen", inte "Högt i Åre Björnen". Undvik particip-inledningar av typen "Beläget i ...", "Placerat vid ...", "Högt beläget ..."; börja hellre med en riktig mening.
- Skriv INTE meta-meningar som sammanfattar det du nyss räknat upp. Det gäller HELA mönstret, inte bara enskilda ordval: varje mening av typen "det är/det här är X för den här bostaden", "det är X du hittar här", "det är ramen för ...", "så ser förutsättningarna ut", "detta är hemmet för ..." ska bort — oavsett vilket ord som står på X-platsen (förutsättningarna, läget, ramen, utgångspunkten). Låt uppräkningen stå för sig själv och gå vidare; ingen mäklare knyter ihop sin egen inledning på det sättet.
- Beskriv målgrupper med vardaglig svenska – "den stora familjen", "kompisgänget", "vännerna som åker tillsammans" – och håll formerna PARALLELLA när du räknar upp flera: "plats för den stora familjen eller kompisgänget" (båda i bestämd form, ingen artikel framför den andra). Skriv alltså inte "den stora familjen eller ett kompisgäng", och aldrig "ett kompisgänget". Använd inte resebranschord som "sällskapsresor" eller "sällskap".`;


/* Anropar Claude direkt från webbläsaren med mäklarens egen nyckel och delar
   svaret i lång + kort text på ---KORT---. Nyare modeller lägger ett
   tänkeblock först i content, därför plockas textblocken uttryckligen.
   max_tokens 8000: tänkandet räknas in i taket, 4000 kapade den korta texten. */
function anropaClaudeTvaTexter(prompt, apiKey) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] })
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (data.error) throw new Error(data.error.message || 'okänt fel');
    var txt = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    var parts = txt.split('---KORT---');
    var longTxt = parts[0].trim(), shortTxt = parts[1] ? parts[1].trim() : '';
    if (shortTxt.length > 300) shortTxt = shortTxt.substring(0, 297) + '...';
    return { longText: longTxt, shortText: shortTxt, charsShort: shortTxt.length };
  });
}
