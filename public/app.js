'use strict';
/* =========================================================================
   서울 아파트 실거래가 AI 예측 — 프론트엔드 앱
   APIs: POST /api/predict   GET /api/districts   GET /api/trends/:gu
         GET /api/complexes/:gu   GET /api/health
   6 UI 상태: idle | loading | success | error | no-data | partial
   ========================================================================= */

// ── 투자 신호 메타 ────────────────────────────────────────────────────────
const SIGNAL_META = {
  undervalued: { label: '🟢 저평가', desc: '구 중앙 시세 대비 10% 이상 낮음 — 매수 유리', attr: 'undervalued' },
  fair:        { label: '🔵 적정가', desc: '구 중앙 시세 ± 10% 이내 — 시장 균형 수준',    attr: 'fair'        },
  overvalued:  { label: '🔴 고평가', desc: '구 중앙 시세 대비 10% 이상 높음 — 주의 필요',  attr: 'overvalued'  },
};

// ── CSS 커스텀 프로퍼티 (style.css :root 토큰 단일 소스) ─────────────────
const CSS = (() => {
  const s = getComputedStyle(document.documentElement);
  const g = n => s.getPropertyValue(n).trim();
  return {
    accent:      g('--accent'),
    accentLight: g('--accent-light'),
    signalUnder: g('--signal-under'),
    signalFair:  g('--signal-fair'),
    signalOver:  g('--signal-over'),
    textMuted:   g('--text-muted'),
    textLabel:   g('--text-label'),
    bgCard:      g('--bg-card'),
    border:      g('--border'),
    bgInput:     g('--bg-input'),
    chartAmber:  g('--chart-amber'),
    chartPurple: g('--chart-purple'),
    mapBorder:   g('--map-border'),
    choro1:      g('--choro-stop-1').split(',').map(Number),
    choro2:      g('--choro-stop-2').split(',').map(Number),
    choro3:      g('--choro-stop-3').split(',').map(Number),
  };
})();

// ── 가격 포맷 ─────────────────────────────────────────────────────────────
function fmt(manwon) {
  const n = Math.round(manwon);
  if (n >= 10000) {
    const eok  = Math.floor(n / 10000);
    const rest  = n % 10000;
    return rest > 0 ? `${eok}억 ${rest.toLocaleString()}만` : `${eok}억`;
  }
  return `${n.toLocaleString()}만`;
}
function fmtShort(manwon) {
  return `${(Math.round(manwon) / 10000).toFixed(1)}억`;
}

// ── Choropleth 색상 (CSS 토큰 기반 — JS 하드코딩 없음) ──────────────────
function choroplethColor(avg, minAvg, maxAvg) {
  const r = Math.max(0, Math.min(1, (avg - minAvg) / (maxAvg - minAvg || 1)));
  const [r1, g1, b1] = CSS.choro1;
  const [r2, g2, b2] = CSS.choro2;
  const [r3, g3, b3] = CSS.choro3;
  if (r < 0.5) {
    const t = r * 2;
    return `rgb(${Math.round(r1+(r2-r1)*t)},${Math.round(g1+(g2-g1)*t)},${Math.round(b1+(b2-b1)*t)})`;
  }
  const t = (r - 0.5) * 2;
  return `rgb(${Math.round(r2+(r3-r2)*t)},${Math.round(g2+(g3-g2)*t)},${Math.round(b2+(b3-b2)*t)})`;
}

// ── 앱 상태 ───────────────────────────────────────────────────────────────
let districtMap = {};   // { 강남구: {gu,avg,min,max,q25,q75,median} }
let leafletMap  = null;
let geoLayers   = {};
let trendsChart = null;
let fiChart     = null;
let lastResult  = null;

// ── UI 상태 제어 ──────────────────────────────────────────────────────────
function setUIState(state) {
  document.getElementById('result-panel').dataset.uiState = state;
}

// ── 폼 초기화 (retry 버튼) ───────────────────────────────────────────────
window.resetForm = function () {
  setUIState('idle');
  document.getElementById('predict-btn').disabled = false;
};

// ── 토스트 ────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${type === 'error' ? ' toast-error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

