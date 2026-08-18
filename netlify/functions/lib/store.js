// netlify/functions/lib/store.js
// Liten persistensfunktion: läser/skriver en JSON-fil i GitHub-repot via
// GH_TOKEN-proxyn — samma mönster som contacts.js. Det finns ingen databas;
// JSON i repot är versionerat och läsbart av chatt/agenter.
//
// Miljövariabler:
//   GH_TOKEN = personlig access-token med repo-scope
//   GH_USER  = Jimblo72              (fallback)
//   GH_REPO  = GruvanTechDasboard    (fallback)

function ghConf(override) {
  const token = process.env.GH_TOKEN;
  const user = (override && override.user) || process.env.GH_USER || 'Jimblo72';
  const repo = (override && override.repo) || process.env.GH_REPO || 'GruvanTechDasboard';
  if (!token) throw new Error('GH_TOKEN saknas i Netlify environment variables');
  return { token, user, repo };
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gruvan-dashboard',
  };
}

// Läser en JSON-fil. Returnerar { data, sha } — data=fallback om filen saknas.
async function readJsonFile(filePath, fallback = null) {
  const { token, user, repo } = ghConf();
  const apiBase = `https://api.github.com/repos/${user}/${repo}/contents/${filePath}`;
  const r = await fetch(`${apiBase}?ref=main`, { headers: ghHeaders(token) });
  if (r.status === 404) return { data: fallback, sha: null };
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status} vid läsning av ${filePath}`);
  const d = await r.json();
  const content = Buffer.from(d.content || '', 'base64').toString('utf8');
  let data;
  try { data = JSON.parse(content); } catch { data = fallback; }
  return { data, sha: d.sha };
}

// Skriver (commit) en JSON-fil. Hämtar SHA själv om det inte skickas in.
async function writeJsonFile(filePath, obj, message, sha) {
  const { token, user, repo } = ghConf();
  const apiBase = `https://api.github.com/repos/${user}/${repo}/contents/${filePath}`;
  let useSha = sha;
  if (useSha === undefined) {
    const getR = await fetch(`${apiBase}?ref=main`, { headers: ghHeaders(token) });
    if (getR.ok) { const d = await getR.json(); useSha = d.sha; }
  }
  const body = {
    message: message || `Uppdatera ${filePath}`,
    content: Buffer.from(JSON.stringify(obj, null, 2), 'utf8').toString('base64'),
    branch: 'main',
  };
  if (useSha) body.sha = useSha;

  const putR = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!putR.ok) {
    const errText = await putR.text();
    throw new Error(`GitHub HTTP ${putR.status} vid skrivning av ${filePath}: ${errText.slice(0, 200)}`);
  }
  const result = await putR.json();
  return { sha: result.content?.sha };
}

// Skriver en BINÄR fil (base64-kodad) — t.ex. ett genererat textkort som ska
// vara publikt nåbart via raw.githubusercontent.com. `override` kan peka på ett
// annat repo än kö-repot ({user, repo}), vilket behövs eftersom bilder MÅSTE
// ligga i ett publikt repo för att Meta ska kunna hämta dem vid IG-publicering.
async function writeBase64File(filePath, base64, message, override) {
  const { token, user, repo } = ghConf(override);
  const apiBase = `https://api.github.com/repos/${user}/${repo}/contents/${filePath}`;

  // Hämta ev. befintlig sha (överskrivning kräver den).
  let sha;
  const getR = await fetch(`${apiBase}?ref=main`, { headers: ghHeaders(token) });
  if (getR.ok) { const d = await getR.json(); sha = d.sha; }

  const body = { message: message || `Lägg till ${filePath}`, content: base64, branch: 'main' };
  if (sha) body.sha = sha;

  const putR = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!putR.ok) {
    const errText = await putR.text();
    throw new Error(`GitHub HTTP ${putR.status} vid skrivning av ${filePath}: ${errText.slice(0, 200)}`);
  }
  return { user, repo, path: filePath };
}

module.exports = { readJsonFile, writeJsonFile, writeBase64File };
