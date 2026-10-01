/* ═══════════════════════════════════════════════════════════════════════════
   skistar-andelar.js — referensdata för SkiStar Vacation Club-andelarna.

   Används av andelsforsaljning.html (andelsverktyget) och av dashboardens
   objektsunderlag (index.html → js/objektsunderlag.js). Flyttad hit ur
   andelsforsaljning.html 2026-10-01 så att båda läser SAMMA data — verktyget
   har en gång glidit isär från en kopia (se ANDELSVERKTYGET.md). Gör ingen
   kopia: ändra här.

   APT_DATA       — fakta per lägenhetstyp (nyckel = bildmappens namn, byt aldrig).
                    Snötorget 45 kvm = 3 rum och kök, 2 sovrum enligt SkiStars Excel
                    (Jimmy 2026-10-01; var 2 rok/1 sovrum, Mspecs-objekten hade redan Excels).
   VECKOPRIS      — SkiStars insatspris per typ och vecka (GENERERAD, se nedan).
   normalizeWeeksStr / calcBrfMonthly / summeraVeckopris — veckomodellen.

   Andelsverktygets egna ändringar ur fliken Referensdata ligger i
   localStorage 'af_aptOverrides' och läggs på i respektive sida.
   ═══════════════════════════════════════════════════════════════════════════ */

