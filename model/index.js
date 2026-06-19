/**
 * 서울 아파트 실거래가 AI 추론 모듈 (LightGBM + 단지 lookup · 실공공데이터)
 *
 * 내보내는 함수:
 *   predict(gu, area, floor, buildYear, complex?)
 *     → {prediction, lower_bound, upper_bound, confidence, feature_importance,
 *        investment_signal, market_median, market_deviation_pct, used_complex}
 *   getDistrictStats()   → {구명: {avg,min,max,q25,q75}, ...}
 *   getTrends(gu)        → [{year,month,price}, ...]
 *   getComplexes(gu)     → [{name,avg,n,q25,q75}, ...]
 *
 * 모델: LightGBM 1000트리, 실거래 67,430건 (국토부 2023~2024)
 * MAE  (단지 미선택): ~10,242만원 | (단지 선택 시): ~6,000~7,000만원 수준
 * P95 추론 레이턴시: 1ms 이하
 */

'use strict';

const path  = require('path');
const model = require(path.join(__dirname, 'model.json'));

// ── 상수 캐시 ─────────────────────────────────────────────────────────────
const LR             = model.learning_rate;
const INIT           = model.init_prediction;
const SCALE_MEAN     = model.scale.mean;
const SCALE_STD      = model.scale.std;
const ESTIMATORS     = model.estimators;
const DISTRICT_ENC   = model.district_encoding;
const DISTRICT_STATS = model.district_stats;
const TRENDS         = model.trends;
const FI             = model.feature_importances;
const GAAG_TABLE     = model.gaag_table;
const GLOBAL_MEAN    = model.global_mean_price;
const CURRENT_YEAR   = 2024;

// 단지 lookup (model.json에 추가된 테이블)
const CPLX_AREA_TABLE = model.complex_area_table  || {};  // "단지명|area_b5" → 평균가
const CPLX_MEAN_TABLE = model.complex_mean_table  || {};  // "단지명" → 평균가
const GU_COMPLEXES    = model.gu_complexes        || {};  // 구 → [{name,avg,n}]

// 피처 표시명
const FEATURE_DISPLAY = {
  gu_idx:           '구(지역)',
  area:             '전용면적',
  floor:            '층',
  age:              '연식',
  gu_area_age_mean: '구×면적×연식기준가',
  area_sq:          '면적제곱',
  age_sq:           '연식제곱',
  area_x_age:       '면적×연식',
  floor_x_area:     '층×면적',
  log_area:         '면적로그',
};

// ── 트리 추론 (비재귀 — P95 최적화) ─────────────────────────────────────
function traverseTree(node, features) {
  let cur = node;
  while (true) {
    if ('v' in cur) return cur.v;
    cur = features[cur.f] <= cur.t ? cur.l : cur.r;
  }
}

// ── 표준화 ───────────────────────────────────────────────────────────────
function standardize(raw) {
  return raw.map((v, i) => (v - SCALE_MEAN[i]) / SCALE_STD[i]);
}

// ── gu_area_age_mean lookup (기존) ──────────────────────────────────────
function lookupGuAreaAgeMean(guIdx, area, age) {
  const ab  = Math.floor(area / 10) * 10;
  const agb = Math.floor(age  / 5)  * 5;
  const key = `${guIdx}_${ab}_${agb}`;
  return GAAG_TABLE[key] !== undefined ? GAAG_TABLE[key] : GLOBAL_MEAN;
}

// ── 단지 lookup ──────────────────────────────────────────────────────────
function lookupComplexPrice(complex, area) {
  if (!complex) return null;
  const ab5 = Math.floor(area / 5) * 5;
  const k1  = `${complex}|${ab5}`;
  if (CPLX_AREA_TABLE[k1] !== undefined) return CPLX_AREA_TABLE[k1];
  if (CPLX_MEAN_TABLE[complex] !== undefined) return CPLX_MEAN_TABLE[complex];
  return null;
}

// ── 10개 피처 벡터 생성 ───────────────────────────────────────────────────
function buildFeatures(guIdx, area, floor, age) {
  const gaagMean = lookupGuAreaAgeMean(guIdx, area, age);
  return [
    guIdx,
    area,
    floor,
    age,
    gaagMean,
    area  * area,
    age   * age,
    area  * age,
    floor * area,
    Math.log(area),
  ];
}

// ── LightGBM 기반 예측 ───────────────────────────────────────────────────
function predictLGBM(guIdx, area, floor, age) {
  const rawFeatures = buildFeatures(guIdx, area, floor, age);
  const features    = standardize(rawFeatures);

  let prediction = INIT;
  for (let i = 0; i < ESTIMATORS.length; i++) {
    prediction += LR * traverseTree(ESTIMATORS[i], features);
  }
  // 외삽 클리핑 (구×면적×연식 평균의 1.7배 초과 억제)
  const gaagMean = lookupGuAreaAgeMean(guIdx, area, age);
  prediction = Math.min(prediction, gaagMean * 1.7);
  return Math.round(Math.max(10_000, prediction));
}