// ── 지도 초기화 ───────────────────────────────────────────────────────────
async function initMap() {
  leafletMap = L.map('map', {
    center: [37.5665, 126.978],
    zoom: 11,
    zoomControl: true,
    attributionControl: false,
  });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, opacity: 0.3,
  }).addTo(leafletMap);

  try {
    const geo = await (await fetch('/seoul_geo.json')).json();
    L.geoJSON(geo, {
      style: () => ({ fillColor: CSS.border, fillOpacity: 0.65, color: CSS.textLabel, weight: 1.5 }),
      onEachFeature: (feat, layer) => {
        const gu = feat.properties.name;
        geoLayers[gu] = layer;
        layer.bindTooltip(gu, { sticky: true, className: 'leaflet-tooltip-custom', direction: 'auto' });
        layer.on('click',     () => selectDistrict(gu));
        layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.9, weight: 2.5 }));
        layer.on('mouseout',  () => restyleLayer(gu));
      },
    }).addTo(leafletMap);
    if (Object.keys(districtMap).length > 0) applyChoropleth();
  } catch (e) { console.error('GeoJSON 로드 실패:', e); }

  window.addEventListener('resize', () => leafletMap && leafletMap.invalidateSize());
}

function restyleLayer(gu) {
  const layer = geoLayers[gu]; if (!layer) return;
  const d = districtMap[gu];
  if (!d) {
    layer.setStyle({ fillColor: CSS.border, fillOpacity: 0.65, color: CSS.textLabel, weight: 1.5 });
    return;
  }
  const avgs = Object.values(districtMap).map(x => x.avg);
  layer.setStyle({
    fillColor: choroplethColor(d.avg, Math.min(...avgs), Math.max(...avgs)),
    fillOpacity: 0.7, color: CSS.mapBorder, weight: 1,
  });
}

function applyChoropleth() {
  const avgs   = Object.values(districtMap).map(x => x.avg);
  const minAvg = Math.min(...avgs), maxAvg = Math.max(...avgs);
  Object.entries(districtMap).forEach(([gu, d]) => {
    const layer = geoLayers[gu]; if (!layer) return;
    layer.setStyle({
      fillColor: choroplethColor(d.avg, minAvg, maxAvg),
      fillOpacity: 0.7, color: CSS.mapBorder, weight: 1,
    });
  });
  const minEl = document.getElementById('legend-min');
  const maxEl = document.getElementById('legend-max');
  if (minEl) minEl.textContent = fmtShort(minAvg);
  if (maxEl) maxEl.textContent = fmtShort(maxAvg);
}

function selectDistrict(gu) {
  const sel = document.getElementById('gu-select');
  if (sel) { sel.value = gu; sel.dispatchEvent(new Event('change')); }
  Object.entries(geoLayers).forEach(([g, layer]) => {
    restyleLayer(g);
    if (g === gu) layer.setStyle({ color: CSS.accentLight, weight: 3, fillOpacity: 0.85 });
  });
  showToast(`${gu} 선택 — 조건 입력 후 예측하기를 눌러주세요`);
}

// ── 지역 시세 로드 ────────────────────────────────────────────────────────
async function loadDistricts() {
  try {
    const json = await (await fetch('/api/districts')).json();
    json.result.forEach(d => { districtMap[d.gu] = d; });
    applyChoropleth();
  } catch (e) { console.warn('지역 시세 로드 실패:', e.message); }
}

// ── 단지 목록 로드 (구 선택 시) ──────────────────────────────────────────
async function loadComplexes(gu) {
  const sel   = document.getElementById('complex-select');
  const hint  = document.getElementById('accuracy-hint');
  sel.disabled = true;
  sel.innerHTML = '<option value="">로딩 중...</option>';

  try {
    const json = await (await fetch(`/api/complexes/${encodeURIComponent(gu)}`)).json();
    sel.innerHTML = '<option value="">— 단지 선택 (선택사항) —</option>';
    if (json.result && json.result.length > 0) {
      json.result.forEach(c => {
        const opt = document.createElement('option');
        opt.value       = c.name;
        opt.textContent = `${c.name} (${fmtShort(c.avg)} · ${c.n}건)`;
        sel.appendChild(opt);
      });
      hint.style.display = 'block';
    } else {
      sel.innerHTML = '<option value="">단지 데이터 없음</option>';
    }
    sel.disabled = false;
  } catch (e) {
    sel.innerHTML = '<option value="">단지 목록 로드 실패</option>';
    sel.disabled  = false;
  }
}

