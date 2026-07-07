// Kodstädning: kör knip (deterministisk dödkodsanalys), greppar varje fynd för
// referenser knip inte ser (strängbaserad require, property-access, <script src>,
// onclick), och låter Gemini TOLKA fynden — aldrig besluta om radering.
//
// Zero-dep (Node 20+). CI-läge upsertar ett GitHub-issue; lokalt skriver till konsolen.
// Trigger i CI: manuellt (workflow_dispatch) eller schemalagt. Inget raderas automatiskt.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MARKER = "<!-- gemini-cleanup-scan -->";
const ISSUE_TITLE = "🧹 Kodstädning (knip + Gemini)";
const CI = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

// ---------- kör knip ----------
function runKnip() {
  try {
    const out = execSync("npx --yes knip@5 --reporter json", {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"], // dölj knips stderr-varningar
    });
    return JSON.parse(out);
  } catch (e) {
    // knip avslutar med kod 1 när det finns fynd — JSON:en ligger i stdout ändå.
    if (e.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* faller igenom */ }
    }
    throw new Error("Kunde inte köra/tolka knip: " + (e.message || "okänt fel"));
  }
}

// ---------- samla fynd ----------
function collectFindings(knip) {
  const out = [];
  for (const file of knip.files || []) {
    out.push({ kind: "oanvänd-fil", file, symbol: path.basename(file) });
  }
  for (const iss of knip.issues || []) {
    for (const e of iss.exports || []) out.push({ kind: "oanvänd-export", file: iss.file, symbol: e.name, line: e.line });
    for (const t of iss.types || []) out.push({ kind: "oanvänd-typ", file: iss.file, symbol: t.name, line: t.line });
    for (const d of iss.dependencies || []) out.push({ kind: "oanvänt-beroende", file: iss.file, symbol: typeof d === "string" ? d : d.name });
    for (const d of iss.devDependencies || []) out.push({ kind: "oanvänt-devberoende", file: iss.file, symbol: typeof d === "string" ? d : d.name });
    for (const u of iss.unlisted || []) out.push({ kind: "olistat-beroende", file: iss.file, symbol: typeof u === "string" ? u : u.name });
  }
  return out.filter((f) => f.symbol);
}

// ---------- grep-kontext (fångar dynamiska referenser knip inte ser) ----------
function grepContext(finding) {
  const args = finding.kind === "oanvänd-fil"
    ? ["grep", "-n", "-F", "--", finding.symbol] // filnamn: fast sträng (<script src>)
    : ["grep", "-n", "-w", "--", finding.symbol]; // identifierare: ordgräns
  try {
    return git(args).split("\n").filter(Boolean).slice(0, 25);
  } catch {
    return []; // git grep ger exit 1 vid noll träffar
  }
}

// ---------- Gemini ----------
const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          file: { type: "string" },
          classification: { type: "string", enum: ["dead", "needless-export", "maybe-dynamic", "keep"] },
          action: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["symbol", "file", "classification", "action", "rationale"],
      },
    },
  },
  required: ["summary", "items"],
};

const SYSTEM = `Du tolkar resultat från kodstädningsverktyget knip. knip listar potentiellt oanvänd kod men SER INTE dynamiska referenser (strängbaserad require, property-access, <script src>, onclick, event-baserade anrop). Din uppgift är att KLASSIFICERA varje fynd utifrån den bifogade grep-kontexten — inte att besluta om radering.

Sätt "classification" för varje fynd:
- "dead": symbolen används ingenstans (grep visar bara definitionen + export-/deklarationsraden). Säker att ta bort helt.
- "needless-export": symbolen ANVÄNDS internt i sin egen fil (grep visar ett anrop på annan rad än module.exports/export) men importeras ingen annanstans. Ta bort den ur exporterna — men RADERA ALDRIG funktionen, den behövs internt.
- "maybe-dynamic": grep visar textuella referenser som kan vara dynamiska (sträng, property, <script src>, onclick). Granska manuellt innan något rörs.
- "keep": troligt falskt positivt (t.ex. avsiktligt publikt API, plugin-krok).

Regler:
- Grunda klassificeringen HÅRT på grep-kontexten, inte gissningar.
- Föreslå ALDRIG att radera en funktion/variabel som anropas internt — det är "needless-export".
- "action" = en konkret, säker åtgärd på svenska.
- Svara på svenska.`;

