// RCI-poäng för Åre Strand. Handskriven 2026-09-28 — inte genererad.
//
// TABELLEN: RCI:s "Directory of Affiliated Resorts 2015–2017 — RCI Points Values",
// Holiday Club Åre (resortkod 7791). Den har bara två lägenhetstyper, 2BR och 3BR.
// Nyare tabeller är inte publika (bara inloggad på rci.com).
//
// STICKPROVET 2026-09-28 mot objektsbeskrivningarna i ÅreStrand-mappen (annonser 2021–2025):
//   stämmer:  18:2 vårvinter villa 153 500 · 15:2 v.4 villa 114 500 · 22:2 v.5 villa 114 000 (tabell 114 500)
//             1B3 v.8 76 kvm 107 500 · 6B3 v.4 78 kvm 86 000
//   stämmer INTE: 14:1 v.8 och 14:2 v.6 (95 kvm, 2 sov) 123 500 · 2B1 v.6 (111 kvm) 137 500 · 3B1 v.11 (111 kvm) 107 500
// Därför: tabellen används bara för villor (3BR) och mellanlägenheterna 74–81 kvm (2BR).
// Stora lägenheter får bara annonsvärdet för exakt den enhet och vecka det gäller; små (1 sov)
// finns inte i tabellen alls. Alla stickprov är vinterveckor — sommar och höst är okontrollerade.
// Jimmys beslut 2026-09-28.

const ARESTRAND_RCI_TABELL = [
  // [veckor, 2BR, 3BR]
  [[1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 52], 107500, 153500],
  [[2, 3, 4, 5, 17, 18, 50, 51], 86000, 114500],
  [[19, 21, 22, 23, 40, 41, 42], 37000, 47000],
  [[20], 37000, 37000],
  [[24, 25], 37000, 81000],
  [[26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38], 74500, 110000],
  [[39], 74500, 92500],
  [[43, 44], 74500, 96500],
  [[45, 46, 47, 48, 49], 52000, 70000],
];

// Enheter där tabellen inte gäller men objektsbeskrivningen anger poängen. Nyckel "enhet|vecka".
const ARESTRAND_RCI_KANDA = {
  '14:1|8': 123500,
  '14:2|6': 123500,
  '2B1|6': 137500,
  '3B1|11': 107500,
};
