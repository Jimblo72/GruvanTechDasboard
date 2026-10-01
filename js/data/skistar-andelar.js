/* ═══════════════════════════════════════════════════════════════════════════
   skistar-andelar.js — referensdata för SkiStar Vacation Club-andelarna.

   Används av andelsforsaljning.html (andelsverktyget) och av dashboardens
   objektsunderlag (index.html → js/objektsunderlag.js). Flyttad hit ur
   andelsforsaljning.html 2026-10-01 så att båda läser SAMMA data — verktyget
   har en gång glidit isär från en kopia (se ANDELSVERKTYGET.md). Gör ingen
   kopia: ändra här.

   APT_DATA       — fakta per lägenhetstyp (nyckel = bildmappens namn, byt aldrig).
   VECKOPRIS      — SkiStars insatspris per typ och vecka (GENERERAD, se nedan).
   normalizeWeeksStr / calcBrfMonthly / summeraVeckopris — veckomodellen.

   Andelsverktygets egna ändringar ur fliken Referensdata ligger i
   localStorage 'af_aptOverrides' och läggs på i respektive sida.
   ═══════════════════════════════════════════════════════════════════════════ */

const APT_DATA = {"av1-50": {"name": "Åre Village 1 · 50 kvm", "area": "Åre", "size_sqm": 50, "size_label": "50 kvm", "rooms": "2 rum och kök", "bedrooms": "1 sovrum", "bed_count": "4 bäddar", "extras": "balkong med utsikt över Åresjön", "brf": "Brf Åre Village 1", "brf_avgift": 1602, "stad_0_6": 1281, "stad_7_11": 1619, "stad_12": 2050, "stad_jul_nyar": 2428.5, "lgh_nr": "Lgh 903, 908, 913 (C)", "sort": 1}, "av2-50": {"name": "Åre Village 2 · 50 kvm", "area": "Åre", "size_sqm": 50, "size_label": "50 kvm", "rooms": "2 rum och kök", "bedrooms": "1 sovrum", "bed_count": "4 bäddar", "extras": "balkong med utsikt över Åresjön", "brf": "Brf Åre Village 2", "brf_avgift": 1653, "stad_0_6": 1281, "stad_7_11": 1619, "stad_12": 2050, "stad_jul_nyar": 2428.5, "lgh_nr": "Lgh 917, 922, 927 (C)", "sort": 2}, "av1-83": {"name": "Åre Village 1 · 83 kvm", "area": "Åre", "size_sqm": 83, "size_label": "83 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 1", "brf_avgift": 3172, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 904, 909, 914 (D)", "sort": 3}, "av2-83": {"name": "Åre Village 2 · 83 kvm", "area": "Åre", "size_sqm": 83, "size_label": "83 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 2", "brf_avgift": 3265, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 918, 923, 928 (D)", "sort": 4}, "av1-85": {"name": "Åre Village 1 · 85 kvm", "area": "Åre", "size_sqm": 85, "size_label": "85 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 1", "brf_avgift": 3172, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 901-912 (A/B/E)", "sort": 5}, "av2-85": {"name": "Åre Village 2 · 85 kvm", "area": "Åre", "size_sqm": 85, "size_label": "85 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 2", "brf_avgift": 3265, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 915-926 (A/B/E)", "sort": 6}, "av1-87": {"name": "Åre Village 1 · 87 kvm", "area": "Åre", "size_sqm": 87, "size_label": "87 kvm", "rooms": "3 rum och kök", "bedrooms": "2-3 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 1", "brf_avgift": 3172, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 901-912 (A/B/E)", "sort": 7}, "av2-87": {"name": "Åre Village 2 · 87 kvm", "area": "Åre", "size_sqm": 87, "size_label": "87 kvm", "rooms": "3 rum och kök", "bedrooms": "2-3 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 2", "brf_avgift": 3265, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 915-926 (A/B/E)", "sort": 8}, "snotorget-45": {"name": "Snötorget · 45 kvm", "area": "Sälen", "size_sqm": 45, "size_label": "45 kvm", "rooms": "2 rum och kök", "bedrooms": "1 sovrum", "bed_count": "4-5 bäddar", "extras": "modern planlösning", "brf": "Brf Snötorget", "brf_avgift": 2315, "stad_0_6": 1343, "stad_7_11": 1695, "stad_12": 2148, "stad_jul_nyar": 2542.5, "lgh_nr": "Våning 2: 1B, 1C, 1D", "sort": 10}, "snotorget-85": {"name": "Snötorget · 85 kvm", "area": "Sälen", "size_sqm": 85, "size_label": "85 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "6-8 bäddar", "extras": "modern planlösning", "brf": "Brf Snötorget", "brf_avgift": 3125, "stad_0_6": 2030, "stad_7_11": 2519, "stad_12": 3237, "stad_jul_nyar": 3778.5, "lgh_nr": "Våning 1-2: 2A-3D", "sort": 11}, "timmerbyn-1-46": {"name": "Timmerbyn 1 · 46 kvm", "area": "Sälen", "size_sqm": 46, "size_label": "46 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "5 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 1", "brf_avgift": 2376, "stad_0_6": 1566, "stad_7_11": 1919, "stad_12": 2506, "stad_jul_nyar": 2878.5, "lgh_nr": "Lgh 106-110C", "sort": 20}, "timmerbyn-1-100": {"name": "Timmerbyn 1 · 100 kvm", "area": "Sälen", "size_sqm": 100, "size_label": "100 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 1", "brf_avgift": 4135, "stad_0_6": 2672, "stad_7_11": 3161, "stad_12": 4275, "stad_jul_nyar": 4741.5, "lgh_nr": "Lgh 106-110A", "sort": 21}, "timmerbyn-2-46": {"name": "Timmerbyn 2 · 46 kvm", "area": "Sälen", "size_sqm": 46, "size_label": "46 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "5 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 2", "brf_avgift": 2449, "stad_0_6": 1566, "stad_7_11": 1919, "stad_12": 2506, "stad_jul_nyar": 2878.5, "lgh_nr": "Lgh 111-114C", "sort": 22}, "timmerbyn-2-100": {"name": "Timmerbyn 2 · 100 kvm", "area": "Sälen", "size_sqm": 100, "size_label": "100 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 2", "brf_avgift": 4463, "stad_0_6": 2672, "stad_7_11": 3161, "stad_12": 4275, "stad_jul_nyar": 4741.5, "lgh_nr": "Lgh 111-114B", "sort": 23}, "timmerbyn-3-46": {"name": "Timmerbyn 3 · 46 kvm", "area": "Sälen", "size_sqm": 46, "size_label": "46 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "5 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 3", "brf_avgift": 2131, "stad_0_6": 1566, "stad_7_11": 1919, "stad_12": 2506, "stad_jul_nyar": 2878.5, "lgh_nr": "Lgh 148C, 151-153C", "sort": 24}, "timmerbyn-3-100": {"name": "Timmerbyn 3 · 100 kvm", "area": "Sälen", "size_sqm": 100, "size_label": "100 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 3", "brf_avgift": 3864, "stad_0_6": 2672, "stad_7_11": 3161, "stad_12": 4275, "stad_jul_nyar": 4741.5, "lgh_nr": "Lgh 148A, 151-153A", "sort": 25}, "timmerbyn-4-54": {"name": "Timmerbyn 4 · 54 kvm", "area": "Sälen", "size_sqm": 54, "size_label": "54 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "6 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 4", "brf_avgift": 2380, "stad_0_6": 1630, "stad_7_11": 1983, "stad_12": 2607, "stad_jul_nyar": 2974.5, "lgh_nr": "Lgh 115-116C, 120-121C", "sort": 26}, "timmerbyn-4-113": {"name": "Timmerbyn 4 · 113 kvm", "area": "Sälen", "size_sqm": 113, "size_label": "113 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 4", "brf_avgift": 4140, "stad_0_6": 2796, "stad_7_11": 3285, "stad_12": 4473, "stad_jul_nyar": 4927.5, "lgh_nr": "Lgh 115-116A, 120-121B", "sort": 27}, "timmerbyn-5-54": {"name": "Timmerbyn 5 · 54 kvm", "area": "Sälen", "size_sqm": 54, "size_label": "54 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "6 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 5", "brf_avgift": 2303, "stad_0_6": 1630, "stad_7_11": 1983, "stad_12": 2607, "stad_jul_nyar": 2974.5, "lgh_nr": "Lgh 117-118C", "sort": 28}, "timmerbyn-5-113": {"name": "Timmerbyn 5 · 113 kvm", "area": "Sälen", "size_sqm": 113, "size_label": "113 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 5", "brf_avgift": 4444, "stad_0_6": 2796, "stad_7_11": 3285, "stad_12": 4473, "stad_jul_nyar": 4927.5, "lgh_nr": "Lgh 117-118A", "sort": 29}, "sorgardarna-80": {"name": "Sörgårdarna SAK2 · 80 kvm", "area": "Vemdalen", "size_sqm": 80, "size_label": "80 kvm", "rooms": "5 rum och kök", "bedrooms": "4 sovrum", "bed_count": "8 bäddar", "extras": "bastu", "brf": "Brf Sörgårdarna SAK 2", "brf_avgift": 2200, "stad_0_6": 2583, "stad_7_11": 3072, "stad_12": 4132, "stad_jul_nyar": 4608, "lgh_nr": "BRF Sörgårdarna SAK2 (4 sovrum)", "sort": 40}};