const APT_DATA = {"av1-50": {"name": "Åre Village 1 · 50 kvm", "area": "Åre", "size_sqm": 50, "size_label": "50 kvm", "rooms": "2 rum och kök", "bedrooms": "1 sovrum", "bed_count": "4 bäddar", "extras": "balkong med utsikt över Åresjön", "brf": "Brf Åre Village 1", "brf_avgift": 1602, "stad_0_6": 1281, "stad_7_11": 1619, "stad_12": 2050, "stad_jul_nyar": 2428.5, "lgh_nr": "Lgh 903, 908, 913 (C)", "sort": 1}, "av2-50": {"name": "Åre Village 2 · 50 kvm", "area": "Åre", "size_sqm": 50, "size_label": "50 kvm", "rooms": "2 rum och kök", "bedrooms": "1 sovrum", "bed_count": "4 bäddar", "extras": "balkong med utsikt över Åresjön", "brf": "Brf Åre Village 2", "brf_avgift": 1653, "stad_0_6": 1281, "stad_7_11": 1619, "stad_12": 2050, "stad_jul_nyar": 2428.5, "lgh_nr": "Lgh 917, 922, 927 (C)", "sort": 2}, "av1-83": {"name": "Åre Village 1 · 83 kvm", "area": "Åre", "size_sqm": 83, "size_label": "83 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 1", "brf_avgift": 3172, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 904, 909, 914 (D)", "sort": 3}, "av2-83": {"name": "Åre Village 2 · 83 kvm", "area": "Åre", "size_sqm": 83, "size_label": "83 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 2", "brf_avgift": 3265, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 918, 923, 928 (D)", "sort": 4}, "av1-85": {"name": "Åre Village 1 · 85 kvm", "area": "Åre", "size_sqm": 85, "size_label": "85 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 1", "brf_avgift": 3172, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 901, 905, 906, 910, 911", "sort": 5}, "av2-85": {"name": "Åre Village 2 · 85 kvm", "area": "Åre", "size_sqm": 85, "size_label": "85 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 2", "brf_avgift": 3265, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 915, 919, 920, 924, 925", "sort": 6}, "av1-87": {"name": "Åre Village 1 · 87 kvm", "area": "Åre", "size_sqm": 87, "size_label": "87 kvm", "rooms": "3 rum och kök", "bedrooms": "2-3 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 1", "brf_avgift": 3172, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 902, 907, 912", "sort": 7}, "av2-87": {"name": "Åre Village 2 · 87 kvm", "area": "Åre", "size_sqm": 87, "size_label": "87 kvm", "rooms": "3 rum och kök", "bedrooms": "2-3 sovrum", "bed_count": "8 bäddar", "extras": "balkong med utsikt över Åresjön, två badrum, bastu", "brf": "Brf Åre Village 2", "brf_avgift": 3265, "stad_0_6": 1966, "stad_7_11": 2435, "stad_12": 3146, "stad_jul_nyar": 3652.5, "lgh_nr": "Lgh 916, 921, 926", "sort": 8}, "snotorget-45": {"name": "Snötorget · 45 kvm", "area": "Sälen", "size_sqm": 45, "size_label": "45 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "4-5 bäddar", "extras": "modern planlösning", "brf": "Brf Snötorget", "brf_avgift": 2315, "stad_0_6": 1343, "stad_7_11": 1695, "stad_12": 2148, "stad_jul_nyar": 2542.5, "lgh_nr": "Våning 2: 1B, 1C, 1D", "sort": 10}, "snotorget-85": {"name": "Snötorget · 85 kvm", "area": "Sälen", "size_sqm": 85, "size_label": "85 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "6-8 bäddar", "extras": "modern planlösning", "brf": "Brf Snötorget", "brf_avgift": 3125, "stad_0_6": 2030, "stad_7_11": 2519, "stad_12": 3237, "stad_jul_nyar": 3778.5, "lgh_nr": "Våning 1-2: 2A-3D", "sort": 11}, "timmerbyn-1-46": {"name": "Timmerbyn 1 · 46 kvm", "area": "Sälen", "size_sqm": 46, "size_label": "46 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "5 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 1", "brf_avgift": 2376, "stad_0_6": 1566, "stad_7_11": 1919, "stad_12": 2506, "stad_jul_nyar": 2878.5, "lgh_nr": "Lgh 106-110C", "sort": 20}, "timmerbyn-1-100": {"name": "Timmerbyn 1 · 100 kvm", "area": "Sälen", "size_sqm": 100, "size_label": "100 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 1", "brf_avgift": 4135, "stad_0_6": 2672, "stad_7_11": 3161, "stad_12": 4275, "stad_jul_nyar": 4741.5, "lgh_nr": "Lgh 106-110A", "sort": 21}, "timmerbyn-2-46": {"name": "Timmerbyn 2 · 46 kvm", "area": "Sälen", "size_sqm": 46, "size_label": "46 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "5 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 2", "brf_avgift": 2449, "stad_0_6": 1566, "stad_7_11": 1919, "stad_12": 2506, "stad_jul_nyar": 2878.5, "lgh_nr": "Lgh 111-114C", "sort": 22}, "timmerbyn-2-100": {"name": "Timmerbyn 2 · 100 kvm", "area": "Sälen", "size_sqm": 100, "size_label": "100 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 2", "brf_avgift": 4463, "stad_0_6": 2672, "stad_7_11": 3161, "stad_12": 4275, "stad_jul_nyar": 4741.5, "lgh_nr": "Lgh 111-114B (A i ekonomiska planen)", "sort": 23}, "timmerbyn-3-46": {"name": "Timmerbyn 3 · 46 kvm", "area": "Sälen", "size_sqm": 46, "size_label": "46 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "5 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 3", "brf_avgift": 2131, "stad_0_6": 1566, "stad_7_11": 1919, "stad_12": 2506, "stad_jul_nyar": 2878.5, "lgh_nr": "Lgh 148C, 151-153C", "sort": 24}, "timmerbyn-3-100": {"name": "Timmerbyn 3 · 100 kvm", "area": "Sälen", "size_sqm": 100, "size_label": "100 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 3", "brf_avgift": 3864, "stad_0_6": 2672, "stad_7_11": 3161, "stad_12": 4275, "stad_jul_nyar": 4741.5, "lgh_nr": "Lgh 148A, 151-153A", "sort": 25}, "timmerbyn-4-54": {"name": "Timmerbyn 4 · 54 kvm", "area": "Sälen", "size_sqm": 54, "size_label": "54 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "6 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 4", "brf_avgift": 2380, "stad_0_6": 1630, "stad_7_11": 1983, "stad_12": 2607, "stad_jul_nyar": 2974.5, "lgh_nr": "Lgh 115-116C, 120-121C", "sort": 26}, "timmerbyn-4-113": {"name": "Timmerbyn 4 · 113 kvm", "area": "Sälen", "size_sqm": 113, "size_label": "113 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 4", "brf_avgift": 4140, "stad_0_6": 2796, "stad_7_11": 3285, "stad_12": 4473, "stad_jul_nyar": 4927.5, "lgh_nr": "Lgh 115-116A, 120-121B", "sort": 27}, "timmerbyn-5-54": {"name": "Timmerbyn 5 · 54 kvm", "area": "Sälen", "size_sqm": 54, "size_label": "54 kvm", "rooms": "3 rum och kök", "bedrooms": "2 sovrum", "bed_count": "6 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 5", "brf_avgift": 2303, "stad_0_6": 1630, "stad_7_11": 1983, "stad_12": 2607, "stad_jul_nyar": 2974.5, "lgh_nr": "Lgh 117-119C", "sort": 28}, "timmerbyn-5-113": {"name": "Timmerbyn 5 · 113 kvm", "area": "Sälen", "size_sqm": 113, "size_label": "113 kvm", "rooms": "4 rum och kök", "bedrooms": "3 sovrum", "bed_count": "8-10 bäddar", "extras": "bastu, parkering", "brf": "Brf Timmerbyn 5", "brf_avgift": 4444, "stad_0_6": 2796, "stad_7_11": 3285, "stad_12": 4473, "stad_jul_nyar": 4927.5, "lgh_nr": "Lgh 117-119A", "sort": 29}, "sorgardarna-80": {"name": "Sörgårdarna SAK2 · 80 kvm", "area": "Vemdalen", "size_sqm": 80, "size_label": "80 kvm", "rooms": "5 rum och kök", "bedrooms": "4 sovrum", "bed_count": "8 bäddar", "extras": "bastu", "brf": "Brf Sörgårdarna SAK 2", "brf_avgift": 2200, "stad_0_6": 2583, "stad_7_11": 3072, "stad_12": 4132, "stad_jul_nyar": 4608, "lgh_nr": "Lgh 57-60 (Sörgårdarna 57–60)", "sort": 40}};

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

// ═══ Föreningarna: adress, org.nr och Mspecs-namn ══════════════════════════
// Källa: peakfast-verktyg (HANDOFF.md 2026-06-30, salen/salen_oversikt.csv,
// salen/timmerbyn_batch.json) — uppgifterna som de 44 Sälen-objekten i Mspecs
// lades upp med, kontrollerade av Jimmy. Nyckel = APT_DATA[..].brf.
//
// mspecs_namn  = föreningens namn EXAKT som det står i Mspecs. Namnet ÄR
//                kopplingen (object.housingAssociationName) och är inkonsekvent
//                stavat där ("Bfr Timmerbyn 4") — rätta inte här utan i Mspecs.
// adress_mall  = gatuadressen, {enhet} = lägenhetsnumret ("Timmerbyn 121B").
// gata         = gatunamnet utan nummer (uppdragsnamnet: "Timmerbyn, lgh 121B, …").
// null         = okänt. Hitta inte på — fyll i när uppgiften finns.
const SALEN_GEO = { postnr: '780 91', ort: 'Sälen', omrade: 'Lindvallen-Sälen', kommun: 'Malung-Sälen', lan: 'Dalarna' };
const TIMMERBYN = Object.assign({}, SALEN_GEO, {
  gata: 'Timmerbyn', adress_mall: 'Timmerbyn {enhet}',
  byggar: 2005, renovering: 'helt renoverat 2019', vaningsplan: 1, vaningar: 1, balkong: false,
});
const SKISTAR_FORENINGAR = {
  // fastighet: ur respektive ekonomisk plan (kunskap/skistar-brf/ i datarepot).
  'Brf Timmerbyn 1': Object.assign({}, TIMMERBYN, { mspecs_namn: 'Brf Timmerbyn 1', orgnr: '769622-0735', bildad: 2010, fastighet: 'Malung-Sälen Västra Sälen 3:120' }),
  'Brf Timmerbyn 2': Object.assign({}, TIMMERBYN, { mspecs_namn: 'Brf Timmerbyn 2', orgnr: '769626-9419', bildad: 2013, fastighet: 'Malung-Sälen Västra Sälen 3:101' }),
  'Brf Timmerbyn 3': Object.assign({}, TIMMERBYN, { mspecs_namn: 'BRF Timmerbyn 3', orgnr: '769629-2817', bildad: 2014, fastighet: 'Malung-Sälen Västra Sälen 5:630' }),
  'Brf Timmerbyn 4': Object.assign({}, TIMMERBYN, { mspecs_namn: 'Bfr Timmerbyn 4', orgnr: '769632-5989', bildad: 2016, fastighet: 'Del av Malung-Sälen Västra Sälen 3:102' }),
  // Fastigheten var under bildande när planen skrevs (stamfastighet Västra Sälen 3:102).
  'Brf Timmerbyn 5': Object.assign({}, TIMMERBYN, { mspecs_namn: 'BRF Timmerbyn 5', orgnr: '769637-8160', bildad: 2019 }),
  // BRF = Snötorget, men ADRESSEN är Experiumtorget {enhet}.
  'Brf Snötorget': Object.assign({}, SALEN_GEO, {
    mspecs_namn: 'BRF Snötorget', orgnr: '769610-6009', bildad: 2011, fastighet: 'Västra Sälen 3:119',
    gata: 'Experiumtorget', adress_mall: 'Experiumtorget {enhet}', byggar: 1991, vaningar: 3,
    // 45 kvm (1B–1D) vån 3 utan balkong; 85 kvm: A+B vån 2, C+D vån 3, med balkong.
    vaningsplan_per_enhet: { '1B': 3, '1C': 3, '1D': 3, '2A': 2, '2B': 2, '3A': 2, '3B': 2, '2C': 3, '2D': 3, '3C': 3, '3D': 3 },
    balkong_per_typ: { 'snotorget-45': false, 'snotorget-85': true },
  }),
  // Åre Village: gatuadressen enligt Mspecs-projektet; org.nr, fastighet, byggår
  // och renovering ur de ekonomiska planerna. Postnummer och föreningens namn i
  // Mspecs saknas än.
  'Brf Åre Village 1': { mspecs_namn: null, orgnr: '769635-7289', bildad: 2017, fastighet: 'Åre Lien 2:70', gata: 'Årevägen', adress_mall: 'Årevägen 150', postnr: null, ort: 'Åre', kommun: 'Åre', lan: 'Jämtland', byggar: 2003, renovering: 'omfattande renovering 2017–2018', vaningar: 3 },
  'Brf Åre Village 2': { mspecs_namn: null, orgnr: '769637-8178', bildad: 2019, fastighet: 'Åre Lien 2:71', gata: 'Årevägen', adress_mall: 'Årevägen 150', postnr: null, ort: 'Åre', kommun: 'Åre', lan: 'Jämtland', byggar: 2004, renovering: 'omfattande renovering 2019', vaningar: 3 },
  // Vemdalen ("Kv Höjen"): adressen är Sörgårdarna {lgh-nr} enligt planen.
  'Brf Sörgårdarna SAK 2': { mspecs_namn: 'Brf Sörgårdarna SAK 2', orgnr: '769637-8004', bildad: 2019, fastighet: 'Vemdalens Kyrkby 56:67', gata: 'Sörgårdarna', adress_mall: 'Sörgårdarna {enhet}', postnr: '840 92', ort: 'Vemdalen', omrade: 'Vemdalsskalet', kommun: 'Härjedalen', lan: 'Jämtland', byggar: 2005, renovering: 'genomgripande renovering 2019', vaningar: 2 },
};

// Lägenhetsnumret ur fritext: "Timmerbyn 121 B" → "121B", "lgh 1d" → "1D".
// Korta tal utan bokstav ("2" i "Timmerbyn 2") räknas inte.
function lghKod(enhet) {
  const s = String(enhet || '').toUpperCase();
  const re = /(\d{1,4})\s*([A-Z])?(?![A-Z0-9])/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[2] || m[1].length >= 3) return m[1] + (m[2] || '');
  }
  return '';
}

