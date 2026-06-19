"""
MOLIT 실거래가 수집 - 병렬 다운로드로 60초 내 완료
ThreadPoolExecutor 사용, 구별 병렬 처리
"""

import requests
import pandas as pd
import io
import time
import os
import sys
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

warnings.filterwarnings("ignore")
requests.packages.urllib3.disable_warnings()

BASE = "https://rt.molit.go.kr"

SEOUL_SGG = {
    "강남구":   "11680", "강동구":   "11740", "강북구":   "11305",
    "강서구":   "11500", "관악구":   "11620", "광진구":   "11215",
    "구로구":   "11530", "금천구":   "11545", "노원구":   "11350",
    "도봉구":   "11320", "동대문구": "11230", "동작구":   "11590",
    "마포구":   "11440", "서대문구": "11410", "서초구":   "11650",
    "성동구":   "11200", "성북구":   "11290", "송파구":   "11710",
    "양천구":   "11470", "영등포구": "11560", "용산구":   "11170",
    "은평구":   "11380", "종로구":   "11110", "중구":     "11140",
    "중랑구":   "11260",
}

# Thread-local 세션 (스레드별 독립 세션)
_tlocal = threading.local()
_session_lock = threading.Lock()

def get_session():
    if not hasattr(_tlocal, 'session'):
        s = requests.Session()
        s.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": f"{BASE}/pt/xls/xls.do?mobileAt=",
        })
        r = s.get(f"{BASE}/pt/xls/xls.do?mobileAt=", timeout=20, verify=False)
        _tlocal.session = s
        _tlocal.jsid = s.cookies.get("JSESSIONID", "")
    return _tlocal.session, _tlocal.jsid


def find_header_row(content):
    df_raw = pd.read_excel(io.BytesIO(content), header=None, dtype=str, nrows=20)
    for i in range(len(df_raw)):
        row_str = " ".join(str(v) for v in df_raw.iloc[i].values if str(v) != 'nan')
        if "전용면적" in row_str and "거래금액" in row_str:
            return i
    return 12


def parse_excel(content, gu_name):
    """MOLIT 엑셀 → gu, area, floor, built_year, price, complex_name, deal_ym 파싱
    컬럼: NO, 시군구, 번지, 본번, 부번, 단지명, 전용면적(㎡),
          계약년월, 계약일, 거래금액(만원), 동, 층, 매수자, 매도자, 건축년도, ...
    """
    try:
        hdr = find_header_row(content)
        df = pd.read_excel(io.BytesIO(content), header=hdr, dtype=str)
        df = df.dropna(axis=1, how="all").dropna(how="all")

        col_map = {}
        for col in df.columns:
            c = str(col).strip()
            if "전용면적" in c:         col_map[col] = "area"
            elif c == "층":             col_map[col] = "floor"
            elif "건축년도" in c:       col_map[col] = "built_year"
            elif "거래금액" in c:       col_map[col] = "price_raw"
            elif c == "단지명":         col_map[col] = "complex_name"
            elif "계약년월" in c:       col_map[col] = "deal_ym"
            elif c == "시군구":         col_map[col] = "sgg_col"

        df = df.rename(columns=col_map)
        df["gu"] = gu_name

        required = {"area", "floor", "built_year", "price_raw"}
        if required - set(df.columns):
            return None

        def to_f(x):
            try: return float(str(x).replace(",", "").strip())
            except: return None

        df["area"]       = df["area"].apply(to_f)
        df["floor"]      = df["floor"].apply(to_f)
        df["built_year"] = df["built_year"].apply(lambda x: int(v) if (v := to_f(x)) else None)
        df["price"]      = df["price_raw"].apply(to_f)

        # 단지명: 공백 정리
        if "complex_name" in df.columns:
            df["complex_name"] = df["complex_name"].apply(
                lambda x: str(x).strip() if str(x) not in ['nan','None',''] else None)
        else:
            df["complex_name"] = None

        # 계약년월: 6자리 숫자 (예: 202301)
        if "deal_ym" in df.columns:
            df["deal_ym"] = df["deal_ym"].apply(to_f)
        else:
            df["deal_ym"] = None

        cols = ["gu", "area", "floor", "built_year", "price", "complex_name", "deal_ym"]
        res = df[[c for c in cols if c in df.columns]].dropna(subset=["area","floor","built_year","price"])
        res = res[
            (res["area"] > 0) & (res["area"] < 600) &
            (res["floor"] >= 1) & (res["floor"] <= 100) &
            (res["built_year"] >= 1960) & (res["built_year"] <= 2026) &
            (res["price"] > 1000)
        ].copy()
        return res
    except:
        return None


