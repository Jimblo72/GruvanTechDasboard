// netlify/functions/github-prs.js
// Listar öppna pull requests över alla Jimmys repon (via GitHub search) — utan
// exponerad token. Ett anrop täcker alla repon (även privata, med token).
// Anrop: GET /.netlify/functions/github-prs

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const user = process.env.GH_USER || 'Jimblo72';
  const token = process.env.GH_TOKEN;

  try {
    const q = encodeURIComponent(`is:open is:pr user:${user} archived:false`);
    const url = `https://api.github.com/search/issues?q=${q}&per_page=50&sort=updated&order=desc`;
    const ghHeaders = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'gruvan-dashboard' };
    if (token) ghHeaders['Authorization'] = `token ${token}`;

    const r = await fetch(url, { headers: ghHeaders });
    if (!r.ok) {
      const t = await r.text();
      return { statusCode: r.status, headers, body: JSON.stringify({ error: `GitHub HTTP ${r.status}: ${t.slice(0, 150)}` }) };
    }
    const data = await r.json();
    const prs = (data.items || []).map((i) => ({
      number: i.number,
      title: i.title,
      url: i.html_url,
      updated_at: i.updated_at,
      draft: !!i.draft,
      repo: (i.repository_url || '').split('/').pop(),
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ total: data.total_count || prs.length, prs }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