// GENERERAD — redigera inte för hand. Kör scripts/gen_veckopris.py i
// C:\dev\peakfast-verktyg när prislistan uppdaterats och klistra in blocket
// HÄR (låg tidigare i andelsforsaljning.html).
// Källa: SkiStar_Vacation_Club_prislista.xlsx
// Prislista giltig from 21 dec 2022 | Period 1 = Helperiod, Period 2 = Halvperiod, Period 3 = Kvartsperiod, S = Servicevecka
// VECKOPRIS[aptKey][vecka] = insats i kr för DEN enskilda veckan.
// Veckor som saknas är servicveckor eller ej tillgängliga.
const VECKOPRIS_KALLA = 'Prislista giltig from 21 dec 2022 | Period 1 = Helperiod, Period 2 = Halvperiod, Period 3 = Kvartsperiod, S = Servicevecka';
const VECKOPRIS = {
  'av1-50': {2:111000, 3:98000, 4:111000, 5:147000, 6:163000, 7:242000, 8:285000, 9:285000, 10:227000, 11:227000, 12:227000, 13:227000, 14:170000, 15:123000, 16:100000, 17:91000, 18:60000, 21:40000, 22:40000, 23:40000, 24:40000, 25:60000, 26:73000, 27:80000, 28:84000, 29:91000, 30:91000, 31:91000, 32:91000, 33:84000, 34:69000, 35:69000, 36:69000, 37:58000, 38:58000, 39:58000, 40:40000, 41:40000, 42:40000, 43:58000, 44:73000, 46:40000, 47:40000, 48:42000, 49:73000, 50:73000, 51:228000, 52:350000},
  'av1-83': {2:158000, 3:140000, 4:158000, 5:210000, 6:234000, 7:345000, 8:407000, 9:407000, 10:325000, 11:325000, 12:325000, 13:325000, 14:244000, 15:175000, 16:144000, 17:129000, 18:95000, 21:57000, 22:57000, 23:57000, 24:57000, 25:95000, 26:103000, 27:112000, 28:119000, 29:129000, 30:129000, 31:129000, 32:129000, 33:119000, 34:99000, 35:99000, 36:99000, 37:82000, 38:82000, 39:82000, 40:57000, 41:57000, 42:57000, 43:91000, 44:103000, 46:57000, 47:57000, 48:59000, 49:103000, 50:103000, 51:326000, 52:502000},
  'av1-85': {2:199000, 3:179000, 4:199000, 5:266000, 6:297000, 7:438000, 8:517000, 9:517000, 10:411000, 11:411000, 12:411000, 13:411000, 14:332000, 15:222000, 16:181000, 17:164000, 18:106000, 21:57000, 22:57000, 23:57000, 24:57000, 25:106000, 26:129000, 27:144000, 28:152000, 29:164000, 30:164000, 31:164000, 32:164000, 33:152000, 34:125000, 35:125000, 36:125000, 37:104000, 38:104000, 39:104000, 40:57000, 41:57000, 42:57000, 43:102000, 44:129000, 46:57000, 47:57000, 48:59000, 49:129000, 50:129000, 51:414000, 52:636000},
  'av1-87': {2:199000, 3:179000, 4:199000, 5:266000, 6:297000, 7:438000, 8:517000, 9:517000, 10:411000, 11:411000, 12:411000, 13:411000, 14:332000, 15:222000, 16:181000, 17:164000, 18:106000, 21:57000, 22:57000, 23:57000, 24:57000, 25:106000, 26:129000, 27:144000, 28:152000, 29:164000, 30:164000, 31:164000, 32:164000, 33:152000, 34:125000, 35:125000, 36:125000, 37:104000, 38:104000, 39:104000, 40:57000, 41:57000, 42:57000, 43:102000, 44:129000, 46:57000, 47:57000, 48:59000, 49:129000, 50:129000, 51:414000, 52:636000},
  'av2-50': {2:111000, 3:98000, 4:111000, 5:147000, 6:163000, 7:242000, 8:285000, 9:285000, 10:227000, 11:227000, 12:227000, 13:227000, 14:170000, 15:123000, 16:100000, 17:91000, 18:60000, 21:40000, 22:40000, 23:40000, 24:40000, 25:60000, 26:73000, 27:80000, 28:84000, 29:91000, 30:91000, 31:91000, 32:91000, 33:84000, 34:69000, 35:69000, 36:69000, 37:58000, 38:58000, 39:58000, 40:40000, 41:40000, 42:40000, 43:58000, 44:73000, 46:40000, 47:40000, 48:42000, 49:73000, 50:73000, 51:228000, 52:350000},
  'av2-83': {2:158000, 3:140000, 4:158000, 5:210000, 6:234000, 7:345000, 8:407000, 9:407000, 10:325000, 11:325000, 12:325000, 13:325000, 14:244000, 15:175000, 16:144000, 17:129000, 18:95000, 21:57000, 22:57000, 23:57000, 24:57000, 25:95000, 26:103000, 27:112000, 28:119000, 29:129000, 30:129000, 31:129000, 32:129000, 33:119000, 34:99000, 35:99000, 36:99000, 37:82000, 38:82000, 39:82000, 40:57000, 41:57000, 42:57000, 43:91000, 44:103000, 46:57000, 47:57000, 48:59000, 49:103000, 50:103000, 51:326000, 52:502000},
  'av2-85': {2:199000, 3:179000, 4:199000, 5:266000, 6:297000, 7:438000, 8:517000, 9:517000, 10:411000, 11:411000, 12:411000, 13:411000, 14:332000, 15:222000, 16:181000, 17:164000, 18:106000, 21:57000, 22:57000, 23:57000, 24:57000, 25:106000, 26:129000, 27:144000, 28:152000, 29:164000, 30:164000, 31:164000, 32:164000, 33:152000, 34:125000, 35:125000, 36:125000, 37:104000, 38:104000, 39:104000, 40:57000, 41:57000, 42:57000, 43:102000, 44:129000, 46:57000, 47:57000, 48:59000, 49:129000, 50:129000, 51:414000, 52:636000},
  'av2-87': {2:199000, 3:179000, 4:199000, 5:266000, 6:297000, 7:438000, 8:517000, 9:517000, 10:411000, 11:411000, 12:411000, 13:411000, 14:332000, 15:222000, 16:181000, 17:164000, 18:106000, 21:57000, 22:57000, 23:57000, 24:57000, 25:106000, 26:129000, 27:144000, 28:152000, 29:164000, 30:164000, 31:164000, 32:164000, 33:152000, 34:125000, 35:125000, 36:125000, 37:104000, 38:104000, 39:104000, 40:57000, 41:57000, 42:57000, 43:102000, 44:129000, 46:57000, 47:57000, 48:59000, 49:129000, 50:129000, 51:414000, 52:636000},
  'snotorget-45': {1:223000, 2:159000, 3:148000, 4:159000, 5:183000, 6:193000, 7:287000, 8:309000, 9:309000, 10:244000, 11:222000, 12:222000, 13:222000, 14:211000, 15:159000, 16:144000, 17:108000, 18:85000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:104000, 27:104000, 28:108000, 29:123000, 30:123000, 31:123000, 32:123000, 33:108000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:81000, 44:101000, 46:47000, 47:47000, 48:49000, 49:108000, 50:108000, 51:133000, 52:223000},
  'snotorget-85': {1:339000, 2:223000, 3:211000, 4:223000, 5:269000, 6:281000, 7:380000, 8:427000, 9:427000, 10:365000, 11:327000, 12:327000, 13:327000, 14:311000, 15:223000, 16:205000, 17:119000, 18:85000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:119000, 27:119000, 28:131000, 29:152000, 30:152000, 31:152000, 32:152000, 33:131000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:81000, 44:101000, 46:47000, 47:47000, 48:49000, 49:119000, 50:119000, 51:184000, 52:339000},
  'sorgardarna-80': {2:130000, 3:130000, 4:162000, 5:184000, 6:189000, 7:315000, 8:315000, 9:387000, 10:281000, 11:278000, 12:225000, 13:225000, 14:199000, 15:172000, 16:168000, 17:112000, 18:43000, 21:42000, 22:42000, 23:42000, 24:42000, 25:71000, 26:71000, 27:71000, 28:84000, 29:84000, 30:84000, 31:84000, 32:84000, 33:71000, 34:69000, 35:69000, 36:69000, 37:69000, 38:69000, 39:69000, 40:42000, 41:42000, 43:42000, 44:84000, 45:42000, 46:42000, 47:42000, 48:74000, 49:90000, 50:90000, 51:285000, 52:387000},
  'timmerbyn-1-100': {1:418000, 2:290000, 3:264000, 4:290000, 5:341000, 6:354000, 7:470000, 8:508000, 9:508000, 10:440000, 11:397000, 12:397000, 13:397000, 14:346000, 15:264000, 16:234000, 17:131000, 18:85000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:124000, 27:124000, 28:140000, 29:158000, 30:158000, 31:158000, 32:158000, 33:140000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:81000, 44:101000, 46:47000, 47:47000, 48:49000, 49:140000, 50:140000, 51:219000, 52:418000},
  'timmerbyn-1-46': {1:240000, 2:170000, 3:159000, 4:170000, 5:194000, 6:205000, 7:299000, 8:323000, 9:323000, 10:257000, 11:234000, 12:234000, 13:234000, 14:223000, 15:170000, 16:155000, 17:114000, 18:84000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:108000, 27:108000, 28:114000, 29:131000, 30:131000, 31:131000, 32:131000, 33:114000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:80000, 44:101000, 46:47000, 47:47000, 48:49000, 49:114000, 50:114000, 51:139000, 52:240000},
  'timmerbyn-2-100': {1:418000, 2:290000, 3:264000, 4:290000, 5:341000, 6:354000, 7:470000, 8:508000, 9:508000, 10:440000, 11:397000, 12:397000, 13:397000, 14:346000, 15:264000, 16:234000, 17:131000, 18:85000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:124000, 27:124000, 28:140000, 29:158000, 30:158000, 31:158000, 32:158000, 33:140000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:81000, 44:101000, 46:47000, 47:47000, 48:49000, 49:140000, 50:140000, 51:219000, 52:418000},
  'timmerbyn-2-46': {1:240000, 2:170000, 3:159000, 4:170000, 5:194000, 6:205000, 7:299000, 8:323000, 9:323000, 10:257000, 11:234000, 12:234000, 13:234000, 14:223000, 15:170000, 16:155000, 17:114000, 18:84000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:108000, 27:108000, 28:114000, 29:131000, 30:131000, 31:131000, 32:131000, 33:114000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:80000, 44:101000, 46:47000, 47:47000, 48:49000, 49:114000, 50:114000, 51:139000, 52:240000},
  'timmerbyn-3-100': {1:418000, 2:290000, 3:264000, 4:290000, 5:341000, 6:354000, 7:470000, 8:508000, 9:508000, 10:440000, 11:397000, 12:397000, 13:397000, 14:346000, 15:264000, 16:234000, 17:131000, 18:85000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:124000, 27:124000, 28:140000, 29:158000, 30:158000, 31:158000, 32:158000, 33:140000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:81000, 44:101000, 46:47000, 47:47000, 48:49000, 49:140000, 50:140000, 51:219000, 52:418000},
  'timmerbyn-3-46': {1:240000, 2:170000, 3:159000, 4:170000, 5:194000, 6:205000, 7:299000, 8:323000, 9:323000, 10:257000, 11:234000, 12:234000, 13:234000, 14:223000, 15:170000, 16:155000, 17:114000, 18:84000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:108000, 27:108000, 28:114000, 29:131000, 30:131000, 31:131000, 32:131000, 33:114000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:80000, 44:101000, 46:47000, 47:47000, 48:49000, 49:114000, 50:114000, 51:139000, 52:240000},
  'timmerbyn-4-113': {1:443000, 2:307000, 3:280000, 4:307000, 5:362000, 6:375000, 7:498000, 8:538000, 9:538000, 10:467000, 11:421000, 12:421000, 13:421000, 14:366000, 15:279000, 16:247000, 17:141000, 18:85000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:131000, 27:131000, 28:148000, 29:172000, 30:172000, 31:172000, 32:172000, 33:148000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:81000, 44:101000, 46:47000, 47:47000, 48:49000, 49:148000, 50:148000, 51:232000, 52:443000},
  'timmerbyn-4-54': {1:256000, 2:182000, 3:168000, 4:182000, 5:205000, 6:219000, 7:317000, 8:341000, 9:341000, 10:271000, 11:248000, 12:248000, 13:248000, 14:236000, 15:182000, 16:164000, 17:121000, 18:84000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:114000, 27:114000, 28:124000, 29:144000, 30:144000, 31:144000, 32:144000, 33:124000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:80000, 44:101000, 46:47000, 47:47000, 48:49000, 49:124000, 50:124000, 51:148000, 52:256000},
  'timmerbyn-5-113': {2:307000, 3:280000, 4:307000, 5:362000, 6:375000, 7:498000, 8:539000, 9:539000, 10:467000, 11:421000, 12:421000, 13:421000, 14:366000, 15:280000, 16:247000, 17:141000, 18:85000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:131000, 27:131000, 28:148000, 29:172000, 30:172000, 31:172000, 32:172000, 33:148000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:81000, 44:101000, 46:47000, 47:47000, 48:49000, 49:148000, 50:148000, 51:539000, 52:646000},
  'timmerbyn-5-54': {2:182000, 3:168000, 4:182000, 5:205000, 6:219000, 7:317000, 8:341000, 9:341000, 10:271000, 11:248000, 12:248000, 13:248000, 14:236000, 15:182000, 16:164000, 17:121000, 18:84000, 21:47000, 22:47000, 23:47000, 24:47000, 25:49000, 26:114000, 27:114000, 28:124000, 29:144000, 30:144000, 31:144000, 32:144000, 33:124000, 34:97000, 35:97000, 36:97000, 37:97000, 38:97000, 39:97000, 40:47000, 41:47000, 42:47000, 43:80000, 44:101000, 46:47000, 47:47000, 48:49000, 49:124000, 50:124000, 51:341000, 52:409000},
};

