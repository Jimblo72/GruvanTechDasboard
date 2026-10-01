# GruvanTechDasboard — arbetssätt

- Dashboarden är Jimmys interna verktyg. **PR:er i det här repot mergas direkt** när de är testade och Netlifys deploy preview är grön — ingen väntan på granskning eller godkännande (Jimmy, 2026-10-01). Gemini-granskningens fynd åtgärdas eller besvaras innan merge.
- **Ingen PR-bevakning** (Jimmy, 2026-10-01): prenumerera inte på PR-aktivitet (`subscribe_pr_activity`) och schemalägg inga check-ins (`send_later`/triggers) för PR:er i det här repot. Kontrollera deploy preview en gång före merge, merga, klart. Det gäller även datarepots PR:er.
- Data ligger i det privata repot `Jimblo72/gruvan-dashboard-data` (se HANDOFF.md där). Ändringar där görs fortfarande via PR.
- Netlify-funktionerna är CommonJS. `netlify/functions/package.json` (`"type": "commonjs"`) måste finnas kvar, annars stoppar Netlify bygget (`zisi_error_cjs_in_esm_scope`).
- Detaljhandoffar: `HANDOFF_MAILHUB.md`, `HANDOFF_AI_GRANSKNINGSPANEL.md`, `HANDOFF_GRANSKNINGSSYSTEM.md`, `ANDELSVERKTYGET.md`, `HANDOFF_2026-09-15_ARE_STRAND.md`.
