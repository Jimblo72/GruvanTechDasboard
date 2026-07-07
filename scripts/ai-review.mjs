// AI-granskning av en pull request-diff med Gemini.
//
// Zero-dependency (Node 20+ global fetch). Två lägen:
//   * CI-läge (GitHub Actions): postar/uppdaterar en PR-kommentar med fynden.
//   * Lokalt läge: skriver fynden till konsolen. Kör:  node scripts/ai-review.mjs [base]
//
// Skickar ENDAST diffen (inte hela kodbasen) till Gemini — precision, inte kontextfönster.
// Rådgivande: ingen auto-merge, inget block. Jimmy granskar och bestämmer.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_DIFF_CHARS = 60000; // klipp enorma diffar — skydda kostnad och fokus
const MARKER = "<!-- gemini-ai-review -->"; // för att hitta+uppdatera egen kommentar

const CI = !!(process.env.GITHUB_TOKEN && process.env.PR_NUMBER && process.env.GITHUB_REPOSITORY);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// ---------- .aiignore ----------
function loadMatchers() {
  const patterns = [
    "node_modules/", "package-lock.json", "*.min.js", "*.map",
    "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.ico", "*.svg", "*.pdf", "*.zip",
  ];
  try {
    for (const line of fs.readFileSync(".aiignore", "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) patterns.push(t);
    }
  } catch { /* .aiignore är valfri */ }
  return patterns.map(makeMatcher);
}
function makeMatcher(pattern) {
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1);
    return (f) => f === dir || f.startsWith(dir + "/") || f.includes("/" + dir + "/");
  }
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1);
    return (f) => f.endsWith(ext);
  }
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join("[^/]*") + "$");
  return (f) => re.test(f) || f.split("/").pop() === pattern;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- diff ----------
function getDiff() {
  const base = CI ? process.env.BASE_SHA : (process.argv[2] || "origin/main");
  const range = `${base}...HEAD`;
  const files = git(["diff", "--name-only", range]).split("\n").filter(Boolean);
  const matchers = loadMatchers();
  const kept = files.filter((f) => !matchers.some((m) => m(f)));
  const skipped = files.filter((f) => matchers.some((m) => m(f)));
  let diff = kept.length ? git(["diff", "--unified=3", range, "--", ...kept]) : "";
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    // Klipp vid sista radbrytningen inom gränsen så ingen rad/hunk-huvud halveras.
    const cut = diff.lastIndexOf("\n", MAX_DIFF_CHARS);
    diff = diff.slice(0, cut > 0 ? cut : MAX_DIFF_CHARS);
    truncated = true;
  }
  return { base, kept, skipped, diff, truncated };
}

// ---------- Gemini ----------
const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          issue: { type: "string" },
          severity: { type: "string", enum: ["critical", "moderate", "nice-to-have"] },
          evidence: { type: "string", enum: ["reasoning", "static_analysis", "execution"] },
          suggestion: { type: "string" },
        },
        required: ["file", "issue", "severity", "evidence", "suggestion"],
      },
    },
    verdict: { type: "string", enum: ["ship", "revise", "reconsider"] },
  },
  required: ["summary", "findings", "verdict"],
};

const SYSTEM = `Du är en noggrann kodgranskare. Du får en unified diff från en pull request och granskar ENDAST det som ändrats.

Fokusera på: buggar och logikfel som ändringen inför, säkerhet (injektion, auth, exponerade hemligheter, DoS), missad felhantering/edge-cases, riskabla mönster (race conditions, resursläckor).

Regler:
- Granska bara ändrad kod (+-rader). Kommentera inte oförändrad kod.
- En linter (ESLint) kör redan — hoppa över ren stil/formatering.
- Hitta INTE på problem för att verka användbar. En tom findings-lista är ett giltigt svar om diffen är sund.
- Flagga ALDRIG modellnamn, API-/biblioteksversioner eller om en modell/tjänst "existerar" som fel — din träningsdata kan vara föråldrad och du kan inte verifiera vad som finns idag. Granska kodens logik och beteende, inte faktapåståenden om externa versioner.
- severity: "critical" = bug/säkerhetshål som bör stoppa merge; "moderate" = bör åtgärdas; "nice-to-have" = förbättring.
- evidence: "reasoning" (du kör ingen kod). Använd "static_analysis" bara om verktygsutdata bifogats.
- Ange "file" och om möjligt "line" utifrån nya filens radnummer (läs hunk-huvudet @@ -a,b +c,d @@ och räkna från c).
- Varje fynd ska ha ett konkret "suggestion".
- verdict: "ship" (inget kritiskt), "revise" (moderata problem), "reconsider" (allvarliga fel).
- Svara på svenska.`;

