/* ═══════════════════════════════════════════════════════════════════════════
   arestrand-vardering.js — riktvärde för en andelsvecka på Åre Strand.

   Modellen är samma som i analys/are-strand/analys_strand.py:
     pris = bas(typ) × veckofaktor(veckoklass) × årsfaktor^(år − 2023)
   skattad med minsta kvadrat på log(pris) över enveckasaffärerna i
   ARESTRAND_AFFARER (+ det som sparats lokalt). Räknas om i webbläsaren vid
   varje sidladdning, så nya affärer slår igenom direkt.

   Tre lager visas var för sig: direkta jämförelser, modellvärde med
   intervall, rekommenderat utgångspris. Aldrig en siffra utan intervall och
   jämförelselista — det är ett riktvärde inför prissättning, inte ett
   värderingsintyg (se texten i verktyget).
   ═══════════════════════════════════════════════════════════════════════════ */

const AV = (function () {
  'use strict';

  const TYPER = ['lgh_53_59', 'lgh_63', 'lgh_74_81', 'lgh_90_95', 'lgh_111', 'villa_118'];
  const KLASSER = ['jul_nyar', 'sportlov', 'vinter', 'senvinter', 'var', 'sommar', 'lag'];
  const KLASS_NAMN = { jul_nyar: 'Jul/nyår (v.51, 52, 1)', sportlov: 'Sportlov (v.7–10)', vinter: 'Vinter (v.2–6)', senvinter: 'Senvinter (v.11–13)', var: 'Vår (v.14–18)', sommar: 'Sommar (v.26–32)', lag: 'Lågsäsong (v.19–25, 33–50)' };
  const INTERVALL = 0.25;   // ±25 % fångar två tredjedelar av affärerna (analysen 2026-09-15)

  function veckoklass(v) {
    if (v === 51 || v === 52 || v === 1) return 'jul_nyar';
    if (v >= 7 && v <= 10) return 'sportlov';
    if (v >= 2 && v <= 6) return 'vinter';
    if (v >= 11 && v <= 13) return 'senvinter';
    if (v >= 14 && v <= 18) return 'var';
    if (v >= 26 && v <= 32) return 'sommar';
    return 'lag';
  }

  function typAvBoarea(boarea, avgift) {
    if (avgift && avgift >= 800) return 'paket_1_6';
    if (boarea == null) return null;
    if (boarea <= 60) return 'lgh_53_59';
    if (boarea <= 66) return 'lgh_63';
    if (boarea <= 82) return 'lgh_74_81';
    if (boarea <= 96) return 'lgh_90_95';
    if (boarea <= 112) return 'lgh_111';
    return 'villa_118';
  }

  /* Löser A·x = b med Gauss-elimination (partiell pivotering). Systemet är
     litet (≈13 okända), så ingen numerik utöver detta behövs. */
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

  /* Minsta kvadrat: x = (XᵀX)⁻¹ Xᵀy */
  function ols(X, y) {
    const p = X[0].length;
    const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
    const Xty = new Array(p).fill(0);
    for (let i = 0; i < X.length; i++) {
      for (let a = 0; a < p; a++) {
        Xty[a] += X[i][a] * y[i];
        for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
      }
    }
    return los(XtX, Xty);
  }

  function rad(r) {
    const x = new Array(TYPER.length + KLASSER.length - 1 + 1).fill(0);
    x[TYPER.indexOf(r.typ)] = 1;
    const k = KLASSER.indexOf(veckoklass(r.veckor[0]));
    if (k > 0) x[TYPER.length + k - 1] = 1;
    x[x.length - 1] = parseInt(r.datum.slice(0, 4), 10) - 2023;
    return x;
  }

  let modell = null;

  /* Skattar modellen ur affärslistan. Returnerar parametrarna + felmått så de
     kan visas i verktyget. */
  function skatta(affarer) {
    const enkla = affarer.filter(r => r.veckor && r.veckor.length === 1 && TYPER.includes(r.typ) && r.pris > 0 && r.datum);
    const X = enkla.map(rad), y = enkla.map(r => Math.log(r.pris));
    const beta = ols(X, y);
    const res = enkla.map((r, i) => Math.exp(y[i] - X[i].reduce((s, v, j) => s + v * beta[j], 0)) - 1);
    const abs = res.map(Math.abs).sort((a, b) => a - b);
    modell = {
      n: enkla.length,
      bas: Object.fromEntries(TYPER.map((t, i) => [t, Math.exp(beta[i])])),
      vecko: Object.fromEntries(KLASSER.map((k, i) => [k, i === 0 ? 1 : Math.exp(beta[TYPER.length + i - 1])])),
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

  /* Jämförelser i tre nivåer. Varje rad får en vikt: nivå × färskhet
     (halveras vart tredje år). */
  function jamforelser(affarer, enhet, typ, vecka) {
    const nu = new Date().getFullYear();
    const klass = veckoklass(vecka);
    const ut = [];
    for (const r of affarer) {
      if (!r.veckor || !r.veckor.length || !r.pris) continue;
      const sammaEnhet = r.enhet === enhet;
      const sammaVecka = r.veckor.includes(vecka);
      const sammaTyp = r.typ === typ;
      let niva = null;
      if (sammaEnhet && sammaVecka) niva = 1;
      else if (sammaTyp && sammaVecka) niva = 2;
      else if (sammaTyp && r.veckor.every(v => veckoklass(v) === klass)) niva = 3;
      else if (sammaEnhet) niva = 4;
      if (!niva) continue;
      const ar = parseInt(r.datum.slice(0, 4), 10);
      const farskhet = Math.pow(0.5, Math.max(0, nu - ar) / 3);
      const nivavikt = { 1: 3, 2: 2, 3: 1, 4: 0.5 }[niva];
      // Två veckor i samma affär: priset per vecka som en grov delning.
      const perVecka = r.veckor.length > 1 ? r.pris / r.veckor.length : r.pris;
      ut.push({ ...r, niva, vikt: nivavikt * farskhet, perVecka, prisNu: perVecka * Math.pow(modell ? modell.arsfaktor : 1, nu - ar) });
    }
    ut.sort((a, b) => a.niva - b.niva || b.datum.localeCompare(a.datum));
    return ut;
  }

  function avrunda5000(x) { return Math.round(x / 5000) * 5000; }

  /* Sammanvägt riktvärde. Modellen och jämförelserna vägs mot varandra
     beroende på hur mycket jämförelserna väger. */
  function vardera(affarer, enhet, typ, vecka) {
    if (!modell) skatta(affarer);
    const M = modellvarde(typ, vecka);
    const jf = jamforelser(affarer, enhet, typ, vecka);
    const direkta = jf.filter(j => j.niva <= 3);
    const viktsumma = direkta.reduce((s, j) => s + j.vikt, 0);
    const C = viktsumma > 0 ? direkta.reduce((s, j) => s + j.vikt * j.prisNu, 0) / viktsumma : null;
    let andelJf = 0;
    if (C != null) andelJf = Math.min(0.7, viktsumma / (viktsumma + 2));   // 2 "modellvikter" som ankare
    const varde = M == null ? C : C == null ? M : (1 - andelJf) * M + andelJf * C;
    const nTypKlass = direkta.filter(j => j.niva <= 3).length;
    return {
      typ, vecka, klass: veckoklass(vecka), klassNamn: KLASS_NAMN[veckoklass(vecka)],
      modell: M, jamforelsevarde: C, andelJamforelser: andelJf,
      varde, lag: varde != null ? varde * (1 - INTERVALL) : null, hog: varde != null ? varde * (1 + INTERVALL) : null,
      utgangspris: varde != null ? avrunda5000(varde) : null,
      jamforelser: jf, antalDirekta: nTypKlass, tunt: nTypKlass < 3,
      parametrar: modell,
    };
  }

  return { TYPER, KLASSER, KLASS_NAMN, INTERVALL, veckoklass, typAvBoarea, skatta, modellvarde, jamforelser, vardera, avrunda5000 };
})();