// ── 신뢰구간 산출 ────────────────────────────────────────────────────────
function computeInterval(prediction, stats, usedComplex) {
  const iqr    = stats.q75 - stats.q25;
  // 단지 선택 시: 좁은 구간(IQR×0.25), 미선택 시: 넓은 구간(IQR×0.40)
  const factor = usedComplex ? 0.25 : 0.40;
  const margin = iqr * factor;
  const lower  = Math.round(Math.max(10_000, prediction - margin));
  const upper  = Math.round(prediction + margin);

  const deviation = Math.abs(prediction - stats.avg) / stats.avg;
  // 단지 선택 시: 더 높은 기본 confidence
  const base = usedComplex ? 0.72 : 0.55;
  const confidence = parseFloat(
    Math.max(base, Math.min(0.97, 1 - deviation * 0.5)).toFixed(3)
  );

  return { lower, upper, confidence };
}

// ── 투자 신호 판정 ───────────────────────────────────────────────────────
function evaluateSignal(prediction, stats) {
  const median = (stats.q25 + stats.q75) / 2;
  const ratio  = (prediction - median) / median;
  if (ratio < -0.10) return 'undervalued';
  if (ratio >  0.10) return 'overvalued';
  return 'fair';
}

// ── predict ─────────────────────────────────────────────────────────────
/**
 * @param {string}  gu        구 이름 (서울 25개 구)
 * @param {number}  area      전용면적 m²
 * @param {number}  floor     층수
 * @param {number}  buildYear 건축연도
 * @param {string=} complex   단지명 (선택 — 제공 시 정확도 대폭 향상)
 */
function predict(gu, area, floor, buildYear, complex) {
  // 입력 유효성
  if (typeof gu !== 'string' || !(gu in DISTRICT_ENC)) {
    throw new Error(`Unknown district: "${gu}". 서울 25개 구 중 하나를 입력하세요.`);
  }
  if (!Number.isFinite(area)  || area  <= 0 || area  > 500) {
    throw new Error(`area 범위 오류: ${area} (0 < area ≤ 500 m²)`);
  }
  if (!Number.isFinite(floor) || floor <= 0 || floor > 100) {
    throw new Error(`floor 범위 오류: ${floor} (1 ≤ floor ≤ 100)`);
  }
  if (!Number.isFinite(buildYear) || buildYear < 1960 || buildYear > CURRENT_YEAR) {
    throw new Error(`buildYear 범위 오류: ${buildYear} (1960 ≤ buildYear ≤ ${CURRENT_YEAR})`);
  }

  const guIdx = DISTRICT_ENC[gu];
  const age   = CURRENT_YEAR - buildYear;
  const stats = DISTRICT_STATS[gu];

  // 단지 lookup 시도
  const complexPrice = lookupComplexPrice(complex || null, area);
  const usedComplex  = complexPrice !== null;

  let prediction;
  if (usedComplex) {
    // 단지+면적 평균을 기준으로 층수 보정
    // 층수 효과: LightGBM 예측값에서 층수 항만 추출하는 것은 복잡하므로
    // 단지 평균 + 간단한 층 보정 (데이터로 추정된 층당 ~50~150만원)
    const lgbmPred    = predictLGBM(guIdx, area, floor, age);
    const lgbmNoFloor = predictLGBM(guIdx, area, 5, age);   // 중간층(5층) 기준
    const floorEffect = lgbmPred - lgbmNoFloor;             // 층 효과만 분리
    prediction = Math.round(complexPrice + floorEffect);
    prediction = Math.max(10_000, prediction);
  } else {
    prediction = predictLGBM(guIdx, area, floor, age);
  }

  const { lower, upper, confidence } = computeInterval(prediction, stats, usedComplex);
  const signal   = evaluateSignal(prediction, stats);
  const median   = Math.round((stats.q25 + stats.q75) / 2);
  const devPct   = parseFloat(((prediction - median) / median * 100).toFixed(1));

  // FI 객체 → [{feature, importance, display_name}] 배열 (상위 5개, 중요도 내림차순)
  const fiArray = Object.entries(FI)
    .map(([feature, importance]) => ({
      feature,
      importance: parseFloat(importance.toFixed(4)),
      display_name: FEATURE_DISPLAY[feature] || feature,
    }))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 5);

  return {
    prediction,
    lower_bound:          lower,
    upper_bound:          upper,
    confidence,
    feature_importance:   fiArray,
    feature_display:      FEATURE_DISPLAY,
    investment_signal:    signal,
    market_median:        median,
    market_deviation_pct: devPct,
    used_complex:         usedComplex,   // 단지 선택 여부 (UI 표시용)
    complex_name:         complex || null,
  };
}

// ── getDistrictStats ─────────────────────────────────────────────────────
function getDistrictStats() {
  return DISTRICT_STATS;
}

// ── getTrends ─────────────────────────────────────────────────────────────
function getTrends(gu) {
  if (!(gu in TRENDS)) throw new Error(`Unknown district: "${gu}"`);
  return TRENDS[gu];
}

// ── getComplexes ──────────────────────────────────────────────────────────
/**
 * 특정 구의 아파트 단지 목록 반환 (거래 2건 이상, 평균가 내림차순)
 * @param {string} gu
 * @returns {{name:string, avg:number, n:number, q25:number, q75:number}[]}
 */
function getComplexes(gu) {
  return GU_COMPLEXES[gu] || [];
}

module.exports = { predict, getDistrictStats, getTrends, getComplexes };
