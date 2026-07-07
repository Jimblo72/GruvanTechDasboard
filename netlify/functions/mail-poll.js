// netlify/functions/mail-poll.js
// Schemalagd Netlify-funktion (var 10:e minut, se netlify.toml) som:
//   1. Läser inkorgen för MAILBOX_USER via Graph.
//   2. Plockar ut olästa meddelanden som är NYARE än senast sedda tidsstämpel.
//   3. Klassificerar var och en (Claude Haiku, ev. Gemini). För icke-brus skapas ett svarsutkast
//      (Claude + Graph createReply) — MEN endast om MAIL_AUTODRAFT === 'true'.
//      Annars torrkörning: klassificera + köa, skapa INGA utkast.
//   4. Persisterar "lastSeen" + en liten kö till data/mail-queue.json (GitHub).
//
// Säkerhet:
//   * MAIL_AUTODRAFT (default: torrkörning). Sätt = 'true' för att låta pollern
//     faktiskt skapa utkast i Outlook. Skickar ALDRIG — bara utkast.
//   * Max 10 nya meddelanden per körning.
//
// Schemaläggning: registrerad i netlify.toml → [functions."mail-poll"].

const { graphJson } = require('./lib/graph');
const { triageMessage, POLL_RETRY_DELAYS } = require('./lib/triage');
const { readJsonFile, writeJsonFile } = require('./lib/store');

const FILE_PATH = 'data/mail-queue.json';
const MAX_PER_RUN = 10;
const MAX_QUEUE = 100;
const MAILBOX = () => process.env.MAILBOX_USER || 'jimmy@peakfast.se';

exports.handler = async () => {
  const autodraft = process.env.MAIL_AUTODRAFT === 'true';
  const log = { ran: new Date().toISOString(), autodraft, considered: 0, triaged: 0, drafts: 0, errors: [] };

  try {
    // 1. Nuvarande kö + lastSeen.
    const { data } = await readJsonFile(FILE_PATH, { lastSeen: null, items: [] });
    const state = data || { lastSeen: null, items: [] };
    const lastSeen = state.lastSeen ? new Date(state.lastSeen).getTime() : 0;

    // 2. Hämta inkorgen.
    const mailbox = MAILBOX();
    const select = 'id,subject,from,receivedDateTime,bodyPreview,conversationId,isRead';
    const inbox = await graphJson(
      `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
      `?$top=25&$select=${select}&$orderby=receivedDateTime desc`
    );
    const messages = inbox.value || [];

    // 3. Nya + olästa, nyare än lastSeen. Äldst först så lastSeen stiger korrekt.
    const fresh = messages
      .filter(m => !m.isRead && new Date(m.receivedDateTime).getTime() > lastSeen)
      .sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime))
      .slice(0, MAX_PER_RUN);

    log.considered = fresh.length;

    const newItems = [];
    let newestSeen = state.lastSeen;

    for (const m of fresh) {
      try {
        const message = {
          id: m.id,
          subject: m.subject || '',
          fromName: m.from?.emailAddress?.name || '',
          fromAddress: m.from?.emailAddress?.address || '',
          received: m.receivedDateTime || '',
          conversationId: m.conversationId || '',
          text: m.bodyPreview || '',
        };
        // Pollern har lång timeout → större retry-budget + full kontext
        // (inkl. tvärtråds-sökning) än den synkrona on-click-vägen.
        const result = await triageMessage(m.id, {
          message,
          autodraft,
          retryDelays: POLL_RETRY_DELAYS,
          includeCrossThread: true,
        });
        log.triaged++;
        if (result.draftId) log.drafts++;
        newItems.push({
          messageId: result.messageId,
          category: result.category,
          subject: result.subject,
          fromName: result.fromName,
          fromAddress: result.fromAddress,
          reason: result.reason,
          confidence: result.confidence,
          suggested_action: result.suggested_action,
          needsManualConfirm: result.needsManualConfirm,
          draftId: result.draftId,
          draftWebLink: result.draftWebLink,
          autodraft: result.autodraft,
          alreadyReplied: result.alreadyReplied,
          duplicateDraft: result.duplicateDraft,
          skipReason: result.skipReason,
          received: m.receivedDateTime || '',
          timestamp: result.timestamp,
        });
      } catch (e) {
        log.errors.push(`${m.id}: ${e.message}`);
      }
      // Höj lastSeen oavsett triage-utfall så vi inte fastnar på ett trasigt mejl.
      if (!newestSeen || new Date(m.receivedDateTime) > new Date(newestSeen)) {
        newestSeen = m.receivedDateTime;
      }
    }

    // 4. Persistera (nyast först i kön), om något hände.
    if (newItems.length || newestSeen !== state.lastSeen) {
      const merged = [...newItems.reverse(), ...(state.items || [])].slice(0, MAX_QUEUE);
      await writeJsonFile(
        FILE_PATH,
        { lastSeen: newestSeen, items: merged },
        `Mail-hub: ${newItems.length} nya triage-poster (autodraft=${autodraft})`
      );
    }

    return { statusCode: 200, body: JSON.stringify(log) };
  } catch (e) {
    log.errors.push(e.message);
    // Icke-blockerande: logga och returnera 200 så schemat inte spammar fel.
    return { statusCode: 200, body: JSON.stringify(log) };
  }
};
