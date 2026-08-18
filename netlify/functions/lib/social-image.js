// netlify/functions/lib/social-image.js
// Tar emot ett textkort (JPEG som base64, renderat i dashboardens canvas) och
// lägger det på en PUBLIKT NÅBAR URL.
//
// VARFÖR GitHub och inte vår egen domän: Instagram Content Publishing kräver
// att MEIA kan hämta bilden själv från `image_url`. Dashboardens Netlify-domän
// är lösenordsskyddad (401) → Metas servrar kommer aldrig in. Samma insikt som
// för mailsignaturernas loggor. Bilden läggs därför i ett PUBLIKT GitHub-repo
// och serveras via raw.githubusercontent.com.
//
// raw.githubusercontent (inte jsDelivr) med flit: jsDelivr cachar aggressivt och
// kan svara 404 på en nyss commitad fil i flera minuter — vilket skulle få
// IG-publiceringen att misslyckas direkt efter att bilden skapats. raw är
// omedelbart konsistent.
//
// Miljövariabler (valfria — defaultar till dashboard-repot, som är publikt):
//   SOCIAL_IMAGE_USER / SOCIAL_IMAGE_REPO
//
// OBS: kö-filen (data/social-queue.json) bor i GH_REPO-repot, som kan vara ett
// ANNAT och privat repo. Bilder får aldrig hamna där — därför egen override.

const { writeBase64File } = require('./store');

const IMAGE_DIR = 'social-bilder';
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB råbild — ett 1080×1080-kort väger ~150 kB
const HEAD_TIMEOUT_MS = 6000;

function imageRepo() {
  return {
    user: process.env.SOCIAL_IMAGE_USER || process.env.GH_USER || 'Jimblo72',
    repo: process.env.SOCIAL_IMAGE_REPO || 'GruvanTechDasboard',
  };
}

// Filnamn härlett ur köpostens id + tidsstämpel. Tidsstämpeln gör varje
// uppladdning unik → ingen risk att Meta hämtar en cachad äldre version när en
// bild görs om.
function fileNameFor(id) {
  const safe = String(id).replace(/[^a-z0-9åäö-]+/gi, '-').replace(/-+/g, '-').slice(0, 60).replace(/^-|-$/g, '');
  return `${IMAGE_DIR}/${safe || 'kort'}-${Date.now()}.jpg`;
}

// Validerar att innehållet verkligen är en JPEG (magiska bytes FFD8FF) och inte
// för stort. Skyddar mot att endpointen används för att lägga godtyckliga filer
// i repot.
function decodeJpeg(imageBase64) {
  const raw = String(imageBase64 || '').replace(/^data:image\/jpe?g;base64,/, '').trim();
  if (!raw) throw new Error('Ingen bilddata mottagen.');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new Error('Bilddatan är inte giltig base64.');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 1024) throw new Error('Bilden är misstänkt liten — genererades kortet korrekt?');
  if (buf.length > MAX_BYTES) throw new Error(`Bilden är för stor (${Math.round(buf.length / 1024)} kB, max ${MAX_BYTES / 1024 / 1024} MB).`);
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) {
    throw new Error('Filen är inte en JPEG (Instagram kräver JPEG).');
  }
  return buf.toString('base64');
}

// Laddar upp och returnerar { url, path }. Verifierar DIREKT att URL:en är
// publikt nåbar utan inloggning — misslyckas den kontrollen skulle IG bara ge
// ett kryptiskt Meta-fel senare, så vi fångar det här i stället.
async function uploadCard(id, imageBase64, title) {
  const base64 = decodeJpeg(imageBase64);
  const path = fileNameFor(id);
  const { user, repo } = imageRepo();

  await writeBase64File(path, base64, `Sociala förslag: textkort för ${String(title || id).slice(0, 60)}`, { user, repo });
  const url = `https://raw.githubusercontent.com/${user}/${repo}/main/${path}`;

  // Publik nåbarhet (utan token) — Meta hämtar anonymt.
  let publicOk = false;
  let publicNote = '';
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
    publicOk = r.ok;
    if (!r.ok) publicNote = `HTTP ${r.status} vid publik kontroll`;
  } catch (e) {
    publicNote = e.message;
  }
  if (!publicOk) {
    throw new Error(
      `Bilden sparades men är inte publikt nåbar (${publicNote}). ` +
      `Instagram kan bara hämta bilder från publika adresser — kontrollera att repot ${user}/${repo} är publikt ` +
      `(eller peka SOCIAL_IMAGE_REPO på ett publikt repo).`
    );
  }

  return { url, path };
}

module.exports = { uploadCard, decodeJpeg, fileNameFor, imageRepo };
