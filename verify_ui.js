/**
 * Playwright UI 검증 스크립트
 * - 6개 UI 상태, 예측 결과, 단지 로드, 에러 처리 검증
 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('console', m => {
    if (m.type() === 'error') console.log('브라우저 콘솔 에러:', m.text());
  });

  await page.goto('http://localhost:3000');
  await page.waitForLoadState('networkidle');
  await new Promise(r => setTimeout(r, 1500));

  // 1. 초기 idle 상태
  const initState = await page.evaluate(
    () => document.getElementById('result-panel').dataset.uiState
  );
  console.log('1. 초기 UI 상태:', initState === 'idle' ? 'PASS (idle)' : 'FAIL: ' + initState);

  // 2. 지도 렌더링
  const mapCount = await page.locator('#map .leaflet-container').count();
  console.log('2. 지도 렌더링:', mapCount > 0 ? 'PASS' : 'FAIL (Leaflet 없음)');

  // 3. 구 선택 → 단지 로드
  await page.selectOption('#gu-select', '강남구');
  await new Promise(r => setTimeout(r, 2000));
  const cplxOpts = await page.evaluate(
    () => document.getElementById('complex-select').options.length
  );
  console.log('3. 단지 드롭다운 로드:', cplxOpts > 5 ? `PASS (${cplxOpts}개)` : 'FAIL: ' + cplxOpts);

  // 4. 예측 실행 → success 상태
  await page.fill('#area', '84');
  await page.fill('#floor', '10');
  await page.fill('#built', '2010');
  await page.click('#predict-btn');
  await new Promise(r => setTimeout(r, 2500));

  const afterState = await page.evaluate(
    () => document.getElementById('result-panel').dataset.uiState
  );
  console.log('4. 예측 후 UI 상태:', afterState === 'success' ? 'PASS (success)' : 'FAIL: ' + afterState);

  if (afterState === 'success') {
    const price  = await page.evaluate(() => document.getElementById('res-price-main').textContent);
    const sub    = await page.evaluate(() => document.getElementById('res-price-sub').textContent);
    const signal = await page.evaluate(() => document.getElementById('signal-badge').textContent);
    const conf   = await page.evaluate(() => document.getElementById('conf-pct-val').textContent);
    console.log('   예측가:', price);
    console.log('   예측 구간:', sub);
    console.log('   투자 신호:', signal);
    console.log('   신뢰도:', conf);
  }

  // 5. 피처 중요도 차트 렌더링
  const fiCanvas = await page.locator('#fi-chart').count();
  console.log('5. 피처 중요도 차트:', fiCanvas > 0 ? 'PASS' : 'FAIL');

  // 6. 추이 차트
  const trendsCanvas = await page.locator('#trends-chart').count();
  console.log('6. 추이 차트:', trendsCanvas > 0 ? 'PASS' : 'FAIL');

  // 7. 비교 패널
  const compareContent = await page.evaluate(
    () => document.getElementById('compare-content').style.display
  );
  console.log('7. 비교 패널:', compareContent === 'block' ? 'PASS (표시됨)' : 'FAIL: ' + compareContent);

  // 8. 스크린샷
  await page.screenshot({ path: '/tmp/apt_ui.png', fullPage: false });
  console.log('8. 스크린샷: /tmp/apt_ui.png');

  // 9. 에러 상태 (area=0)
  await page.fill('#area', '0');
  await page.click('#predict-btn');
  await new Promise(r => setTimeout(r, 600));
  const toast = await page.evaluate(() => document.getElementById('toast').textContent);
  const toastShow = await page.evaluate(() => document.getElementById('toast').className);
  console.log('9. 에러 토스트 (area=0):', toastShow.includes('show') ? `PASS ("${toast}")` : 'FAIL');

  // 10. 단지 선택 + 재예측
  await page.fill('#area', '84');
  await page.selectOption('#complex-select', { index: 1 }); // 1번째 단지 선택
  await page.click('#predict-btn');
  await new Promise(r => setTimeout(r, 2000));

  const state10 = await page.evaluate(
    () => document.getElementById('result-panel').dataset.uiState
  );
  const badge = await page.evaluate(() => document.getElementById('complex-badge-wrap').style.display);
  console.log('10. 단지 선택 예측:', state10 === 'success' ? 'PASS' : 'FAIL: ' + state10);
  console.log('    단지 배지 표시:', badge === 'block' ? 'PASS' : 'FAIL: ' + badge);

  // 스크린샷 (단지 선택 상태)
  await page.screenshot({ path: '/tmp/apt_ui_complex.png', fullPage: false });
  console.log('    단지 선택 스크린샷: /tmp/apt_ui_complex.png');

  await browser.close();
  console.log('\n전체 Playwright 검증 완료');
})().catch(e => {
  console.error('검증 실패:', e.message);
  process.exit(1);
});
