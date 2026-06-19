'use strict';
/**
 * QA 자가 포함 검증 스크립트
 * node qa_verify.js
 * - 서버를 인프로세스로 기동
 * - 8개 시나리오를 http.request로 순서대로 검증
 * - 결과를 PASS/FAIL로 출력
 */

const http   = require('http');
const assert = require('assert');

const PORT = 3777; // 충돌 회피용 포트

// ── 서버 기동 ───────────────────────────────────────────────────────────────
let modelLoadLog = '';
const origLog    = console.log.bind(console);
console.log = (...a) => { modelLoadLog += a.join(' ') + '\n'; origLog(...a); };

const app = require('./server.js');

console.log = origLog; // 복원

const server = http.createServer(app);

// ── 헬퍼 ────────────────────────────────────────────────────────────────────
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port    : PORT,
      path,
      method,
      headers : {
        'Content-Type'  : 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = http.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = data; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    origLog(`  ${PASS}  ${name}`);
  } else {
    origLog(`  ${FAIL}  ${name}  →  ${detail}`);
    failures++;
  }
}

// ── 메인 검증 ───────────────────────────────────────────────────────────────
server.listen(PORT, '127.0.0.1', async () => {
  origLog(`\n[QA] 서버 기동 완료 (port ${PORT})`);

  // ── 시나리오 0: 모델 로드 로그 확인 ────────────────────────────────────────
  origLog('\n[S0] 모델 로드 로그 확인');
  check('모델 로드 성공 로그 포함',
    modelLoadLog.includes('모델 로드 완료'),
    `로그: ${modelLoadLog.trim().slice(0, 120)}`);

  // ── 시나리오 1: GET /api/health ─────────────────────────────────────────
  origLog('\n[S1] GET /api/health');
  try {
    const r = await req('GET', '/api/health');
    origLog('  응답:', JSON.stringify(r.body));
    check('HTTP 200',           r.status === 200,                  `status=${r.status}`);
    check('status: ok',         r.body && r.body.status === 'ok',  `body=${JSON.stringify(r.body)}`);
    check('model: loaded 확인', r.body && r.body.model === 'loaded', `model=${r.body && r.body.model}`);
  } catch (e) { check('GET /api/health', false, e.message); }

  // ── 시나리오 2: GET /api/districts ─────────────────────────────────────
  origLog('\n[S2] GET /api/districts');
  try {
    const r = await req('GET', '/api/districts');
    check('HTTP 200',         r.status === 200,                              `status=${r.status}`);
    check('status: ok',       r.body && r.body.status === 'ok',              `body=${JSON.stringify(r.body).slice(0,80)}`);
    check('25개 구 반환',     r.body && r.body.result && r.body.result.length === 25, `count=${r.body && r.body.result && r.body.result.length}`);
    if (r.body && r.body.result && r.body.result[0]) {
      const s = r.body.result[0];
      origLog('  sample:', JSON.stringify(s));
      check('avg 필드 number', typeof s.avg === 'number',  `avg=${s.avg}`);
      check('min/max 필드',    typeof s.min === 'number' && typeof s.max === 'number', `min=${s.min} max=${s.max}`);
      check('gu 필드',         typeof s.gu  === 'string',  `gu=${s.gu}`);
    }
  } catch (e) { check('GET /api/districts', false, e.message); }

  // ── 시나리오 3: GET /api/trends/강남구 ─────────────────────────────────
  origLog('\n[S3] GET /api/trends/강남구');
  try {
    const r = await req('GET', '/api/trends/' + encodeURIComponent('강남구'));
    check('HTTP 200',                r.status === 200,                             `status=${r.status}`);
    check('status: ok',              r.body && r.body.status === 'ok',             `body=${JSON.stringify(r.body).slice(0,80)}`);
    check('24개월 이상 추이',        r.body && r.body.result && r.body.result.length >= 24, `count=${r.body && r.body.result && r.body.result.length}`);
    if (r.body && r.body.result && r.body.result[0]) {
      const t = r.body.result[0];
      origLog('  sample:', JSON.stringify(t));
      check('year 필드', typeof t.year  === 'number', `year=${t.year}`);
      check('month 필드',typeof t.month === 'number', `month=${t.month}`);
      check('price 필드',typeof t.price === 'number', `price=${t.price}`);
    }
  } catch (e) { check('GET /api/trends', false, e.message); }

  // ── 시나리오 4: GET /api/complexes/강남구 ──────────────────────────────
  origLog('\n[S4] GET /api/complexes/강남구');
  try {
    const r = await req('GET', '/api/complexes/' + encodeURIComponent('강남구'));
    check('HTTP 200',       r.status === 200,                             `status=${r.status}`);
    check('status: ok',     r.body && r.body.status === 'ok',             `body=${JSON.stringify(r.body).slice(0,80)}`);
    check('단지 1개 이상',  r.body && r.body.result && r.body.result.length >= 1, `count=${r.body && r.body.result && r.body.result.length}`);
    if (r.body && r.body.result && r.body.result[0]) {
      origLog('  sample:', JSON.stringify(r.body.result[0]));
    }
  } catch (e) { check('GET /api/complexes', false, e.message); }

  // ── 시나리오 5: POST /api/predict 정상 ────────────────────────────────
  origLog('\n[S5] POST /api/predict {gu:"강남구",area:84,floor:10,built:2010}');
  try {
    const r = await req('POST', '/api/predict', { gu:'강남구', area:84, floor:10, built:2010 });
    origLog('  응답:', JSON.stringify(r.body).slice(0, 300));
    check('HTTP 200',               r.status === 200,                               `status=${r.status}`);
    check('status: ok',             r.body && r.body.status === 'ok',               `body=${JSON.stringify(r.body).slice(0,80)}`);
    const res = r.body && r.body.result;
    check('prediction 존재(number)',     res && typeof res.prediction === 'number',      `prediction=${res && res.prediction}`);
    check('prediction > 0',              res && res.prediction > 0,                      `prediction=${res && res.prediction}`);
    check('lower_bound 존재(number)',    res && typeof res.lower_bound === 'number',     `lower_bound=${res && res.lower_bound}`);
    check('upper_bound 존재(number)',    res && typeof res.upper_bound === 'number',     `upper_bound=${res && res.upper_bound}`);
    check('confidence 존재(0~1)',        res && typeof res.confidence === 'number' && res.confidence >= 0 && res.confidence <= 1, `confidence=${res && res.confidence}`);
    check('feature_importance 배열',     res && Array.isArray(res.feature_importance), `fi=${JSON.stringify(res && res.feature_importance).slice(0,80)}`);
    check('investment_signal 존재',      res && ['undervalued','fair','overvalued'].includes(res.investment_signal), `signal=${res && res.investment_signal}`);
    check('lower ≤ prediction ≤ upper', res && res.lower_bound <= res.prediction && res.prediction <= res.upper_bound, `lb=${res && res.lower_bound} pred=${res && res.prediction} ub=${res && res.upper_bound}`);
  } catch (e) { check('POST /api/predict (valid)', false, e.message); }

  // ── 시나리오 6: POST /api/predict 잘못된 입력 area=-1 ──────────────────
  origLog('\n[S6] POST /api/predict {area:-1} → 400 에러');
  try {
    const r = await req('POST', '/api/predict', { gu:'강남구', area:-1, floor:10, built:2010 });
    origLog('  응답:', JSON.stringify(r.body));
    check('HTTP 400',       r.status === 400,                  `status=${r.status}`);
    check('status: error',  r.body && r.body.status === 'error', `status=${r.body && r.body.status}`);
    check('code: INVALID_INPUT', r.body && r.body.code === 'INVALID_INPUT', `code=${r.body && r.body.code}`);
    check('message 존재',   r.body && typeof r.body.message === 'string', `message=${r.body && r.body.message}`);
  } catch (e) { check('POST /api/predict (invalid)', false, e.message); }

  // ── 시나리오 7: GET /api/predict (잘못된 메서드) → 404 ─────────────────
  origLog('\n[S7] GET /api/predict → 404');
  try {
    const r = await req('GET', '/api/predict');
    origLog('  응답:', JSON.stringify(r.body));
    check('HTTP 404',       r.status === 404,                   `status=${r.status}`);
    check('status: error',  r.body && r.body.status === 'error', `status=${r.body && r.body.status}`);
    check('code: NOT_FOUND', r.body && r.body.code === 'NOT_FOUND', `code=${r.body && r.body.code}`);
  } catch (e) { check('GET /api/predict (404)', false, e.message); }

  // ── 추가: 경계값 테스트 ─────────────────────────────────────────────────
  origLog('\n[S8-EDGE] 경계값 테스트');
  // area=0 → 400
  try {
    const r = await req('POST', '/api/predict', { gu:'강남구', area:0, floor:10, built:2010 });
    check('area=0 → 400', r.status === 400, `status=${r.status}`);
  } catch (e) { check('area=0 → 400', false, e.message); }
  // floor=0 → 400
  try {
    const r = await req('POST', '/api/predict', { gu:'강남구', area:84, floor:0, built:2010 });
    check('floor=0 → 400', r.status === 400, `status=${r.status}`);
  } catch (e) { check('floor=0 → 400', false, e.message); }
  // built=1959 → 400
  try {
    const r = await req('POST', '/api/predict', { gu:'강남구', area:84, floor:10, built:1959 });
    check('built=1959 → 400', r.status === 400, `status=${r.status}`);
  } catch (e) { check('built=1959 → 400', false, e.message); }
  // 잘못된 구 → 400
  try {
    const r = await req('POST', '/api/predict', { gu:'부산시', area:84, floor:10, built:2010 });
    check('unknown gu → 400', r.status === 400, `status=${r.status}`);
  } catch (e) { check('unknown gu → 400', false, e.message); }
  // trends 잘못된 구 → 400 (한글 경로는 encodeURIComponent 필수)
  try {
    const r = await req('GET', '/api/trends/' + encodeURIComponent('부산시'));
    check('trends unknown gu → 400', r.status === 400, `status=${r.status}`);
  } catch (e) { check('trends unknown gu → 400', false, e.message); }

  // ── 추가: 추론 레이턴시 (P95 ≤ 500ms) ─────────────────────────────────
  origLog('\n[S9] P95 추론 레이턴시 측정 (50회)');
  try {
    const latencies = [];
    for (let i = 0; i < 50; i++) {
      const t0 = Date.now();
      await req('POST', '/api/predict', { gu:'강남구', area:59 + i % 50, floor:i % 20 + 1, built:1990 + i % 30 });
      latencies.push(Date.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    const p50 = latencies[24];
    const p95 = latencies[47];
    const max = latencies[49];
    origLog(`  P50=${p50}ms  P95=${p95}ms  MAX=${max}ms`);
    check('P95 ≤ 500ms', p95 <= 500, `p95=${p95}ms`);
    check('MAX ≤ 1000ms', max <= 1000, `max=${max}ms`);
  } catch (e) { check('레이턴시 측정', false, e.message); }

  // ── 결과 요약 ──────────────────────────────────────────────────────────
  origLog('\n' + '─'.repeat(60));
  if (failures === 0) {
    origLog(`\x1b[32m[QA] 전체 PASS — 실패 0건\x1b[0m`);
  } else {
    origLog(`\x1b[31m[QA] 실패 ${failures}건 발생\x1b[0m`);
  }

  server.close();
  process.exit(failures > 0 ? 1 : 0);
});

server.on('error', e => {
  origLog('[QA] 서버 기동 오류:', e.message);
  process.exit(2);
});
