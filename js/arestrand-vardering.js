/* ═══════════════════════════════════════════════════════════════════════════
   arestrand-vardering.js — riktvärde för en andelsvecka på Åre Strand.

   Modellen: pris = bas(storlek) × säsongsfaktor × årsfaktor^(år − 2023),
   skattad med minsta kvadrat på log(pris) över enveckasaffärerna i
   ARESTRAND_AFFARER (+ det som sparats lokalt). Räknas om i webbläsaren vid
   varje sidladdning, så nya affärer slår igenom direkt.

   Storleksklasserna går tvärs över huslängorna — Jimmys erfarenhet är att en
   lägenhet av samma storlek är mer eller mindre samma produkt oavsett hus
   (2026-09-15). Fyra klasser i stället för sex: liten (53–66 kvm, 2–3 rok),
   mellan (74–81 kvm, 3 rok), stor (90–112 kvm, 3–4 rok), strandvilla (118+).

   Säsongerna följer prisbilden över året, inte kalendern: jul/nyår, vinter,
   sportlov, vårvinter (skidsäsongens slut, påsken), vår, sommar, höst.

   Tre lager visas var för sig: direkta jämförelser, modellvärde med
   intervall, rekommenderat utgångspris. Aldrig en siffra utan intervall och
   jämförelselista — det är ett riktvärde inför prissättning, inte ett
   värderingsintyg.
   ═══════════════════════════════════════════════════════════════════════════ */

