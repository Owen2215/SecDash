"""SecDash backend — wraps SEC EDGAR lookups (see ../../api.py) as FastAPI routes.

Every number returned here is pulled live from SEC's XBRL "company facts" API
(data.sec.gov) — no scraping, no cached snapshots of filing documents, no
fabricated data. Each figure carries the accession number of the specific
filing it came from, so the frontend can link straight back to the primary
source document on EDGAR for verification.
"""

import asyncio
import math
import os
import re
import time
from datetime import date
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types as genai_types
from google.genai import errors as genai_errors
from pydantic import BaseModel

load_dotenv()

SEC_HEADERS = {"User-Agent": "SecDash contact@example.com"}
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
FILING_INDEX_URL = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{accn_nodash}/{accn}-index.htm"
BROWSE_EDGAR_URL = "https://www.sec.gov/cgi-bin/browse-edgar"

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODEL = "gemini-3.1-flash-lite"
_gemini_client = (
    genai.Client(api_key=GEMINI_API_KEY, http_options=genai_types.HttpOptions(timeout=100_000))
    if GEMINI_API_KEY
    else None
)

app = FastAPI(title="SecDash API", description="Live SEC EDGAR financial data for SecDash")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8731",
        "http://127.0.0.1:8731",
        "https://secdash.netlify.app",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ============================== Rate limiting ==============================
# SEC enforces a hard cap of 10 requests/second per IP and returns 429s past
# that. A simple leaky-bucket: a lock plus a minimum spacing between requests
# leaving this process, shared across all concurrent handlers.
_SEC_MIN_INTERVAL = 0.12  # ~8.3 req/s, safely under SEC's 10 req/s cap
_rate_limit_lock = asyncio.Lock()
_last_request_at = 0.0


