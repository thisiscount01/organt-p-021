"""
단지명(complex_name) 기반 lookup table 생성 + model.json에 병합
- 기존 LightGBM 모델은 유지 (재훈련 없음)
- complex_area_mean, complex_mean, gu_complexes 테이블을 추가해 model.json 확장
- 기대 MAE 개선: 10,242만 → 4,000~6,000만 수준
"""

import pandas as pd, numpy as np, json, os

BASE = os.path.dirname(__file__)
df = pd.read_csv(os.path.join(BASE,'seoul_apt_raw.csv'), encoding='utf-8-sig')
for c in ['area','floor','built_year','price']:
    df[c] = pd.to_numeric(df[c], errors='coerce')
df = df.dropna(subset=['gu','area','floor','built_year','price','complex_name'])

DISTRICTS = ["강남구","서초구","송파구","용산구","성동구","마포구","광진구","서대문구","동작구","강동구",
             "영등포구","강서구","양천구","노원구","구로구","동대문구","성북구","은평구","관악구","중구",
             "종로구","금천구","강북구","도봉구","중랑구"]
DISTRICT_ENC = {n:i for i,n in enumerate(DISTRICTS)}
df = df[df['gu'].isin(DISTRICT_ENC)]
df['age'] = 2024 - df['built_year']
df = df[(df['area']>10)&(df['area']<400)&(df['floor']>=1)&(df['floor']<=80)&
        (df['age']>=0)&(df['age']<=60)&(df['price']>3000)&(df['price']<500000)]

# 이상치 제거 (구별 1%~99%)
parts = []
for gu, grp in df.groupby('gu'):
    lo, hi = grp['price'].quantile([0.01, 0.99])
    parts.append(grp[(grp['price']>=lo)&(grp['price']<=hi)])
df = pd.concat(parts, ignore_index=True)
print(f"전처리 후: {len(df):,}행")

df['area_b5'] = (df['area']//5*5).astype(int)
df['age_b5']  = (df['age']//5*5).astype(int)

# ── 단지+면적구간 평균 lookup ─────────────────────────────────────────────
cplx_area_mean = df.groupby(['complex_name','area_b5'])['price'].mean()
cplx_area_table = {}
for (cplx, ab), mean_p in cplx_area_mean.items():
    k = f"{cplx}|{int(ab)}"
    cplx_area_table[k] = round(float(mean_p), 1)

# ── 단지 전체 평균 lookup ─────────────────────────────────────────────────
cplx_mean_table = {}
for cplx, mean_p in df.groupby('complex_name')['price'].mean().items():
    cplx_mean_table[cplx] = round(float(mean_p), 1)

# ── gu→complexes 드롭다운용 ───────────────────────────────────────────────
gu_complexes = {}
for gu in DISTRICTS:
    sub = df[df['gu']==gu]
    stats = sub.groupby('complex_name').agg(n=('price','count'), avg=('price','mean'), q25=('price', lambda x: x.quantile(0.25)), q75=('price', lambda x: x.quantile(0.75)))
    stats = stats[stats['n'] >= 2].sort_values('avg', ascending=False)
    gu_complexes[gu] = [
        {'name': idx, 'avg': int(round(v['avg'])), 'n': int(v['n']),
         'q25': int(round(v['q25'])), 'q75': int(round(v['q75']))}
        for idx, v in stats.iterrows()
    ]

print(f"단지 lookup 엔트리: cplx_area={len(cplx_area_table)}, cplx={len(cplx_mean_table)}")
print(f"gu→complexes 단지 수: {sum(len(v) for v in gu_complexes.values())}")

# ── MAE 검증 (in-sample lookup precision) ────────────────────────────────
df['pred_cplx'] = df.apply(
    lambda r: cplx_area_table.get(f"{r['complex_name']}|{r['area_b5']}",
              cplx_mean_table.get(r['complex_name'], 103460.0)), axis=1)
mae = (df['price'] - df['pred_cplx']).abs().mean()
print(f"단지+면적 lookup MAE (in-sample): {mae:.0f} 만원")

# ── model.json 로드 후 병합 ───────────────────────────────────────────────
model_path = os.path.join(BASE, 'model.json')
with open(model_path, encoding='utf-8') as f:
    model = json.load(f)

model['complex_area_table'] = cplx_area_table
model['complex_mean_table'] = cplx_mean_table
model['gu_complexes']       = gu_complexes
model['has_complex_lookup'] = True

with open(model_path, 'w', encoding='utf-8') as f:
    json.dump(model, f, ensure_ascii=False)

size_kb = os.path.getsize(model_path) / 1024
print(f"\nmodel.json 업데이트 완료: {size_kb:.1f} KB")
print("complex lookup 테이블 추가 완료 → predict()에서 단지 정보 활용 가능")
