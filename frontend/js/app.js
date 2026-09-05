(function () {
  "use strict";

  const API_BASE = "https://secdash.onrender.com";
  const liveDataCache = new Map();

  const state = {
    ticker: null,
    range: 8,
  };

  // Most recently fetched profile/peers — reused by the chat context builder
  // so it doesn't need a duplicate fetch of data already on screen.
  let lastProfile = null;
  let lastPeers = null;

  // Charts the user has scoped the next chat question to, by clicking them
  // (multiple charts can be selected at once). Map keyed by chart id so
  // membership checks and toggling are simple; reset per-ticker and by the
  // scope chip's clear button.
  const selectedCharts = new Map(); // chartId -> label

  const els = {
    landing: document.getElementById("landing"),
    dashboard: document.getElementById("dashboard"),
    backBtn: document.getElementById("backBtn"),

    searchForm: document.getElementById("searchForm"),
    searchInput: document.getElementById("searchInput"),
    searchResults: document.getElementById("searchResults"),
    tickerChips: document.querySelectorAll(".ticker-chip"),

    topbarSearchForm: document.getElementById("topbarSearchForm"),
    topbarSearchInput: document.getElementById("topbarSearchInput"),
    topbarSearchResults: document.getElementById("topbarSearchResults"),

    themeToggle: document.getElementById("themeToggle"),
    dashboardThemeToggle: document.getElementById("dashboardThemeToggle"),

    companyName: document.getElementById("companyName"),
    companyTicker: document.getElementById("companyTicker"),
    rangeBtns: document.querySelectorAll(".range-btn"),

    statRevenue: document.getElementById("statRevenue"),
    statRevenueDelta: document.getElementById("statRevenueDelta"),
    statIncome: document.getElementById("statIncome"),
    statIncomeDelta: document.getElementById("statIncomeDelta"),
    statMargin: document.getElementById("statMargin"),

    revenueChart: document.getElementById("revenueChart"),
    revenueTooltip: document.getElementById("revenueTooltip"),
    compareChart: document.getElementById("compareChart"),
    compareTooltip: document.getElementById("compareTooltip"),
    compareLegend: document.getElementById("compareLegend"),
    marginChart: document.getElementById("marginChart"),
    marginTooltip: document.getElementById("marginTooltip"),

    latestSourceLink: document.getElementById("latestSourceLink"),

    cashflowChart: document.getElementById("cashflowChart"),
    cashflowTooltip: document.getElementById("cashflowTooltip"),
    cashflowLegend: document.getElementById("cashflowLegend"),

    dsoChart: document.getElementById("dsoChart"),
    dsoTooltip: document.getElementById("dsoTooltip"),
    wcDsoLatest: document.getElementById("wcDsoLatest"),
    dioChart: document.getElementById("dioChart"),
    dioTooltip: document.getElementById("dioTooltip"),
    wcDioLatest: document.getElementById("wcDioLatest"),
    goodwillChart: document.getElementById("goodwillChart"),
    goodwillTooltip: document.getElementById("goodwillTooltip"),
    wcGoodwillLatest: document.getElementById("wcGoodwillLatest"),

    filingsList: document.getElementById("filingsList"),

    profileCard: document.getElementById("profileCard"),
    profileIndustry: document.getElementById("profileIndustry"),
    profileExchange: document.getElementById("profileExchange"),
    profileState: document.getElementById("profileState"),
    profileFiscalYearEnd: document.getElementById("profileFiscalYearEnd"),
    profileCategory: document.getElementById("profileCategory"),

    peersSubtitle: document.getElementById("peersSubtitle"),
    peersEmpty: document.getElementById("peersEmpty"),
    peersChartWrap: document.getElementById("peersChartWrap"),
    peersChart: document.getElementById("peersChart"),
    peersTooltip: document.getElementById("peersTooltip"),

    chatCompanyLabel: document.getElementById("chatCompanyLabel"),
    chatMessages: document.getElementById("chatMessages"),
    chatEmpty: document.getElementById("chatEmpty"),
    chatForm: document.getElementById("chatForm"),
    chatInput: document.getElementById("chatInput"),
    chatSendBtn: document.getElementById("chatSendBtn"),
    chatClearBtn: document.getElementById("chatClearBtn"),
    chatScopeChip: document.getElementById("chatScopeChip"),
    chatScopeLabel: document.getElementById("chatScopeLabel"),
    chatScopeClear: document.getElementById("chatScopeClear"),
    chartPanels: document.querySelectorAll(".chart-panel.is-selectable"),
    chatSidebar: document.getElementById("chatSidebar"),
    chatCollapseBtn: document.getElementById("chatCollapseBtn"),
    chatReopenBtn: document.getElementById("chatReopenBtn"),
  };

  // ============================== Theme ==============================
  function applyTheme(theme, skipRedraw) {
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
    const isDark = theme === "dark";
    [els.themeToggle, els.dashboardThemeToggle].forEach((btn) => {
      if (!btn) return;
      btn.setAttribute("aria-checked", isDark ? "true" : "false");
      btn.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    });
    try {
      localStorage.setItem("agentdash-theme", theme);
    } catch (e) { /* storage unavailable */ }
    if (!skipRedraw && state.ticker) renderAllCharts();
  }

  function toggleTheme() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(isDark ? "light" : "dark");
  }

  els.themeToggle.addEventListener("click", toggleTheme);
  els.dashboardThemeToggle.addEventListener("click", toggleTheme);

  (function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("agentdash-theme");
    } catch (e) { /* storage unavailable */ }
    // Default is light regardless of OS setting; dark only if the user chose it before.
    applyTheme(saved === "dark" ? "dark" : "light", true);
  })();

  // ============================== Search ==============================
  // Searches the full SEC EDGAR ticker universe via the backend — not a
  // hardcoded local list — so any public company can be found. No offline
  // fallback: if the backend is unreachable, search simply returns nothing.
  const searchCache = new Map();

  async function searchCompaniesLive(query) {
    const q = query.trim();
    if (!q) return [];
    if (searchCache.has(q)) return searchCache.get(q);
    try {
      const resp = await fetch(`${API_BASE}/companies/search?q=${encodeURIComponent(q)}`);
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      const data = await resp.json();
      const results = (data.results || []).map((r) => ({ ticker: r.ticker, name: r.name }));
      searchCache.set(q, results);
      return results;
    } catch (err) {
      console.warn(`SecDash: search API unavailable (${err.message})`);
      return [];
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderSearchList(listEl, results, query) {
    listEl.innerHTML = "";
    if (results.length === 0) {
      listEl.innerHTML = `<li class="search-empty">No matches for “${escapeHtml(query)}”</li>`;
      listEl.hidden = false;
      return;
    }
    results.forEach((r) => {
      const li = document.createElement("li");
      li.className = "search-result-item";
      li.setAttribute("role", "option");
      li.dataset.ticker = r.ticker;
      li.innerHTML = `<span class="search-result-ticker">${escapeHtml(r.ticker)}</span><span class="search-result-name">${escapeHtml(r.name)}</span>`;
      li.addEventListener("click", () => selectTicker(r.ticker, r.name));
      listEl.appendChild(li);
    });
    listEl.hidden = false;
  }

  function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function wireSearchInput(inputEl, listEl) {
    let requestToken = 0;

    const runSearch = debounce(async (query) => {
      if (!query.trim()) {
        listEl.hidden = true;
        return;
      }
      const token = ++requestToken;
      const results = await searchCompaniesLive(query);
      if (token !== requestToken) return; // a newer keystroke superseded this request
      renderSearchList(listEl, results, query);
    }, 250);

    inputEl.addEventListener("input", (e) => runSearch(e.target.value));

    inputEl.closest("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const query = inputEl.value.trim();
      if (!query) return;
      const results = await searchCompaniesLive(query);
      if (results.length > 0) {
        selectTicker(results[0].ticker, results[0].name);
        inputEl.value = "";
        listEl.hidden = true;
      }
    });
  }

  wireSearchInput(els.searchInput, els.searchResults);
  wireSearchInput(els.topbarSearchInput, els.topbarSearchResults);

  els.tickerChips.forEach((chip) => {
    chip.addEventListener("click", () => selectTicker(chip.dataset.ticker));
  });

  document.addEventListener("click", (e) => {
    if (!els.searchForm.contains(e.target)) els.searchResults.hidden = true;
    if (!els.topbarSearchForm.contains(e.target)) els.topbarSearchResults.hidden = true;
  });

  // ============================== Navigation ==============================
  function selectTicker(ticker, knownName) {
    if (!ticker) return;
    ticker = ticker.toUpperCase();
    state.ticker = ticker;
    if (knownName) companyNameCache.set(ticker, knownName);
    els.landing.hidden = true;
    els.dashboard.hidden = false;
    els.searchInput.value = "";
    els.searchResults.hidden = true;
    updateDashboard();
  }

  els.backBtn.addEventListener("click", () => {
    els.dashboard.hidden = true;
    els.landing.hidden = false;
    state.ticker = null;
  });

  els.rangeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      els.rangeBtns.forEach((b) => {
        b.classList.remove("is-active");
        b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-selected", "true");
      state.range = Number(btn.dataset.range);
      renderAllCharts();
    });
  });

  // ============================== Live data ==============================
  // Pulls real financials from the backend (which pulls from SEC EDGAR) for
  // whatever ticker the user searched — not limited to any hardcoded list.
  // No offline fallback: if the live fetch fails, the dashboard shows an
  // explicit "no data available" state rather than hardcoded/mock figures.
  //
  // - liveDataCache: only ever holds a *successful* live fetch. Never caches
  //   failures, so a transient network hiccup or a backend that was briefly
  //   down doesn't permanently lock a ticker out of live data on retry.
  // - renderDataCache: whatever renderAllCharts() should actually draw right
  //   now (live data, or null) — this is what getCompanyForRender() reads,
  //   so range-toggle clicks etc. always have something to render without
  //   re-fetching.
  const companyNameCache = new Map();
  const renderDataCache = new Map();

  async function fetchLiveFinancials(ticker) {
    if (liveDataCache.has(ticker)) return liveDataCache.get(ticker);
    try {
      const resp = await fetch(`${API_BASE}/companies/${ticker}/financials?years=12`);
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      const data = await resp.json();

      // SEC's XBRL coverage thins out in older years (tag changes, missing filings).
      // Keep the trailing contiguous run of years where both fields are present,
      // rather than rejecting the whole response over one old, incomplete year.
      const complete = data.years.filter((y) => y.revenue != null && y.net_income != null);
      if (complete.length === 0) throw new Error("No complete years in SEC data");

      const years = complete.map((y) => y.year);
      const revenue = complete.map((y) => y.revenue);
      const netIncome = complete.map((y) => y.net_income);
      // Keep the full per-year records too (cash flow, working capital, provenance)
      // for the extra dashboard modules — not just the two headline series.
      const live = { years, revenue, netIncome, name: data.name, yearRecords: complete };
      liveDataCache.set(ticker, live);
      renderDataCache.set(ticker, live);
      if (data.name) companyNameCache.set(ticker, data.name);
      return live;
    } catch (err) {
      console.warn(`SecDash: no live data for ${ticker} (${err.message})`);
      renderDataCache.set(ticker, null);
      return null;
    }
  }

  function getCompanyForRender(ticker) {
    return renderDataCache.get(ticker) || null;
  }

  // ============================== Dashboard update ==============================
  let dashboardRequestId = 0;

  async function updateDashboard() {
    const ticker = state.ticker;
    const requestId = ++dashboardRequestId;
    lastProfile = null;
    lastPeers = null;

    els.companyName.textContent = companyNameCache.get(ticker) || ticker;
    els.companyTicker.textContent = `${ticker} · Annual data · Loading…`;
    els.latestSourceLink.hidden = true;
    els.filingsList.innerHTML = `<li class="filings-empty">Loading filings…</li>`;
    els.profileCard.hidden = true;
    els.profileIndustry.textContent = "—";
    els.profileExchange.textContent = "—";
    els.profileState.textContent = "—";
    els.profileFiscalYearEnd.textContent = "—";
    els.profileCategory.textContent = "—";
    els.peersEmpty.hidden = false;
    els.peersEmpty.textContent = "Loading comparison…";
    els.peersChartWrap.hidden = true;

    const data = await fetchLiveFinancials(ticker);
    if (requestId !== dashboardRequestId) return;

    if (!data) {
      els.companyTicker.textContent = `${ticker} · No financial data available`;
      els.filingsList.innerHTML = `<li class="filings-empty">No filings available</li>`;
      els.peersEmpty.textContent = "No data available";
      clearDashboard();
      updateChatForTicker(ticker);
      return;
    }

    if (data.name) els.companyName.textContent = data.name;
    els.companyTicker.textContent = `${ticker} · Annual data · SEC EDGAR (live)`;

    const latestRecord = data.yearRecords[data.yearRecords.length - 1];
    if (latestRecord && latestRecord.source_url) {
      els.latestSourceLink.href = latestRecord.source_url;
      els.latestSourceLink.hidden = false;
    }

    renderAllCharts();
    fetchAndRenderFilings(ticker, requestId);
    fetchAndRenderProfile(ticker, requestId);
    fetchAndRenderPeers(ticker, requestId);
    updateChatForTicker(ticker);
  }

  async function fetchAndRenderFilings(ticker, requestId) {
    try {
      const resp = await fetch(`${API_BASE}/companies/${ticker}/filings?limit=12`);
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      const data = await resp.json();
      if (requestId !== dashboardRequestId) return;
      renderFilingsList(data.filings || []);
    } catch (err) {
      if (requestId !== dashboardRequestId) return;
      console.warn(`SecDash: filings feed unavailable for ${ticker} (${err.message})`);
      els.filingsList.innerHTML = `<li class="filings-empty">Filing feed unavailable</li>`;
    }
  }

  function renderFilingsList(filings) {
    if (filings.length === 0) {
      els.filingsList.innerHTML = `<li class="filings-empty">No recent filings found</li>`;
      return;
    }
    els.filingsList.innerHTML = filings
      .map((f) => `
        <li class="filing-row">
          <span class="filing-type">${escapeHtml(f.form)}</span>
          <span class="filing-meta">
            <p class="filing-title">${escapeHtml(f.period_of_report ? `Period ending ${f.period_of_report}` : "Filing")}</p>
            <p class="filing-sub">Filed ${escapeHtml(f.filed)} · ${escapeHtml(f.accession_number)}</p>
          </span>
          <a class="filing-link" href="${f.url}" target="_blank" rel="noopener noreferrer">
            View
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M7 7h10v10"/></svg>
          </a>
        </li>
      `)
      .join("");
  }

  // ============================== Company profile ==============================
  async function fetchAndRenderProfile(ticker, requestId) {
    try {
      const resp = await fetch(`${API_BASE}/companies/${ticker}/profile`);
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      const data = await resp.json();
      if (requestId !== dashboardRequestId) return;
      lastProfile = data;
      renderProfileCard(data);
    } catch (err) {
      if (requestId !== dashboardRequestId) return;
      console.warn(`SecDash: profile unavailable for ${ticker} (${err.message})`);
      els.profileCard.hidden = true;
    }
  }

  function renderProfileCard(profile) {
    if (!profile.industry) {
      els.profileCard.hidden = true;
      return;
    }
    els.profileIndustry.textContent = profile.industry;
    els.profileExchange.textContent = profile.exchange || "—";
    els.profileState.textContent = profile.state_of_incorporation || "—";
    els.profileFiscalYearEnd.textContent = profile.fiscal_year_end || "—";
    els.profileCategory.textContent = profile.category || "—";
    els.profileCard.hidden = false;
  }

  // ============================== Peer comparison ==============================
  async function fetchAndRenderPeers(ticker, requestId) {
    try {
      const resp = await fetch(`${API_BASE}/companies/${ticker}/peers?limit=5`);
      if (!resp.ok) throw new Error(`API ${resp.status}`);
      const data = await resp.json();
      if (requestId !== dashboardRequestId) return;
      lastPeers = data;
      renderPeersChart(ticker, data);
    } catch (err) {
      if (requestId !== dashboardRequestId) return;
      console.warn(`SecDash: peer comparison unavailable for ${ticker} (${err.message})`);
      els.peersEmpty.textContent = "Comparison unavailable";
      els.peersEmpty.hidden = false;
      els.peersChartWrap.hidden = true;
    }
  }

  function renderPeersChart(ticker, data) {
    if (data.industry) {
      els.peersSubtitle.textContent = `${data.industry} — same SEC industry classification, by revenue`;
    }

    const company = getCompanyForRender(ticker);
    const ownRevenue = company && company.revenue ? company.revenue[company.revenue.length - 1] : null;

    if (!data.peers || data.peers.length === 0 || ownRevenue == null) {
      els.peersEmpty.textContent = "No comparable companies found in SEC's records for this industry.";
      els.peersEmpty.hidden = false;
      els.peersChartWrap.hidden = true;
      return;
    }

    els.peersEmpty.hidden = true;
    els.peersChartWrap.hidden = false;

    const ownName = (companyNameCache.get(ticker) || ticker);
    const bars = [
      { ticker, name: ownName, revenue: ownRevenue, isTarget: true },
      ...data.peers.map((p) => ({ ticker: p.ticker, name: p.name, revenue: p.revenue, isTarget: false })),
    ].sort((a, b) => b.revenue - a.revenue);

    const svg = d3.select(els.peersChart);
    svg.selectAll("*").remove();

    const wrap = els.peersChart.parentElement.getBoundingClientRect();
    const width = Math.max(wrap.width, 280);
    const rowHeight = 36;
    const height = Math.max(bars.length * rowHeight + 20, 120);
    const margin = { top: 10, right: 70, bottom: 10, left: 140 };
    const innerW = width - margin.left - margin.right;
    const innerH = bars.length * rowHeight;

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const y = d3.scaleBand().domain(bars.map((b) => b.ticker)).range([0, innerH]).padding(0.3);
    const x = d3.scaleLinear().domain([0, d3.max(bars, (b) => b.revenue) * 1.1]).range([0, innerW]);

    const rows = g.selectAll(".peer-row")
      .data(bars)
      .join("g")
      .attr("class", "peer-row")
      .attr("transform", (b) => `translate(0,${y(b.ticker)})`);

    rows.append("text")
      .attr("x", -12)
      .attr("y", y.bandwidth() / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", "end")
      .attr("class", "axis-tick")
      .style("font-weight", (b) => (b.isTarget ? 700 : 500))
      .style("fill", (b) => (b.isTarget ? "var(--color-foreground)" : "var(--color-secondary-ink)"))
      .text((b) => b.ticker);

    rows.append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", 0)
      .attr("height", y.bandwidth())
      .attr("rx", 4)
      .attr("fill", (b) => (b.isTarget ? "var(--series-revenue)" : "var(--color-border-strong)"))
      .transition()
      .duration(450)
      .ease(d3.easeCubicOut)
      .attr("width", (b) => Math.max(2, x(b.revenue)));

    rows.append("text")
      .attr("x", (b) => x(b.revenue) + 8)
      .attr("y", y.bandwidth() / 2)
      .attr("dy", "0.35em")
      .attr("class", "direct-label")
      .style("font-weight", (b) => (b.isTarget ? 700 : 500))
      .text((b) => fmtUSD(b.revenue));

    rows.style("cursor", (b) => (b.isTarget ? "default" : "pointer"))
      .on("mousemove", function (event, b) {
        const wrapRect = els.peersChart.parentElement.getBoundingClientRect();
        const svgRect = els.peersChart.getBoundingClientRect();
        const xPos = svgRect.left - wrapRect.left + margin.left + x(b.revenue) / 2;
        const yPos = svgRect.top - wrapRect.top + margin.top + y(b.ticker);

        els.peersTooltip.style.left = `${xPos}px`;
        els.peersTooltip.style.top = `${yPos}px`;
        els.peersTooltip.innerHTML = `
          <div class="tt-year">${escapeHtml(b.name)}${b.isTarget ? " (this company)" : ""}</div>
          <div class="tt-row"><span class="tt-dot" style="background:${b.isTarget ? "var(--series-revenue)" : "var(--color-border-strong)"}"></span>Revenue: ${fmtUSD(b.revenue)}</div>
          ${b.isTarget ? "" : `<div class="tt-hint">Click to view ${escapeHtml(b.ticker)}'s dashboard</div>`}
        `;
        els.peersTooltip.hidden = false;
      })
      .on("mouseleave", () => { els.peersTooltip.hidden = true; })
      .on("click", (event, b) => {
        if (b.isTarget) return;
        event.stopPropagation(); // navigating to a peer, not selecting this chart for chat
        els.peersTooltip.hidden = true;
        selectTicker(b.ticker, b.name);
      });
  }

  function fmtUSD(n) {
    if (n == null) return "—";
    const abs = Math.abs(n);
    if (abs >= 1000) return `$${(n / 1000).toFixed(2)}T`;
    return `$${n.toFixed(1)}B`;
  }

  function fmtPct(n) {
    if (n == null) return "—";
    const sign = n > 0 ? "+" : "";
    return `${sign}${n.toFixed(1)}%`;
  }

  // Net margin per year, as a percentage (e.g. 24.8 for 24.8%), or null
  // where revenue is missing/zero or net income is missing.
  function getMargins({ revenue, netIncome }) {
    return revenue.map((rev, i) => {
      const ni = netIncome[i];
      if (rev == null || rev === 0 || ni == null) return null;
      return (ni / rev) * 100;
    });
  }

  // Percent change from the second-to-last to the last value in a series,
  // or null if there aren't at least two comparable points.
  function yoyDelta(series) {
    if (series.length < 2) return null;
    const prev = series[series.length - 2];
    const curr = series[series.length - 1];
    if (prev == null || curr == null || prev === 0) return null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  }

  function clearDashboard() {
    // Reset every numeric display to an honest empty state instead of leaving
    // the previous company's (or the page's static placeholder) figures on
    // screen when a searched ticker has no data anywhere.
    els.statRevenue.textContent = "—";
    els.statIncome.textContent = "—";
    els.statMargin.textContent = "—";
    updateDelta(els.statRevenueDelta, null);
    updateDelta(els.statIncomeDelta, null);

    [els.revenueChart, els.compareChart, els.marginChart, els.cashflowChart, els.dsoChart, els.dioChart, els.goodwillChart]
      .forEach((svgEl) => d3.select(svgEl).selectAll("*").remove());
    els.compareLegend.innerHTML = "";
    els.cashflowLegend.innerHTML = "";
    els.wcDsoLatest.textContent = "—";
    els.wcDioLatest.textContent = "—";
    els.wcGoodwillLatest.textContent = "—";
  }

  function renderAllCharts() {
    if (!state.ticker) return;
    const company = getCompanyForRender(state.ticker);
    if (!company) return;
    const range = Math.min(state.range, company.years.length);

    const years = company.years.slice(-range);
    const revenue = company.revenue.slice(-range);
    const netIncome = company.netIncome.slice(-range);
    const margins = getMargins({ revenue, netIncome });
    const records = (company.yearRecords || []).slice(-range);

    renderAnswerStrip(years, revenue, netIncome, margins);
    renderRevenueChart(years, revenue);
    renderCompareChart(years, revenue, netIncome);
    renderMarginChart(years, margins);
    renderCashflowChart(years, records);
    renderWorkingCapitalCharts(years, records);
  }

  function renderAnswerStrip(years, revenue, netIncome, margins) {
    const lastRev = revenue[revenue.length - 1];
    const lastNi = netIncome[netIncome.length - 1];
    const lastMargin = margins[margins.length - 1];
    const revDelta = yoyDelta(revenue);
    const niDelta = yoyDelta(netIncome);

    els.statRevenue.textContent = fmtUSD(lastRev);
    els.statIncome.textContent = fmtUSD(lastNi);
    els.statMargin.textContent = lastMargin == null ? "—" : `${lastMargin.toFixed(1)}%`;

    updateDelta(els.statRevenueDelta, revDelta);
    updateDelta(els.statIncomeDelta, niDelta);
  }

  function updateDelta(el, delta) {
    if (delta == null) {
      el.textContent = "No prior-year data";
      el.classList.remove("is-down");
      return;
    }
    el.textContent = `${fmtPct(delta)} vs prior year`;
    el.classList.toggle("is-down", delta < 0);
  }

  // ============================== Chart 1: Revenue area ==============================
  function renderRevenueChart(years, revenue) {
    const svg = d3.select(els.revenueChart);
    svg.selectAll("*").remove();

    const wrap = els.revenueChart.parentElement.getBoundingClientRect();
    const width = Math.max(wrap.width, 280);
    const height = Math.max(wrap.height, 160);
    const margin = { top: 16, right: 12, bottom: 26, left: 52 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scalePoint().domain(years).range([0, innerW]).padding(0.5);
    const yMax = d3.max(revenue) * 1.2;
    const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]);

    g.append("g")
      .selectAll("line")
      .data(y.ticks(4))
      .join("line")
      .attr("class", "grid-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    g.append("g")
      .attr("class", "axis-tick")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(10))
      .call((sel) => sel.select(".domain").attr("class", "axis-line"));

    g.append("g")
      .attr("class", "axis-tick")
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8).tickFormat((d) => `$${d}B`))
      .call((sel) => sel.select(".domain").remove());

    const points = years.map((yr, i) => ({ year: yr, value: revenue[i] }));

    const area = d3.area()
      .x((d) => x(d.year))
      .y0(innerH)
      .y1((d) => y(d.value))
      .curve(d3.curveMonotoneX);

    const line = d3.line()
      .x((d) => x(d.year))
      .y((d) => y(d.value))
      .curve(d3.curveMonotoneX);

    g.append("path")
      .datum(points)
      .attr("class", "series-area")
      .attr("fill", "var(--series-revenue)")
      .attr("d", area);

    const path = g.append("path")
      .datum(points)
      .attr("class", "series-path")
      .attr("stroke", "var(--series-revenue)")
      .attr("d", line);

    const totalLength = path.node().getTotalLength();
    path
      .attr("stroke-dasharray", `${totalLength} ${totalLength}`)
      .attr("stroke-dashoffset", totalLength)
      .transition()
      .duration(500)
      .ease(d3.easeCubicOut)
      .attr("stroke-dashoffset", 0);

    g.selectAll(".dot")
      .data(points)
      .join("circle")
      .attr("class", "dot")
      .attr("cx", (d) => x(d.year))
      .attr("cy", (d) => y(d.value))
      .attr("r", 3.5)
      .attr("fill", "var(--series-revenue)");

    // Direct label on the last point (endpoint labeling per dataviz guidance)
    const last = points[points.length - 1];
    g.append("text")
      .attr("class", "direct-label")
      .attr("x", x(last.year))
      .attr("y", y(last.value) - 12)
      .attr("text-anchor", "end")
      .text(fmtUSD(last.value));

    attachHover(g, svg, els.revenueChart, els.revenueTooltip, x, y, innerW, innerH, margin, years, [
      { key: "revenue", label: "Revenue", color: "var(--series-revenue)", values: revenue },
    ]);
  }

  // ============================== Chart 2: Revenue vs income (grouped bars) ==============================
  function renderCompareChart(years, revenue, netIncome) {
    const svg = d3.select(els.compareChart);
    svg.selectAll("*").remove();

    const wrap = els.compareChart.parentElement.getBoundingClientRect();
    const width = Math.max(wrap.width, 280);
    const height = Math.max(wrap.height, 200);
    const margin = { top: 16, right: 12, bottom: 26, left: 52 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x0 = d3.scaleBand().domain(years).range([0, innerW]).padding(0.3);
    const x1 = d3.scaleBand().domain(["revenue", "netIncome"]).range([0, x0.bandwidth()]).padding(0.12);

    const allValues = [...revenue, ...netIncome, 0];
    const yMin = Math.min(0, d3.min(allValues));
    const yMax = d3.max(allValues) * 1.15;
    const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([innerH, 0]);

    g.append("g")
      .selectAll("line")
      .data(y.ticks(4))
      .join("line")
      .attr("class", "grid-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    g.append("g")
      .attr("class", "axis-tick")
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8).tickFormat((d) => `$${d}B`))
      .call((sel) => sel.select(".domain").remove());

    // Zero-baseline rule drawn first (under the bars); the axis year labels
    // are appended *after* the bars below, so they always paint on top and
    // stay legible even when a tall negative bar would otherwise cover them.
    g.append("line")
      .attr("class", "axis-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", y(0)).attr("y2", y(0));

    const groups = g.selectAll(".bar-group")
      .data(years)
      .join("g")
      .attr("class", "bar-group")
      .attr("transform", (yr) => `translate(${x0(yr)},0)`);

    const barSpecs = [
      { key: "revenue", color: "var(--series-revenue)", values: revenue },
      { key: "netIncome", color: "var(--series-income)", values: netIncome },
    ];

    const barWidth = Math.min(x1.bandwidth(), 24);
    const barOffset = (x1.bandwidth() - barWidth) / 2;

    barSpecs.forEach((spec) => {
      groups.append("rect")
        .attr("class", "bar")
        .attr("x", x1(spec.key) + barOffset)
        .attr("width", barWidth)
        .attr("y", y(0))
        .attr("height", 0)
        .attr("rx", 3)
        .attr("fill", spec.color)
        .attr("data-key", spec.key)
        .transition()
        .duration(450)
        .delay((yr, i) => i * 30)
        .ease(d3.easeCubicOut)
        .attr("y", (yr) => y(Math.max(0, spec.values[years.indexOf(yr)])))
        .attr("height", (yr) => Math.abs(y(spec.values[years.indexOf(yr)]) - y(0)));
    });

    // Year labels appended last so they sit visually on top of any bar,
    // instead of being painted first and covered by a tall negative bar.
    g.append("g")
      .attr("class", "axis-tick")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x0).tickSize(0).tickPadding(10))
      .call((sel) => sel.select(".domain").remove());

    els.compareLegend.innerHTML = `
      <li><span class="legend-dot" style="background:var(--series-revenue)"></span>Revenue</li>
      <li><span class="legend-dot" style="background:var(--series-income)"></span>Net Income</li>
    `;

    // Bar hover tooltip
    groups.style("cursor", "pointer")
      .on("mousemove", function (event, yr) {
        const idx = years.indexOf(yr);
        const wrapRect = els.compareChart.parentElement.getBoundingClientRect();
        const svgRect = els.compareChart.getBoundingClientRect();
        const xPos = svgRect.left - wrapRect.left + margin.left + x0(yr) + x0.bandwidth() / 2;
        const topVal = Math.max(revenue[idx], netIncome[idx], 0);
        const yPos = svgRect.top - wrapRect.top + margin.top + y(topVal);

        els.compareTooltip.style.left = `${xPos}px`;
        els.compareTooltip.style.top = `${yPos}px`;
        els.compareTooltip.innerHTML = `
          <div class="tt-year">${yr}</div>
          <div class="tt-row"><span class="tt-dot" style="background:var(--series-revenue)"></span>Revenue: ${fmtUSD(revenue[idx])}</div>
          <div class="tt-row"><span class="tt-dot" style="background:var(--series-income)"></span>Net Income: ${fmtUSD(netIncome[idx])}</div>
        `;
        els.compareTooltip.hidden = false;
      })
      .on("mouseleave", () => { els.compareTooltip.hidden = true; });
  }

  // ============================== Chart 3: Margin line ==============================
  function renderMarginChart(years, margins) {
    const svg = d3.select(els.marginChart);
    svg.selectAll("*").remove();

    const wrap = els.marginChart.parentElement.getBoundingClientRect();
    const width = Math.max(wrap.width, 280);
    const height = Math.max(wrap.height, 140);
    const margin = { top: 16, right: 12, bottom: 26, left: 46 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scalePoint().domain(years).range([0, innerW]).padding(0.5);
    const validMargins = margins.filter((m) => m != null);
    const yMin = Math.min(0, d3.min(validMargins) ?? 0);
    const yMax = Math.max(d3.max(validMargins) ?? 0, 0) * 1.2;
    const y = d3.scaleLinear().domain([yMin, yMax]).nice().range([innerH, 0]);

    g.append("g")
      .selectAll("line")
      .data(y.ticks(4))
      .join("line")
      .attr("class", "grid-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    // Zero baseline, slightly emphasized
    g.append("line")
      .attr("class", "axis-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", y(0)).attr("y2", y(0));

    g.append("g")
      .attr("class", "axis-tick")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(10))
      .call((sel) => sel.select(".domain").remove());

    g.append("g")
      .attr("class", "axis-tick")
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8).tickFormat((d) => `${d}%`))
      .call((sel) => sel.select(".domain").remove());

    const points = years.map((yr, i) => ({ year: yr, value: margins[i] })).filter((d) => d.value != null);

    const line = d3.line()
      .x((d) => x(d.year))
      .y((d) => y(d.value))
      .curve(d3.curveMonotoneX);

    const path = g.append("path")
      .datum(points)
      .attr("class", "series-path")
      .attr("stroke", "var(--series-margin)")
      .attr("d", line);

    const totalLength = path.node().getTotalLength();
    path
      .attr("stroke-dasharray", `${totalLength} ${totalLength}`)
      .attr("stroke-dashoffset", totalLength)
      .transition()
      .duration(500)
      .ease(d3.easeCubicOut)
      .attr("stroke-dashoffset", 0);

    g.selectAll(".dot")
      .data(points)
      .join("circle")
      .attr("class", "dot")
      .attr("cx", (d) => x(d.year))
      .attr("cy", (d) => y(d.value))
      .attr("r", 3.5)
      .attr("fill", "var(--series-margin)");

    const last = points[points.length - 1];
    if (last) {
      g.append("text")
        .attr("class", "direct-label")
        .attr("x", x(last.year))
        .attr("y", y(last.value) - 12)
        .attr("text-anchor", "end")
        .text(`${last.value.toFixed(1)}%`);
    }

    attachHover(g, svg, els.marginChart, els.marginTooltip, x, y, innerW, innerH, margin, years, [
      { key: "margin", label: "Net margin", color: "var(--series-margin)", values: margins, fmt: (v) => (v == null ? "—" : `${v.toFixed(1)}%`) },
    ]);
  }

  // ============================== Chart 4: Cash flow allocation (stacked bars) ==============================
  const CASHFLOW_SERIES = [
    { key: "capex", label: "Reinvestment (CapEx)", color: "var(--series-blue-1)" },
    { key: "debt_repayment", label: "Debt repayment", color: "var(--series-blue-2)" },
    { key: "dividends_paid", label: "Dividends", color: "var(--series-blue-3)" },
    { key: "buybacks", label: "Buybacks", color: "var(--series-blue-4)" },
  ];

  function renderCashflowChart(years, records) {
    const svg = d3.select(els.cashflowChart);
    svg.selectAll("*").remove();
    els.cashflowLegend.innerHTML = "";

    const hasData = records.some((r) => r && r.operating_cash_flow != null);
    if (!hasData) {
      renderEmptyChart(svg, els.cashflowChart, "Cash flow breakdown not available for this company");
      return;
    }

    const wrap = els.cashflowChart.parentElement.getBoundingClientRect();
    const width = Math.max(wrap.width, 280);
    const height = Math.max(wrap.height, 240);
    const margin = { top: 16, right: 12, bottom: 26, left: 52 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(years).range([0, innerW]).padding(0.3);

    // Each use of cash is shown as a positive segment of OCF allocated to it;
    // "Unallocated / retained" fills the remainder, so segments always sum to OCF
    // (or to the allocated total if it exceeds OCF, which just means the company
    // funded some of that spend from cash reserves or financing, not operations).
    const stackData = years.map((yr, i) => {
      const r = records[i] || {};
      const ocf = r.operating_cash_flow ?? 0;
      const segments = CASHFLOW_SERIES.map((s) => Math.max(0, r[s.key] ?? 0));
      const allocated = segments.reduce((a, b) => a + b, 0);
      const unallocated = Math.max(0, ocf - allocated);
      return { year: yr, ocf, segments, unallocated };
    });

    const maxTotal = d3.max(stackData, (d) => Math.max(d.ocf, d.segments.reduce((a, b) => a + b, 0)));
    const y = d3.scaleLinear().domain([0, maxTotal * 1.1 || 1]).nice().range([innerH, 0]);

    g.append("g")
      .selectAll("line")
      .data(y.ticks(4))
      .join("line")
      .attr("class", "grid-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    g.append("g")
      .attr("class", "axis-tick")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(10))
      .call((sel) => sel.select(".domain").attr("class", "axis-line"));

    g.append("g")
      .attr("class", "axis-tick")
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8).tickFormat((d) => `$${d}B`))
      .call((sel) => sel.select(".domain").remove());

    const barWidth = Math.min(x.bandwidth(), 48);
    const barOffset = (x.bandwidth() - barWidth) / 2;
    const GAP = 2; // surface-color gap between stacked segments

    const groups = g.selectAll(".stack-group")
      .data(stackData)
      .join("g")
      .attr("class", "stack-group")
      .attr("transform", (d) => `translate(${x(d.year) + barOffset},0)`);

    groups.each(function (d) {
      const group = d3.select(this);
      let cumulative = 0;
      CASHFLOW_SERIES.forEach((s, i) => {
        const val = d.segments[i];
        if (val <= 0) return;
        const yTop = y(cumulative + val);
        const yBottom = y(cumulative);
        group.append("rect")
          .attr("class", "bar")
          .attr("x", 0)
          .attr("width", barWidth)
          .attr("y", yBottom)
          .attr("height", 0)
          .attr("fill", s.color)
          .attr("data-key", s.key)
          .transition()
          .duration(450)
          .ease(d3.easeCubicOut)
          .attr("y", yTop + GAP / 2)
          .attr("height", Math.max(0, yBottom - yTop - GAP));
        cumulative += val;
      });
      if (d.unallocated > 0) {
        const yTop = y(cumulative + d.unallocated);
        const yBottom = y(cumulative);
        group.append("rect")
          .attr("class", "bar")
          .attr("x", 0)
          .attr("width", barWidth)
          .attr("y", yBottom)
          .attr("height", 0)
          .attr("fill", "var(--color-border-strong)")
          .attr("data-key", "unallocated")
          .transition()
          .duration(450)
          .ease(d3.easeCubicOut)
          .attr("y", yTop + GAP / 2)
          .attr("height", Math.max(0, yBottom - yTop - GAP));
      }
    });

    els.cashflowLegend.innerHTML = [
      ...CASHFLOW_SERIES.map((s) => `<li><span class="legend-dot" style="background:${s.color}"></span>${s.label}</li>`),
      `<li><span class="legend-dot" style="background:var(--color-border-strong)"></span>Retained / other</li>`,
    ].join("");

    groups.style("cursor", "pointer")
      .on("mousemove", function (event, d) {
        const wrapRect = els.cashflowChart.parentElement.getBoundingClientRect();
        const svgRect = els.cashflowChart.getBoundingClientRect();
        const xPos = svgRect.left - wrapRect.left + margin.left + x(d.year) + x.bandwidth() / 2;
        const totalHeight = Math.max(d.ocf, d.segments.reduce((a, b) => a + b, 0));
        const yPos = svgRect.top - wrapRect.top + margin.top + y(totalHeight);

        const rows = CASHFLOW_SERIES.map((s, i) => d.segments[i] > 0
          ? `<div class="tt-row"><span class="tt-dot" style="background:${s.color}"></span>${s.label}: ${fmtUSD(d.segments[i])}</div>`
          : "").join("");
        const unallocatedRow = d.unallocated > 0
          ? `<div class="tt-row"><span class="tt-dot" style="background:var(--color-border-strong)"></span>Retained / other: ${fmtUSD(d.unallocated)}</div>`
          : "";

        els.cashflowTooltip.style.left = `${xPos}px`;
        els.cashflowTooltip.style.top = `${yPos}px`;
        els.cashflowTooltip.innerHTML = `
          <div class="tt-year">${d.year} · OCF ${fmtUSD(d.ocf)}</div>
          ${rows}${unallocatedRow}
        `;
        els.cashflowTooltip.hidden = false;
      })
      .on("mouseleave", () => { els.cashflowTooltip.hidden = true; });
  }

  // ============================== Chart 5: Working capital trends ==============================
  function computeDSO(records) {
    return records.map((r) => {
      if (!r || r.accounts_receivable == null || !r.revenue) return null;
      return (r.accounts_receivable / r.revenue) * 365;
    });
  }

  function computeDIO(records) {
    return records.map((r) => {
      if (!r || r.inventory == null || !r.cogs) return null;
      return (r.inventory / r.cogs) * 365;
    });
  }

  function computeGoodwillPct(records) {
    return records.map((r) => {
      if (!r || r.goodwill == null || !r.total_assets) return null;
      return (r.goodwill / r.total_assets) * 100;
    });
  }

  function renderWorkingCapitalCharts(years, records) {
    const dso = computeDSO(records);
    const dio = computeDIO(records);
    const goodwillPct = computeGoodwillPct(records);

    renderMiniLineChart(els.dsoChart, els.dsoTooltip, years, dso, {
      color: "var(--series-blue-1)",
      label: "DSO",
      fmt: (v) => `${v.toFixed(0)} days`,
      latestEl: els.wcDsoLatest,
    });
    renderMiniLineChart(els.dioChart, els.dioTooltip, years, dio, {
      color: "var(--series-blue-3)",
      label: "DIO",
      fmt: (v) => `${v.toFixed(0)} days`,
      latestEl: els.wcDioLatest,
    });
    renderMiniLineChart(els.goodwillChart, els.goodwillTooltip, years, goodwillPct, {
      color: "var(--series-blue-5)",
      label: "Goodwill %",
      fmt: (v) => `${v.toFixed(1)}%`,
      latestEl: els.wcGoodwillLatest,
    });
  }

  function renderMiniLineChart(svgEl, tooltipEl, years, values, opts) {
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    const validPoints = years.map((yr, i) => ({ year: yr, value: values[i] })).filter((d) => d.value != null);

    if (validPoints.length === 0) {
      opts.latestEl.textContent = "—";
      renderEmptyChart(svg, svgEl, "Not reported");
      return;
    }

    const latest = validPoints[validPoints.length - 1];
    opts.latestEl.textContent = opts.fmt(latest.value);

    const wrap = svgEl.parentElement.getBoundingClientRect();
    const width = Math.max(wrap.width, 200);
    const height = Math.max(wrap.height, 100);
    const margin = { top: 12, right: 8, bottom: 22, left: 8 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scalePoint().domain(years).range([0, innerW]).padding(0.5);
    const vals = validPoints.map((d) => d.value);
    const yMin = Math.min(0, d3.min(vals));
    const yMax = Math.max(d3.max(vals), 0) * 1.15;
    const y = d3.scaleLinear().domain([yMin, yMax || 1]).nice().range([innerH, 0]);

    g.append("g")
      .attr("class", "axis-tick")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).tickSize(0).tickPadding(8).tickValues(x.domain().filter((_, i, arr) => i === 0 || i === arr.length - 1)))
      .call((sel) => sel.select(".domain").remove());

    const line = d3.line()
      .x((d) => x(d.year))
      .y((d) => y(d.value))
      .curve(d3.curveMonotoneX);

    const path = g.append("path")
      .datum(validPoints)
      .attr("class", "series-path")
      .attr("stroke", opts.color)
      .attr("d", line);

    const totalLength = path.node().getTotalLength();
    path
      .attr("stroke-dasharray", `${totalLength} ${totalLength}`)
      .attr("stroke-dashoffset", totalLength)
      .transition()
      .duration(450)
      .ease(d3.easeCubicOut)
      .attr("stroke-dashoffset", 0);

    g.selectAll(".dot")
      .data(validPoints)
      .join("circle")
      .attr("class", "dot")
      .attr("cx", (d) => x(d.year))
      .attr("cy", (d) => y(d.value))
      .attr("r", 3)
      .attr("fill", opts.color);

    attachHover(g, svg, svgEl, tooltipEl, x, y, innerW, innerH, margin, years, [
      { key: opts.label, label: opts.label, color: opts.color, values: years.map((yr) => {
        const match = validPoints.find((d) => d.year === yr);
        return match ? match.value : null;
      }), fmt: (v) => (v == null ? "—" : opts.fmt(v)) },
    ]);
  }

  function renderEmptyChart(svg, svgEl, message) {
    const wrap = svgEl.parentElement.getBoundingClientRect();
    const width = Math.max(wrap.width, 200);
    const height = Math.max(wrap.height, 100);
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    svg.append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("class", "axis-tick")
      .style("fill", "var(--color-muted-foreground)")
      .style("font-size", "12.5px")
      .text(message);
  }

  // ============================== Shared hover behavior (line/area charts) ==============================
  function attachHover(g, svg, svgEl, tooltipEl, x, y, innerW, innerH, margin, years, series) {
    const hoverLine = g.append("line").attr("class", "hover-line").attr("y1", 0).attr("y2", innerH);
    const overlay = g.append("rect").attr("class", "overlay").attr("width", innerW).attr("height", innerH);

    const bisectYear = (mx) => {
      const domain = x.domain();
      const step = innerW / (domain.length - 1 || 1);
      const idx = Math.round(mx / step);
      return domain[Math.max(0, Math.min(domain.length - 1, idx))];
    };

    overlay
      .on("mousemove", (event) => {
        const [mx] = d3.pointer(event);
        const yr = bisectYear(mx);
        const xPos = x(yr);
        hoverLine.attr("x1", xPos).attr("x2", xPos).style("opacity", 1);

        const idx = years.indexOf(yr);
        const wrapRect = svgEl.parentElement.getBoundingClientRect();
        const svgRect = svgEl.getBoundingClientRect();
        const validVals = series.map((s) => s.values[idx]).filter((v) => v != null);
        const topVal = validVals.length ? Math.max(...validVals) : 0;
        const tooltipX = svgRect.left - wrapRect.left + margin.left + xPos;
        const tooltipY = svgRect.top - wrapRect.top + margin.top + y(topVal);

        tooltipEl.style.left = `${tooltipX}px`;
        tooltipEl.style.top = `${tooltipY}px`;
        tooltipEl.innerHTML = `
          <div class="tt-year">${yr}</div>
          ${series.map((s) => `
            <div class="tt-row">
              <span class="tt-dot" style="background:${s.color}"></span>
              ${s.label}: ${s.fmt ? s.fmt(s.values[idx]) : fmtUSD(s.values[idx])}
            </div>
          `).join("")}
        `;
        tooltipEl.hidden = false;
      })
      .on("mouseleave", () => {
        hoverLine.style("opacity", 0);
        tooltipEl.hidden = true;
      });
  }

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      if (state.ticker) renderAllCharts();
    });
    ro.observe(document.body);
  }

  // ============================== AI chat ==============================
  // Chat history per ticker, so switching companies and coming back doesn't
  // lose the conversation, but each company gets its own thread.
  const chatHistory = new Map(); // ticker -> [{role, content}]

  function buildDashboardContext(ticker) {
    const company = getCompanyForRender(ticker);
    if (!company) return "No financial data is currently loaded for this company.";

    const range = Math.min(state.range, company.years.length);
    const years = company.years.slice(-range);
    const revenue = company.revenue.slice(-range);
    const netIncome = company.netIncome.slice(-range);
    const margins = getMargins({ revenue, netIncome });
    const records = (company.yearRecords || []).slice(-range);

    const lines = [];
    const name = companyNameCache.get(ticker) || ticker;
    lines.push(`Company: ${name} (${ticker})`);

    if (lastProfile && lastProfile.industry) {
      lines.push(
        `Industry: ${lastProfile.industry} (SEC SIC ${lastProfile.sic || "n/a"}). ` +
        `Exchange: ${lastProfile.exchange || "n/a"}. ` +
        `Incorporated in: ${lastProfile.state_of_incorporation || "n/a"}. ` +
        `Fiscal year ends: ${lastProfile.fiscal_year_end || "n/a"}. ` +
        `Filer category: ${lastProfile.category || "n/a"}.`
      );
    }

    lines.push("");
    lines.push(`Annual financials, ${years[0]}-${years[years.length - 1]} (USD billions):`);
    years.forEach((yr, i) => {
      const parts = [`  ${yr}: revenue ${fmtUSD(revenue[i])}`, `net income ${fmtUSD(netIncome[i])}`];
      if (margins[i] != null) parts.push(`net margin ${margins[i].toFixed(1)}%`);
      const r = records[i];
      if (r) {
        if (r.operating_income != null) parts.push(`operating income ${fmtUSD(r.operating_income)}`);
        if (r.operating_cash_flow != null) parts.push(`operating cash flow ${fmtUSD(r.operating_cash_flow)}`);
        if (r.free_cash_flow != null) parts.push(`free cash flow ${fmtUSD(r.free_cash_flow)}`);
      }
      lines.push(parts.join(", "));
    });

    const latestRecord = records[records.length - 1];
    if (latestRecord) {
      const extras = [];
      if (latestRecord.capex != null) extras.push(`CapEx ${fmtUSD(latestRecord.capex)}`);
      if (latestRecord.stock_based_comp != null) extras.push(`stock-based comp ${fmtUSD(latestRecord.stock_based_comp)}`);
      if (latestRecord.dividends_paid != null) extras.push(`dividends paid ${fmtUSD(latestRecord.dividends_paid)}`);
      if (latestRecord.debt_repayment != null) extras.push(`debt repayment ${fmtUSD(latestRecord.debt_repayment)}`);
      if (latestRecord.buybacks != null) extras.push(`share buybacks ${fmtUSD(latestRecord.buybacks)}`);
      if (latestRecord.goodwill != null && latestRecord.total_assets) {
        extras.push(`goodwill ${((latestRecord.goodwill / latestRecord.total_assets) * 100).toFixed(1)}% of total assets`);
      }
      if (extras.length > 0) {
        lines.push("");
        lines.push(`Latest year (${latestRecord.year}) additional detail: ${extras.join(", ")}.`);
      }
    }

    if (lastPeers && lastPeers.peers && lastPeers.peers.length > 0) {
      lines.push("");
      lines.push(
        `Industry peers by revenue (${lastPeers.industry || "same SEC industry code"}): ` +
        lastPeers.peers.map((p) => `${p.ticker} ${fmtUSD(p.revenue)}`).join(", ") + "."
      );
    }

    return lines.join("\n");
  }

  const CHART_LABELS = {
    revenue: "Revenue chart (Is the business growing?)",
    compare: "Revenue vs. Net Income chart (Is it actually profitable?)",
    margin: "Net Margin chart (How healthy is the business?)",
    cashflow: "Cash Flow Allocation chart (Where does the cash go?)",
    workingcapital: "Working Capital Trends (DSO, DIO, Goodwill %)",
    peers: "Peer Comparison chart",
  };

  // A focused context for one chart, used instead of the full dashboard
  // summary when the user has clicked that chart's "Ask AI" button — keeps
  // the model's attention on just the data being asked about.
  // Data lines for one chart only (no header/company boilerplate) — used by
  // buildChartContext() below to compose one or more selected charts.
  function buildOneChartSection(ticker, chartId, years, revenue, netIncome, margins, records) {
    const lines = [`--- ${CHART_LABELS[chartId] || chartId} ---`];

    switch (chartId) {
      case "revenue":
        lines.push(`Revenue by year (USD billions):`);
        years.forEach((yr, i) => lines.push(`  ${yr}: ${fmtUSD(revenue[i])}`));
        break;

      case "compare":
        lines.push(`Revenue vs. net income by year (USD billions):`);
        years.forEach((yr, i) => lines.push(`  ${yr}: revenue ${fmtUSD(revenue[i])}, net income ${fmtUSD(netIncome[i])}`));
        break;

      case "margin":
        lines.push(`Net margin by year (%):`);
        years.forEach((yr, i) => lines.push(`  ${yr}: ${margins[i] == null ? "n/a" : margins[i].toFixed(1) + "%"}`));
        break;

      case "cashflow":
        lines.push(`Operating cash flow allocation by year (USD billions):`);
        years.forEach((yr, i) => {
          const r = records[i];
          if (!r) return;
          const parts = [`OCF ${fmtUSD(r.operating_cash_flow)}`];
          if (r.capex != null) parts.push(`CapEx ${fmtUSD(r.capex)}`);
          if (r.debt_repayment != null) parts.push(`debt repayment ${fmtUSD(r.debt_repayment)}`);
          if (r.dividends_paid != null) parts.push(`dividends ${fmtUSD(r.dividends_paid)}`);
          if (r.buybacks != null) parts.push(`buybacks ${fmtUSD(r.buybacks)}`);
          lines.push(`  ${yr}: ${parts.join(", ")}`);
        });
        break;

      case "workingcapital": {
        const dso = computeDSO(records);
        const dio = computeDIO(records);
        const goodwillPct = computeGoodwillPct(records);
        lines.push(`Days Sales Outstanding, Days Inventory Outstanding, Goodwill % of assets, by year:`);
        years.forEach((yr, i) => {
          const parts = [];
          parts.push(`DSO ${dso[i] == null ? "n/a" : dso[i].toFixed(0) + " days"}`);
          parts.push(`DIO ${dio[i] == null ? "n/a" : dio[i].toFixed(0) + " days"}`);
          parts.push(`Goodwill ${goodwillPct[i] == null ? "n/a" : goodwillPct[i].toFixed(1) + "%"}`);
          lines.push(`  ${yr}: ${parts.join(", ")}`);
        });
        break;
      }

      case "peers": {
        const lastRev = revenue[revenue.length - 1];
        lines.push(`This company's latest revenue: ${fmtUSD(lastRev)}.`);
        if (lastPeers && lastPeers.peers && lastPeers.peers.length > 0) {
          lines.push(
            `Industry peers (${lastPeers.industry || "same SEC industry code"}), by revenue: ` +
            lastPeers.peers.map((p) => `${p.name} (${p.ticker}) ${fmtUSD(p.revenue)}`).join(", ") + "."
          );
        } else {
          lines.push("No peer data is currently loaded.");
        }
        break;
      }
    }

    return lines.join("\n");
  }

  // Focused context for the chart(s) the user has selected (via clicking
  // chart panels), instead of the full dashboard summary — keeps the model's
  // attention on just the data being asked about. Accepts one or more chart
  // ids; each selected chart gets its own labeled section.
  function buildChartContext(ticker, chartIds) {
    const company = getCompanyForRender(ticker);
    if (!company) return "No financial data is currently loaded for this company.";
    if (!chartIds || chartIds.length === 0) return buildDashboardContext(ticker);

    const range = Math.min(state.range, company.years.length);
    const years = company.years.slice(-range);
    const revenue = company.revenue.slice(-range);
    const netIncome = company.netIncome.slice(-range);
    const margins = getMargins({ revenue, netIncome });
    const records = (company.yearRecords || []).slice(-range);
    const name = companyNameCache.get(ticker) || ticker;

    const chartLabels = chartIds.map((id) => CHART_LABELS[id] || id).join(", ");
    const plural = chartIds.length > 1 ? "charts" : "chart";
    const header =
      `Company: ${name} (${ticker})\n` +
      `The user has selected specific ${plural} to ask about: ${chartLabels}. ` +
      `Focus your answer on this data${chartIds.length > 1 ? ", drawing connections between the selected charts where relevant" : ""}.\n`;

    const sections = chartIds.map((id) =>
      buildOneChartSection(ticker, id, years, revenue, netIncome, margins, records)
    );

    return [header, ...sections].join("\n");
  }

  function scrollChatToBottom() {
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  // Minimal, safe markdown -> HTML: escapes all HTML first (this is
  // AI-generated text going into the DOM), then converts a small set of
  // markdown constructs the model actually uses (bold, italics, bullet/
  // numbered lists, paragraph breaks). Not a full markdown parser — just
  // enough to make the assistant's formatting readable instead of raw.
  function renderChatMarkdown(raw) {
    const escaped = escapeHtml(raw);
    const lines = escaped.split("\n");
    const htmlParts = [];
    let listBuffer = [];
    let listType = null;

    const flushList = () => {
      if (listBuffer.length === 0) return;
      const tag = listType === "ol" ? "ol" : "ul";
      htmlParts.push(`<${tag}>${listBuffer.map((li) => `<li>${li}</li>`).join("")}</${tag}>`);
      listBuffer = [];
      listType = null;
    };

    const inline = (s) =>
      s
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
        .replace(/`(.+?)`/g, "<code>$1</code>");

    lines.forEach((line) => {
      const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
      const numberedMatch = line.match(/^\s*\d+[.)]\s+(.*)$/);

      if (bulletMatch) {
        if (listType !== "ul") flushList();
        listType = "ul";
        listBuffer.push(inline(bulletMatch[1]));
      } else if (numberedMatch) {
        if (listType !== "ol") flushList();
        listType = "ol";
        listBuffer.push(inline(numberedMatch[1]));
      } else {
        flushList();
        if (line.trim() === "") {
          htmlParts.push("<br>");
        } else {
          htmlParts.push(`<p>${inline(line)}</p>`);
        }
      }
    });
    flushList();

    return htmlParts.join("");
  }

  function appendChatBubble(role, text) {
    els.chatEmpty.hidden = true;
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble--${role}`;
    if (role === "assistant") {
      bubble.innerHTML = renderChatMarkdown(text);
    } else {
      bubble.textContent = text;
    }
    els.chatMessages.appendChild(bubble);
    scrollChatToBottom();
    return bubble;
  }

  // A small centered marker (not a message bubble, not sent to the AI) that
  // confirms a chart was selected — visible, persistent context in the
  // conversation stream itself, in addition to the scope chip near the input.
  function appendChatSystemNote(text) {
    els.chatEmpty.hidden = true;
    const note = document.createElement("div");
    note.className = "chat-system-note";
    const icon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>`;
    note.innerHTML = `${icon}<span>${escapeHtml(text)}</span>`;
    els.chatMessages.appendChild(note);
    scrollChatToBottom();
    return note;
  }

  function appendChatLoading() {
    els.chatEmpty.hidden = true;
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble chat-bubble--loading";
    bubble.innerHTML = `<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>`;
    els.chatMessages.appendChild(bubble);
    scrollChatToBottom();
    return bubble;
  }

  function renderChatHistoryForTicker(ticker) {
    els.chatMessages.innerHTML = "";
    els.chatMessages.appendChild(els.chatEmpty);
    const history = chatHistory.get(ticker) || [];
    if (history.length === 0) {
      els.chatEmpty.hidden = false;
      return;
    }
    els.chatEmpty.hidden = true;
    history.forEach((m) => appendChatBubble(m.role, m.content));
  }

  let chatRequestInFlight = false;

  async function sendChatMessage(text) {
    const ticker = state.ticker;
    if (!ticker || !text.trim() || chatRequestInFlight) return;

    if (!chatHistory.has(ticker)) chatHistory.set(ticker, []);
    const history = chatHistory.get(ticker);

    history.push({ role: "user", content: text });
    appendChatBubble("user", text);

    chatRequestInFlight = true;
    els.chatSendBtn.disabled = true;
    const loadingBubble = appendChatLoading();

    const context = selectedCharts.size > 0
      ? buildChartContext(ticker, Array.from(selectedCharts.keys()))
      : buildDashboardContext(ticker);

    try {
      const resp = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          company_name: companyNameCache.get(ticker) || ticker,
          dashboard_context: context,
          messages: history,
        }),
      });
      const data = await resp.json();
      loadingBubble.remove();

      if (!resp.ok) {
        const msg = data.detail || `Request failed (${resp.status})`;
        appendChatBubble("error", msg);
        return;
      }

      history.push({ role: "assistant", content: data.reply });
      appendChatBubble("assistant", data.reply);
    } catch (err) {
      loadingBubble.remove();
      appendChatBubble("error", "Couldn't reach the AI service. Check that the backend is running.");
    } finally {
      chatRequestInFlight = false;
      els.chatSendBtn.disabled = false;
    }
  }

  els.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = els.chatInput.value;
    els.chatInput.value = "";
    els.chatInput.style.height = "auto";
    sendChatMessage(text);
  });

  els.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      els.chatForm.requestSubmit();
    }
  });

  els.chatInput.addEventListener("input", () => {
    els.chatInput.style.height = "auto";
    els.chatInput.style.height = `${Math.min(els.chatInput.scrollHeight, 120)}px`;
  });

  document.querySelectorAll(".chat-suggestion-chip").forEach((chip) => {
    chip.addEventListener("click", () => sendChatMessage(chip.textContent));
  });

  els.chatClearBtn.addEventListener("click", () => {
    if (!state.ticker) return;
    chatHistory.delete(state.ticker);
    renderChatHistoryForTicker(state.ticker);
  });

  // ============================== Chat sidebar toggle ==============================
  function setChatCollapsed(collapsed) {
    els.chatSidebar.classList.toggle("is-collapsed", collapsed);
    els.chatReopenBtn.hidden = !collapsed;
    try {
      localStorage.setItem("agentdash-chat-collapsed", collapsed ? "1" : "0");
    } catch (e) { /* storage unavailable */ }
    if (state.ticker) renderAllCharts();
  }

  els.chatCollapseBtn.addEventListener("click", () => setChatCollapsed(true));
  els.chatReopenBtn.addEventListener("click", () => setChatCollapsed(false));

  (function initChatCollapsed() {
    let saved = null;
    try {
      saved = localStorage.getItem("agentdash-chat-collapsed");
    } catch (e) { /* storage unavailable */ }
    setChatCollapsed(saved === "1");
  })();

  function refreshChartSelectionUI() {
    els.chartPanels.forEach((panel) => {
      const isSelected = selectedCharts.has(panel.dataset.chart);
      panel.classList.toggle("is-selected", isSelected);
      panel.setAttribute("aria-pressed", String(isSelected));
    });

    if (selectedCharts.size === 0) {
      els.chatScopeChip.hidden = true;
    } else {
      els.chatScopeLabel.textContent = Array.from(selectedCharts.values()).join(", ");
      els.chatScopeChip.hidden = false;
    }
  }

  // Clears every selected chart at once (used by the scope chip's clear
  // button and when switching companies).
  function clearSelectedCharts() {
    selectedCharts.clear();
    refreshChartSelectionUI();
  }

  els.chartPanels.forEach((panel) => {
    const chartId = panel.dataset.chart;
    const label = CHART_LABELS[chartId] || chartId;

    const activate = () => {
      // Toggle this chart's membership in the selection — other selected
      // charts are unaffected, so multiple charts can be selected at once.
      if (selectedCharts.has(chartId)) {
        selectedCharts.delete(chartId);
        refreshChartSelectionUI();
      } else {
        selectedCharts.set(chartId, label);
        refreshChartSelectionUI();
        appendChatSystemNote(`Selected: ${label}`);
      }
      els.chatInput.focus();
      els.chatSidebar.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    panel.addEventListener("click", activate);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });

  els.chatScopeClear.addEventListener("click", clearSelectedCharts);

  // Called from updateDashboard() once a ticker is selected/switched, so the
  // sidebar's label and thread follow the company currently on screen.
  function updateChatForTicker(ticker) {
    els.chatCompanyLabel.textContent = companyNameCache.get(ticker) || ticker;
    clearSelectedCharts(); // a chart selection from the previous company shouldn't carry over
    renderChatHistoryForTicker(ticker);
  }
})();