const AV = (function () {
  'use strict';

  const TYPER = ['liten', 'mellan', 'stor', 'villa'];
  const TYP_NAMN = { liten: 'Liten · 53–66 kvm · 2–3 rok', mellan: 'Mellan · 74–81 kvm · 3 rok', stor: 'Stor · 90–112 kvm · 3–4 rok', villa: 'Strandvilla · 118 kvm · 4 rok', paket_1_6: 'Paket var sjätte vecka (hus 6)' };
  const GRANNE = { liten: ['mellan'], mellan: ['liten', 'stor'], stor: ['mellan', 'villa'], villa: ['stor'] };
  const KLASSER = ['jul_nyar', 'vinter', 'sportlov', 'varvinter', 'var', 'sommar', 'host'];
  const KLASS_NAMN = { jul_nyar: 'Jul/nyår (v.51–1)', vinter: 'Vinter (v.2–6)', sportlov: 'Sportlov (v.7–10)', varvinter: 'Vårvinter (v.11–17)', var: 'Vår (v.18–25)', sommar: 'Sommar (v.26–33)', host: 'Höst (v.34–50)' };
  const INTERVALL = 0.25;      // ±25 % fångar två tredjedelar av affärerna (analysen 2026-09-15)
  const UTGANGSPASLAG = 1.07;  // slutpriserna i underlaget ligger i median ~7 % under utgångspriset

  function veckoklass(v) {
    if (v === 51 || v === 52 || v === 1) return 'jul_nyar';
    if (v >= 2 && v <= 6) return 'vinter';
    if (v >= 7 && v <= 10) return 'sportlov';
    if (v >= 11 && v <= 17) return 'varvinter';
    if (v >= 18 && v <= 25) return 'var';
    if (v >= 26 && v <= 33) return 'sommar';
    return 'host';
  }

  function typAvBoarea(boarea, avgift) {
    if (avgift && avgift >= 800) return 'paket_1_6';
    if (boarea == null) return null;
    if (boarea <= 66) return 'liten';
    if (boarea <= 85) return 'mellan';
    if (boarea <= 114) return 'stor';
    return 'villa';
  }

  /* Äldre datafiler och lokalt sparade rader kan bära de gamla, smalare
     klassnamnen. Översätts här så inget behöver rensas. */
  const GAMMAL = { lgh_53_59: 'liten', lgh_63: 'liten', lgh_74_81: 'mellan', lgh_90_95: 'stor', lgh_111: 'stor', villa_118: 'villa' };
  function normTyp(r) { const t = r.typ; if (GAMMAL[t]) return GAMMAL[t]; if (TYPER.includes(t) || t === 'paket_1_6') return t; return typAvBoarea(r.boarea, r.avgift); }

  /* Löser A·x = b med Gauss-elimination (partiell pivotering). */
  function los(A, b) {
    const n = b.length;
    const M = A.map((rad, i) => rad.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) continue;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((rad, i) => (Math.abs(rad[i]) < 1e-12 ? 0 : rad[n] / rad[i]));
  }
  function ols(X, y) {
    const p = X[0].length;
    const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
    const Xty = new Array(p).fill(0);
    for (let i = 0; i < X.length; i++) for (let a = 0; a < p; a++) { Xty[a] += X[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b]; }
    return los(XtX, Xty);
  }
  function rad(typ, vecka, ar) {
    const x = new Array(TYPER.length + KLASSER.length - 1 + 1).fill(0);
    x[TYPER.indexOf(typ)] = 1;
    const k = KLASSER.indexOf(veckoklass(vecka));
    if (k > 0) x[TYPER.length + k - 1] = 1;
    x[x.length - 1] = ar - 2023;
    return x;
  }

  let modell = null;

  function skatta(affarer) {
    const enkla = affarer.map(r => ({ ...r, typ: normTyp(r) })).filter(r => r.veckor && r.veckor.length === 1 && TYPER.includes(r.typ) && r.pris > 0 && r.datum);
    const X = enkla.map(r => rad(r.typ, r.veckor[0], parseInt(r.datum.slice(0, 4), 10))), y = enkla.map(r => Math.log(r.pris));
    const beta = ols(X, y);
    const res = enkla.map((r, i) => Math.exp(y[i] - X[i].reduce((s, v, j) => s + v * beta[j], 0)) - 1);
    const abs = res.map(Math.abs).sort((a, b) => a - b);
    const vecko = Object.fromEntries(KLASSER.map((k, i) => [k, i === 0 ? 1 : Math.exp(beta[TYPER.length + i - 1])]));
    /* En säsong med färre än tre affärer får inte sätta sin egen faktor —
       minsta kvadrat passar då de få punkterna exakt och faktorn blir slump.
       Den lånar i stället det geometriska snittet av grannsäsongerna. */
    const antal = Object.fromEntries(KLASSER.map(k => [k, 0]));
    for (const r of enkla) antal[veckoklass(r.veckor[0])]++;
    const tunna = [];
    KLASSER.forEach((k, i) => {
      if (antal[k] >= 3) return;
      const fore = KLASSER[(i - 1 + KLASSER.length) % KLASSER.length], efter = KLASSER[(i + 1) % KLASSER.length];
      vecko[k] = Math.sqrt(vecko[fore] * vecko[efter]);
      tunna.push(k);
    });
    modell = {
      n: enkla.length,
      bas: Object.fromEntries(TYPER.map((t, i) => [t, Math.exp(beta[i])])),
      vecko, antalPerSasong: antal, lanadeSasonger: tunna,
      arsfaktor: Math.exp(beta[beta.length - 1]),
      medianfel: abs.length ? abs[Math.floor(abs.length / 2)] : null,
      inom25: abs.length ? abs.filter(a => a < 0.25).length / abs.length : null,
    };
    return modell;
  }

  function modellvarde(typ, vecka, ar) {
    if (!modell || !modell.bas[typ]) return null;
    ar = ar || new Date().getFullYear();
    return modell.bas[typ] * modell.vecko[veckoklass(vecka)] * Math.pow(modell.arsfaktor, ar - 2023);
  }

  /* Jämförelser i fyra vägda nivåer, plus de övriga affärerna i samma enhet
     som ren information (nivå 5, väger inget — annan säsong är en annan
     prisbild). Vikten är nivå × färskhet (halveras vart tredje år). */
  function jamforelser(affarer, enhet, typ, vecka) {
    const nu = new Date().getFullYear();
    const klass = veckoklass(vecka);
    const ut = [];
    for (const r0 of affarer) {
      if (!r0.veckor || !r0.veckor.length || !r0.pris) continue;
      const r = { ...r0, typ: normTyp(r0) };
      if (r.typ === 'paket_1_6') continue;
      const sammaEnhet = r.enhet === enhet, sammaVecka = r.veckor.includes(vecka), sammaTyp = r.typ === typ;
      const sammaSasong = r.veckor.every(v => veckoklass(v) === klass);
      const grannTyp = (GRANNE[typ] || []).includes(r.typ);
      let niva = null;
      if (sammaEnhet && sammaVecka) niva = 1;
      else if (sammaTyp && sammaVecka) niva = 2;
      else if (sammaTyp && sammaSasong) niva = 3;
      else if (grannTyp && sammaVecka) niva = 4;
      else if (sammaEnhet) niva = 5;
      if (!niva) continue;
      const ar = parseInt(r.datum.slice(0, 4), 10);
      const farskhet = Math.pow(0.5, Math.max(0, nu - ar) / 3);
      const nivavikt = { 1: 3, 2: 2.5, 3: 1, 4: 0.6, 5: 0 }[niva];
      const perVecka = r.veckor.length > 1 ? r.pris / r.veckor.length : r.pris;
      // Grannstorlek räknas om med modellens basförhållande så priset blir jämförbart.
      const storleksjust = niva === 4 && modell && modell.bas[r.typ] ? modell.bas[typ] / modell.bas[r.typ] : 1;
      ut.push({ ...r, niva, vikt: nivavikt * farskhet, perVecka, prisNu: perVecka * storleksjust * Math.pow(modell ? modell.arsfaktor : 1, nu - ar) });
    }
    ut.sort((a, b) => a.niva - b.niva || b.datum.localeCompare(a.datum));
    return ut;
  }

  function avrunda5000(x) { return Math.round(x / 5000) * 5000; }

  function vardera(affarer, enhet, typ, vecka) {
    if (!modell) skatta(affarer);
    const klass = veckoklass(vecka);
    const M = modellvarde(typ, vecka);
    const jf = jamforelser(affarer, enhet, typ, vecka);
    const direkta = jf.filter(j => j.niva <= 4);
    const viktsumma = direkta.reduce((s, j) => s + j.vikt, 0);
    const C = viktsumma > 0 ? direkta.reduce((s, j) => s + j.vikt * j.prisNu, 0) / viktsumma : null;
    // Jämförelserna får väga upp till 80 %; två "modellvikter" som ankare så en enda gammal affär inte styr.
    const andelJf = C == null ? 0 : Math.min(0.8, viktsumma / (viktsumma + 2));
    const varde = M == null ? C : C == null ? M : (1 - andelJf) * M + andelJf * C;
    const nStarka = jf.filter(j => j.niva <= 3).length;
    return {
      typ, typNamn: TYP_NAMN[typ], vecka, klass, klassNamn: KLASS_NAMN[klass],
      modell: M, jamforelsevarde: C, andelJamforelser: andelJf,
      varde, lag: varde != null ? varde * (1 - INTERVALL) : null, hog: varde != null ? varde * (1 + INTERVALL) : null,
      utgangspris: varde != null ? avrunda5000(varde * UTGANGSPASLAG) : null,
      jamforelser: jf, antalDirekta: nStarka, tunt: nStarka < 3,
      parametrar: modell,
    };
  }

  return { TYPER, TYP_NAMN, KLASSER, KLASS_NAMN, INTERVALL, UTGANGSPASLAG, veckoklass, typAvBoarea, normTyp, skatta, modellvarde, jamforelser, vardera, avrunda5000 };
})();