// Föreningens fakta för en lägenhetstyp (+ lägenhet om den är känd), med
// adressen ifylld. Okända uppgifter utelämnas.
function foreningFor(aptKey, enhet) {
  const d = APT_DATA[aptKey];
  const f = d && SKISTAR_FORENINGAR[d.brf];
  if (!f) return null;
  const lghRad = typeof lagenhetFor === 'function' ? lagenhetFor(enhet) : null;
  const kod = lghKod(enhet) || (lghRad ? lghRad.kod : '');
  const ut = {};
  for (const k of Object.keys(f)) {
    if (f[k] == null || typeof f[k] === 'object' || k === 'adress_mall') continue;
    ut[k] = f[k];
  }
  if (f.adress_mall) {
    if (f.adress_mall.indexOf('{enhet}') === -1) ut.adress = f.adress_mall;
    else if (kod) ut.adress = f.adress_mall.replace('{enhet}', kod);
  }
  if (f.vaningsplan_per_enhet && kod && f.vaningsplan_per_enhet[kod] != null) ut.vaningsplan = f.vaningsplan_per_enhet[kod];
  if (lghRad && lghRad.plan != null && ut.vaningsplan == null) ut.vaningsplan = lghRad.plan;
  if (f.balkong_per_typ && f.balkong_per_typ[aptKey] != null) ut.balkong = f.balkong_per_typ[aptKey];
  if (kod) ut.enhet = kod;
  return ut;
}

