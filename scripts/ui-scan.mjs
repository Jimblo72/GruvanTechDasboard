// UI/UX-granskning: axe-core (deterministisk a11y) + Gemini multimodal (visuell/UX).
// Playwright renderar varje sida i två viewports, axe hittar tillgänglighetsfel,
// och skärmdumparna (desktop + mobil per sida) skickas i ETT Gemini-anrop per sida
// för bedömning av visuell hierarki, spacing och läsbarhet. Rapporterar till ett
// GitHub-issue. Rådgivande — inget auto-fixas, inget raderas.
//
// Fri Gemini-nivå har snäv bild-kvot: därför ett anrop per sida (inte per bild) +
// retry med backoff på 429. Ett schemalagt/manuellt batch-jobb får ta sin tid.
import { chromium } from "playwright";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const axeSource = require("axe-core").source;

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const BASE_URL = (process.env.TARGET_URL || "https://maklargruvan-peakfast.netlify.app").replace(/\/$/, "");
const MARKER = "<!-- gemini-ui-scan -->";
const ISSUE_TITLE = "🎨 UI/UX-granskning (axe + Gemini)";
const CI = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);

// Sidor att granska. Konfigurerbart via SCAN_PAGES ("/sökväg|Namn" kommaseparerat)
// för repos med annan sidstruktur (t.ex. dashboarden). Default = Mäklargruvan-sidorna.
const PAGES = process.env.SCAN_PAGES
  ? process.env.SCAN_PAGES.split(",").map((s) => {
      const [path, name] = s.split("|");
      return { name: (name || path).trim(), path: path.trim() };
    })
  : [
      { name: "Startsida", path: "/" },
      { name: "Sociala medier", path: "/sociala-medier.html" },
      { name: "Bild & text", path: "/text.html" },
    ];
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobil", width: 390, height: 844 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- axe-core ----------
async function runAxe(page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const res = await window.axe.run(document, { resultTypes: ["violations"] });
    return res.violations.map((v) => ({
      id: v.id, impact: v.impact || "minor", help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.length,
    }));
  });
}

// ---------- Gemini (multimodal, med retry på 429) ----------
const VISUAL_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          viewport: { type: "string", enum: ["desktop", "mobil"] },
          area: { type: "string" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["hög", "medel", "låg"] },
          suggestion: { type: "string" },
        },
        required: ["viewport", "area", "issue", "severity", "suggestion"],
      },
    },
  },
  required: ["summary", "findings"],
};

const VISUAL_SYSTEM = `Du är en erfaren UI/UX- och tillgänglighetsgranskare. Du får skärmdumpar av samma webbsida i olika viewports (desktop/mobil) samt axe-core-fynd som redan täcker maskinmätbar tillgänglighet.

Bedöm det axe INTE fångar: visuell hierarki, spacing/alignment, läsbarhet, typografi, uppenbara kontrastproblem, och mobilanpassning (avklippt innehåll, för små träffytor, horisontell scroll).

Regler:
- Sätt "viewport" på varje fynd (desktop eller mobil) utifrån vilken bild det gäller.
- Konkreta, actionable fynd. Hitta INTE på problem; en kort eller tom lista är okej om sidan ser bra ut.
- Dubblera INTE axe-fynden (de listas redan).
- Bedöm bara det du faktiskt SER i skärmdumparna. Flagga aldrig tekniska fakta du inte kan se (bibliotek, versioner, om något "existerar").
- severity: "hög" = tydligt användar-/läsbarhetsproblem; "medel"; "låg" = puts.
- Svara på svenska.`;

function parseRetryDelay(txt) {
  const m = txt.match(/"retryDelay"\s*:\s*"(\d+)s"/);
  return m ? Math.min(parseInt(m[1], 10) + 2, 65) : 55;
}

