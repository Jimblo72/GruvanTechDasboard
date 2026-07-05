// netlify/functions/github-issues.js
// Hämtar öppna granskningsissues (ui-scan / cleanup) för ett repo — utan att exponera token.
// Anrop: GET /.netlify/functions/github-issues?repo=Maklargruvan-PeakFast
//
// Läser bara (repo-scope räcker). Trigga-delen (workflow_dispatch) är en separat
// funktion som kräver att GH_TOKEN även har workflow-scope.

const MARKERS = ['gemini-ui-scan', 'gemini-cleanup-scan'];

// Första substantiella raden med en siffra = kort sammanfattning (t.ex.
// "Skannade 3 sidor ... 29 tillgänglighetsfynd, 9 visuella fynd").
function summarize(body) {
  for (const raw of (body || '').split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('<') || l.startsWith('#') || l.startsWith('|') || l.startsWith('>')) continue;
    return l.replace(/\*\*/g, '').replace(/`/g, '').slice(0, 180);
  }
  return '';
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const repo = event.queryStringParameters?.repo;
  const user = process.env.GH_USER || 'Jimblo72';
  const token = process.env.GH_TOKEN;

  if (!repo) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'repo krävs' }) };
  }

  try {
    const url = `https://api.github.com/repos/${user}/${encodeURIComponent(repo)}/issues?state=open&per_page=50`;
    const ghHeaders = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'gruvan-dashboard' };
    if (token) ghHeaders['Authorization'] = `token ${token}`;

    const r = await fetch(url, { headers: ghHeaders });
    if (!r.ok) {
      const t = await r.text();
      return { statusCode: r.status, headers, body: JSON.stringify({ error: `GitHub HTTP ${r.status}: ${t.slice(0, 150)}` }) };
    }
    const data = await r.json();

    // issues-endpointen tar med PR:er — filtrera bort dem. Flagga granskningsissues.
    const issues = (Array.isArray(data) ? data : [])
      .filter((i) => !i.pull_request)
      .map((i) => {
        const body = i.body || '';
        const isReview = MARKERS.some((m) => body.includes(m));
        const kind = body.includes('gemini-ui-scan') ? 'ui' : body.includes('gemini-cleanup-scan') ? 'cleanup' : 'other';
        return { number: i.number, title: i.title, url: i.html_url, updated_at: i.updated_at, isReview, kind, summary: isReview ? summarize(body) : '' };
      });

    return { statusCode: 200, headers, body: JSON.stringify({ issues }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
