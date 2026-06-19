"""강남구 2023년 파싱 구조 테스트"""
import requests, pandas as pd, io, warnings
warnings.filterwarnings("ignore")

BASE = "https://rt.molit.go.kr"
s = requests.Session()
s.headers.update({"User-Agent": "Mozilla/5.0", "Referer": f"{BASE}/pt/xls/xls.do?mobileAt="})
r = s.get(f"{BASE}/pt/xls/xls.do?mobileAt=", timeout=15, verify=False)
jsid = s.cookies.get("JSESSIONID", "")
print(f"세션: JSESSIONID={jsid[:15]}...")

form = {
    "srhThingNo": "A", "srhDelngSecd": "1", "srhAddrGbn": "1", "srhLfstsSecd": "1",
    "sidoNm": "서울특별시", "sggNm": "강남구", "emdNm": "", "loadNm": "", "areaNm": "", "hsmpNm": "",
    "mobileAt": "", "srhFromDt": "2023-01-01", "srhToDt": "2023-12-31", "srhNewRonSecd": "",
    "srhSidoCd": "11", "srhSggCd": "11680", "srhEmdCd": "", "srhRoadNm": "", "srhLoadCd": "",
    "srhHsmpCd": "", "srhArea": "", "srhFromAmount": "", "srhToAmount": "", "srhLrArea": ""
}

rd = s.post(f"{BASE}/pt/xls/ptXlsExcelDown.do;jsessionid={jsid}", data=form, timeout=50, verify=False)
print(f"다운로드: {rd.status_code}, {len(rd.content)} bytes")

df_raw = pd.read_excel(io.BytesIO(rd.content), header=None, dtype=str)
print(f"\n원시 shape: {df_raw.shape}")
print("처음 10행 (앞 8열):")
for i in range(min(10, len(df_raw))):
    row = df_raw.iloc[i]
    vals = [str(v)[:30] for v in row.values[:8]]
    print(f"  행{i}: {vals}")

# 헤더 행 찾기
print("\n헤더 탐색:")
for i in range(min(15, len(df_raw))):
    row_str = " ".join(str(v) for v in df_raw.iloc[i].values if str(v) != 'nan')
    keywords = ["전용면적", "거래금액", "건축년도", "층", "시군구", "법정동", "단지명"]
    found = [kw for kw in keywords if kw in row_str]
    if found:
        print(f"  행{i} → 키워드 발견: {found}")
        print(f"  내용: {row_str[:120]}")
