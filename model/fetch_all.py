"""
국토교통부 실거래가 공개시스템 — 서울 25개 구 × 2023~2024 전체 다운로드
- rt.molit.go.kr POST 방식 (세션 기반, 키 불필요)
- 엑셀 헤더 파싱 수정 포함
"""

import requests
import pandas as pd
import io
import time
import os
import sys
import warnings
warnings.filterwarnings("ignore")

BASE = "https://rt.molit.go.kr"

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

def make_session():
    s = requests.Session()
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": f"{BASE}/pt/xls/xls.do?mobileAt=",
    })
    r = s.get(f"{BASE}/pt/xls/xls.do?mobileAt=", timeout=20, verify=False)
    jsid = s.cookies.get("JSESSIONID", "")
    print(f"  세션 확보 (JSESSIONID={jsid[:20]}...)")
    return s, jsid


def build_form(sgg_nm, sgg_cd, year):
    from_dt = f"{year}-01-01"
    to_dt   = f"{year}-12-31"
    return {
        "srhThingNo": "A",
        "srhDelngSecd": "1",
        "srhAddrGbn": "1",
        "srhLfstsSecd": "1",
        "sidoNm": "서울특별시",
        "sggNm": sgg_nm,
        "emdNm": "", "loadNm": "", "areaNm": "", "hsmpNm": "",
        "mobileAt": "",
        "srhFromDt": from_dt,
        "srhToDt": to_dt,
        "srhNewRonSecd": "",
        "srhSidoCd": "11",
        "srhSggCd": sgg_cd,
        "srhEmdCd": "", "srhRoadNm": "", "srhLoadCd": "", "srhHsmpCd": "",
        "srhArea": "", "srhFromAmount": "", "srhToAmount": "", "srhLrArea": "",
    }


def download_one(s, jsid, sgg_nm, sgg_cd, year, retry=2):
    form = build_form(sgg_nm, sgg_cd, year)

    # 건수 체크
    check_url = f"{BASE}/pt/xls/ptXlsDownDataCheck.do;jsessionid={jsid}"
    try:
        rc = s.post(check_url, data=form, timeout=15, verify=False)
        import json
        cnt_data = rc.json()
        cnt = cnt_data.get("cnt", 0)
        if cnt == 0:
            print(f"    [{sgg_nm} {year}] 데이터 없음 (cnt=0)")
            return None
        print(f"    [{sgg_nm} {year}] {cnt}건 확인 →", end=" ")
    except Exception as e:
        print(f"    [{sgg_nm} {year}] 체크 오류: {e}")
        return None

    # 엑셀 다운로드
    down_url = f"{BASE}/pt/xls/ptXlsExcelDown.do;jsessionid={jsid}"
    for attempt in range(retry):
        try:
            rd = s.post(down_url, data=form, timeout=60, verify=False)
            if rd.status_code == 200 and len(rd.content) > 5000:
                print(f"다운로드 성공 ({len(rd.content):,} bytes)")
                return rd.content
            else:
                print(f"재시도 {attempt+1} (status={rd.status_code}, size={len(rd.content)})")
                time.sleep(3)
        except Exception as e:
            print(f"다운로드 오류: {e}")
            time.sleep(3)
    return None


def find_header_row(content):
    """MOLIT 엑셀의 헤더 행 인덱스를 탐색"""
    df_raw = pd.read_excel(io.BytesIO(content), header=None, dtype=str)
    for i in range(min(20, len(df_raw))):
        row_str = " ".join(str(v) for v in df_raw.iloc[i].values if str(v) != 'nan')
        if "전용면적" in row_str and "거래금액" in row_str:
            return i
    return 12  # MOLIT 표준 위치 fallback


def parse_excel(content, gu_name):
    """MOLIT 엑셀 → gu, area, floor, built_year, price 파싱
    실제 헤더: NO,시군구,번지,본번,부번,단지명,전용면적(㎡),계약년월,계약일,
               거래금액(만원),동,층,매수자,매도자,건축년도,...
    """
    try:
        hdr = find_header_row(content)
        df = pd.read_excel(io.BytesIO(content), header=hdr, dtype=str)
        df = df.dropna(axis=1, how="all").dropna(how="all")

        # 컬럼 매핑 - MOLIT 확정 컬럼명 기준
        col_map = {}
        for col in df.columns:
            c = str(col).strip()
            if "전용면적" in c:
                col_map[col] = "area"
            elif c == "층":
                col_map[col] = "floor"
            elif "건축년도" in c or "건축연도" in c:
                col_map[col] = "built_year"
            elif "거래금액" in c:
                col_map[col] = "price_raw"

        df = df.rename(columns=col_map)
        df["gu"] = gu_name

        required = {"area", "floor", "built_year", "price_raw"}
        missing = required - set(df.columns)
        if missing:
            print(f"\n      [경고] 컬럼 누락 {missing}, 전체목록={list(df.columns)[:15]}")
            return None

        def to_f(x):
            try:
                return float(str(x).replace(",", "").strip())
            except:
                return None

        df["area"]       = df["area"].apply(to_f)
        df["floor"]      = df["floor"].apply(to_f)
        df["built_year"] = df["built_year"].apply(lambda x: int(v) if (v := to_f(x)) else None)
        df["price"]      = df["price_raw"].apply(to_f)

        res = df[["gu", "area", "floor", "built_year", "price"]].dropna()
        res = res[
            (res["area"] > 0) & (res["area"] < 600) &
            (res["floor"] >= 1) & (res["floor"] <= 100) &
            (res["built_year"] >= 1960) & (res["built_year"] <= 2026) &
            (res["price"] > 1000)
        ].copy()
        print(f"      → {len(res)}건 유효")
        return res

    except Exception as e:
        import traceback
        print(f"      파싱 오류: {e}")
        traceback.print_exc()
        return None


if __name__ == "__main__":
    print("=== MOLIT 서울 25개 구 실거래가 수집 (2023~2024) ===\n")

    all_dfs = []
    failed = []

    s, jsid = make_session()
    time.sleep(1)

    years = [2023, 2024]
    total = len(SEOUL_SGG) * len(years)
    done = 0

    for year in years:
        for sgg_nm, sgg_cd in SEOUL_SGG.items():
            done += 1
            print(f"[{done}/{total}] {sgg_nm} {year}")

            content = download_one(s, jsid, sgg_nm, sgg_cd, year)
            if content is None:
                failed.append((sgg_nm, year))
                time.sleep(2)
                continue

            df = parse_excel(content, sgg_nm)
            if df is not None and len(df) > 0:
                all_dfs.append(df)
            else:
                failed.append((sgg_nm, year))

            time.sleep(1.5)  # 서버 부하 방지

    print(f"\n=== 수집 완료 ===")
    print(f"성공: {len(all_dfs)}개 배치, 실패: {failed}")

    if not all_dfs:
        print("모든 다운로드 실패")
        sys.exit(1)

    combined = pd.concat(all_dfs, ignore_index=True)
    print(f"총 {len(combined):,}건")
    print(f"컬럼: {list(combined.columns)}")
    print(combined.groupby("gu")["price"].agg(["count", "mean"]).round(0))

    out_path = os.path.join(os.path.dirname(__file__), "seoul_apt_raw.csv")
    combined.to_csv(out_path, index=False, encoding="utf-8-sig")
    print(f"\n저장 완료: {out_path}  ({len(combined):,}행)")
