'use strict';

/**
 * 서울 아파트 실거래가 AI 예측 웹서비스 — 백엔드 서버
 * 엔드포인트: POST /api/predict, GET /api/districts,
 *             GET /api/trends/:gu, GET /api/health
 */

const express  = require('express');
const path     = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const app  = express();

// ── 모델 Eager 로드 (cold start에서 즉시 실패 감지) ───────────────────────
let model          = null;
let modelLoadError = null;

try {
  model = require('./model/index.js');
  console.log('[server] 모델 로드 완료');
} catch (err) {
  modelLoadError = err;
  console.error('[server] 모델 로드 실패:', err.message);
}

// ── 미들웨어 ──────────────────────────────────────────────────────────────
app.use(express.json());

// CORS (외부 접근 허용)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 요청 로그
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// public/ 정적 파일 서빙
app.use(express.static(path.join(__dirname, 'public')));

// ── 공통: 모델 가용성 게이트 ───────────────────────────────────────────────
function requireModel(req, res, next) {
  if (modelLoadError || !model) {
    return res.status(503).json({
      status : 'error',
      code   : 'MODEL_UNAVAILABLE',
      message: '모델 로드에 실패했습니다. 서버를 재시작하거나 잠시 후 다시 시도해주세요.',
    });
  }
  next();
}

// ── 서울 25개 구 (유효 enum — 판정은 서버 단일) ───────────────────────────
const VALID_GU = new Set([
  '강남구','강동구','강북구','강서구','관악구','광진구','구로구','금천구',
  '노원구','도봉구','동대문구','동작구','마포구','서대문구','서초구','성동구',
  '성북구','송파구','양천구','영등포구','용산구','은평구','종로구','중구','중랑구',
]);

// ── 입력 유효성 검사 (백엔드 권위: 모든 판정 함수는 여기서만) ───────────────
function validatePredict(body) {
  const errs = [];

  // gu
  if (body.gu == null || body.gu === '') {
    errs.push('gu 필드가 필요합니다 (서울 25개 구 중 하나).');
  } else if (!VALID_GU.has(String(body.gu))) {
    errs.push(`gu 값이 유효하지 않습니다: "${body.gu}". 서울 25개 구 중 하나를 입력하세요.`);
  }

  // area
  if (body.area == null) {
    errs.push('area 필드가 필요합니다 (전용면적 m²).');
  } else {
    const v = Number(body.area);
    if (!Number.isFinite(v) || v <= 0 || v > 500) {
      errs.push(`area 범위 오류: ${body.area} (허용 범위: 0 < area ≤ 500 m²)`);
    }
  }

  // floor
  if (body.floor == null) {
    errs.push('floor 필드가 필요합니다 (층수).');
  } else {
    const v = Number(body.floor);
    if (!Number.isFinite(v) || v <= 0 || v > 100) {
      errs.push(`floor 범위 오류: ${body.floor} (허용 범위: 1 ≤ floor ≤ 100)`);
    }
  }

  // built
  if (body.built == null) {
    errs.push('built 필드가 필요합니다 (건축연도).');
  } else {
    const v = Number(body.built);
    if (!Number.isFinite(v) || v < 1960 || v > 2024) {
      errs.push(`built 범위 오류: ${body.built} (허용 범위: 1960 ≤ built ≤ 2024)`);
    }
  }

  // complex (선택 필드 — 제공 시 문자열만 허용)
  if (body.complex != null && typeof body.complex !== 'string') {
    errs.push('complex 필드는 문자열이어야 합니다 (단지명).');
  }

  return errs;
}

// ────────────────────────────────────────────────────────────────────────────
// 라우트
// ────────────────────────────────────────────────────────────────────────────

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status   : 'ok',
    model    : modelLoadError ? 'unavailable' : 'loaded',
    uptime_s : Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// POST /api/predict
app.post('/api/predict', requireModel, (req, res) => {
  const body = req.body || {};

  const errs = validatePredict(body);
  if (errs.length > 0) {
    return res.status(400).json({
      status : 'error',
      code   : 'INVALID_INPUT',
      message: errs[0],   // 첫 번째 오류를 대표 메시지로
      errors : errs,
    });
  }

  const gu        = String(body.gu);
  const area      = Number(body.area);
  const floor     = Number(body.floor);
  const buildYear = Number(body.built);
  const complex   = body.complex ? String(body.complex).trim() : undefined;

  try {
    const result = model.predict(gu, area, floor, buildYear, complex);
    return res.json({ status: 'ok', result });
  } catch (err) {
    // predict() 내부 유효성 예외 → 400
    if (err.message && (
      err.message.includes('범위 오류') ||
      err.message.includes('Unknown district')
    )) {
      return res.status(400).json({
        status : 'error',
        code   : 'INVALID_INPUT',
        message: err.message,
      });
    }
    // 예상치 못한 내부 오류 → 500
    console.error('[predict error]', err);
    return res.status(500).json({
      status : 'error',
      code   : 'INTERNAL_ERROR',
      message: '예측 중 내부 오류가 발생했습니다.',
    });
  }
});