// ── 추이 차트 ─────────────────────────────────────────────────────────────
async function loadTrends(gu) {
  try {
    const json = await (await fetch(`/api/trends/${encodeURIComponent(gu)}`)).json();
    if (json.status !== 'ok') return;

    const labels = json.result.map(t => `${t.year}.${String(t.month).padStart(2, '0')}`);
    const data   = json.result.map(t => t.price);

    const ctx = document.getElementById('trends-chart').getContext('2d');
    if (trendsChart) trendsChart.destroy();

    trendsChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: `${gu} 평균 시세`,
          data,
          borderColor     : CSS.accent,
          backgroundColor : CSS.accent + '22',
          borderWidth     : 2.5,
          pointRadius     : 2.5,
          pointHoverRadius: 5,
          tension         : 0.35,
          fill            : true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend : { display: false },
          tooltip: { callbacks: { label: c => ` ${c.parsed.y.toLocaleString()}만원` } },
        },
        scales: {
          x: {
            ticks : { color: CSS.textLabel, maxTicksLimit: 8, font: { size: 10 } },
            grid  : { color: CSS.bgInput },
            border: { color: CSS.border },
          },
          y: {
            ticks : { color: CSS.textLabel, font: { size: 10 }, callback: v => `${(v/10000).toFixed(1)}억` },
            grid  : { color: CSS.bgInput },
            border: { color: CSS.border },
          },
        },
      },
    });
    document.getElementById('trends-title').textContent = `📈 ${gu} 24개월 시세 추이`;
  } catch (e) { console.warn('추이 로드 실패:', e.message); }
}

// ── 피처 중요도 차트 ──────────────────────────────────────────────────────
function renderFIChart(fi, displayNames) {
  // 상위 6개만 표시
  const entries  = Object.entries(fi).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const labels   = entries.map(([k]) => displayNames[k] || k);
  const data     = entries.map(([, v]) => parseFloat((v * 100).toFixed(1)));
  const palette  = [CSS.accent, CSS.signalUnder, CSS.chartAmber, CSS.chartPurple,
                    CSS.accentLight, CSS.signalOver];

  const ctx = document.getElementById('fi-chart').getContext('2d');
  if (fiChart) fiChart.destroy();

  fiChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label          : '기여도 (%)',
        data,
        backgroundColor: palette.map(c => c + 'cc'),
        borderColor    : palette,
        borderWidth    : 1,
        borderRadius   : 4,
      }],
    },
    options: {
      indexAxis  : 'y',
      responsive : true,
      maintainAspectRatio: true,
      plugins    : {
        legend : { display: false },
        tooltip: { callbacks: { label: c => ` ${c.parsed.x.toFixed(1)}%` } },
      },
      scales: {
        x: {
          max   : Math.min(100, Math.ceil(data[0] / 10) * 10 + 10),
          ticks : { color: CSS.textLabel, font: { size: 10 }, callback: v => `${v}%` },
          grid  : { color: CSS.bgInput },
          border: { color: CSS.border },
        },
        y: {
          ticks : { color: CSS.textMuted, font: { size: 11 } },
          grid  : { display: false },
          border: { color: CSS.border },
        },
      },
    },
  });
}

// ── 비교 패널 ─────────────────────────────────────────────────────────────
function renderComparison(result, gu) {
  const d = districtMap[gu];
  const placeholder = document.getElementById('compare-placeholder');
  const content     = document.getElementById('compare-content');
  if (!d || !content) return;

  placeholder.style.display = 'none';
  content.style.display     = 'block';

  const pred   = result.prediction;
  const devPct = result.market_deviation_pct;
  const devSign = devPct >= 0 ? '+' : '';
  const devClass = devPct >  5 ? 'deviation-pos'
                 : devPct < -5 ? 'deviation-neg'
                 :               'deviation-neu';

  function barRow(label, value, maxVal, color) {
    const pct = Math.min(100, (value / maxVal) * 100).toFixed(1);
    return `
      <div class="compare-row">
        <div class="cr-label">${label}</div>
        <div class="compare-bar-track">
          <div class="compare-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="cr-value">${fmt(value)}원</div>
      </div>`;
  }

  content.innerHTML = `
    ${barRow('AI 예측가', pred,   d.max, CSS.accent)}
    ${barRow('구 평균',   d.avg,  d.max, CSS.textMuted)}
    ${barRow('구 최고가', d.max,  d.max, CSS.signalOver + '99')}
    ${barRow('구 최저가', d.min,  d.max, CSS.signalUnder + '99')}
    <div class="deviation-summary">
      <div class="dev-label">구 중앙값 대비</div>
      <div class="dev-value">
        <span class="dev-pct ${devClass}">${devSign}${devPct}%</span>
        <span class="deviation-pill ${devClass}">${devPct > 5 ? '고평가' : devPct < -5 ? '저평가' : '적정'}</span>
      </div>
      <div class="dev-base">기준 중앙값: ${fmt(result.market_median)}원</div>
    </div>
  `;
}

