// netlify/functions/github-write.js
// Lägger till en feature-punkt i en handoff-fil och committar tillbaka till GitHub.
// Läser nuvarande fil, infogar raden under "## Planerat att bygga", committar.
//
// SÄTT I NETLIFY → Environment variables:
//   GH_TOKEN     = ghp_...   (NY token med repo-skrivrättigheter)
//   GH_USER      = Jimblo72
//   GH_REPO      = GruvanTechDasboard
//   WRITE_SECRET = <valfri hemlig sträng — måste matcha den i dashboarden>
//
// Skyddet: dashboarden måste skicka rätt WRITE_SECRET i headern, annars 401.
// Det hindrar att vem som helst som hittar din Netlify-URL kan skriva till repot.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Write-Secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Skyddskontroll
  const secret = process.env.WRITE_SECRET;
  const provided = event.headers['x-write-secret'] || event.headers['X-Write-Secret'];
  if (secret && provided !== secret) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Ogiltig skrivtoken' }) };
  }

  const token = process.env.GH_TOKEN;
  const user = process.env.GH_USER || 'Jimblo72';
  const repo = process.env.GH_REPO;
  if (!token || !repo) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GH_TOKEN eller GH_REPO saknas i environment variables' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

  const { appId, title, desc } = payload;
  if (!appId || !title) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'appId och title krävs' }) };
  }

  const path = `handoffs/${appId}.md`;
  const apiBase = `https://api.github.com/repos/${user}/${repo}/contents/${path}`;
  const ghHeaders = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'gruvan-dashboard',
    'Content-Type': 'application/json',
  };

  try {
    // 1. Hämta nuvarande fil (för innehåll + sha)
    const getRes = await fetch(apiBase, { headers: ghHeaders });
    if (!getRes.ok) {
      const t = await getRes.text();
      return { statusCode: getRes.status, headers, body: JSON.stringify({ error: `Kunde inte läsa fil: HTTP ${getRes.status} ${t.slice(0,120)}` }) };
    }
    const fileData = await getRes.json();
    const current = Buffer.from(fileData.content, 'base64').toString('utf-8');

    // 2. Infoga ny rad under "## Planerat att bygga"
    const newLine = `- [ ] **${title.trim()}**${desc && desc.trim() ? ` — ${desc.trim()}` : ''}`;
    const marker = '## Planerat att bygga';
    let updated;
    const idx = current.indexOf(marker);
    if (idx === -1) {
      // Marker saknas — lägg till sektion i slutet
      updated = current + `\n\n${marker}\n\n${newLine}\n`;
    } else {
      // Hitta första radslut efter markern + ev. tom rad, infoga som sista punkt i listan
      const afterMarker = idx + marker.length;
      // hitta nästa "## " efter markern (nästa sektion) eller slutet
      const nextSection = current.indexOf('\n## ', afterMarker);
      const sectionEnd = nextSection === -1 ? current.length : nextSection;
      const before = current.slice(0, sectionEnd).replace(/\s*$/, '');
      const after = current.slice(sectionEnd);
      updated = before + '\n' + newLine + '\n' + after;
    }

    // 3. Uppdatera även "updated:"-datumet i frontmatter
    const today = new Date().toISOString().slice(0,10);
    updated = updated.replace(/^updated:.*$/m, `updated: ${today}`);

    // 4. Committa tillbaka
    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify({
        message: `dashboard: lägg till "${title.trim()}" i ${appId}`,
        content: Buffer.from(updated, 'utf-8').toString('base64'),
        sha: fileData.sha,
      }),
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      return { statusCode: putRes.status, headers, body: JSON.stringify({ error: `Kunde inte committa: HTTP ${putRes.status} ${t.slice(0,120)}` }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, added: newLine }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
