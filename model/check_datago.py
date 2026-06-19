"""data.go.kr 파일 다운로드 URL 추출"""
from playwright.sync_api import sync_playwright
import time, json

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--ignore-certificate-errors'])
    ctx = browser.new_context(ignore_https_errors=True)
    page = ctx.new_page()

    # AJAX 응답 캡처
    api_responses = []
    def handle_response(response):
        url = response.url
        if any(kw in url for kw in ['atchFile', 'fileDetail', 'FileData', 'download']):
            try:
                body = response.text()
                api_responses.append({'url': url, 'status': response.status, 'body': body[:500]})
            except:
                api_responses.append({'url': url, 'status': response.status})

    page.on('response', handle_response)

    page.goto('https://www.data.go.kr/data/15052419/fileData.do', timeout=30000)
    page.wait_for_load_state('networkidle', timeout=20000)
    time.sleep(3)

    print('Page title:', page.title())
    print('\n=== API Responses ===')
    for r in api_responses:
        print(r)

    # 다운로드 버튼 찾기
    buttons = page.eval_on_selector_all('[onclick*="fn_fileData"]',
        'els => els.map(e => ({text: e.textContent.trim(), onclick: e.getAttribute("onclick")}))')
    print('\n=== Download Buttons ===')
    for b in buttons:
        print(b)

    browser.close()
