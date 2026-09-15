// Netlify Function: läser Hemnets slutpriser för Åre Strand.
//
// GET /.netlify/functions/hemnet-slutpriser            → alla sidor (max 5)
// GET /.netlify/functions/hemnet-slutpriser?sidor=1    → bara första sidan (de senaste 50)
//
// Hemnet svarar 403 på anrop utan webbläsar-UA men 200 med, och sidan bär
// hela resultatlistan som JSON i <script id="__NEXT_DATA__"> (Apollo-cache,
// typen SaleCard). Vi läser den i stället för att skrapa text — fälten är
// stabila och listingId ger en riktig dubblettnyckel.
//
// Ingen hemlighet inblandad. Bara läsning av en publik sida.

const BAS = 'https://www.hemnet.se/salda/lagenhet/are-kommun/are-strand';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

function tal(s) {
  const m = String(s || '').replace(/ /g, ' ').match(/-?[\d ]+/);
  return m ? parseInt(m[0].replace(/ /g, ''), 10) : null;
}

/* "Åre Strand 20:2 V29" → { enhet: "20:2", veckor: [29] }. Samma normalisering
   som analys/are-strand/analys_strand.py — håll dem i fas. */
function tolkaObjekt(adress) {
  let n = String(adress || '').replace(/Åre\s*Strand/i, '').trim().replace(/^[\s,–-]+/, '');
  let enhet = null, m;
  if ((m = n.match(/^(\d{1,2})\s*:\s*0?(\d)\b/))) enhet = `${parseInt(m[1], 10)}:${m[2]}`;
  else if ((m = n.match(/^(\d)\s*:?\s*([AB])\s*:?\s*(\d)\b/i))) enhet = `${m[1]}${m[2].toUpperCase()}${m[3]}`;
  else if ((m = n.match(/^(\d)\s*\/?\s*([ABC])\b/i))) enhet = `${m[1]}${m[2].toUpperCase()}?`;
  else if ((m = n.match(/^(\d{1,2})\b/))) enhet = `${m[1]}?`;
  const veckor = new Set();
  for (const x of n.matchAll(/(?:[vV]\.?\s*|[vV]ecka\s*|[vV]\s)(\d{1,2})/g)) veckor.add(parseInt(x[1], 10));
  for (const x of n.matchAll(/&\s*[vV]?\.?\s*(\d{1,2})\b/g)) veckor.add(parseInt(x[1], 10));
  return { enhet, veckor: [...veckor].filter(v => v >= 1 && v <= 53).sort((a, b) => a - b) };
}

function tillRad(c) {
  const { enhet, veckor } = tolkaObjekt(c.streetAddress);
  const datum = c.soldAt ? new Date(parseFloat(c.soldAt) * 1000).toISOString().slice(0, 10) : null;
  return {
    listingId: c.listingId || null,
    datum,
    objekt: c.streetAddress || '',
    enhet, veckor,
    boarea: tal(c.livingArea),
    rum: tal(c.rooms),
    avgift: tal(c.fee),
    pris: tal(c.finalPrice),
    utgangspris: tal(c.askingPrice),
    maklare: c.brokerAgencyName || '',
    kalla: 'hemnet',
  };
}

async function lasSida(sida) {
  const url = sida > 1 ? `${BAS}?page=${sida}` : BAS;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'sv-SE,sv;q=0.9' } });
  if (!r.ok) throw new Error(`Hemnet svarade ${r.status} på sida ${sida}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Hittade inte __NEXT_DATA__ — har Hemnet bytt sidstruktur?');
  const j = JSON.parse(m[1]);
  const apollo = (j.props && j.props.pageProps && j.props.pageProps.__APOLLO_STATE__) || {};
  const kort = Object.values(apollo).filter(v => v && v.__typename === 'SaleCard');
  let totalt = null;
  const rq = apollo.ROOT_QUERY || {};
  for (const k of Object.keys(rq)) {
    if (/sold/i.test(k) && rq[k] && typeof rq[k].total === 'number') totalt = rq[k].total;
  }
  return { rader: kort.map(tillRad), totalt };
}

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  const maxSidor = Math.min(5, Math.max(1, parseInt((event.queryStringParameters || {}).sidor || '5', 10) || 5));
  try {
    const alla = [];
    let totalt = null;
    for (let s = 1; s <= maxSidor; s++) {
      const { rader, totalt: t } = await lasSida(s);
      if (t != null) totalt = t;
      alla.push(...rader);
      if (rader.length < 50) break;               // sista sidan
    }
    // Samma listingId kan dyka upp två gånger om listan flyttar sig mellan sidorna.
    const sedd = new Set();
    const unika = alla.filter(r => { const k = r.listingId || (r.objekt + r.datum + r.pris); if (sedd.has(k)) return false; sedd.add(k); return true; });
    return { statusCode: 200, headers: cors, body: JSON.stringify({ hamtat: new Date().toISOString(), totalt, antal: unika.length, rader: unika }) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

exports._test = { tolkaObjekt, tal };
