// netlify/functions/github-file.js
// Hämtar innehållet i en fil från ett privat eller publikt GitHub-repo
// utan att exponera din token i frontend.
//
// SÄTT I NETLIFY → Environment variables:
//   GH_TOKEN  = ghp_...   (en NY token — den gamla i v7 var exponerad, återkalla den)
//   GH_USER   = Jimblo72
//
// Anrop: GET /.netlify/functions/github-file?repo=maklargruvan-pilot&path=index.html

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const repo = event.queryStringParameters?.repo;
  const path = event.queryStringParameters?.path;
  const user = process.env.GH_USER || 'Jimblo72';
  const token = process.env.GH_TOKEN;

  if (!repo || !path) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'repo och path krävs' }) };
  }
  if (!token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GH_TOKEN saknas i Netlify environment variables' }) };
  }

  try {
    const url = `https://api.github.com/repos/${user}/${encodeURIComponent(repo)}/contents/${path}`;
    const r = await fetch(url, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'gruvan-dashboard',
      },
    });
    if (!r.ok) {
      const t = await r.text();
      return { statusCode: r.status, headers, body: JSON.stringify({ error: `GitHub HTTP ${r.status}: ${t.slice(0,150)}` }) };
    }
    const data = await r.json();
    // GitHub returnerar base64-kodat innehåll
    const content = data.content
      ? Buffer.from(data.content, 'base64').toString('utf-8')
      : '';
    return { statusCode: 200, headers, body: JSON.stringify({ content, path, sha: data.sha }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
