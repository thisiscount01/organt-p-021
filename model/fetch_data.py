"""
국토교통부 실거래가 데이터 수집 스크립트
- MOLIT 실거래가 공개시스템에서 서울 25개 구 아파트 매매 데이터를 수집
- 세션 기반 방식으로 직접 엑셀 다운로드 시도
- 2023~2024년 데이터 수집 목표
"""

import requests
import pandas as pd
import io
import time
import json
import os
import sys

BASE_URL = "https://rt.molit.go.kr"

# 서울 25개 구 코드 매핑 (시도코드 11 = 서울특별시)
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

def create_session():
    """MOLIT 세션 생성"""
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Origin': 'https://rt.molit.go.kr',
        'Referer': 'https://rt.molit.go.kr/pt/xls/xls.do?mobileAt=',
    })
    # 메인 페이지 방문으로 세션 쿠키 획득
    r = session.get(f"{BASE_URL}/pt/xls/xls.do?mobileAt=", timeout=20)
    print(f"세션 시작: {r.status_code}, 쿠키={dict(session.cookies)}")
    return session


def fetch_apt_data(session, sgg_cd, sgg_nm, from_dt, to_dt):
    """특정 구의 아파트 매매 데이터를 엑셀로 다운로드"""
    # 데이터 건수 체크
    check_url = f"{BASE_URL}/pt/xls/ptXlsDownDataCheck.do"
    check_data = {
        "srhThingNo": "A",    # A=아파트 (HTML 폼 기본값)
        "srhDelngSecd": "1",  # 1=매매
        "srhAddrGbn": "1",    # 1=지번
        "srhLfstsSecd": "1",  # 1=보증금
        "sidoNm": "서울특별시",
        "sggNm": sgg_nm,
        "emdNm": "",
        "loadNm": "",
        "areaNm": "",
        "hsmpNm": "",
        "mobileAt": "",
        "srhFromDt": from_dt,
        "srhToDt": to_dt,
        "srhNewRonSecd": "",
        "srhSidoCd": "11",
        "srhSggCd": sgg_cd,
        "srhEmdCd": "",
        "srhRoadNm": "",
        "srhLoadCd": "",
        "srhHsmpCd": "",
        "srhArea": "",
        "srhFromAmount": "",
        "srhToAmount": "",
        "srhLrArea": "",
    }

    try:
        r_check = session.post(check_url, data=check_data, timeout=15)
        print(f"  체크 {sgg_nm} {from_dt}: {r_check.status_code} {r_check.text[:200]}")
    except Exception as e:
        print(f"  체크 오류: {e}")

    # 엑셀 다운로드
    down_url = f"{BASE_URL}/pt/xls/ptXlsExcelDown.do"
    try:
        r_down = session.post(down_url, data=check_data, timeout=60)
        print(f"  다운로드 {sgg_nm}: {r_down.status_code}, size={len(r_down.content)}, "
              f"content-type={r_down.headers.get('content-type','?')}")

        ct = r_down.headers.get('content-type', '')
        if 'excel' in ct or 'spreadsheet' in ct or 'octet-stream' in ct:
            return r_down.content
        elif r_down.status_code == 200 and len(r_down.content) > 5000:
            # 혹시 content-type이 잘못 설정된 경우도 시도
            return r_down.content
        else:
            print(f"  응답 내용: {r_down.text[:300]}")
            return None
    except Exception as e:
        print(f"  다운로드 오류: {e}")
        return None


def parse_excel(content, sgg_nm):
    """엑셀 바이트 → DataFrame"""
    try:
        df = pd.read_excel(io.BytesIO(content), header=0)
        print(f"  파싱 성공: {len(df)}행, 컬럼={list(df.columns)[:8]}")
        return df
    except Exception as e:
        print(f"  엑셀 파싱 실패: {e}")
        # CSV 시도
        try:
            df = pd.read_csv(io.BytesIO(content), encoding='cp949')
            print(f"  CSV 파싱 성공: {len(df)}행")
            return df
        except:
            return None


if __name__ == "__main__":
    print("=== MOLIT 실거래가 데이터 수집 시작 ===")

    session = create_session()
    time.sleep(1)

    all_dfs = []
    # 테스트: 강남구 2023년만 먼저 시도
    for sgg_nm, sgg_cd in list(SEOUL_SGG.items())[:3]:
        print(f"\n[{sgg_nm}] 2023년 데이터 수집...")
        content = fetch_apt_data(
            session, sgg_cd, sgg_nm,
            "2023-01-01", "2023-12-31"
        )
        if content:
            df = parse_excel(content, sgg_nm)
            if df is not None:
                df['_gu'] = sgg_nm
                all_dfs.append(df)
        time.sleep(2)

    if all_dfs:
        combined = pd.concat(all_dfs, ignore_index=True)
        print(f"\n합계: {len(combined)}행")
        print(combined.head())
        combined.to_csv('/tmp/molit_test_data.csv', index=False, encoding='utf-8-sig')
        print("저장: /tmp/molit_test_data.csv")
    else:
        print("\n데이터 수집 실패 - 대안 방법 필요")