// GET /api/districts
app.get('/api/districts', requireModel, (req, res) => {
  try {
    const stats  = model.getDistrictStats();
    // Object → Array (프론트엔드가 배열로 소비)
    const result = Object.entries(stats).map(([gu, s]) => ({
      gu,
      avg   : s.avg,
      min   : s.min,
      max   : s.max,
      q25   : s.q25,
      q75   : s.q75,
      median: Math.round((s.q25 + s.q75) / 2),
    }));
    // 평균 가격 내림차순 정렬 (지도 choropleth 범례 편의)
    result.sort((a, b) => b.avg - a.avg);
    res.json({ status: 'ok', count: result.length, result });
  } catch (err) {
    console.error('[districts error]', err);
    res.status(500).json({
      status : 'error',
      code   : 'INTERNAL_ERROR',
      message: '시세 통계 조회 중 오류가 발생했습니다.',
    });
  }
});

// GET /api/trends/:gu
app.get('/api/trends/:gu', requireModel, (req, res) => {
  const gu = decodeURIComponent(req.params.gu);

  if (!VALID_GU.has(gu)) {
    return res.status(400).json({
      status : 'error',
      code   : 'INVALID_INPUT',
      message: `구 이름이 유효하지 않습니다: "${gu}". 서울 25개 구 중 하나를 입력하세요.`,
    });
  }

  try {
    const trends = model.getTrends(gu);
    res.json({ status: 'ok', gu, count: trends.length, result: trends });
  } catch (err) {
    if (err.message && err.message.includes('Unknown district')) {
      return res.status(400).json({
        status : 'error',
        code   : 'INVALID_INPUT',
        message: `구 이름이 유효하지 않습니다: "${gu}"`,
      });
    }
    console.error('[trends error]', err);
    res.status(500).json({
      status : 'error',
      code   : 'INTERNAL_ERROR',
      message: '추이 조회 중 오류가 발생했습니다.',
    });
  }
});

// GET /api/complexes/:gu  ─ 구별 아파트 단지 목록
app.get('/api/complexes/:gu', requireModel, (req, res) => {
  const gu = decodeURIComponent(req.params.gu);

  if (!VALID_GU.has(gu)) {
    return res.status(400).json({
      status : 'error',
      code   : 'INVALID_INPUT',
      message: `구 이름이 유효하지 않습니다: "${gu}".`,
    });
  }

  try {
    const complexes = model.getComplexes(gu);
    res.json({ status: 'ok', gu, count: complexes.length, result: complexes });
  } catch (err) {
    console.error('[complexes error]', err);
    res.status(500).json({
      status : 'error',
      code   : 'INTERNAL_ERROR',
      message: '단지 목록 조회 중 오류가 발생했습니다.',
    });
  }
});

// ── 404 핸들러 ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    status : 'error',
    code   : 'NOT_FOUND',
    message: `${req.method} ${req.path} 는 존재하지 않는 엔드포인트입니다.`,
  });
});

// ── 글로벌 에러 핸들러 ────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // express.json() (body-parser) JSON 파싱 실패 → 400 구조화 응답 (500 차단)
  if (err.type === 'entity.parse.failed' || (err.status === 400 && err.body !== undefined)) {
    return res.status(400).json({
      status : 'error',
      code   : 'INVALID_JSON',
      message: 'Request body가 유효한 JSON이 아닙니다.',
      errors : ['잘못된 JSON 형식입니다. Content-Type: application/json 헤더와 올바른 JSON body를 전송하세요.'],
    });
  }
  console.error('[unhandled error]', err);
  res.status(500).json({
    status : 'error',
    code   : 'INTERNAL_ERROR',
    message: '서버 내부 오류가 발생했습니다.',
  });
});

// ── 서버 시작 ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT} 에서 시작`);
  console.log(`[server] 모델: ${modelLoadError ? '로드 실패 ⚠' : '정상 로드 ✓'}`);
});

module.exports = app; // 테스트 호환