// ─── SkiStar specialvecko-normalisering ────────────────────────
// SkiStars Excel-paketblad skriver "Jul", "Nyår", "Mellandagar" osv
// som strängar istället för veckonummer. Vi mappar till canoniska
// veckonummer så BRF-beräkning och lång-text fungerar korrekt.
// Mappning baserad på SkiStars praxis för andelsveckor.
const SPECIAL_WEEK_MAP = {
  'jul':           [51],      // Julvecka = v.51
  'julvecka':      [51],
  // Nyår = EN bokningsbar enhet i SkiStar-systemet (söndag-söndag över årsskiftet).
  // Räknas som 1 vecka för både pris (1 jul/nyår-tariff ×1,5) och antal_veckor.
  // Representeras som v.52 internt; för marknadsföringstext finns veckor_original
  // som bevarar etiketten "Nyår".
  'nyår':          [52],
  'nyar':          [52],
  'nyårsvecka':    [52],
  'mellandagar':   [52],      // Mellandagarna = v.52 (utan nyårsafton-natten)
  'sportlov v.7':  [7],
  'sportlov v.8':  [8],
  'sportlov v.9':  [9],
  'sportlov v.10': [10],
  'påsk':          [15],      // Påsk varierar, sätter mittenvecka som default
  'pask':          [15],
  'påskvecka':     [15],
  'midsommar':     [26],      // Midsommarvecka v.26
  'midsommarvecka':[26]
};

