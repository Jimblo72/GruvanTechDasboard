// netlify/functions/lib/social-meta.js
// Meta-publicering för Mäklargruvans EGNA sidor (Gruvan Techs kanaler) — inte
// att förväxla med pilotens meta-publish.js där KUNDER ansluter sina sidor via
// OAuth. Här används i stället Business Managerns systemanvändare
// (mg-adsserver), vars token sätts som Netlify-env och aldrig går ut till
// klienten.
//
// Mönstret är bevisat i Fas 0 (managed ads, 2026-08-10): systemanvändaren
// måste ha sidan TILLDELAD (har den: Innehåll/Annonser/Statistik), och New
// Page Experience-sidor kräver att man publicerar med SID-token — därför
// härleds page access token ur systemanvändartoken vid varje publicering
// (GET /{page-id}?fields=access_token).
//
// Miljövariabler:
//   META_MG_SYSTEM_TOKEN  systemanvändartoken (hemlig; genereras av Jimmy i
//                         Business Settings → Systemanvändare → mg-adsserver)
//   META_MG_PAGE_ID       valfri override; default Mäklargruvan-sidan
//   META_MG_IG_ID         valfri override; default @maklargruvan
//
// Instagram: KRÄVER bild (image_url) och att IG-kontot är tilldelat
// systemanvändaren (kontrollerat 2026-08-17: INTE gjort än). IG-vägen ligger
// därför vilande tills bildmotorn finns — publishToInstagram anropas bara när
// en köpost faktiskt bär en bild-URL.

const GRAPH = 'https://graph.facebook.com/v25.0';
const DEFAULT_PAGE_ID = '1095768663623009';   // Facebook-sidan Mäklargruvan
const DEFAULT_IG_ID = '17841446151311056';    // @maklargruvan (IG Business)
const FETCH_TIMEOUT_MS = 8000;

function metaConfigured() {
  return !!process.env.META_MG_SYSTEM_TOKEN;
}

function pageId() { return process.env.META_MG_PAGE_ID || DEFAULT_PAGE_ID; }
function igId() { return process.env.META_MG_IG_ID || DEFAULT_IG_ID; }

// Normaliserar Graph-fel till läsbara meddelanden (Graph svarar 200-4xx med
// { error: { message, code, ... } }). Token/behörighetsfel ska synas klart i
// dashboarden — inte som "HTTP 400".
async function graphJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  let data = null;
  try { data = await r.json(); } catch (_) { /* icke-JSON-svar hanteras nedan */ }
  if (!r.ok || (data && data.error)) {
    const ge = data && data.error;
    const msg = ge
      ? `Graph ${ge.code || r.status}: ${ge.message || 'okänt fel'}`
      : `Graph HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.graphCode = ge && ge.code;
    throw err;
  }
  return data || {};
}

// Systemanvändartoken → sid-token. Kräver att sidan är tilldelad
// systemanvändaren och att appen har pages_manage_posts.
async function getPageToken() {
  const sysToken = process.env.META_MG_SYSTEM_TOKEN;
  if (!sysToken) throw new Error('META_MG_SYSTEM_TOKEN saknas i Netlify environment variables');
  const d = await graphJson(`${GRAPH}/${pageId()}?fields=access_token&access_token=${encodeURIComponent(sysToken)}`);
  if (!d.access_token) throw new Error('Sidan gav ingen access_token — är sidan tilldelad systemanvändaren med Innehålls-behörighet?');
  return d.access_token;
}

// Publicerar ett inlägg på Facebook-sidan. Text-only via /feed; med bild via
// /photos (bilden hämtas av Meta från URL:en — måste vara publikt nåbar).
// Returnerar { postId, url }.
async function publishToFacebook(text, imageUrl) {
  const pageToken = await getPageToken();
  let d;
  if (imageUrl) {
    d = await graphJson(`${GRAPH}/${pageId()}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: imageUrl, caption: text, access_token: pageToken }),
    });
  } else {
    d = await graphJson(`${GRAPH}/${pageId()}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, access_token: pageToken }),
    });
  }
  // /feed ger { id: "pageid_postid" }; /photos ger { id, post_id }.
  const postId = d.post_id || d.id;
  if (!postId) throw new Error('Publiceringen gav inget inläggs-id — kontrollera sidan manuellt innan du försöker igen.');
  return { postId, url: `https://www.facebook.com/${postId}` };
}

// Steg 1 av IG-publiceringen: skapa media-container. Det är HÄR allt som kan
// vara fel visar sig — token, att IG-kontot är tilldelat systemanvändaren, och
// att Meta faktiskt kan HÄMTA bild-URL:en (den måste vara publik).
// En container som aldrig publiceras syns inte utåt och förfaller av sig själv,
// vilket gör detta till en ofarlig torrkörning av hela kedjan.
async function createIgContainer(imageUrl, caption) {
  if (!imageUrl) throw new Error('Instagram kräver bild — ingen bild-URL på posten.');
  const pageToken = await getPageToken();
  const c = await graphJson(`${GRAPH}/${igId()}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: pageToken }),
  });
  if (!c.id) throw new Error('Instagram gav ingen media-container.');
  return { containerId: c.id, pageToken };
}

// Torrkörning: skapar container och publicerar den ALDRIG. Bevisar att
// IG-vägen fungerar utan att något hamnar på kontot.
async function testInstagram(imageUrl, caption) {
  const { containerId } = await createIgContainer(imageUrl, caption);
  return { containerId, published: false };
}

// Instagram-publicering (tvåstegs: media-container → media_publish). KRÄVER
// bild; anropas bara när köposten bär en imageUrl.
async function publishToInstagram(imageUrl, caption) {
  const { containerId, pageToken } = await createIgContainer(imageUrl, caption);
  const p = await graphJson(`${GRAPH}/${igId()}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: containerId, access_token: pageToken }),
  });
  if (!p.id) throw new Error('Instagram publicerade inte containern — kontrollera kontot manuellt innan du försöker igen.');
  return { mediaId: p.id, url: 'https://www.instagram.com/maklargruvan/' };
}

module.exports = {
  metaConfigured,
  getPageToken,
  publishToFacebook,
  publishToInstagram,
  createIgContainer,
  testInstagram,
};