async def _throttled_get(client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
    global _last_request_at
    async with _rate_limit_lock:
        now = time.monotonic()
        wait = _SEC_MIN_INTERVAL - (now - _last_request_at)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_request_at = time.monotonic()
    return await client.get(url, **kwargs)


# ============================== Caches ==============================
# SEC's ticker list is ~10MB and rarely changes; company facts/submissions
# are re-fetched per request (no historical filing is ever rewritten, but
# new filings appear, so these aren't cached long-term here).
_ticker_cache: dict = {"data": None, "fetched_at": 0.0}
TICKER_CACHE_TTL = 24 * 60 * 60  # 24h


# ============================== Models ==============================
class FinancialYear(BaseModel):
    year: int
    revenue: Optional[float] = None
    net_income: Optional[float] = None
    operating_income: Optional[float] = None
    operating_cash_flow: Optional[float] = None
    capex: Optional[float] = None
    free_cash_flow: Optional[float] = None
    stock_based_comp: Optional[float] = None
    dividends_paid: Optional[float] = None
    debt_repayment: Optional[float] = None
    buybacks: Optional[float] = None
    accounts_receivable: Optional[float] = None
    inventory: Optional[float] = None
    goodwill: Optional[float] = None
    total_assets: Optional[float] = None
    cogs: Optional[float] = None
    # Provenance: which SEC filing this year's headline figures were sourced from.
    source_accession: Optional[str] = None
    source_filed: Optional[str] = None
    source_form: Optional[str] = None
    source_url: Optional[str] = None


class CompanyFinancials(BaseModel):
    ticker: str
    cik: str
    name: str
    years: list[FinancialYear]


class Filing(BaseModel):
    form: str
    filed: str
    period_of_report: Optional[str] = None
    accession_number: str
    primary_document: Optional[str] = None
    url: str


class CompanyFilings(BaseModel):
    ticker: str
    cik: str
    name: str
    filings: list[Filing]


class CompanyProfile(BaseModel):
    ticker: str
    cik: str
    name: str
    sic: Optional[str] = None
    industry: Optional[str] = None
    exchange: Optional[str] = None
    state_of_incorporation: Optional[str] = None
    fiscal_year_end: Optional[str] = None
    category: Optional[str] = None
    website: Optional[str] = None


class PeerCompany(BaseModel):
    ticker: str
    cik: str
    name: str
    revenue: Optional[float] = None
    net_income: Optional[float] = None
    year: Optional[int] = None


class PeerComparison(BaseModel):
    ticker: str
    industry: Optional[str] = None
    peers: list[PeerCompany]


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    ticker: str
    company_name: Optional[str] = None
    dashboard_context: str  # plain-text summary of what's currently on screen
    messages: list[ChatMessage]  # prior turns, most recent last


class ChatResponse(BaseModel):
    reply: str


# ============================== SEC lookups ==============================
async def _get_ticker_map(client: httpx.AsyncClient) -> dict:
    now = time.time()
    if _ticker_cache["data"] is not None and (now - _ticker_cache["fetched_at"]) < TICKER_CACHE_TTL:
        return _ticker_cache["data"]

    resp = await _throttled_get(client, TICKERS_URL, headers=SEC_HEADERS)
    resp.raise_for_status()
    raw = resp.json()

    by_ticker = {entry["ticker"].upper(): entry for entry in raw.values()}
    _ticker_cache["data"] = by_ticker
    _ticker_cache["fetched_at"] = now
    return by_ticker


async def _resolve_cik(client: httpx.AsyncClient, ticker: str) -> tuple[str, str]:
    tickers = await _get_ticker_map(client)
    entry = tickers.get(ticker.upper())
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Ticker '{ticker}' not found")
    cik = str(entry["cik_str"]).zfill(10)
    return cik, entry["title"]


def _period_days(start: Optional[str], end: Optional[str]) -> Optional[int]:
    if not start or not end:
        return None
    try:
        s = date.fromisoformat(start)
        e = date.fromisoformat(end)
    except (TypeError, ValueError):
        return None
    return (e - s).days


def _filing_url(cik: str, accn: str) -> str:
    cik_int = str(int(cik))  # EDGAR archive paths use the un-padded CIK
    accn_nodash = accn.replace("-", "")
    return FILING_INDEX_URL.format(cik_int=cik_int, accn_nodash=accn_nodash, accn=accn)


# Domestic US filers report under us-gaap and file 10-Ks. Foreign private issuers
# (e.g. TSM, foreign ADRs) report under IFRS and file 20-Fs instead - same annual
# structure, different taxonomy and form type, so both are tried.
ANNUAL_FORMS = ("10-K", "10-K/A", "20-F", "20-F/A")
TAXONOMIES = ("us-gaap", "ifrs-full")

Fact = dict  # {val, accn, filed, form}


def _extract_annual_facts(facts: dict, tags: list[str], instant: bool = False) -> dict[int, Fact]:
    """Merge one or more XBRL tags (across taxonomies) into one fact per fiscal year.

    Companies sometimes switch XBRL tags across years (e.g. Apple used `Revenues`
    through FY2018, then `RevenueFromContractWithCustomerExcludingAssessedTax`
    from FY2017 onward) so tags are merged to fill gaps, not tried in fallback order.

    Annual filings also restate prior-year comparatives under the SEC's `fy` label, so
    the same `fy` can appear multiple times with different periods. Key by the actual
    period's end-date year instead. Duration facts (revenue, cash flow) are kept only
    if the period is ~1 year long; instant facts (balance-sheet snapshots like
    Goodwill) have no `start` date and are kept by `end` date alone.
    """
    all_facts = facts.get("facts", {})
    by_year: dict[int, Fact] = {}

    for taxonomy in TAXONOMIES:
        taxonomy_facts = all_facts.get(taxonomy, {})
        for tag in tags:
            concept = taxonomy_facts.get(tag)
            if not concept:
                continue
            units = concept.get("units", {}).get("USD", [])
            for item in units:
                if item.get("form") not in ANNUAL_FORMS:
                    continue
                if item.get("fp") != "FY":
                    continue
                start, end, val = item.get("start"), item.get("end"), item.get("val")
                accn, filed, form = item.get("accn"), item.get("filed", ""), item.get("form")
                if not end or val is None or not accn:
                    continue

                if instant:
                    if start:  # this tag reported a duration fact, not instant — skip
                        continue
                else:
                    days = _period_days(start, end)
                    if days is None or not (350 <= days <= 380):
                        continue

                year = int(end[:4])
                existing = by_year.get(year)
                if existing is None:
                    by_year[year] = {"val": val, "accn": accn, "filed": filed, "form": form}
                elif val != existing["val"] and filed > existing["filed"]:
                    # Genuine restatement (later filing reports a different value for
                    # this year) — take the newer, corrected figure.
                    by_year[year] = {"val": val, "accn": accn, "filed": filed, "form": form}
                elif val == existing["val"] and filed < existing["filed"]:
                    # Same value cited again as a comparative in a later filing —
                    # keep citing the original filing where this year was first reported,
                    # so the source link points to the primary document, not a reprint.
                    by_year[year] = {"val": val, "accn": accn, "filed": filed, "form": form}

    return by_year


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/companies/{ticker}/financials", response_model=CompanyFinancials)
async def get_company_financials(ticker: str, years: int = 8):
    async with httpx.AsyncClient(timeout=15.0) as client:
        cik, name = await _resolve_cik(client, ticker)

        resp = await _throttled_get(client, FACTS_URL.format(cik=cik), headers=SEC_HEADERS)
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail=f"No SEC facts available for '{ticker}'")
        resp.raise_for_status()
        facts = resp.json()

    # Duration facts (income statement + cash flow statement lines)
    revenue = _extract_annual_facts(
        facts, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "Revenue"]
    )
    net_income = _extract_annual_facts(facts, ["NetIncomeLoss", "ProfitLoss"])
    operating_income = _extract_annual_facts(facts, ["OperatingIncomeLoss", "ProfitLossFromOperatingActivities"])
    cogs = _extract_annual_facts(facts, ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfSales"])
    ocf = _extract_annual_facts(
        facts, ["NetCashProvidedByUsedInOperatingActivities", "CashFlowsFromUsedInOperatingActivities"]
    )
    capex = _extract_annual_facts(
        facts,
        [
            "PaymentsToAcquirePropertyPlantAndEquipment",
            "PurchaseOfPropertyPlantAndEquipment",
            "PaymentsToAcquireProductiveAssets",
        ],
    )
    sbc = _extract_annual_facts(facts, ["ShareBasedCompensation"])
    dividends = _extract_annual_facts(facts, ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"])
    debt_repayment = _extract_annual_facts(
        facts, ["RepaymentsOfLongTermDebt", "RepaymentsOfDebt"]
    )
    buybacks = _extract_annual_facts(
        facts, ["PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfEquity"]
    )

    # Instant facts (balance-sheet snapshots)
    accounts_receivable = _extract_annual_facts(
        facts, ["AccountsReceivableNetCurrent", "TradeReceivablesCurrent"], instant=True
    )
    inventory = _extract_annual_facts(facts, ["InventoryNet", "Inventories"], instant=True)
    goodwill = _extract_annual_facts(facts, ["Goodwill"], instant=True)
    total_assets = _extract_annual_facts(facts, ["Assets"], instant=True)

    # Revenue + net income define which fiscal years the dashboard covers;
    # everything else is best-effort overlay on those same years.
    all_years = sorted(set(revenue) | set(net_income))[-years:]
    if not all_years:
        raise HTTPException(status_code=404, detail=f"No annual financial facts found for '{ticker}'")

    def get(series: dict[int, Fact], y: int, scale: float = 1e9) -> Optional[float]:
        f = series.get(y)
        return f["val"] / scale if f else None

    series_list = []
    for y in all_years:
        rev_fact = revenue.get(y) or net_income.get(y)
        ocf_val = get(ocf, y)
        capex_val = get(capex, y)
        fcf_val = (ocf_val - capex_val) if (ocf_val is not None and capex_val is not None) else None

        series_list.append(
            FinancialYear(
                year=y,
                revenue=get(revenue, y),
                net_income=get(net_income, y),
                operating_income=get(operating_income, y),
                operating_cash_flow=ocf_val,
                capex=capex_val,
                free_cash_flow=fcf_val,
                stock_based_comp=get(sbc, y),
                dividends_paid=get(dividends, y),
                debt_repayment=get(debt_repayment, y),
                buybacks=get(buybacks, y),
                accounts_receivable=get(accounts_receivable, y),
                inventory=get(inventory, y),
                goodwill=get(goodwill, y),
                total_assets=get(total_assets, y),
                cogs=get(cogs, y),
                source_accession=rev_fact["accn"] if rev_fact else None,
                source_filed=rev_fact["filed"] if rev_fact else None,
                source_form=rev_fact["form"] if rev_fact else None,
                source_url=_filing_url(cik, rev_fact["accn"]) if rev_fact else None,
            )
        )

    return CompanyFinancials(ticker=ticker.upper(), cik=cik, name=name, years=series_list)


@app.get("/companies/{ticker}/filings", response_model=CompanyFilings)
async def get_company_filings(ticker: str, limit: int = 15):
    async with httpx.AsyncClient(timeout=15.0) as client:
        cik, name = await _resolve_cik(client, ticker)

        resp = await _throttled_get(client, SUBMISSIONS_URL.format(cik=cik), headers=SEC_HEADERS)
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail=f"No SEC submissions found for '{ticker}'")
        resp.raise_for_status()
        data = resp.json()

    recent = data.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    filed_dates = recent.get("filingDate", [])
    period_dates = recent.get("reportDate", [])
    accns = recent.get("accessionNumber", [])
    primary_docs = recent.get("primaryDocument", [])

    interesting_forms = {"10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "8-K", "6-K"}

    filings = []
    for i in range(len(forms)):
        if forms[i] not in interesting_forms:
            continue
        accn = accns[i]
        filings.append(
            Filing(
                form=forms[i],
                filed=filed_dates[i] if i < len(filed_dates) else "",
                period_of_report=period_dates[i] if i < len(period_dates) and period_dates[i] else None,
                accession_number=accn,
                primary_document=primary_docs[i] if i < len(primary_docs) else None,
                url=_filing_url(cik, accn),
            )
        )
        if len(filings) >= limit:
            break

    return CompanyFilings(ticker=ticker.upper(), cik=cik, name=name, filings=filings)


# SEC's stateOfIncorporationDescription is usually just the 2-letter code for
# US states (not spelled out) — map the common ones for a more readable profile.
US_STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
    "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "DC": "District of Columbia",
}

_MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def _format_fiscal_year_end(raw: Optional[str]) -> Optional[str]:
    """SEC gives fiscalYearEnd as MMDD (e.g. "0926" -> "September 26")."""
    if not raw or len(raw) != 4 or not raw.isdigit():
        return raw
    month, day = int(raw[:2]), int(raw[2:])
    if not (1 <= month <= 12):
        return raw
    return f"{_MONTH_NAMES[month]} {day}"


@app.get("/companies/{ticker}/profile", response_model=CompanyProfile)
async def get_company_profile(ticker: str):
    """Plain-language company identity: what industry it's in, where it's
    incorporated, which exchange it trades on. Answers "what is this company"
    before the reader gets to any numbers.
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        cik, name = await _resolve_cik(client, ticker)

        resp = await _throttled_get(client, SUBMISSIONS_URL.format(cik=cik), headers=SEC_HEADERS)
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail=f"No SEC submissions found for '{ticker}'")
        resp.raise_for_status()
        data = resp.json()

    exchanges = data.get("exchanges") or []
    state_code = data.get("stateOfIncorporationDescription") or data.get("stateOfIncorporation") or None
    state_name = US_STATE_NAMES.get(state_code, state_code) if state_code else None

    return CompanyProfile(
        ticker=ticker.upper(),
        cik=cik,
        name=name,
        sic=data.get("sic"),
        industry=data.get("sicDescription"),
        exchange=exchanges[0] if exchanges else None,
        state_of_incorporation=state_name,
        fiscal_year_end=_format_fiscal_year_end(data.get("fiscalYearEnd")),
        category=data.get("category"),
        website=data.get("website") or None,
    )


async def _latest_revenue_and_income(client: httpx.AsyncClient, cik: str) -> tuple[Optional[float], Optional[float], Optional[int]]:
    """Lightweight version of the financials extraction — just the most recent
    year's revenue and net income, for peer comparison (where fetching all 15
    fields for every peer would be wasted work)."""
    resp = await _throttled_get(client, FACTS_URL.format(cik=cik), headers=SEC_HEADERS)
    if resp.status_code != 200:
        return None, None, None
    facts = resp.json()

    revenue = _extract_annual_facts(
        facts, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "Revenue"]
    )
    net_income = _extract_annual_facts(facts, ["NetIncomeLoss", "ProfitLoss"])

    years = sorted(set(revenue) & set(net_income))
    if not years:
        years = sorted(set(revenue) | set(net_income))
    if not years:
        return None, None, None

    latest = years[-1]
    rev = revenue.get(latest)
    ni = net_income.get(latest)
    return (rev["val"] / 1e9 if rev else None, ni["val"] / 1e9 if ni else None, latest)


@app.get("/companies/{ticker}/peers", response_model=PeerComparison)
async def get_company_peers(ticker: str, limit: int = 4):
    """Same-industry companies (matched by SEC's SIC code) with their latest
    revenue and net income, so a reader has a comparison point for whether a
    number like "$400B revenue" is actually large for this kind of business.

    SEC's SIC-code listing has no size ordering (roughly CIK/registration
    order), so a raw first-N slice mostly surfaces tiny, unfamiliar filers
    ahead of real, recognizable peers. Instead: pull a wide candidate pool,
    fetch each one's latest revenue, and keep the peers whose revenue is
    closest in scale (log-distance) to the target company — that reliably
    surfaces comparably-sized competitors instead of registration-order noise.
    """
    async with httpx.AsyncClient(timeout=25.0) as client:
        cik, name = await _resolve_cik(client, ticker)

        sub_resp = await _throttled_get(client, SUBMISSIONS_URL.format(cik=cik), headers=SEC_HEADERS)
        sub_resp.raise_for_status()
        sub_data = sub_resp.json()
        sic = sub_data.get("sic")
        industry = sub_data.get("sicDescription")

        if not sic:
            return PeerComparison(ticker=ticker.upper(), industry=industry, peers=[])

        own_revenue, _own_ni, _own_year = await _latest_revenue_and_income(client, cik)

        # SEC's browse-edgar-by-SIC listing includes every registrant in that
        # industry, most of which never got an actively-traded ticker (bonds,
        # inactive filers, preferred-only issuers) — so only a small fraction
        # of results cross-reference to a real ticker. Pull the max page size
        # to have enough candidates left after filtering.
        browse_resp = await _throttled_get(
            client,
            BROWSE_EDGAR_URL,
            params={
                "action": "getcompany",
                "SIC": sic,
                "type": "10-K",
                "dateb": "",
                "owner": "include",
                "count": 100,
                "output": "atom",
            },
            headers=SEC_HEADERS,
        )
        browse_resp.raise_for_status()
        peer_ciks = re.findall(r"<cik>(\d+)</cik>", browse_resp.text)

        tickers_map = await _get_ticker_map(client)
        cik_to_ticker = {str(v["cik_str"]).zfill(10): k for k, v in tickers_map.items()}

        # Same-SIC companies that also have a common-stock ticker (skips bonds,
        # preferred-share-only filers, etc.) and aren't the company itself.
        own_cik_padded = cik
        candidate_ciks = [
            c.zfill(10) for c in peer_ciks
            if c.zfill(10) != own_cik_padded and c.zfill(10) in cik_to_ticker
        ]

        candidates: list[PeerCompany] = []
        for peer_cik in candidate_ciks:
            peer_ticker = cik_to_ticker[peer_cik]
            peer_entry = tickers_map[peer_ticker]
            rev, ni, year = await _latest_revenue_and_income(client, peer_cik)
            if rev is None or rev <= 0:
                continue
            candidates.append(
                PeerCompany(
                    ticker=peer_ticker,
                    cik=peer_cik,
                    name=peer_entry["title"],
                    revenue=rev,
                    net_income=ni,
                    year=year,
                )
            )

        if own_revenue and own_revenue > 0:
            candidates.sort(key=lambda p: abs(math.log(p.revenue) - math.log(own_revenue)))
        peers = candidates[:limit]

    return PeerComparison(ticker=ticker.upper(), industry=industry, peers=peers)


@app.get("/companies/search")
async def search_companies(q: str):
    async with httpx.AsyncClient(timeout=15.0) as client:
        tickers = await _get_ticker_map(client)

    q_upper = q.upper()
    matches = [
        {"ticker": t, "name": entry["title"], "cik": str(entry["cik_str"]).zfill(10)}
        for t, entry in tickers.items()
        if q_upper in t or q_upper in entry["title"].upper()
    ][:20]
    return {"results": matches}


# ============================== AI chat (Gemini) ==============================
# The API key lives only here, read from the environment (.env, never
# committed) — the frontend never sees it. It calls this backend endpoint,
# which relays to Gemini and returns just the reply text.
CHAT_SYSTEM_PROMPT = (
    "You are a financial analyst assistant embedded in SecDash, a dashboard "
    "that shows plain-English financial data pulled live from SEC filings. "
    "You are given the exact data currently on screen for one company (and "
    "sometimes a specific chart the user has selected). When the user asks "
    "about the company or the data, answer using that data — be concise (a "
    "few sentences unless asked for detail), avoid jargon a non-technical "
    "reader wouldn't know without explaining it, and never invent numbers "
    "that aren't in the provided context; if something isn't in the data, "
    "say so plainly rather than guessing. If the user asks something "
    "unrelated to this company or general finance (small talk, an unrelated "
    "topic, etc.), just answer it naturally and helpfully like a normal "
    "assistant would — don't refuse or redirect just because it's off topic. "
    "You may use light markdown (bold, bullet lists) where it genuinely aids "
    "readability, but don't overuse it for short answers."
)

MAX_CHAT_MESSAGES = 20  # cap conversation length sent to the model


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    if not _gemini_client:
        raise HTTPException(
            status_code=503,
            detail="AI chat is not configured — GEMINI_API_KEY is not set on the server.",
        )
    if not req.messages:
        raise HTTPException(status_code=400, detail="No messages provided")

    company_label = req.company_name or req.ticker
    system_instruction = (
        f"{CHAT_SYSTEM_PROMPT}\n\n"
        f"Company currently shown: {company_label} ({req.ticker.upper()})\n\n"
        f"Dashboard data currently on screen:\n{req.dashboard_context}"
    )

    # "assistant" maps to Gemini's "model" role.
    contents = [
        genai_types.Content(
            role="model" if m.role == "assistant" else "user",
            parts=[genai_types.Part(text=m.content)],
        )
        for m in req.messages[-MAX_CHAT_MESSAGES:]
    ]

    config = genai_types.GenerateContentConfig(
        system_instruction=system_instruction,
        temperature=0.3,
        max_output_tokens=1024,
    )

    try:
        resp = await _gemini_client.aio.models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=config,
        )
    except genai_errors.ServerError:
        raise HTTPException(status_code=503, detail="The AI model is temporarily overloaded. Try again shortly.")
    except genai_errors.ClientError as e:
        if e.code == 429:
            raise HTTPException(status_code=429, detail="AI request quota exceeded. Try again later.")
        raise HTTPException(status_code=502, detail=f"AI request failed: {str(e)[:300]}")
    except (httpx.TimeoutException, TimeoutError):
        raise HTTPException(status_code=504, detail="AI request timed out — try again.")

    if not resp.candidates:
        block_reason = getattr(resp.prompt_feedback, "block_reason", None) if resp.prompt_feedback else None
        if block_reason:
            raise HTTPException(status_code=422, detail=f"Response blocked: {block_reason}")
        raise HTTPException(status_code=502, detail="AI returned no response.")

    reply = (resp.text or "").strip()
    if not reply:
        raise HTTPException(status_code=502, detail="AI returned an empty response.")

    return ChatResponse(reply=reply)
