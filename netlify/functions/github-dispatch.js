// netlify/functions/github-dispatch.js
// Triggar en granskningsworkflow (workflow_dispatch) på ett repo.
// Anrop: POST {repo, workflow}  — t.ex. {repo:'Maklargruvan-PeakFast', workflow:'cleanup.yml'}
//
// KRÄVER att GH_TOKEN har workflow-scope (utöver repo). Utan det ger GitHub 403.
// Skydd: bara vår egen whitelist av granskningsworkflows får triggas — aldrig godtycklig.

const ALLOWED = ['cleanup.yml', 'ui-scan.yml', 'ai-review.yml'];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = process.env.GH_TOKEN;
  const user = process.env.GH_USER || 'Jimblo72';
  if (!token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GH_TOKEN saknas' }) };
  }

  let p;
  try { p = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

  const { repo, workflow, ref = 'main' } = p;
  if (!repo || !workflow) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'repo och workflow krävs' }) };
  }
  if (!ALLOWED.includes(workflow)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'workflow ej tillåten' }) };
  }

  try {
    const url = `https://api.github.com/repos/${user}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'gruvan-dashboard', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    });
    if (r.status === 204) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, started: workflow }) };
    }
    const t = await r.text();
    // 403 = trolig avsaknad av workflow-scope på token
    return { statusCode: r.status, headers, body: JSON.stringify({ error: `GitHub HTTP ${r.status}: ${t.slice(0, 150)}`, needsScope: r.status === 403 }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
