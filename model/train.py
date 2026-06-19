"""
서울 아파트 실거래가 AI 모델 학습 (실 공공데이터 최종판)
- 국토교통부 실거래가 2023~2024, 67,430건
- Inference 가능한 피처만 사용: gu, area, floor, age + 파생 피처
- LightGBM 학습 후 모델 구조를 JSON으로 직렬화 (Node.js 호환)
- 달성 가능 MAE ~10,000~12,000만원 (4피처 실데이터 한계 투명 보고)
"""

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
import lightgbm as lgb
import json, os, sys, warnings, time
warnings.filterwarnings("ignore")

CURRENT_YEAR = 2024

DISTRICTS_ORDER = [
    "강남구", "서초구", "송파구", "용산구", "성동구",
    "마포구", "광진구", "서대문구", "동작구", "강동구",
    "영등포구", "강서구", "양천구", "노원구", "구로구",
    "동대문구", "성북구", "은평구", "관악구", "중구",
    "종로구", "금천구", "강북구", "도봉구", "중랑구",
]
DISTRICT_ENCODING = {name: idx for idx, name in enumerate(DISTRICTS_ORDER)}

# ── 데이터 로드 ──────────────────────────────────────────────────────────────
data_path = os.path.join(os.path.dirname(__file__), "seoul_apt_raw.csv")
df = pd.read_csv(data_path, encoding="utf-8-sig")
print(f"원본: {len(df):,}행")

for c in ["area", "floor", "built_year", "price"]:
    df[c] = pd.to_numeric(df[c], errors="coerce")
df = df.dropna(subset=["gu", "area", "floor", "built_year", "price"])
df = df[df["gu"].isin(DISTRICT_ENCODING)]
df["age"]    = (CURRENT_YEAR - df["built_year"]).astype(float)
df["gu_idx"] = df["gu"].map(DISTRICT_ENCODING)

df = df[
    (df["area"]  >  10) & (df["area"]  < 400)  &
    (df["floor"] >=  1) & (df["floor"] <=  80) &
    (df["age"]   >=  0) & (df["age"]   <=  60) &
    (df["price"] > 3000) & (df["price"] < 500000)
]
parts = []
for gu, grp in df.groupby("gu"):
    lo, hi = grp["price"].quantile([0.01, 0.99])
    parts.append(grp[(grp["price"] >= lo) & (grp["price"] <= hi)])
df = pd.concat(parts, ignore_index=True)
print(f"전처리 후: {len(df):,}행  구={df['gu'].nunique()}")

# ── 구별 통계 먼저 계산 (도메인 지식으로 피처 생성용) ───────────────────────
gu_area_age_mean = df.groupby(["gu_idx",
    df["area"].apply(lambda x: int(x/10)*10),    # area_bin
    df["age"].apply(lambda x: int(x/5)*5)         # age_bin
])["price"].mean()

# 각 행에 구×면적구간×연식구간 평균가 매핑
df["area_b"]  = df["area"].apply(lambda x: int(x/10)*10)
df["age_b"]   = df["age"].apply(lambda x: int(x/5)*5)
df["gu_area_age_mean"] = df.apply(
    lambda r: gu_area_age_mean.get((r["gu_idx"], r["area_b"], r["age_b"]),
                                    df["price"].mean()),
    axis=1
)
print(f"구×면적×연식 그룹 평균 피처 생성: {gu_area_age_mean.shape[0]}개 그룹")

# ── inference 가능 피처 (predict 함수 입력 = gu, area, floor, buildYear) ───
FEATURES = [
    "gu_idx",
    "area",
    "floor",
    "age",
    "gu_area_age_mean",   # ← 구+면적구간+연식구간 평균가 (inference 가능)
    "area_sq",
    "age_sq",
    "area_x_age",
    "floor_x_area",
    "log_area",
]

df["area_sq"]     = df["area"] ** 2
df["age_sq"]      = df["age"]  ** 2
df["area_x_age"]  = df["area"] * df["age"]
df["floor_x_area"]= df["floor"] * df["area"]
df["log_area"]    = np.log(df["area"])

X = df[FEATURES].values
y = df["price"].values
print(f"학습 데이터: {X.shape}")

X_tr, X_val, y_tr, y_val = train_test_split(X, y, test_size=0.15, random_state=42)

scaler = StandardScaler()
X_tr_s  = scaler.fit_transform(X_tr)
X_val_s = scaler.transform(X_val)

# ── LightGBM 학습 ────────────────────────────────────────────────────────────
print("\nLightGBM 학습...")
t0 = time.time()
lgbm = lgb.LGBMRegressor(
    objective="regression_l1",
    n_estimators=1000, learning_rate=0.04,
    max_depth=8, num_leaves=127,
    min_child_samples=3, subsample=0.85, subsample_freq=1,
    colsample_bytree=0.85, reg_alpha=0.05, reg_lambda=0.05,
    random_state=42, verbose=-1,
)
lgbm.fit(X_tr_s, y_tr,
         eval_set=[(X_val_s, y_val)],
         callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(0)])
lgb_pred = lgbm.predict(X_val_s)
lgb_mae  = mean_absolute_error(y_val, lgb_pred)
lgb_mape = np.mean(np.abs((y_val - lgb_pred) / y_val)) * 100
print(f"  LightGBM MAE: {lgb_mae:,.0f} 만원  ({time.time()-t0:.1f}s)")
print(f"  LightGBM MAPE: {lgb_mape:.1f}%")

# ── LightGBM 트리를 Node.js 호환 JSON으로 직렬화 ─────────────────────────────
# LightGBM 내부 트리 구조를 index.js가 읽을 수 있는 형식으로 변환
print("LightGBM 트리 JSON 직렬화...")
lgb_model_json = lgbm.booster_.dump_model()
trees_raw = lgb_model_json["tree_info"]
print(f"  트리 수: {len(trees_raw)}")

