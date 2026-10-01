// netlify/functions/objekt-underlag-kalla.js
// Hämtar KÄLLMATERIALET för ett objektsunderlag: en eller flera mejltrådar (ren
// text) och PDF-bilagorna i dem (base64). Själva tolkningen till fält görs sedan
// i webbläsaren (js/objektsunderlag.js), som anropar Claude direkt.
//
// POST { messageId, messageIds?, mailbox? }
//   → { subject, messages:[{ ..., trad }], attachments:[{ ..., trad }], tradar:[{ nr, subject, antal }] }
//
// messageIds (högst MAX_TRADAR) låter ett underlag bygga på flera trådar, t.ex.
// kundens mejl + Holiday Clubs utdrag om andelen. messageId är alltid tråd 1.
//
// ── VARFÖR SÅ HÄR ─────────────────────────────────────────────────────────
// * Personuppgifter (namn, personnummer, kontakt) ska ALDRIG lagras här —
//   varken i datarepot, i kön eller i loggar. Funktionen läser, svarar och
//   glömmer. Inget console.log av innehåll.
// * Tolkningen av trådar + PDF:er tar längre tid än Netlifys 10 s för
//   synkrona funktioner. En bakgrundsfunktion hade krävt att resultatet
//   sparades någonstans (= personuppgifter i lagring). Därför gör webbläsaren
//   LLM-anropet, precis som Åre Strand- och andelsverktyget redan gör.
// * Brevlådan måste vara konfigurerad (samma skydd som mail-triage).
//
// Tak: högst 25 meddelanden per tråd, högst MAX_PDFS PDF:er totalt (fördelade
// jämnt över trådarna) och högst MAX_TOTAL_BYTES PDF-data (svaret får inte
// närma sig Netlifys 6 MB).

const { graphJson } = require('./lib/graph');
const { isAllowed, defaultMailbox } = require('./lib/mailboxes');
const { planAttachments, fetchPdfBytes } = require('./lib/attachments');
const { htmlToText } = require('./lib/triage');
const { encodeFilter } = require('./lib/thread');

const MAX_TRADAR = 3;
const MAX_PDFS = 6;
const MAX_TOTAL_BYTES = 3.5 * 1024 * 1024;   // rådata; base64 blir ~4,7 MB
const PER_BODY_CHARS = 6000;