// Normaliserar en weeksStr så "Nyår, 26, 38" → "52, 1, 26, 38".
// Behåller också original-tokens för texter ("Nyår" snarare än "v.52").
function normalizeWeeksStr(weeksStr) {
  // weeks MÅSTE finnas med även när strängen är tom — calcBrfMonthly gör
  // norm.weeks.forEach och kastade annars TypeError så fort man valde
  // lägenhetstyp innan veckorna fyllts i. Då uppdaterades hela faktarutan inte.
  if (!weeksStr) return { numeric: '', weeks: [], tokens: [], display: '' };
  // Splitta på , + ; eller multiple spaces ("6+30" är dokumenterad syntax i UI:t)
  const tokens = String(weeksStr).split(/[,;+]+|\s{2,}/).map(s => s.trim()).filter(Boolean);
  const numericWeeks = [];
  const labels = [];
  tokens.forEach(tok => {
    // Numeriskt? (kanske med "v." prefix)
    const m = tok.match(/^v\.?\s*(\d+)$|^(\d+)$/);
    if (m) {
      const n = parseInt(m[1] || m[2], 10);
      if (n >= 1 && n <= 53) {
        numericWeeks.push(n);
        labels.push(String(n));
      }
      return;
    }
    // Specialveckor — fuzzy match (lowercase)
    const key = tok.toLowerCase().trim();
    if (SPECIAL_WEEK_MAP[key]) {
      SPECIAL_WEEK_MAP[key].forEach(n => numericWeeks.push(n));
      labels.push(tok); // behåll original-stavning "Jul" / "Nyår"
      return;
    }
    // Försök plocka ut nummer från strängen (t.ex. "Sportlov v.8")
    const numMatch = tok.match(/(\d+)/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (n >= 1 && n <= 53) {
        numericWeeks.push(n);
        labels.push(tok); // behåll hela strängen
      }
    }
  });
  return {
    numeric: numericWeeks.join(', '),
    weeks: numericWeeks,
    tokens: labels,
    display: labels.join(', ')
  };
}

