// netlify/functions/contacts.js
// Läser och skriver kontaktnätverket som JSON i GitHub: data/contacts.json
// Versionerat (varje ändring blir en commit) och analyserbart av chatt/agenter.
//
// GET  → returnerar { contacts: [...] }
// POST { contacts: [...] } → skriver hela listan, returnerar { ok, count, sha }
//
// Miljövariabler (Netlify):
//   GH_TOKEN = personlig access-token med repo-scope
//   GH_USER  = Jimblo72        (fallback nedan)
//   GH_REPO  = GruvanTechDasboard (fallback nedan)

const FILE_PATH = 'data/contacts.json';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const token = process.env.GH_TOKEN;
  const user = process.env.GH_USER || 'Jimblo72';
  const repo = process.env.GH_REPO || 'GruvanTechDasboard';
  if (!token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GH_TOKEN saknas i Netlify environment variables' }) };
  }

  const apiBase = `https://api.github.com/repos/${user}/${repo}/contents/${FILE_PATH}`;
  const ghHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'gruvan-dashboard',
  };

  // ── GET: hämta nuvarande lista ──────────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const r = await fetch(`${apiBase}?ref=main`, { headers: ghHeaders });
      if (r.status === 404) return { statusCode: 200, headers, body: JSON.stringify({ contacts: [] }) };
      if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
      const data = await r.json();
      const content = Buffer.from(data.content || '', 'base64').toString('utf8');
      let contacts;
      try { contacts = JSON.parse(content); } catch { contacts = []; }
      return { statusCode: 200, headers, body: JSON.stringify({ contacts }) };
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── POST: skriv hela listan ─────────────────────────────────
  if (event.httpMethod === 'POST') {
    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

    const list = payload.contacts;
    if (!Array.isArray(list)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Fältet "contacts" måste vara en array' }) };
    }

    // Lätt sanering: behåll bara kända fält, kapa längder
    const clean = list.slice(0, 2000).map(c => ({
      id: String(c.id || '').slice(0, 40),
      name: String(c.name || '').slice(0, 200),
      role: String(c.role || '').slice(0, 200),
      company: String(c.company || '').slice(0, 200),
      rel: ['strong', 'medium', 'weak'].includes(c.rel) ? c.rel : 'medium',
      email: String(c.email || '').slice(0, 200),
      phone: String(c.phone || '').slice(0, 60),
      tags: Array.isArray(c.tags) ? c.tags.slice(0, 30).map(t => String(t).slice(0, 60)) : [],
      notes: String(c.notes || '').slice(0, 4000),
    }));

    try {
      // Hämta nuvarande SHA (krävs för uppdatering; saknas → ny fil)
      let sha;
      const getR = await fetch(`${apiBase}?ref=main`, { headers: ghHeaders });
      if (getR.ok) { const d = await getR.json(); sha = d.sha; }

      const body = {
        message: `Uppdatera kontaktnätverk (${clean.length} kontakter)`,
        content: Buffer.from(JSON.stringify(clean, null, 2), 'utf8').toString('base64'),
        branch: 'main',
      };
      if (sha) body.sha = sha;

      const putR = await fetch(apiBase, {
        method: 'PUT',
        headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!putR.ok) {
        const errText = await putR.text();
        throw new Error(`GitHub HTTP ${putR.status}: ${errText.slice(0, 200)}`);
      }
      const result = await putR.json();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: clean.length, sha: result.content?.sha }) };
    } catch (e) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