function odataQuote(v) { return String(v == null ? '' : v).replace(/'/g, "''"); }

// Hela tråden som startmejlet ingår i, äldst först.
async function hamtaTrad(base, messageId) {
  const start = await graphJson(`${base}/${encodeURIComponent(messageId)}?$select=subject,conversationId`);
  const cid = start && start.conversationId;
  let msgs = [];
  if (cid) {
    // Ingen $orderby — Graph avvisar den kombinationen med conversationId-filter (se thread.js).
    const filter = `conversationId eq '${odataQuote(cid)}'`;
    const sel = 'id,subject,from,receivedDateTime,sentDateTime,body,isDraft,hasAttachments';
    const data = await graphJson(`${base}?$filter=${encodeFilter(filter)}&$select=${sel}&$top=25`);
    msgs = ((data && data.value) || []).filter(m => m && m.isDraft !== true);
  }
  if (!msgs.length) {
    const m = await graphJson(`${base}/${encodeURIComponent(messageId)}?$select=id,subject,from,receivedDateTime,body,hasAttachments`);
    msgs = [m];
  }
  msgs.sort((a, b) => new Date(a.receivedDateTime || a.sentDateTime || 0) - new Date(b.receivedDateTime || b.sentDateTime || 0));
  return { subject: (start && start.subject) || '', msgs };
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ogiltig JSON' }) }; }

  const messageId = String(payload.messageId || '').trim();
  if (!messageId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'messageId saknas' }) };
  const extra = (Array.isArray(payload.messageIds) ? payload.messageIds : [])
    .map(x => String(x || '').trim()).filter(x => x && x !== messageId);
  const ids = [messageId, ...new Set(extra)];
  if (ids.length > MAX_TRADAR) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Högst ${MAX_TRADAR} mejltrådar per underlag` }) };
  }
  const mbIn = String(payload.mailbox || '').trim();
  if (mbIn && !(await isAllowed(mbIn))) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Okänd brevlåda: ${mbIn}` }) };
  }
  const mb = mbIn || defaultMailbox().address;
  const base = `/users/${encodeURIComponent(mb)}/messages`;
  const mbLower = mb.toLowerCase();

  try {
    // 1. Trådarna parallellt. Två valda mejl i samma tråd blir en tråd.
    const rader = await Promise.all(ids.map(id => hamtaTrad(base, id)));
    const sedda = new Set();
    const tradar = [];
    const messages = [];
    rader.forEach(({ subject, msgs }) => {
      const nya = msgs.filter(m => m && m.id && !sedda.has(m.id));
      if (!nya.length) return;
      nya.forEach(m => sedda.add(m.id));
      const nr = tradar.length + 1;
      tradar.push({ nr, subject, antal: nya.length });
      for (const m of nya) {
        const addr = String(m.from?.emailAddress?.address || '');
        let text = htmlToText(m.body?.content || '', m.body?.contentType);
        if (text.length > PER_BODY_CHARS) text = text.slice(0, PER_BODY_CHARS) + '…';
        messages.push({
          id: m.id,
          trad: nr,
          when: m.receivedDateTime || m.sentDateTime || '',
          from: addr.toLowerCase() === mbLower ? 'Jimmy (mäklaren)' : (m.from?.emailAddress?.name || addr),
          fromAddress: addr,
          subject: m.subject || '',
          text,
          hasAttachments: !!m.hasAttachments,
        });
      }
    });

    // 2. PDF-bilagor — nyast först inom varje tråd, och turvis mellan trådarna
    // så att varje tråd får plats (ett Holiday Club-utdrag ska inte trängas ut
    // av bilagorna i kundens tråd).
    const withAtt = messages.filter(m => m.hasAttachments).reverse();
    const lists = await Promise.all(withAtt.map(m =>
      graphJson(`${base}/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size,isInline`)
        .then(d => ({ m, list: (d && d.value) || [] }))
        .catch(() => ({ m, list: [] }))
    ));
    const perTrad = new Map();
    for (const { m, list } of lists) {
      for (const p of planAttachments(list, { maxPdfs: MAX_PDFS })) {
        const entry = { name: p.name, contentType: p.contentType, size: p.size, messageWhen: m.when, from: m.from, trad: m.trad, data: null, skipped: p.skipped };
        if (!perTrad.has(m.trad)) perTrad.set(m.trad, []);
        perTrad.get(m.trad).push({ entry, read: p.read, messageId: m.id, attId: p.id });
      }
    }
    const turordning = [];
    const kolumner = [...perTrad.keys()].sort((a, b) => a - b).map(k => perTrad.get(k));
    for (let i = 0; kolumner.some(k => i < k.length); i++) {
      for (const k of kolumner) if (i < k.length) turordning.push(k[i]);
    }
    const attachments = [];
    let pdfs = 0, bytes = 0;
    const toFetch = [];
    for (const { entry, read, messageId: mid, attId } of turordning) {
      if (read) {
        if (pdfs >= MAX_PDFS) entry.skipped = `max ${MAX_PDFS} PDF:er per underlag`;
        else if (bytes + entry.size > MAX_TOTAL_BYTES) entry.skipped = 'ryms inte (total storlek)';
        else { pdfs++; bytes += entry.size; toFetch.push({ entry, messageId: mid, attId }); }
      }
      attachments.push(entry);
    }
    await Promise.all(toFetch.map(async ({ entry, messageId: mid, attId }) => {
      try { entry.data = await fetchPdfBytes(mb, mid, attId); }
      catch (e) { entry.skipped = 'kunde inte hämtas'; }
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ mailbox: mb, subject: (tradar[0] && tradar[0].subject) || '', tradar, messages, attachments }),
    };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: `Kunde inte läsa tråden: ${e.message}` }) };
  }
};