async function callGemini(parts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY saknas i miljön.");
  const body = {
    systemInstruction: { parts: [{ text: VISUAL_SYSTEM }] },
    contents: [{ role: "user", parts }],
    generationConfig: { responseMimeType: "application/json", responseSchema: VISUAL_SCHEMA, temperature: 0.3 },
  };
  for (let attempt = 0; attempt <= 4; attempt++) {
    const res = await fetch(`${API_BASE}/models/${MODEL}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 4) {
      const wait = parseRetryDelay(await res.text());
      console.error(`   429 kvot — väntar ${wait}s (försök ${attempt + 1}/4)…`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini API-fel ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    if (!text) throw new Error(`Tomt svar. promptFeedback: ${JSON.stringify(data.promptFeedback || {})}`);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("Geminis svar var inte ett giltigt objekt.");
    parsed.findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    return parsed;
  }
  throw new Error("Gemini 429-kvot kvarstod efter flera försök.");
}

async function visualReviewPage(pg, shots) {
  const parts = [{ text: `Sida: ${pg.name} (${pg.path}). Nedan följer skärmdumpar i olika viewports; ange "viewport" per fynd.` }];
  for (const s of shots) {
    const axeSummary = s.axe.length ? s.axe.map((v) => `${v.id} [${v.impact}]`).join(", ") : "inga";
    parts.push({ text: `\nViewport: ${s.vp.name} (${s.vp.width}x${s.vp.height}). axe-fynd (dubblera ej): ${axeSummary}` });
    parts.push({ inlineData: { mimeType: "image/png", data: s.png } });
  }
  return callGemini(parts);
}

// ---------- rendering ----------
const AXE_SEV = { critical: "🔴 kritisk", serious: "🟠 allvarlig", moderate: "🟡 moderat", minor: "🔵 mindre" };
const AXE_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const VIS_SEV = { hög: "🔴 hög", medel: "🟡 medel", låg: "🔵 låg" };
const VIS_ORDER = { hög: 0, medel: 1, låg: 2 };
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function renderIssue(groups, stamp) {
  const totAxe = groups.reduce((n, g) => n + g.viewports.reduce((m, v) => m + v.axe.length, 0), 0);
  const totVis = groups.reduce((n, g) => n + (g.visual.findings?.length || 0), 0);
  const L = [MARKER, `## 🎨 UI/UX-granskning (axe + Gemini ${MODEL})`, ""];
  L.push(`Skannade ${groups.length} sidor (desktop + mobil) mot ${BASE_URL}. **${totAxe}** tillgänglighetsfynd (axe-core), **${totVis}** visuella fynd (Gemini). Rådgivande — inget auto-fixas.`, "");

  for (const g of groups) {
    L.push(`### ${g.page.name}  \`${g.page.path}\``);
    if (g.visual.summary) L.push(`> ${cell(g.visual.summary)}`, "");
    if (g.err) L.push(`_Visuell granskning kunde inte köras: ${cell(g.err)}_`, "");

    for (const vw of g.viewports) {
      L.push(`**${vw.vp.name}** — ♿ axe: ${vw.axe.length ? vw.axe.length + " fynd" : "inga"}${vw.err ? `  ⚠️ ${cell(vw.err)}` : ""}`);
      if (vw.axe.length) {
        L.push("| Allvar | Regel | Beskrivning | Antal |", "|---|---|---|---|");
        for (const v of [...vw.axe].sort((a, b) => (AXE_ORDER[a.impact] ?? 9) - (AXE_ORDER[b.impact] ?? 9))) {
          L.push(`| ${AXE_SEV[v.impact] || v.impact} | [\`${cell(v.id)}\`](${v.helpUrl}) | ${cell(v.help)} | ${v.nodes} |`);
        }
      }
      const vis = (g.visual.findings || []).filter((f) => f.viewport === vw.vp.name);
      if (vis.length) {
        L.push("", `🎨 visuellt (${vw.vp.name}):`);
        L.push("| Allvar | Område | Problem | Förslag |", "|---|---|---|---|");
        for (const f of vis.sort((a, b) => (VIS_ORDER[a.severity] ?? 9) - (VIS_ORDER[b.severity] ?? 9))) {
          L.push(`| ${VIS_SEV[f.severity] || f.severity} | ${cell(f.area)} | ${cell(f.issue)} | ${cell(f.suggestion)} |`);
        }
      }
      L.push("");
    }
  }
  L.push(`<sub>axe-core = deterministisk a11y, Gemini = visuell bedömning (rådgivande). Inget auto-fixas. Senast körd: ${stamp}. · \`scripts/ui-scan.mjs\`</sub>`);
  return L.join("\n");
}

// ---------- GitHub-issue (upsert) ----------
async function ghFetch(p, opts = {}) {
  const res = await fetch(`https://api.github.com${p}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
      "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${opts.method || "GET"} ${p} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function upsertIssue(body) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const issues = await ghFetch(`/repos/${owner}/${repo}/issues?state=open&per_page=100`);
  const mine = issues.find((i) => !i.pull_request && typeof i.body === "string" && i.body.includes(MARKER));
  if (mine) {
    await ghFetch(`/repos/${owner}/${repo}/issues/${mine.number}`, { method: "PATCH", body: JSON.stringify({ body, title: ISSUE_TITLE }) });
    return `uppdaterade issue #${mine.number}`;
  }
  const created = await ghFetch(`/repos/${owner}/${repo}/issues`, { method: "POST", body: JSON.stringify({ title: ISSUE_TITLE, body }) });
  return `skapade issue #${created.number}`;
}

function writeSummary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* strunt */ }
  }
}

// ---------- main ----------
async function main() {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const browser = await chromium.launch();
  const groups = [];
  try {
    for (const pg of PAGES) {
      const shots = [];
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await context.newPage();
        const url = BASE_URL + pg.path;
        console.log(`→ ${pg.name} (${vp.name})  ${url}`);
        const shot = { vp, axe: [], png: null, err: null };
        try {
          await page.goto(url, { waitUntil: "load", timeout: 45000 });
          await page.waitForTimeout(1500);
          shot.axe = await runAxe(page);
          shot.png = (await page.screenshot({ fullPage: false })).toString("base64");
          console.log(`   axe: ${shot.axe.length}`);
        } catch (e) {
          shot.err = e.message;
          console.error(`   fel: ${e.message}`);
        }
        shots.push(shot);
        await context.close();
      }
      let visual = { summary: "", findings: [] }, gErr = null;
      const withImg = shots.filter((s) => s.png);
      if (withImg.length) {
        try {
          console.log(`   Gemini-granskar ${pg.name} (${withImg.length} bild/er)…`);
          visual = await visualReviewPage(pg, withImg);
          console.log(`   visuella fynd: ${visual.findings.length}`);
        } catch (e) { gErr = e.message; console.error(`   Gemini-fel: ${e.message}`); }
      }
      groups.push({ page: pg, visual, err: gErr, viewports: shots.map((s) => ({ vp: s.vp, axe: s.axe, err: s.err })) });
    }
  } finally {
    await browser.close();
  }

  const issueBody = renderIssue(groups, stamp);
  if (CI) {
    const action = await upsertIssue(issueBody);
    writeSummary(issueBody);
    console.log(`Klart — ${action}.`);
  } else {
    console.log("\n" + issueBody + "\n");
  }
}

main().catch((e) => {
  console.error("UI/UX-granskning misslyckades (icke-blockerande):", e.message);
  writeSummary(`### 🎨 UI/UX-granskning kunde inte köras\n\n\`${e.message}\``);
  process.exit(0);
});