// Lägenhetsnumren i APT_DATA.lgh_nr ("Lgh 111-114B", "Lgh 115-116A, 120-121B",
// "Lgh 903, 908, 913 (C)") som poster { nr, bokstav }. Bokstaven på posten går
// före en gemensam bokstav inom parentes; flera bokstäver ("(A/B/E)") betyder
// att bara numret kan matchas.
function lghPoster(lgh) {
  const s = String(lgh || '');
  const grupp = (s.match(/\(([A-Z])\)\s*$/) || [])[1] || null;
  const poster = [];
  s.replace(/\([^)]*\)/g, '').split(',').forEach(function (tok) {
    // Högst fyra siffror: ett felinlagt långt tal (org.nr, telefon) ska aldrig
    // ge en loop över ett jättespann eller förbi flyttalsprecisionen.
    const m = tok.match(/(\d{1,4})(?:\s*-\s*(\d{1,4}))?\s*([A-Z])?\b/);
    if (!m) return;
    const fran = +m[1], till = m[2] ? +m[2] : fran;
    if (till < fran || till - fran > 50) return;
    for (let n = fran; n <= till; n++) poster.push({ nr: n, bokstav: m[3] || grupp });
  });
  return poster;
}

// ═══ Lägenhetsförteckningen ur de ekonomiska planerna ═════════════════════════
// Källa: kunskap/skistar-brf/<förening>/ekonomisk*.pdf i datarepot, hämtade från
// skistar.com/sv/skistar-vacation-club/brf/ 2026-10-01 och avlästa för hand.
// Varje lägenhet: kod → { typ: APT_DATA-nyckel, kvm, rok, plan (våning) }.
// alias = beteckningar som används i Mspecs/SkiStars Excel men inte i planen.
//
// Åre Village: planen numrerar 1–14 per förening. Verktygets nummer är 900 + n
// (ÅV1) och 914 + n (ÅV2) — samma mönster som 50- och 83-kvm-lägenheterna i
// lgh_nr redan följde (903/908/913, 904/909/914 …). Därmed skiljs 85 och 87 kvm åt.
const SKISTAR_LAGENHETER = (function () {
  const ut = {};
  const lagg = (kod, typ, kvm, rok, plan, alias) => {
    ut[kod] = { typ, kvm, rok, plan: plan || null, alias: alias || null };
  };
  // Timmerbyn 1: 106–110, A = stor, C = liten.
  [106, 107, 108, 109, 110].forEach(n => { lagg(n + 'A', 'timmerbyn-1-100', 101, 4); lagg(n + 'C', 'timmerbyn-1-46', 46, 3); });
  // Timmerbyn 2: 111–114. Planen skriver A för de stora; verktyget och Excel skriver B.
  [111, 112, 113, 114].forEach(n => { lagg(n + 'A', 'timmerbyn-2-100', 101, 5, null, n + 'B'); lagg(n + 'C', 'timmerbyn-2-46', 46, 3); });
  // Timmerbyn 3: 148, 151–153.
  [148, 151, 152, 153].forEach(n => { lagg(n + 'A', 'timmerbyn-3-100', 101, 5); lagg(n + 'C', 'timmerbyn-3-46', 46, 3); });
  // Timmerbyn 4: 115A, 116A, 120B, 121B stora; C små.
  ['115A', '116A', '120B', '121B'].forEach(k => lagg(k, 'timmerbyn-4-113', 113, 5));
  ['115C', '116C', '120C', '121C'].forEach(k => lagg(k, 'timmerbyn-4-54', 54, 3));
  // Timmerbyn 5: 117–119.
  [117, 118, 119].forEach(n => { lagg(n + 'A', 'timmerbyn-5-113', 113, 5); lagg(n + 'C', 'timmerbyn-5-54', 54, 3); });
  // Snötorget (planen 2009): 85 kvm 2A–2D (vån 2) och 3A–3D (vån 3), 45 kvm 2E–2G (vån 2).
  // Mspecs-objekten och SkiStars Excel kallar 45-kvm-lägenheterna 1B, 1C, 1D.
  ['2A', '2B', '2C', '2D'].forEach(k => lagg(k, 'snotorget-85', 85, 4, 2));
  ['3A', '3B', '3C', '3D'].forEach(k => lagg(k, 'snotorget-85', 85, 4, 3));
  ['2E', '2F', '2G'].forEach(k => lagg(k, 'snotorget-45', 45, 3, 2));
  ['1B', '1C', '1D'].forEach(k => lagg(k, 'snotorget-45', 45, 3, null));
  // Åre Village 1 och 2: plan 2 = lgh 1–5, plan 3 = 6–10, plan 4 = 11–14.
  const AV = { 1: 85, 2: 87, 3: 50, 4: 83, 5: 85, 6: 85, 7: 87, 8: 50, 9: 83, 10: 85, 11: 85, 12: 87, 13: 50, 14: 83 };
  const AV_ROK = { 50: 2, 83: 3, 85: 4, 87: 4 };
  Object.keys(AV).forEach(n => {
    const kvm = AV[n], plan = n <= 5 ? 2 : n <= 10 ? 3 : 4;
    lagg(String(900 + +n), 'av1-' + kvm, kvm, AV_ROK[kvm], plan);
    lagg(String(914 + +n), 'av2-' + kvm, kvm, AV_ROK[kvm], plan);
  });
  // Sörgårdarna SAK 2 ("Kv Höjen"): 57–60, 80 kvm, adress Sörgårdarna {nr}.
  [57, 58, 59, 60].forEach(n => lagg(String(n), 'sorgardarna-80', 80, 4));
  return ut;
})();