// Summerar SkiStars insatspris för valfri kombination av veckor.
// Varje vecka har ett eget pris i VECKOPRIS, så veckorna kan blandas fritt —
// ägare byter veckor och köper loss ströveckor, och då stämmer inte SkiStars
// färdiga paket. Veckor utan prisuppgift (service, ej tillgängliga) rapporteras
// separat i stället för att tyst räknas som noll.
function summeraVeckopris(aptKey, weeksStr) {
  const tomt = { total: 0, antal: 0, saknade: [] };
  if (!aptKey || typeof VECKOPRIS === 'undefined' || !VECKOPRIS[aptKey]) return tomt;
  const norm = normalizeWeeksStr(weeksStr || '');
  if (!norm.weeks || !norm.weeks.length) return tomt;
  const unika = norm.weeks.filter(function(w, i, a){ return a.indexOf(w) === i; });
  const tabell = VECKOPRIS[aptKey];
  let total = 0, antal = 0;
  const saknade = [];
  unika.forEach(function(v){
    if (tabell[v]) { total += tabell[v]; antal++; }
    else { saknade.push(v); }
  });
  return { total: total, antal: antal, saknade: saknade };
}

// Returnerar beräknad BRF-månadsavgift baserat på antal veckor och om jul/nyår ingår
// brf_avgift i APT_DATA = kr/år och vecka. Jul/nyår × 1,5 för ÅV, SAK2 och Sälen (v.51, v.52, v.1).
function calcBrfMonthly(aptKey, weeksStr) {
  const d = APT_DATA[aptKey];
  if (!d) return { monthly: 0, total: 0, weeks: 0, julNyar: 0 };
  const norm = normalizeWeeksStr(weeksStr || '');
  const weeks = norm.weeks;
  const isJulNyarApt = (d.area === 'Åre' && d.brf.indexOf('Village') >= 0) || d.area === 'Vemdalen' || d.area === 'Sälen';
  let julNyar = 0, normal = 0;
  weeks.forEach(w => {
    if (isJulNyarApt && (w === 51 || w === 52 || w === 1)) julNyar++;
    else normal++;
  });
  const total = (normal * d.brf_avgift) + (julNyar * d.brf_avgift * 1.5);
  return { monthly: Math.round(total / 12), total: Math.round(total), weeks: weeks.length, julNyar, normal };
}