function buildPrompt(findings) {
  const parts = ["Klassificera följande knip-fynd. För varje ges grep-kontext (git grep över spårade filer).\n"];
  findings.forEach((f, i) => {
    parts.push(`### ${i + 1}. ${f.kind}: ${f.symbol}${f.file ? `  (${f.file}${f.line ? ":" + f.line : ""})` : ""}`);
    const ctx = f.grep && f.grep.length ? f.grep.join("\n") : "(inga textuella träffar)";
    parts.push("grep-kontext:\n```\n" + ctx + "\n```\n");
  });
  return parts.join("\n");
}

async function interpret(findings) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY saknas i miljön.");
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: buildPrompt(findings) }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2 },
  };
  const res = await fetch(`${API_BASE}/models/${MODEL}:generateContent?key=${key}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini API-fel ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error(`Tomt svar från Gemini. promptFeedback: ${JSON.stringify(data.promptFeedback || {})}`);
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("Geminis svar var inte ett giltigt objekt.");
  parsed.items = Array.isArray(parsed.items) ? parsed.items : [];
  return parsed;
}

// ---------- rendering ----------
const CLASS = { dead: "🔴 död kod", "needless-export": "🟡 onödig export", "maybe-dynamic": "🔵 möjlig dyn. ref", keep: "⚪ behåll" };
const CLASS_ORDER = { dead: 0, "needless-export": 1, "maybe-dynamic": 2, keep: 3 };

function renderIssue(result, stamp) {
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [MARKER, `## 🧹 Kodstädning (knip + Gemini ${MODEL})`, "", result.summary || "", ""];
  const items = [...result.items].sort((a, b) => (CLASS_ORDER[a.classification] ?? 9) - (CLASS_ORDER[b.classification] ?? 9));
  if (items.length) {
    lines.push("| Klassificering | Symbol | Fil | Åtgärd | Motivering |", "|---|---|---|---|---|");
    for (const it of items) {
      lines.push(`| ${CLASS[it.classification] || it.classification} | \`${cell(it.symbol)}\` | \`${cell(it.file)}\` | ${cell(it.action)} | ${cell(it.rationale)} |`);
    }
  } else {
    lines.push("_Inga fynd att åtgärda._");
  }
  lines.push("", `<sub>knip hittar, Gemini tolkar. **Inget raderas automatiskt** — granska och skapa ev. städ-PR själv. Senast körd: ${stamp}. · \`scripts/cleanup-scan.mjs\`</sub>`);
  return lines.join("\n");
}

// ---------- GitHub-issue (upsert) ----------
async function ghFetch(p, opts = {}) {
  const res = await fetch(`https://api.github.com${p}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
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
  console.log("Kör knip…");
  const knip = runKnip();
  const findings = collectFindings(knip);
  console.log(`knip: ${findings.length} potentiella fynd.`);

  if (!findings.length) {
    const msg = "🧹 Kodstädning: knip hittade inga oanvända filer, exporter eller beroenden. Rent.";
    console.log(msg);
    writeSummary(msg);
    return;
  }

  for (const f of findings) f.grep = grepContext(f);
  console.log(`Tolkar med ${MODEL}…`);
  const result = await interpret(findings);
  const issueBody = renderIssue(result, stamp);

  if (CI) {
    const action = await upsertIssue(issueBody);
    writeSummary(issueBody);
    console.log(`Klart — ${action}. ${result.items.length} klassificerade fynd.`);
  } else {
    console.log("\n" + issueBody + "\n");
  }
}

main().catch((e) => {
  console.error("Kodstädning misslyckades (icke-blockerande):", e.message);
  writeSummary(`### 🧹 Kodstädning kunde inte köras\n\n\`${e.message}\``);
  process.exit(0);
});