// ── 결과 클립보드 복사 ────────────────────────────────────────────────────
function copyResult() {
  if (!lastResult) return;
  const gu    = document.getElementById('gu-select').value;
  const area  = document.getElementById('area').value;
  const floor = document.getElementById('floor').value;
  const built = document.getElementById('built').value;
  const sig   = SIGNAL_META[lastResult.investment_signal] || SIGNAL_META.fair;
  const conf  = Math.round(lastResult.confidence * 100);

  const lines = [
    '🏢 서울 아파트 AI 예측 결과',
    `구: ${gu}  |  전용 ${area}㎡  |  ${floor}층  |  ${built}년`,
    '',
    `📊 예측 가격: ${fmt(lastResult.prediction)}원`,
    `   구간: ${fmt(lastResult.lower_bound)} ~ ${fmt(lastResult.upper_bound)}원  |  신뢰도 ${conf}%`,
    '',
    `${sig.label}  |  ${sig.desc}`,
    '',
    '국토교통부 실거래가 공공데이터 기반 · 서울 25개 구 · 67,430건 학습',
  ];
  const text = lines.join('\n');

  const doFallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast('📋 결과가 클립보드에 복사됐습니다'); }
    catch (_) { showToast('복사 실패 — 브라우저가 지원하지 않습니다', 'error'); }
    finally    { document.body.removeChild(ta); }
  };

  if (navigator.clipboard) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('📋 결과가 클립보드에 복사됐습니다'))
      .catch(doFallback);
  } else {
    doFallback();
  }
}

// ── 성공 결과 렌더링 ──────────────────────────────────────────────────────
function renderSuccess(result) {
  lastResult = result;

  const gu  = document.getElementById('gu-select').value;
  const d   = districtMap[gu] || {};

  // 단지 배지
  const badgeWrap = document.getElementById('complex-badge-wrap');
  const badgeText = document.getElementById('complex-badge-text');
  if (result.used_complex && result.complex_name) {
    badgeText.textContent   = `🏢 ${result.complex_name}`;
    badgeWrap.style.display = 'block';
  } else {
    badgeWrap.style.display = 'none';
  }

  // 주요 가격 표시
  document.getElementById('res-price-main').textContent = `${fmt(result.prediction)}원`;
  document.getElementById('res-price-sub').textContent  =
    `예측 구간: ${fmt(result.lower_bound)} ~ ${fmt(result.upper_bound)}원`;

  // 가격 범위 바 마커
  const range     = result.upper_bound - result.lower_bound;
  const markerPct = range > 0
    ? ((result.prediction - result.lower_bound) / range * 100).toFixed(1)
    : 50;
  document.getElementById('price-marker').style.left   = `${markerPct}%`;
  document.getElementById('range-lower').textContent   = `하한 ${fmt(result.lower_bound)}`;
  document.getElementById('range-upper').textContent   = `상한 ${fmt(result.upper_bound)}`;

  // 신뢰도 바
  const confPct = Math.round(result.confidence * 100);
  document.getElementById('conf-fill').style.width     = `${confPct}%`;
  document.getElementById('conf-pct-val').textContent  = `${confPct}%`;
  document.getElementById('conf-pct').textContent      = `신뢰도 ${confPct}%`;

  // 투자 신호
  const sig  = result.investment_signal;
  const meta = SIGNAL_META[sig] || SIGNAL_META.fair;
  const badge = document.getElementById('signal-badge');
  badge.textContent    = meta.label;
  badge.dataset.signal = meta.attr;
  document.getElementById('signal-desc').textContent = meta.desc;

  // 비교 수치 그리드
  document.getElementById('cmp-pred').textContent   = `${fmt(result.prediction)}원`;
  document.getElementById('cmp-median').textContent = `${fmt(result.market_median)}원`;
  document.getElementById('cmp-avg').textContent    = d.avg ? `${fmt(d.avg)}원` : '—';
  document.getElementById('cmp-max').textContent    = d.max ? `${fmt(d.max)}원` : '—';

  setUIState('success');

  // 피처 중요도 차트
  renderFIChart(result.feature_importance, result.feature_display || {});

  // 비교 패널
  renderComparison(result, gu);

  // 추이 차트 (구 선택 시)
  if (gu) loadTrends(gu);
}