def download_gu_year(sgg_nm, sgg_cd, year):
    """단일 구+연도 다운로드 및 파싱"""
    try:
        s, jsid = get_session()
        form = {
            "srhThingNo": "A", "srhDelngSecd": "1", "srhAddrGbn": "1", "srhLfstsSecd": "1",
            "sidoNm": "서울특별시", "sggNm": sgg_nm,
            "emdNm": "", "loadNm": "", "areaNm": "", "hsmpNm": "",
            "mobileAt": "",
            "srhFromDt": f"{year}-01-01", "srhToDt": f"{year}-12-31",
            "srhNewRonSecd": "",
            "srhSidoCd": "11", "srhSggCd": sgg_cd,
            "srhEmdCd": "", "srhRoadNm": "", "srhLoadCd": "", "srhHsmpCd": "",
            "srhArea": "", "srhFromAmount": "", "srhToAmount": "", "srhLrArea": "",
        }

        # 건수 확인
        rc = s.post(f"{BASE}/pt/xls/ptXlsDownDataCheck.do;jsessionid={jsid}",
                    data=form, timeout=15, verify=False)
        cnt = rc.json().get("cnt", 0)
        if cnt == 0:
            return sgg_nm, year, None, 0

        # 엑셀 다운로드
        rd = s.post(f"{BASE}/pt/xls/ptXlsExcelDown.do;jsessionid={jsid}",
                    data=form, timeout=60, verify=False)
        if rd.status_code != 200 or len(rd.content) < 5000:
            return sgg_nm, year, None, cnt

        df = parse_excel(rd.content, sgg_nm)
        return sgg_nm, year, df, cnt

    except Exception as e:
        return sgg_nm, year, None, 0


if __name__ == "__main__":
    print("=== MOLIT 병렬 수집 시작 ===\n")
    t0 = time.time()

    tasks = [(nm, cd, yr) for yr in [2023, 2024] for nm, cd in SEOUL_SGG.items()]
    print(f"총 {len(tasks)}개 배치 (25구 × 2년)")

    all_dfs = []
    failed = []
    results_log = []

    # 4개 스레드 병렬 (서버 부하 고려)
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = {ex.submit(download_gu_year, nm, cd, yr): (nm, yr)
                   for nm, cd, yr in tasks}
        done = 0
        for fut in as_completed(futures):
            sgg_nm, year, df, cnt = fut.result()
            done += 1
            elapsed = time.time() - t0
            if df is not None and len(df) > 0:
                all_dfs.append(df)
                print(f"  [{done:2d}/50] ✓ {sgg_nm} {year}: {len(df)}건  ({elapsed:.1f}s)")
                results_log.append(f"{sgg_nm},{year},{len(df)}")
            else:
                failed.append((sgg_nm, year))
                print(f"  [{done:2d}/50] ✗ {sgg_nm} {year}: cnt={cnt}  ({elapsed:.1f}s)")

    total_time = time.time() - t0
    print(f"\n=== 완료: {total_time:.1f}초 ===")
    print(f"성공: {len(all_dfs)}배치, 실패: {len(failed)}배치")

    if not all_dfs:
        print("모든 다운로드 실패")
        sys.exit(1)

    combined = pd.concat(all_dfs, ignore_index=True)
    combined["area"]       = combined["area"].astype(float)
    combined["floor"]      = combined["floor"].astype(float)
    combined["built_year"] = combined["built_year"].astype(int)
    combined["price"]      = combined["price"].astype(float)

    print(f"\n총 {len(combined):,}건")
    print(f"구별 건수:\n{combined.groupby('gu')['price'].count().to_string()}")
    print(f"\n가격 통계 (만원):\n  평균={combined['price'].mean():.0f}, "
          f"중앙값={combined['price'].median():.0f}, "
          f"최소={combined['price'].min():.0f}, 최대={combined['price'].max():.0f}")

    out = os.path.join(os.path.dirname(__file__), "seoul_apt_raw.csv")
    combined.to_csv(out, index=False, encoding="utf-8-sig")
    print(f"\n저장: {out}  ({len(combined):,}행)")