// Lägenheten i förteckningen (koden eller ett alias), eller null.
function lagenhetFor(enhet) {
  // Tvåsiffriga nummer (Sörgårdarna 57–60) räknas bara om de finns i förteckningen.
  const tva = (String(enhet || '').match(/\b\d{2}\b/g) || []).find(x => SKISTAR_LAGENHETER[x]);
  const kod = lghKod(enhet) || tva || '';
  if (!kod) return null;
  if (SKISTAR_LAGENHETER[kod]) return Object.assign({ kod }, SKISTAR_LAGENHETER[kod]);
  for (const k of Object.keys(SKISTAR_LAGENHETER)) {
    if (SKISTAR_LAGENHETER[k].alias === kod) return Object.assign({ kod, planKod: k }, SKISTAR_LAGENHETER[k]);
  }
  return null;
}

// Lägenhetsnummer ("Timmerbyn 111B", "lgh 121 B") → APT_DATA-nyckel, men bara
// när EXAKT en typ innehåller lägenheten. Annars '' — då får någon välja.
// Åre Village 901–912 delas t.ex. av 85- och 87-kvm-typen och avgörs inte här.
function typForLgh(enhet, omrade) {
  // Förteckningen ur de ekonomiska planerna först — den är entydig per lägenhet.
  const lgh = lagenhetFor(enhet);
  if (lgh && APT_DATA[lgh.typ] && (!omrade || APT_DATA[lgh.typ].area.toLowerCase() === String(omrade).toLowerCase())) return lgh.typ;
  const kod = lghKod(enhet);
  if (!kod) return '';
  const m = kod.match(/^(\d+)([A-Z])?$/);
  const nr = +m[1], bokstav = m[2] || null;
  const omr = String(omrade || '').toLowerCase();
  const traffar = Object.keys(APT_DATA).filter(function (k) {
    if (omr && APT_DATA[k].area.toLowerCase() !== omr) return false;
    return lghPoster(APT_DATA[k].lgh_nr).some(function (p) {
      return p.nr === nr && (!bokstav || !p.bokstav || p.bokstav === bokstav);
    });
  });
  return traffar.length === 1 ? traffar[0] : '';
}