// ── 예측 요청 ─────────────────────────────────────────────────────────────
async function doPrediction() {
  const gu      = document.getElementById('gu-select').value;
  const complex = document.getElementById('complex-select').value || undefined;
  const area    = parseFloat(document.getElementById('area').value);
  const floor   = parseFloat(document.getElementById('floor').value);
  const built   = parseFloat(document.getElementById('built').value);

  // 클라이언트 사전 검증
  if (!gu)                               { showToast('구를 선택해주세요.', 'error');              return; }
  if (!area  || area  <= 0 || area  > 500) { showToast('전용면적을 1~500 사이로 입력해주세요.', 'error'); return; }
  if (!floor || floor <= 0 || floor > 100) { showToast('층수를 1~100 사이로 입력해주세요.', 'error');    return; }
  if (!built || built < 1960 || built > 2024) { showToast('건축연도를 1960~2024 사이로 입력해주세요.', 'error'); return; }

  setUIState('loading');
  document.getElementById('predict-btn').disabled = true;

  const start = performance.now();
  try {
    const res   = await fetch('/api/predict', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ gu, area, floor, built, complex }),
    });
    const elapsed = Math.round(performance.now() - start);
    const json  = await res.json();

    if (!res.ok) {
      if (res.status === 503) {
        // partial: 모델 사용 불가
        document.getElementById('partial-msg').textContent =
          '모델 서비스가 일시적으로 사용 불가합니다. 잠시 후 다시 시도해주세요.';
        setUIState('partial');
      } else if (res.status === 400) {
        document.getElementById('err-msg').textContent    = json.message || '입력값을 확인해주세요.';
        document.getElementById('err-detail').textContent = (json.errors || []).join(' / ');
        setUIState('error');
      } else {
        document.getElementById('err-msg').textContent    = '서버 오류가 발생했습니다.';
        document.getElementById('err-detail').textContent = `HTTP ${res.status}`;
        setUIState('error');
      }
      return;
    }

    if (json.status === 'ok' && json.result) {
      renderSuccess(json.result);
      showToast(`예측 완료 (${elapsed}ms)${json.result.used_complex ? ' · 단지 정밀 예측' : ''}`);
    } else {
      setUIState('no-data');
    }
  } catch (e) {
    document.getElementById('err-msg').textContent    = '네트워크 오류가 발생했습니다.';
    document.getElementById('err-detail').textContent = e.message;
    setUIState('error');
  } finally {
    document.getElementById('predict-btn').disabled = false;
  }
}

// ── 폼 초기화 ─────────────────────────────────────────────────────────────
function initForm() {
  const GU_LIST = [
    '강남구','강동구','강북구','강서구','관악구','광진구','구로구','금천구',
    '노원구','도봉구','동대문구','동작구','마포구','서대문구','서초구','성동구',
    '성북구','송파구','양천구','영등포구','용산구','은평구','종로구','중구','중랑구',
  ];

  const sel = document.getElementById('gu-select');
  GU_LIST.forEach(gu => {
    const opt = document.createElement('option');
    opt.value = gu; opt.textContent = gu;
    sel.appendChild(opt);
  });

  document.getElementById('predict-btn').addEventListener('click', doPrediction);

  // Enter 키
  document.querySelectorAll('.form-input').forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') doPrediction(); });
  });

  // 구 변경 → 단지 목록 로드 + 추이 차트 프리뷰 + 참고 정보 표시
  sel.addEventListener('change', () => {
    const gu = sel.value;

    // 참고 정보 업데이트
    const refEl = document.getElementById('district-ref-info');
    if (refEl) {
      if (gu && districtMap[gu]) {
        const d = districtMap[gu];
        refEl.innerHTML =
          `<span><span class="dri-label">평균</span><span class="dri-val">${fmt(d.avg)}원</span></span>` +
          `<span><span class="dri-label">중앙값</span><span class="dri-val">${fmt(d.median)}원</span></span>` +
          `<span><span class="dri-label">최고가</span><span class="dri-val">${fmt(d.max)}원</span></span>`;
        refEl.style.display = 'flex';
      } else {
        refEl.style.display = 'none';
      }
    }

    if (!gu) return;

    // 지도 하이라이트
    Object.entries(geoLayers).forEach(([g, layer]) => {
      restyleLayer(g);
      if (g === gu) layer.setStyle({ color: CSS.accentLight, weight: 3, fillOpacity: 0.85 });
    });

    // 단지 + 추이 로드
    loadComplexes(gu);
    loadTrends(gu);
  });

  // 복사 버튼
  document.getElementById('copy-result-btn').addEventListener('click', copyResult);
}

// ── 진입점 ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setUIState('idle');
  initForm();
  await Promise.all([initMap(), loadDistricts()]);
  // 기본 미리보기: 강남구
  await loadTrends('강남구');
  document.getElementById('trends-title').textContent = '📈 강남구 24개월 시세 추이';
});
