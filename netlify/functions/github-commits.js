// netlify/functions/github-commits.js
// Hämtar senaste commits för ett repo utan att exponera din token.
// Anrop: GET /.netlify/functions/github-commits?repo=maklargruvan-pilot

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
    const url = `https://api.github.com/repos/${user}/${encodeURIComponent(repo)}/commits?per_page=4`;
    const ghHeaders = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'gruvan-dashboard',
    };
    // Token används om den finns (krävs för privata repon), annars publikt
    if (token) ghHeaders['Authorization'] = `token ${token}`;

    const r = await fetch(url, { headers: ghHeaders });
    if (!r.ok) {
      const t = await r.text();
      return { statusCode: r.status, headers, body: JSON.stringify({ error: `GitHub HTTP ${r.status}: ${t.slice(0,150)}` }) };
    }
    const data = await r.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