def convert_lgb_tree(node):
    """LightGBM tree node → {f, t, l, r} 또는 {v}"""
    if "leaf_value" in node:
        return {"v": float(node["leaf_value"])}
    return {
        "f": int(node["split_feature"]),
        "t": float(node["threshold"]),
        "l": convert_lgb_tree(node["left_child"]),
        "r": convert_lgb_tree(node["right_child"]),
    }

estimators_json = []
for tree_info in trees_raw:
    estimators_json.append(convert_lgb_tree(tree_info["tree_structure"]))

print(f"  직렬화 완료: {len(estimators_json)}개 트리")

# LightGBM 피처 중요도
lgb_fi = lgbm.booster_.feature_importance(importance_type="gain")
lgb_fi_norm = lgb_fi / lgb_fi.sum()
feature_importances = {n: round(float(v), 4) for n, v in zip(FEATURES, lgb_fi_norm)}
print(f"  피처 중요도 (상위5): {dict(sorted(feature_importances.items(),key=lambda x:-x[1])[:5])}")

# ── LightGBM 추론 로직 (Node.js용) ────────────────────────────────────────────
# LightGBM inference: initial_score + sum(learning_rate * leaf_value)
# NOTE: LightGBM과 sklearn GBM의 직렬화 형식은 동일하게 유지
lgb_init = lgb_model_json.get("average_output", float(np.mean(y_tr)))
lgb_lr   = lgbm.booster_.num_trees()  # leaf responses already scaled by lr in dump

# 실제로 LightGBM dump_model의 leaf_value는 이미 학습률 적용된 값
# init_prediction = mean(y_train)
init_pred = float(np.mean(y_tr))
learning_rate = 1.0  # LightGBM leaf_value가 이미 lr 반영됨

# ── 구별 통계 ────────────────────────────────────────────────────────────────
district_stats = {}
for gu in DISTRICTS_ORDER:
    grp = df.loc[df["gu"] == gu, "price"]
    base = grp if len(grp) > 0 else df["price"]
    district_stats[gu] = {
        "avg": int(round(float(base.mean()))),
        "min": int(round(float(base.min()))),
        "max": int(round(float(base.max()))),
        "q25": int(round(float(base.quantile(0.25)))),
        "q75": int(round(float(base.quantile(0.75)))),
    }

# ── 월별 추이 ────────────────────────────────────────────────────────────────
trends = {}
if "deal_ym" in df.columns:
    df["deal_ym_n"] = pd.to_numeric(df["deal_ym"], errors="coerce").fillna(202306)
    for gu in DISTRICTS_ORDER:
        sub = df[df["gu"] == gu]
        ym_avg = sub.groupby("deal_ym_n")["price"].mean()
        monthly = sorted(
            [{"year": int(ym)//100, "month": int(ym)%100, "price": int(round(p))}
             for ym, p in ym_avg.items()],
            key=lambda x: x["year"]*100+x["month"]
        )
        trends[gu] = monthly if monthly else [
            {"year": 2024, "month": m, "price": district_stats[gu]["avg"]}
            for m in range(1,13)]
else:
    for gu in DISTRICTS_ORDER:
        avg = district_stats[gu]["avg"]
        trends[gu] = [{"year": 2024, "month": m, "price": avg} for m in range(1,13)]

# ── gu_area_age_mean 인코딩 테이블 (inference용) ─────────────────────────────
gaag_table = {}
for (gu_i, ab, agb), mean_p in gu_area_age_mean.items():
    key = f"{int(gu_i)}_{int(ab)}_{int(agb)}"
    gaag_table[key] = round(float(mean_p), 1)

global_mean_price = float(df["price"].mean())

# ── model.json 저장 ──────────────────────────────────────────────────────────
model_data = {
    "learning_rate":      learning_rate,
    "init_prediction":    init_pred,
    "n_features":         len(FEATURES),
    "feature_names":      FEATURES,
    "feature_display": {
        "gu_idx": "구(지역)", "area": "전용면적", "floor": "층", "age": "연식",
        "gu_area_age_mean": "구×면적×연식기준가", "area_sq": "면적제곱",
        "age_sq": "연식제곱", "area_x_age": "면적×연식",
        "floor_x_area": "층×면적", "log_area": "면적로그",
    },
    "scale": {
        "mean": [float(v) for v in scaler.mean_],
        "std":  [float(v) for v in scaler.scale_],
    },
    "estimators":          estimators_json,
    "mae":                 round(float(lgb_mae), 2),
    "feature_importances": feature_importances,
    "district_encoding":   DISTRICT_ENCODING,
    "district_stats":      district_stats,
    "trends":              trends,
    # 추론용 조회 테이블
    "gaag_table":          gaag_table,
    "global_mean_price":   round(global_mean_price, 1),
    "data_source":         "국토교통부 실거래가 공개시스템 (rt.molit.go.kr)",
    "data_records":        int(len(df)),
    "data_years":          "2023~2024",
}

out_path = os.path.join(os.path.dirname(__file__), "model.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(model_data, f, ensure_ascii=False)

size_kb = os.path.getsize(out_path) / 1024
print(f"\n=== 최종 ===")
print(f"model.json: {size_kb:.1f} KB")
print(f"MAE: {lgb_mae:,.0f} 만원  ({'✓' if lgb_mae<=3000 else f'목표(3,000) 대비 {lgb_mae/3000:.1f}x'})")
print(f"MAPE: {lgb_mape:.1f}%")
print(f"데이터: {len(df):,}건 (국토부 실거래 2023~2024)")
print(f"트리: {len(estimators_json)}개")
