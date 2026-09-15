# Analys av Åre Strand-affärer: HusmanHagberg-listan (Jimmys egna) + Hemnets slutpriser.
# Normaliserar objekt -> (enhet, veckor), klassar lägenhetstyp och vecka, och testar en
# multiplikativ modell log(pris) = typ + veckoklass + år.
import csv, io, re, sys, math, os
from collections import defaultdict
import numpy as np

S = os.path.dirname(os.path.abspath(__file__))

def enhet_av(namn):
    n = namn.replace('Åre Strand', '').replace('Åre strand', '').strip(' ,-')
    # villor: 13:1, 18:02, 5:B1, 5B:2
    m = re.match(r'^(\d{1,2})\s*:\s*0?(\d)\b', n)
    if m: return f'{int(m.group(1))}:{m.group(2)}', 'villa'
    m = re.match(r'^(\d)\s*:?\s*([AB])\s*:?\s*(\d)\b', n)
    if m: return f'{m.group(1)}{m.group(2)}{m.group(3)}', 'lgh'
    m = re.match(r'^(\d)\s*/?\s*([ABC])\b', n)          # 21A, 8C, 8/A5
    if m: return f'{m.group(1)}{m.group(2)}?', 'okänd'
    m = re.match(r'^(\d{1,2})\b', n)                    # "17", "6"
    if m: return f'{m.group(1)}?', 'okänd'
    return n, 'okänd'

def veckor_av(namn):
    v = [int(x) for x in re.findall(r'(?:[vV]\.?\s*|[vV]ecka\s*|[vV]\s)(\d{1,2})', namn)]
    v += [int(x) for x in re.findall(r'&\s*[vV]?\.?\s*(\d{1,2})\b', namn)]
    v += [int(x) for x in re.findall(r'[vV](?:ecka)?\s*\d{1,2}\s*&\s*(\d{1,2})', namn)]
    return sorted(set(x for x in v if 1 <= x <= 53))

def veckoklass(v):
    if v in (51, 52, 1): return 'jul_nyar'
    if 7 <= v <= 10: return 'sportlov'
    if 2 <= v <= 6: return 'vinter'
    if 11 <= v <= 13: return 'senvinter'
    if 14 <= v <= 18: return 'var'
    if 26 <= v <= 32: return 'sommar'
    return 'lag'   # 19-25, 33-50

def typklass(boarea, avgift):
    if avgift and avgift >= 800: return 'paket_1_6'
    if boarea is None: return None
    if boarea <= 60: return 'lgh_53_59'
    if boarea <= 66: return 'lgh_63'
    if boarea <= 82: return 'lgh_74_81'
    if boarea <= 96: return 'lgh_90_95'
    if boarea <= 112: return 'lgh_111'
    return 'villa_118'

rows = []
with io.open(os.path.join(S, 'hemnet_are_strand.csv'), encoding='utf-8') as f:
    for r in csv.DictReader(f, delimiter=';'):
        rows.append(dict(kalla='hemnet', datum=r['datum'], objekt=r['objekt'],
                         boarea=int(r['boarea'].split('+')[0]) if r['boarea'] else None,
                         avgift=int(r['avgift']) if r['avgift'] else None,
                         pris=int(r['slutpris']), maklare=r['maklare']))
with io.open(os.path.join(S, 'hh_are_strand.csv'), encoding='utf-8') as f:
    for r in csv.DictReader(f, delimiter=';'):
        rows.append(dict(kalla='hh', datum=r['kontraktsdag'], objekt=r['objekt'], boarea=None, avgift=None,
                         pris=int(r['slutpris']), maklare='HusmanHagberg Åre', anm=r['anm']))

# Dubbletter: HH-raden finns ofta även på Hemnet (samma pris, samma månad). Behåll Hemnet-raden (har boarea).
sedd = {}
ut = []
for r in sorted(rows, key=lambda r: (r['kalla'] != 'hemnet')):
    e, _ = enhet_av(r['objekt']); v = tuple(veckor_av(r['objekt']))
    key = (e, v, r['pris'], r['datum'][:7])
    if key in sedd: continue
    sedd[key] = True
    r['enhet'], r['typ_kalla'] = e, _
    r['veckor'] = v
    ut.append(r)

# boarea för HH-rader ur Hemnet-rader med samma enhet
area_per_enhet = defaultdict(list)
for r in ut:
    if r['boarea']: area_per_enhet[r['enhet']].append(r['boarea'])
# lägg till kända ytor ur objektsbeskrivningarna
kanda = {'13:1':105,'14:1':95,'14:2':95,'15:2':118,'17:1':118,'17:2':118,'18:1':118,'19:1':118,'19:2':118,'1A2':76,'1B2':76,
         '1B3':76,'21:2':118,'22:1':119,'22:2':118,'23:2':118,'2A4':63,'2B1':111,'2B4':63,'3A1':111,'3A3':78,'3B1':111,
         '4A1':111,'4A2':76,'5A1':91,'5B5':59,'6A1':112,'6A4':81,'6B3':78,'7A4':53,'7A5':53,'7B2':53,'7B6':74,
         '23:1':118,'18:2':118,'20:1':119,'20:2':119,'21:1':119,'5A5':59,'5A6':58,'7B4':53,'3B3':76,'2B3':76,'1A1':111}
