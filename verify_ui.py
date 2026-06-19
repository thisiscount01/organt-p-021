"""Playwright UI 검증 — 6개 UI 상태 + 예측 흐름 + 단지 선택 완전 검증"""
from playwright.sync_api import sync_playwright
import time

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        page.goto("http://localhost:3000")
        page.wait_for_load_state("networkidle", timeout=15000)
        time.sleep(1.5)

        s = page.evaluate("document.getElementById('result-panel').dataset.uiState")
        print(f"1. 초기 상태: {'PASS (idle)' if s=='idle' else 'FAIL: '+s}")

        cnt = page.locator(".leaflet-container").count()
        print(f"2. 지도: {'PASS' if cnt>0 else 'FAIL'}")

        page.select_option("#gu-select", "강남구")
        time.sleep(2.0)
        opts = page.evaluate("document.getElementById('complex-select').options.length")
        print(f"3. 단지 드롭다운: {'PASS ('+str(opts)+'개)' if opts>5 else 'FAIL: '+str(opts)}")

        page.fill("#area", "84")
        page.fill("#floor", "10")
        page.fill("#built", "2010")
        page.click("#predict-btn")
        time.sleep(2.5)

        s2 = page.evaluate("document.getElementById('result-panel').dataset.uiState")
        print(f"4. 예측 상태: {'PASS (success)' if s2=='success' else 'FAIL: '+s2}")

        if s2 == "success":
            price  = page.evaluate("document.getElementById('res-price-main').textContent")
            sub    = page.evaluate("document.getElementById('res-price-sub').textContent")
            signal = page.evaluate("document.getElementById('signal-badge').textContent")
            conf   = page.evaluate("document.getElementById('conf-pct-val').textContent")
            print(f"   예측가: {price}")
            print(f"   구간: {sub}")
            print(f"   신호: {signal}")
            print(f"   신뢰도: {conf}")

        fi_cnt = page.locator("#fi-chart").count()
        print(f"5. 피처 중요도 차트: {'PASS' if fi_cnt>0 else 'FAIL'}")

        tr_cnt = page.locator("#trends-chart").count()
        print(f"6. 추이 차트: {'PASS' if tr_cnt>0 else 'FAIL'}")

        cmp_vis = page.evaluate("document.getElementById('compare-content').style.display")
        print(f"7. 비교 패널: {'PASS' if cmp_vis=='block' else 'FAIL: '+cmp_vis}")

        page.screenshot(path="/tmp/apt_ui.png")
        print("8. 스크린샷 저장: /tmp/apt_ui.png")

        page.fill("#area", "0")
        page.click("#predict-btn")
        time.sleep(0.7)
        toast_cls = page.evaluate("document.getElementById('toast').className")
        toast_txt = page.evaluate("document.getElementById('toast').textContent")
        print(f"9. 에러 토스트: {'PASS' if 'show' in toast_cls else 'FAIL'} ({toast_txt!r})")

        page.fill("#area", "84")
        page.select_option("#complex-select", index=1)
        page.click("#predict-btn")
        time.sleep(2.5)
        s3 = page.evaluate("document.getElementById('result-panel').dataset.uiState")
        badge_d = page.evaluate("document.getElementById('complex-badge-wrap').style.display")
        badge_t = page.evaluate("document.getElementById('complex-badge-text').textContent")
        print(f"10. 단지 선택 예측: {'PASS' if s3=='success' else 'FAIL: '+s3}")
        print(f"    단지 배지: {'PASS ('+badge_t+')' if badge_d=='block' else 'FAIL: '+badge_d}")

        page.screenshot(path="/tmp/apt_ui_complex.png")
        print("    단지 선택 스크린샷: /tmp/apt_ui_complex.png")

        if errors:
            print(f"⚠ 브라우저 콘솔 에러 {len(errors)}건:", errors[:3])

        browser.close()
        print("\n전체 Playwright 검증 완료")

run()