async function review(diff) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY saknas i miljön.");
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: "Unified diff att granska:\n\n" + diff }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0.3,
    },
  };
  const res = await fetch(`${API_BASE}/models/${MODEL}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini API-fel ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error(`Tomt svar från Gemini. promptFeedback: ${JSON.stringify(data.promptFeedback || {})}`);
  const parsed = JSON.parse(text);
  parsed.findings = Array.isArray(parsed.findings) ? parsed.findings : [];
  parsed.has_critical = parsed.findings.some((f) => f.severity === "critical");
  return parsed;
}

// ---------- rendering ----------
const SEV = { critical: "🔴 kritisk", moderate: "🟡 moderat", "nice-to-have": "🔵 förslag" };
const VERDICT = { ship: "Klar att merga", revise: "Bör åtgärdas", reconsider: "Ompröva" };
const SEV_ORDER = { critical: 0, moderate: 1, "nice-to-have": 2 };

function renderComment(r, meta) {
  const lines = [];
  lines.push(MARKER);
  lines.push(`## 🤖 AI-granskning (Gemini ${MODEL})`);
  lines.push("");
  lines.push(r.summary || "");
  lines.push("");
  const crit = r.findings.filter((f) => f.severity === "critical").length;
  lines.push(`**Omdöme:** ${VERDICT[r.verdict] || r.verdict} · ${r.findings.length} fynd${crit ? ` (${crit} kritiska)` : ""}`);
  lines.push("");
  if (r.findings.length) {
    lines.push("| Allvar | Fil | Rad | Problem | Förslag |");
    lines.push("|---|---|---|---|---|");
    for (const f of [...r.findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))) {
      const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${SEV[f.severity] || f.severity} | \`${cell(f.file)}\` | ${f.line ?? "–"} | ${cell(f.issue)} | ${cell(f.suggestion)} |`);
    }
  } else {
    lines.push("_Inga anmärkningar på ändringarna._");
  }
  lines.push("");
  const notes = [];
  if (meta.truncated) notes.push("⚠️ Diffen var stor och klipptes — delar granskades inte.");
  if (meta.skipped.length) notes.push(`${meta.skipped.length} fil(er) hoppades över via .aiignore.`);
  notes.push("Rådgivande. Ingen auto-merge — du bestämmer.");
  lines.push(`<sub>${notes.join(" · ")} · \`scripts/ai-review.mjs\`</sub>`);
  return lines.join("\n");
}

// ---------- GitHub-kommentar (upsert) ----------
async function ghFetch(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${opts.method || "GET"} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function upsertComment(body) {
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const pr = process.env.PR_NUMBER;
  const existing = await ghFetch(`/repos/${owner}/${repo}/issues/${pr}/comments?per_page=100`);
  const mine = existing.find((c) => typeof c.body === "string" && c.body.includes(MARKER));
  if (mine) {
    await ghFetch(`/repos/${owner}/${repo}/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    return "uppdaterade";
  }
  await ghFetch(`/repos/${owner}/${repo}/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  return "skapade";
}

function writeSummary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* ignen */ }
  }
}

// ---------- main ----------
async function main() {
  const meta = getDiff();
  if (!meta.diff.trim()) {
    console.log(`Inget att granska (bas: ${meta.base}, ${meta.skipped.length} fil(er) ignorerade).`);
    return;
  }
  console.log(`Granskar ${meta.kept.length} fil(er) mot ${meta.base} med ${MODEL}…`);
  const r = await review(meta.diff);
  const comment = renderComment(r, meta);

  if (CI) {
    const action = await upsertComment(comment);
    writeSummary(comment);
    console.log(`PR-kommentar ${action}. ${r.findings.length} fynd, has_critical=${r.has_critical}.`);
  } else {
    console.log("\n" + comment + "\n");
    console.log(JSON.stringify(r, null, 2));
  }
}

main().catch((e) => {
  // Blockera aldrig en PR för att AI:n är nere — logga och gå vidare.
  console.error("AI-granskning misslyckades (icke-blockerande):", e.message);
  writeSummary(`### 🤖 AI-granskning kunde inte köras\n\n\`${e.message}\``);
  process.exit(0);
});