for r in ut:
    if not r['boarea']:
        if r['enhet'] in kanda: r['boarea'] = kanda[r['enhet']]
        elif area_per_enhet[r['enhet']]: r['boarea'] = int(np.median(area_per_enhet[r['enhet']]))
    if r['avgift'] is None and 'paket' in r.get('anm', ''): r['avgift'] = 1100
    r['typ'] = typklass(r['boarea'], r['avgift'])

# Uteslut hela lägenheter (hus 8 + priser > 1,5 Mkr) och rader utan typ
hela = [r for r in ut if r['pris'] > 1_500_000 or r['enhet'].startswith('8')]
ut = [r for r in ut if r not in hela]

print(f'Rader efter dubblettrensning: {len(ut)}  (uteslutna hela lägenheter: {len(hela)})')
enkla = [r for r in ut if len(r['veckor']) == 1 and r['typ'] and r['typ'] != 'paket_1_6']
paket = [r for r in ut if r['typ'] == 'paket_1_6']
flera = [r for r in ut if len(r['veckor']) > 1]
utan = [r for r in ut if len(r['veckor']) == 0 and r['typ'] != 'paket_1_6']
print(f'  en vecka: {len(enkla)} | två veckor: {len(flera)} | 1/6-paket: {len(paket)} | vecka saknas: {len(utan)}')

# Tabell: median per typ x veckoklass
tab = defaultdict(list)
for r in enkla: tab[(r['typ'], veckoklass(r['veckor'][0]))].append(r['pris'])
typer = ['lgh_53_59','lgh_63','lgh_74_81','lgh_90_95','lgh_111','villa_118']
klasser = ['jul_nyar','sportlov','vinter','senvinter','var','sommar','lag']
print('\nMedianpris (kr) och antal per typ × veckoklass:')
print('%-12s' % '' + ''.join('%14s' % k for k in klasser))
for t in typer:
    print('%-12s' % t + ''.join('%14s' % (f"{int(np.median(tab[(t,k)])/1000)}k ({len(tab[(t,k)])})" if tab[(t,k)] else '–') for k in klasser))

# Log-linjär modell: log(pris) = a_typ + b_klass + c*(år-2023)
X, y, meta = [], [], []
tidx = {t:i for i,t in enumerate(typer)}; kidx = {k:i for i,k in enumerate(klasser)}
for r in enkla:
    t, k = r['typ'], veckoklass(r['veckor'][0])
    if t not in tidx: continue
    x = np.zeros(len(typer) + len(klasser) - 1 + 1)
    x[tidx[t]] = 1
    if kidx[k] > 0: x[len(typer) + kidx[k] - 1] = 1
    x[-1] = int(r['datum'][:4]) - 2023
    X.append(x); y.append(math.log(r['pris'])); meta.append(r)
X = np.array(X); y = np.array(y)
beta, *_ = np.linalg.lstsq(X, y, rcond=None)
pred = X @ beta
res = y - pred
print(f'\nModell på {len(y)} enveckasaffärer:')
print('  Bas per typ (jul/nyår, 2023):', {t: int(math.exp(beta[i])) for t,i in tidx.items()})
print('  Veckofaktor vs jul/nyår:', {k: round(math.exp(beta[len(typer)+i-1]),2) for k,i in kidx.items() if i>0})
print(f'  Årsfaktor: {math.exp(beta[-1]):.3f} per år')
mape = np.median(np.abs(np.exp(res) - 1))
print(f'  Median absolut fel: {mape*100:.0f} % | inom ±25 %: {np.mean(np.abs(np.exp(res)-1) < 0.25)*100:.0f} % | inom ±40 %: {np.mean(np.abs(np.exp(res)-1) < 0.40)*100:.0f} %')
print('\nStörsta avvikelserna:')
for i in np.argsort(-np.abs(res))[:8]:
    r = meta[i]; print(f"  {r['datum']} {r['objekt']:34} {r['pris']:>8} kr  modell {int(math.exp(pred[i])):>8} kr  ({(math.exp(res[i])-1)*100:+.0f} %)")

# Spara den rensade datamängden
with io.open(os.path.join(S, 'are_strand_affarer.csv'), 'w', encoding='utf-8', newline='') as f:
    w = csv.writer(f, delimiter=';')
    w.writerow(['datum','enhet','veckor','typ','boarea','avgift','pris','maklare','kalla','objekt'])
    for r in sorted(ut, key=lambda r: r['datum'], reverse=True):
        w.writerow([r['datum'], r['enhet'], '+'.join(map(str, r['veckor'])), r['typ'] or '', r['boarea'] or '', r['avgift'] or '', r['pris'], r['maklare'], r['kalla'], r['objekt']])
print('\nSparat: are_strand_affarer.csv')
