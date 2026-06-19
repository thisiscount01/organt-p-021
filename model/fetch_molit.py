"""
MOLIT 실거래가 - Playwright 브라우저 자동화로 다운로드
JavaScript로 렌더링되는 셀렉트박스 처리 포함
"""
import asyncio
import os
import sys
import time
import json
import pandas as pd
import io
from pathlib import Path

OUTPUT_DIR = Path("/tmp/molit_data")
OUTPUT_DIR.mkdir(exist_ok=True)

# 서울 25개 구 (sgg 코드)
SEOUL_SGG = {
    "강남구":   "11680",
    "강동구":   "11740",
    "강북구":   "11305",
    "강서구":   "11500",
    "관악구":   "11620",
    "광진구":   "11215",
    "구로구":   "11530",
    "금천구":   "11545",
    "노원구":   "11350",
    "도봉구":   "11320",
    "동대문구": "11230",
    "동작구":   "11590",
    "마포구":   "11440",
    "서대문구": "11410",
    "서초구":   "11650",
    "성동구":   "11200",
    "성북구":   "11290",
    "송파구":   "11710",
    "양천구":   "11470",
    "영등포구": "11560",
    "용산구":   "11170",
    "은평구":   "11380",
    "종로구":   "11110",
    "중구":     "11140",
    "중랑구":   "11260",
}

async def download_gu_data(page, sgg_nm, sgg_cd, year):
    """단일 구의 연간 데이터를 MOLIT에서 다운로드"""
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    print(f"\n  [{sgg_nm} {year}] 시작...")

    try:
        # 페이지 새로고침으로 세션 리셋
        await page.goto("https://rt.molit.go.kr/pt/xls/xls.do?mobileAt=", timeout=30000)
        await page.wait_for_load_state("networkidle", timeout=20000)

        # 아파트 탭 클릭 확인 (기본이 아파트=A)
        # srhThingNo = A (아파트)
        await page.evaluate("document.querySelector('#srhThingNo').value = 'A'")
        await page.evaluate("document.querySelector('#srhDelngSecd').value = '1'")  # 매매

        # 날짜 설정
        from_dt = f"{year}-01-01"
        to_dt = f"{year}-12-31"
        await page.fill("#srhFromDt", from_dt)
        await page.fill("#srhToDt", to_dt)

        # 시도 선택 (서울=11)
        await page.select_option("#srhSidoCd", value="11")
        await page.wait_for_timeout(1500)  # AJAX 로딩 대기

        # 시군구 선택
        await page.select_option("#srhSggCd", value=sgg_cd)
        await page.wait_for_timeout(1000)

        # 시도명/시군구명 hidden 업데이트
        await page.evaluate(f"""
            document.querySelector('#sidoNm').value = '서울특별시';
            document.querySelector('#sggNm').value = '{sgg_nm}';
        """)

        # 다운로드 이벤트 캡처
        download_path = OUTPUT_DIR / f"{sgg_nm}_{year}.xls"

        # EXCEL 다운 버튼 클릭
        async with page.expect_download(timeout=60000) as download_info:
            await page.evaluate("fnExcelDown()")

        download = await download_info.value
        await download.save_as(str(download_path))
        size = download_path.stat().st_size if download_path.exists() else 0
        print(f"  ✓ {sgg_nm} {year}: {size:,} bytes → {download_path}")
        return str(download_path)

    except PlaywrightTimeout:
        print(f"  ✗ {sgg_nm} {year}: 타임아웃")
        return None
    except Exception as e:
        print(f"  ✗ {sgg_nm} {year}: {e}")
        return None


async def main():
    from playwright.async_api import async_playwright

    print("=== MOLIT 브라우저 자동화 데이터 수집 ===")
    downloaded_files = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            accept_downloads=True,
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        )
        page = await context.new_page()

        # 서울 25개 구 × 2023~2024 = 50건 다운로드
        years = [2023, 2024]
        for year in years:
            for sgg_nm, sgg_cd in SEOUL_SGG.items():
                fpath = await download_gu_data(page, sgg_nm, sgg_cd, year)
                if fpath:
                    downloaded_files.append(fpath)
                await asyncio.sleep(1.5)  # 서버 부하 방지

        await browser.close()

    print(f"\n총 {len(downloaded_files)}개 파일 다운로드 완료")
    return downloaded_files


def parse_molit_excel(filepath):
    """MOLIT 엑셀 파일 파싱 → gu, area, floor, built_year, price DataFrame"""
    try:
        # MOLIT 엑셀 헤더는 1~2행이 안내문, 3행부터 컬럼명
        df_raw = pd.read_excel(filepath, header=None)
        print(f"  원시 shape: {df_raw.shape}")
        if df_raw.shape[0] < 3:
            return None

        # 컬럼명 행 찾기 (보통 0~3번째 행 중 NaN이 적은 행)
        header_row = 0
        for i in range(min(5, len(df_raw))):
            null_count = df_raw.iloc[i].isna().sum()
            if null_count < df_raw.shape[1] * 0.5:
                header_row = i
                break

        df = pd.read_excel(filepath, header=header_row)
        print(f"  컬럼: {list(df.columns)[:10]}")
        return df
    except Exception as e:
        print(f"  파싱 오류 {filepath}: {e}")
        return None


if __name__ == "__main__":
    files = asyncio.run(main())

    if not files:
        print("다운로드된 파일 없음 - 다른 방법 필요")
        sys.exit(1)

    # 파싱 및 병합
    all_dfs = []
    for f in files:
        df = parse_molit_excel(f)
        if df is not None:
            all_dfs.append(df)

    if all_dfs:
        combined = pd.concat(all_dfs, ignore_index=True)
        combined.to_csv("/tmp/molit_raw.csv", index=False, encoding="utf-8-sig")
        print(f"\n병합 완료: {len(combined)}행")
        print(combined.head())
    else:
        print("파싱 실패")
        sys.exit(1)
