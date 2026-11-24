(() => {
  "use strict";

  const DEFAULT_GIST_ID = "63b3c03789dd8ff3a41c24f9b1c6dc00";
  const GIST_OWNER = "phylipppp-zzy";
  const GIST_FILE = "usage-data.json";
  const CACHE_KEY = "ai_usage_dashboard_snapshot_v1";
  const THEME_KEY = "ai_usage_dashboard_theme_v2";
  const AUTO_REFRESH_MS = 10 * 60 * 1000;

  const BACKEND_COLORS = {
    codex: "var(--codex)",
    antigravity: "var(--agy)",
    claude: "var(--claude)",
  };

  const BACKEND_LABELS = {
    codex: "Codex",
    antigravity: "Antigravity",
    claude: "Claude",
  };

  const state = {
    data: null,
    kpiRange: "today",
    trendSpan: "24h",
    trendMetric: "cost_usd",
    trendBackend: "all",
    modelBackend: "all",
    nextRefreshAt: Date.now() + AUTO_REFRESH_MS,
    loading: false,
    sourceLabel: "",
  };

  const params = new URLSearchParams(window.location.search);
  const gistId = (params.get("gist") || DEFAULT_GIST_ID).replace(/[^a-f0-9]/gi, "") || DEFAULT_GIST_ID;

  // ---------- Formatters ----------
  function fmtUsd(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return "--";
    if (n === 0) return "$0.00";
    if (n < 0.01) return "<$0.01";
    if (n >= 1000) return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return "$" + n.toFixed(2);
  }

  function fmtTokens(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return "--";
    if (n < 1000) return String(Math.round(n));
    for (const [u, s] of [["B", 1e9], ["M", 1e6], ["K", 1e3]]) {
      if (n >= s) {
        const val = (n / s).toFixed(n / s >= 100 ? 0 : 1).replace(/\.0$/, "");
        return val + u;
      }
    }
    return String(Math.round(n));
  }

  function fmtInt(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "--";
  }

  function fmtPct(ratio) {
    if (ratio === null || ratio === undefined || !Number.isFinite(Number(ratio))) return "--";
    return (Number(ratio) * 100).toFixed(1) + "%";
  }

  function fmtMetric(metric, v) {
    if (metric === "cost_usd") return fmtUsd(v);
    if (metric === "total_tokens") return fmtTokens(v);
    return fmtInt(v) + " 次";
  }

  function fmtShortAxis(metric, v) {
    if (metric === "cost_usd") {
      if (v >= 100) return "$" + Math.round(v);
      if (v >= 10) return "$" + v.toFixed(1);
      if (v > 0) return "$" + v.toFixed(2);
      return "$0";
    }
    if (metric === "total_tokens") return fmtTokens(v);
    return fmtInt(v);
  }

  function fmtBjTime(iso, withDate = true) {
    if (!iso) return "未知";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "未知";
    const opts = { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" };
    if (withDate) {
      opts.month = "2-digit";
      opts.day = "2-digit";
    }
    return new Intl.DateTimeFormat("zh-CN", opts).format(d).replace(/\//g, "-");
  }

  function fmtCompactCountdown(iso) {
    if (!iso) return "满额 / 无窗口";
    const target = new Date(iso).getTime();
    if (Number.isNaN(target)) return "未知";
    const diffSec = Math.floor((target - Date.now()) / 1000);
    if (diffSec <= 0) return "即将重置";
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h 后重置`;
    if (hours > 0) return `${hours}h ${mins}m 后重置`;
    return `${Math.max(1, mins)}m 后重置`;
  }

  function fmtAge(iso) {
    if (!iso) return { text: "未知时间", level: "stale" };
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) return { text: "未知时间", level: "stale" };
    const mins = Math.max(0, Math.floor((Date.now() - ts) / 60000));
    const clock = fmtBjTime(iso, false);
    const ageStr = mins < 1 ? "刚刚" : mins < 60 ? `${mins}m 前` : `${Math.floor(mins / 60)}h ${mins % 60}m 前`;
    const level = mins <= 20 ? "fresh" : mins <= 60 ? "delayed" : "stale";
    return { text: `${clock} · ${ageStr}`, level };
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- Theme (Default Obsidian Dark, User-Toggleable) ----------
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const sun = document.getElementById("themeIconSun");
    const moon = document.getElementById("themeIconMoon");
    if (sun && moon) {
      sun.style.display = theme === "dark" ? "block" : "none";
      moon.style.display = theme === "dark" ? "none" : "block";
    }
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    applyTheme(saved === "light" ? "light" : "dark");
    document.getElementById("themeBtn").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
      const next = cur === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
  }

  // ---------- Data Fetching ----------
  async function fetchSnapshot() {
    try {
      const apiRes = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
      });
      if (apiRes.ok) {
        const meta = await apiRes.json();
        const fileObj = meta && meta.files && meta.files[GIST_FILE];
        if (fileObj && fileObj.content) {
          return { data: JSON.parse(fileObj.content), source: "GitHub API" };
        }
      }
    } catch (_) {}

    const rawUrl = `https://gist.githubusercontent.com/${GIST_OWNER}/${gistId}/raw/${GIST_FILE}?t=${Date.now()}`;
    const rawRes = await fetch(rawUrl, { cache: "no-store" });
    if (!rawRes.ok) throw new Error(`HTTP ${rawRes.status}`);
    return { data: await rawRes.json(), source: "Gist Raw" };
  }

  async function loadData(isManual = false) {
    if (state.loading) return;
    state.loading = true;
    const btn = document.getElementById("refreshBtn");
    btn.classList.add("loading");
    if (isManual) document.getElementById("refreshLabel").textContent = "同步中";

    try {
      const { data, source } = await fetchSnapshot();
      state.data = data;
      state.sourceLabel = source;
      state.nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) {}
      document.getElementById("noticeBanner").hidden = true;
      renderAll();
    } catch (err) {
      document.getElementById("noticeText").textContent =
        `同步失败（${err.message || "网络异常"}），${state.data ? "当前展示本地缓存快照" : "请检查网络后重试"}。`;
      document.getElementById("noticeBanner").hidden = false;
    } finally {
      state.loading = false;
      btn.classList.remove("loading");
      document.getElementById("refreshLabel").textContent = "刷新";
    }
  }

  // ---------- Render: Sync Status ----------
  function renderSyncStatus() {
    if (!state.data) return;
    const { text, level } = fmtAge(state.data.generated_at);
    document.getElementById("syncDot").className = "pulse-dot " + level;
    document.getElementById("syncText").textContent = text;

    const remMs = Math.max(0, state.nextRefreshAt - Date.now());
    const m = Math.floor(remMs / 60000);
    const s = Math.floor((remMs % 60000) / 1000);
    document.getElementById("nextRefreshMeta").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

    document.getElementById("footerMeta").textContent =
      `更新于 ${fmtBjTime(state.data.generated_at, true)} · ${state.sourceLabel || "缓存"}`;
  }

  // ---------- Render: Left Hero (Spend & Summary) ----------
  function renderHeroSpend() {
    const summary = state.data.summary || {};
    const cur = summary[state.kpiRange] || {};
    const yesterday = summary.yesterday || {};

    document.getElementById("heroAmount").textContent = fmtUsd(cur.cost_usd);

    let deltaHtml = "";
    if (state.kpiRange === "today") {
      const yCost = Number(yesterday.cost_usd || 0);
      const tCost = Number(cur.cost_usd || 0);
      if (yCost > 0) {
        const diff = ((tCost - yCost) / yCost) * 100;
        const cls = diff > 5 ? "up" : diff < -5 ? "down" : "";
        const sign = diff >= 0 ? "+" : "";
        deltaHtml = `<span class="delta-badge ${cls}">${sign}${diff.toFixed(0)}%</span><span>较昨日 ${fmtUsd(yCost)}</span>`;
      } else {
        deltaHtml = `<span>昨日 ${fmtUsd(yCost)}</span>`;
      }
    } else if (state.kpiRange === "d7") {
      deltaHtml = `<span class="delta-badge">日均 ${fmtUsd((cur.cost_usd || 0) / 7)}</span>`;
    } else {
      deltaHtml = `<span class="delta-badge">日均 ${fmtUsd((cur.cost_usd || 0) / 30)}</span>`;
    }
    document.getElementById("heroDelta").innerHTML = deltaHtml;

    // Backend Spend Proportional Bar
    const backends = state.data.backends || [];
    const totalCost = backends.reduce((acc, b) => acc + Number((b[state.kpiRange] || {}).cost_usd || 0), 0);
    const segs = [];
    const legends = [];
    for (const b of backends) {
      const cost = Number((b[state.kpiRange] || {}).cost_usd || 0);
      const pct = totalCost > 0 ? (cost / totalCost) * 100 : 0;
      if (pct > 0) {
        segs.push(`<div class="share-seg" style="width:${Math.max(1.5, pct)}%;background:${BACKEND_COLORS[b.id]}"></div>`);
      }
      legends.push(
        `<span class="legend-item"><span class="pdot ${esc(b.id)}"></span>${esc(b.name)} <strong>${fmtUsd(cost)}</strong></span>`
      );
    }
    document.getElementById("backendShareBar").innerHTML = segs.join("") || `<div class="share-seg" style="width:100%;background:var(--border-strong)"></div>`;
    document.getElementById("backendShareLegend").innerHTML = legends.join("");

    // Mini Telemetry Metrics
    document.getElementById("mmTokens").textContent = fmtTokens(cur.total_tokens);
    document.getElementById("mmTokensSub").textContent = `输出 ${fmtTokens(cur.output)}`;
    document.getElementById("mmCache").textContent = fmtPct(cur.cache_hit_ratio);
    document.getElementById("mmCacheSub").textContent = `复用 ${fmtTokens(cur.cached)}`;
    document.getElementById("mmReqs").textContent = fmtInt(cur.requests);

    const modelKey = state.kpiRange === "today" ? "models_today" : state.kpiRange === "d7" ? "models_7d" : "models_30d";
    const activeModels = new Set();
    for (const b of backends) {
      for (const m of b[modelKey] || []) {
        if (m.requests > 0 || m.total_tokens > 0) activeModels.add(`${b.id}:${m.model}`);
      }
    }
    document.getElementById("mmReqsSub").textContent = `${activeModels.size} 个活跃模型`;
  }

  // ---------- Render: Right Hero (Circular Radial Quota Rings) ----------
  function ringStrokeColor(rem, backendId) {
    if (rem !== null && rem !== undefined) {
      if (rem < 15) return "var(--danger)";
      if (rem < 35) return "var(--warn)";
    }
    return BACKEND_COLORS[backendId] || "var(--ok)";
  }

  function renderQuotaRings() {
    const backends = state.data.backends || [];
    const ringItems = [];
    const footerNotes = [];

    for (const b of backends) {
      const q = b.quota || {};
      const wins = q.windows || [];
      if (wins.length > 0) {
        for (const w of wins) {
          let shortTitle = w.label || b.name;
          if (b.id === "codex") shortTitle = "Codex " + (w.label || "周额度");
          ringItems.push({
            backendId: b.id,
            title: shortTitle,
            rem: w.remaining_percent,
            resetsAt: w.resets_at,
          });
        }
      } else {
        const cycleCd = q.cycle_reset ? fmtCompactCountdown(q.cycle_reset) : "仅本地统计";
        const cycleTime = q.cycle_reset ? ` (${fmtBjTime(q.cycle_reset, true)})` : "";
        footerNotes.push(
          `<span class="qf-chip"><span class="pdot ${esc(b.id)}"></span><strong>${esc(b.name)}</strong> <span class="qf-muted">在线未连通 · ${esc(cycleCd)}${esc(cycleTime)}</span></span>`
        );
      }
    }

    const r = 31;
    const circ = 2 * Math.PI * r;
    const grid = document.getElementById("quotaRingsGrid");
    grid.innerHTML = ringItems.map((item) => {
      const rem = item.rem === null || item.rem === undefined ? 0 : Math.max(0, Math.min(100, Number(item.rem)));
      const offset = circ * (1 - rem / 100);
      const color = ringStrokeColor(item.rem, item.backendId);
      const pctLabel = item.rem === null || item.rem === undefined ? "--" : `${rem >= 100 ? "100" : rem.toFixed(1).replace(/\.0$/, "")}%`;
      const cd = fmtCompactCountdown(item.resetsAt);
      const resetClock = item.resetsAt ? fmtBjTime(item.resetsAt, true) : "";

      return `
        <div class="ring-tile" title="${esc(item.title)} ${resetClock ? "· 重置 " + resetClock : ""}">
          <div class="ring-svg-wrap">
            <svg class="ring-svg" viewBox="0 0 76 76">
              <circle class="ring-bg" cx="38" cy="38" r="${r}"/>
              <circle class="ring-fg" cx="38" cy="38" r="${r}" stroke="${color}" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
            </svg>
            <div class="ring-center">
              <span class="ring-pct" style="color:${color}">${esc(pctLabel)}</span>
              <span class="ring-unit">剩余</span>
            </div>
          </div>
          <div class="ring-title">${esc(item.title)}</div>
          <div class="ring-meta">${esc(cd)}</div>
        </div>
      `;
    }).join("");

    // Also add 7d quick reference in footer bar
    const d7Summary = (state.data.summary || {}).d7 || {};
    footerNotes.push(
      `<span class="qf-chip qf-muted">近 7 天全后端合计 <strong style="color:var(--text)">${fmtUsd(d7Summary.cost_usd)}</strong> · ${fmtTokens(d7Summary.total_tokens)} tok</span>`
    );
    document.getElementById("quotaFooterBar").innerHTML = footerNotes.join("");
  }

  // ---------- Render: True 1:1 Responsive SVG Stacked Trend Chart ----------
  function buildContinuousSeries() {
    const backends = state.data.backends || [];
    const span = state.trendSpan;
    const metric = state.trendMetric;
    const activeIds = state.trendBackend === "all" ? ["codex", "antigravity", "claude"] : [state.trendBackend];

    const now = new Date(state.data.generated_at || Date.now());
    const bjNowMs = now.getTime() + 8 * 3600 * 1000;
    const slots = [];

    if (span === "24h") {
      const bjHourEnd = Math.floor(bjNowMs / 3600000) * 3600000;
      for (let i = 23; i >= 0; i--) {
        const d = new Date(bjHourEnd - i * 3600000);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:00:00+08:00`;
        const shortLabel = `${String(d.getUTCHours()).padStart(2, "0")}:00`;
        const fullLabel = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${shortLabel}`;
        slots.push({ key, shortLabel, fullLabel, values: { codex: 0, antigravity: 0, claude: 0 }, total: 0 });
      }
      const map = new Map(slots.map((s) => [s.key, s]));
      for (const b of backends) {
        if (!activeIds.includes(b.id)) continue;
        for (const item of b.hourly_24h || []) {
          const s = map.get(item.ts);
          if (s) {
            const v = Number(item[metric] || 0);
            s.values[b.id] += v;
            s.total += v;
          }
        }
      }
    } else {
      const days = span === "7d" ? 7 : 30;
      const bjDayEnd = Math.floor(bjNowMs / 86400000) * 86400000;
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(bjDayEnd - i * 86400000);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        const shortLabel = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        slots.push({ key, shortLabel, fullLabel: key, values: { codex: 0, antigravity: 0, claude: 0 }, total: 0 });
      }
      const map = new Map(slots.map((s) => [s.key, s]));
      for (const b of backends) {
        if (!activeIds.includes(b.id)) continue;
        for (const item of b.daily_30d || []) {
          const s = map.get(item.date);
          if (s) {
            const v = Number(item[metric] || 0);
            s.values[b.id] += v;
            s.total += v;
          }
        }
      }
    }
    return { slots, activeIds };
  }

  function renderTrendChart() {
    if (!state.data) return;
    const stage = document.getElementById("chartStage");
    const svg = document.getElementById("trendSvg");
    const tooltip = document.getElementById("chartTooltip");
    tooltip.hidden = true;

    const { slots, activeIds } = buildContinuousSeries();
    const totalSum = slots.reduce((a, s) => a + s.total, 0);
    const activeCount = slots.filter((s) => s.total > 0).length;
    const peak = slots.reduce((best, s) => (s.total > (best ? best.total : -1) ? s : best), null);

    document.getElementById("chartStats").innerHTML = `
      <span>合计 <strong>${fmtMetric(state.trendMetric, totalSum)}</strong></span>
      <span>峰值 <strong>${peak && peak.total > 0 ? `${fmtShortAxis(state.trendMetric, peak.total)} (${peak.shortLabel})` : "--"}</strong></span>
      <span>活跃 <strong>${activeCount}/${slots.length}</strong></span>
    `;

    // True 1:1 CSS pixel dimensions -> ZERO font or bar distortion!
    const W = Math.max(300, Math.round(stage.clientWidth || 920));
    const H = Math.max(190, Math.round(stage.clientHeight || 260));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    const padL = 52;
    const padR = 12;
    const padT = 14;
    const padB = 28;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const maxVal = Math.max(1e-9, ...slots.map((s) => s.total));

    const parts = [
      `<defs>
        <linearGradient id="g-codex" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--codex)" stop-opacity="1"/>
          <stop offset="100%" stop-color="var(--codex)" stop-opacity="0.65"/>
        </linearGradient>
        <linearGradient id="g-antigravity" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--agy)" stop-opacity="1"/>
          <stop offset="100%" stop-color="var(--agy)" stop-opacity="0.65"/>
        </linearGradient>
        <linearGradient id="g-claude" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--claude)" stop-opacity="1"/>
          <stop offset="100%" stop-color="var(--claude)" stop-opacity="0.65"/>
        </linearGradient>
      </defs>`,
    ];

    // Horizontal Grid & Y Labels
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const ratio = i / yTicks;
      const y = padT + plotH * (1 - ratio);
      parts.push(`<line class="grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`);
      parts.push(`<text class="axis-text" x="${padL - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(fmtShortAxis(state.trendMetric, maxVal * ratio))}</text>`);
    }

    const n = slots.length;
    const step = plotW / n;
    const barW = Math.max(5, Math.min(30, step * 0.58));
    const maxLabels = Math.max(4, Math.floor(plotW / 64));
    const labelEvery = Math.max(1, Math.ceil(n / maxLabels));

    slots.forEach((slot, idx) => {
      const cx = padL + step * idx + step / 2;
      const x = cx - barW / 2;
      let curY = padT + plotH;

      // Subtle slot hover hit area behind bars
      parts.push(
        `<rect class="bar-slot-hit" data-idx="${idx}" x="${(padL + step * idx).toFixed(1)}" y="${padT}" width="${step.toFixed(1)}" height="${plotH}" rx="4"/>`
      );

      for (const bid of activeIds) {
        const v = slot.values[bid] || 0;
        if (v <= 0) continue;
        const h = Math.max(3, (v / maxVal) * plotH);
        curY -= h;
        parts.push(
          `<rect pointer-events="none" x="${x.toFixed(1)}" y="${curY.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="url(#g-${bid})"/>`
        );
      }

      if (idx % labelEvery === 0 || idx === n - 1) {
        parts.push(`<text class="axis-text" x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(slot.shortLabel)}</text>`);
      }
    });

    svg.innerHTML = parts.join("");

    function showTooltip(idx, clientX) {
      const slot = slots[idx];
      if (!slot) return;
      const lines = activeIds.map((bid) => `
        <div class="tt-line">
          <span class="tt-label"><span class="pdot ${bid}"></span>${BACKEND_LABELS[bid]}</span>
          <span>${fmtMetric(state.trendMetric, slot.values[bid] || 0)}</span>
        </div>
      `).join("");

      tooltip.innerHTML = `
        <div class="tt-head">${esc(slot.fullLabel)}</div>
        ${lines}
        ${activeIds.length > 1 ? `<div class="tt-line tt-sum"><span>合计</span><span>${fmtMetric(state.trendMetric, slot.total)}</span></div>` : ""}
      `;
      tooltip.hidden = false;

      const rect = stage.getBoundingClientRect();
      const relX = clientX - rect.left;
      const ttW = tooltip.offsetWidth || 195;
      const left = relX + 16 + ttW > rect.width ? Math.max(4, relX - ttW - 16) : relX + 16;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `10px`;
    }

    svg.querySelectorAll(".bar-slot-hit").forEach((el) => {
      el.addEventListener("mouseenter", (e) => showTooltip(Number(el.dataset.idx), e.clientX));
      el.addEventListener("mousemove", (e) => showTooltip(Number(el.dataset.idx), e.clientX));
      el.addEventListener("click", (e) => showTooltip(Number(el.dataset.idx), e.clientX));
    });
    stage.onmouseleave = () => { tooltip.hidden = true; };
  }

  // ---------- Render: Model Leaderboard ----------
  function renderModelTable() {
    const rangeName = state.kpiRange === "today" ? "今日" : state.kpiRange === "d7" ? "近 7 天" : "近 30 天";
    document.getElementById("modelRangeBadge").textContent = rangeName;

    const modelKey = state.kpiRange === "today" ? "models_today" : state.kpiRange === "d7" ? "models_7d" : "models_30d";
    const rows = [];
    for (const b of state.data.backends || []) {
      if (state.modelBackend !== "all" && b.id !== state.modelBackend) continue;
      for (const m of b[modelKey] || []) {
        rows.push({ backendId: b.id, backendName: b.name, ...m });
      }
    }
    rows.sort((a, b) => (b.cost_usd - a.cost_usd) || (b.total_tokens - a.total_tokens) || (b.requests - a.requests));

    const totalCost = rows.reduce((acc, r) => acc + Number(r.cost_usd || 0), 0);
    const tbody = document.getElementById("modelTableBody");

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">当前范围内暂无模型调用记录</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((r) => {
      const share = totalCost > 0 ? (Number(r.cost_usd || 0) / totalCost) * 100 : 0;
      return `
        <tr>
          <td>
            <div class="model-cell">
              <span class="btag ${esc(r.backendId)}">${esc(r.backendName)}</span>
              <span class="model-name">${esc(r.model)}</span>
            </div>
          </td>
          <td class="num"><strong>${fmtUsd(r.cost_usd)}</strong></td>
          <td class="bar-td">
            <div class="share-inline">
              <div class="share-bg">
                <div class="share-val" style="width:${Math.max(share > 0 ? 3 : 0, share)}%;background:${BACKEND_COLORS[r.backendId]}"></div>
              </div>
              <span class="share-num">${share.toFixed(1)}%</span>
            </div>
          </td>
          <td class="num">${fmtInt(r.requests)}</td>
          <td class="num">${fmtTokens(r.total_tokens)}</td>
          <td class="num">${fmtPct(r.cache_hit_ratio)}</td>
        </tr>
      `;
    }).join("");
  }

  // ---------- Render: Claude Billing Cycles ----------
  function renderClaudeCycles() {
    const list = document.getElementById("cyclesList");
    const cycles = state.data.claude_cycles || [];
    if (cycles.length === 0) {
      list.innerHTML = `<div class="empty-cell">暂无 Claude 历史周期数据</div>`;
      return;
    }

    const ordered = [...cycles].reverse();
    list.innerHTML = ordered.map((c) => {
      const badgeCls = c.current ? "cycle-badge current" : "cycle-badge";
      const badgeTxt = c.current ? "当前周期" : c.partial ? "部分记录" : "完整周期";
      const siteVal = c.site_cost_usd !== null && c.site_cost_usd !== undefined ? fmtUsd(c.site_cost_usd) : "--";
      const topModels = (c.models || []).slice(0, 3).map((m) =>
        `<span class="cmodel-pill">${esc(m.model)} · ${fmtUsd(m.site_cost_usd ?? m.local_cost_usd)}</span>`
      ).join("");

      return `
        <div class="cycle-item">
          <div class="cycle-top">
            <span class="cycle-date">${esc(c.period)}</span>
            <span class="${badgeCls}">${badgeTxt}</span>
          </div>
          <div class="cycle-nums">
            <div>
              <div class="cn-label">本机估算</div>
              <div class="cn-val">${fmtUsd(c.local_cost_usd)}</div>
            </div>
            <div>
              <div class="cn-label">网站记录</div>
              <div class="cn-val">${siteVal}</div>
            </div>
            <div>
              <div class="cn-label">总 Token</div>
              <div class="cn-val">${fmtTokens(c.total_tokens)}</div>
            </div>
          </div>
          ${topModels ? `<div class="cycle-tags">${topModels}</div>` : ""}
        </div>
      `;
    }).join("");
  }

  function renderAll() {
    if (!state.data) return;
    renderSyncStatus();
    renderHeroSpend();
    renderQuotaRings();
    renderTrendChart();
    renderModelTable();
    renderClaudeCycles();
  }

  // ---------- Controls & Resize ----------
  function bindControls() {
    document.getElementById("refreshBtn").addEventListener("click", () => loadData(true));
    document.getElementById("noticeRetry").addEventListener("click", () => loadData(true));

    document.querySelectorAll("#kpiRangeGroup .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#kpiRangeGroup .seg-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", String(b === btn));
        });
        state.kpiRange = btn.dataset.range;
        if (state.data) {
          renderHeroSpend();
          renderModelTable();
        }
      });
    });

    document.querySelectorAll("#trendSpanGroup .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#trendSpanGroup .seg-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", String(b === btn));
        });
        state.trendSpan = btn.dataset.span;
        renderTrendChart();
      });
    });

    document.querySelectorAll("#trendMetricGroup .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#trendMetricGroup .seg-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", String(b === btn));
        });
        state.trendMetric = btn.dataset.metric;
        renderTrendChart();
      });
    });

    document.querySelectorAll("#backendFilterGroup .pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#backendFilterGroup .pill").forEach((b) => b.classList.toggle("active", b === btn));
        state.trendBackend = btn.dataset.backend;
        renderTrendChart();
      });
    });

    document.querySelectorAll("#modelBackendFilter .pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#modelBackendFilter .pill").forEach((b) => b.classList.toggle("active", b === btn));
        state.modelBackend = btn.dataset.backend;
        if (state.data) renderModelTable();
      });
    });

    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (state.data) renderTrendChart();
      });
      ro.observe(document.getElementById("chartStage"));
    } else {
      window.addEventListener("resize", () => {
        if (state.data) renderTrendChart();
      });
    }
  }

  // ---------- Boot ----------
  initTheme();
  bindControls();

  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      state.data = JSON.parse(cached);
      state.sourceLabel = "本地缓存";
      renderAll();
    }
  } catch (_) {}

  loadData(false);

  let ticks = 0;
  setInterval(() => {
    ticks += 1;
    if (state.data) {
      renderSyncStatus();
      if (ticks % 60 === 0) renderQuotaRings();
    }
    if (Date.now() >= state.nextRefreshAt && !state.loading) {
      loadData(false);
    }
  }, 1000);
})();
