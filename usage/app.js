(() => {
  "use strict";

  const DEFAULT_GIST_ID = "63b3c03789dd8ff3a41c24f9b1c6dc00";
  const GIST_OWNER = "phylipppp-zzy";
  const GIST_FILE = "usage-data.json";
  const CACHE_KEY = "ai_usage_dashboard_snapshot_v1";
  const THEME_KEY = "ai_usage_dashboard_theme";
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
    const units = [["B", 1e9], ["M", 1e6], ["K", 1e3]];
    for (const [u, s] of units) {
      if (n >= s) {
        const val = (n / s).toFixed(n / s >= 100 ? 0 : 1).replace(/\.0$/, "");
        return val + u;
      }
    }
    return String(Math.round(n));
  }

  function fmtInt(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "--";
    return Math.round(n).toLocaleString("en-US");
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

  function fmtShortMetric(metric, v) {
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
    const opts = {
      timeZone: "Asia/Shanghai",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    };
    if (withDate) {
      opts.month = "2-digit";
      opts.day = "2-digit";
    }
    return new Intl.DateTimeFormat("zh-CN", opts).format(d).replace(/\//g, "-");
  }

  function fmtCountdown(iso) {
    if (!iso) return null;
    const target = new Date(iso).getTime();
    if (Number.isNaN(target)) return null;
    const diffSec = Math.floor((target - Date.now()) / 1000);
    if (diffSec <= 0) return "即将重置";
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    if (days > 0) return `${days}天 ${hours}小时后重置`;
    if (hours > 0) return `${hours}小时 ${mins}分后重置`;
    return `${Math.max(1, mins)}分钟后重置`;
  }

  function fmtAge(iso) {
    if (!iso) return { text: "未知时间", level: "stale" };
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) return { text: "未知时间", level: "stale" };
    const mins = Math.max(0, Math.floor((Date.now() - ts) / 60000));
    const clock = fmtBjTime(iso, false);
    let ageStr = mins < 1 ? "刚刚" : mins < 60 ? `${mins} 分钟前` : `${Math.floor(mins / 60)} 小时 ${mins % 60} 分前`;
    const level = mins <= 20 ? "fresh" : mins <= 60 ? "delayed" : "stale";
    const prefix = level === "fresh" ? "实时同步" : level === "delayed" ? "同步稍有延迟" : "长时间未同步";
    return { text: `${prefix} · ${clock} (${ageStr})`, level };
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- Theme ----------
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const sun = document.getElementById("themeIconSun");
    const moon = document.getElementById("themeIconMoon");
    if (sun && moon) {
      sun.style.display = theme === "dark" ? "none" : "block";
      moon.style.display = theme === "dark" ? "block" : "none";
    }
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      applyTheme(saved);
    } else {
      const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      applyTheme(dark ? "dark" : "light");
    }
    document.getElementById("themeBtn").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      const next = cur === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
  }

  // ---------- Data Fetching ----------
  async function fetchSnapshot() {
    // Primary: GitHub Gist API (instant freshness, no Fastly CDN lag)
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
    } catch (_) {
      // Fallback below
    }

    // Fallback: Raw Gist URL (exempt from API 60/hr limit)
    const rawUrl = `https://gist.githubusercontent.com/${GIST_OWNER}/${gistId}/raw/${GIST_FILE}?t=${Date.now()}`;
    const rawRes = await fetch(rawUrl, { cache: "no-store" });
    if (!rawRes.ok) {
      throw new Error(`HTTP ${rawRes.status}`);
    }
    return { data: await rawRes.json(), source: "Gist Raw" };
  }

  async function loadData(isManual = false) {
    if (state.loading) return;
    state.loading = true;
    const btn = document.getElementById("refreshBtn");
    btn.classList.add("loading");
    if (isManual) document.getElementById("refreshLabel").textContent = "同步中…";

    try {
      const { data, source } = await fetchSnapshot();
      state.data = data;
      state.sourceLabel = source;
      state.nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      } catch (_) {}
      hideNotice();
      renderAll();
    } catch (err) {
      showNotice(`无法拉取最新快照（${err.message || "网络异常"}），${state.data ? "当前展示本地缓存数据" : "请检查网络后重试"}。`);
    } finally {
      state.loading = false;
      btn.classList.remove("loading");
      document.getElementById("refreshLabel").textContent = "刷新";
    }
  }

  function showNotice(msg) {
    const el = document.getElementById("noticeBanner");
    document.getElementById("noticeText").textContent = msg;
    el.hidden = false;
  }

  function hideNotice() {
    document.getElementById("noticeBanner").hidden = true;
  }

  // ---------- Render: Sync Pill & Countdown ----------
  function renderSyncStatus() {
    if (!state.data) return;
    const { text, level } = fmtAge(state.data.generated_at);
    const dot = document.getElementById("syncDot");
    const txt = document.getElementById("syncText");
    dot.className = "sync-dot " + level;
    txt.textContent = text;

    const remMs = Math.max(0, state.nextRefreshAt - Date.now());
    const remMin = Math.floor(remMs / 60000);
    const remSec = Math.floor((remMs % 60000) / 1000);
    document.getElementById("nextRefreshMeta").textContent =
      `自动刷新倒计时：${String(remMin).padStart(2, "0")}:${String(remSec).padStart(2, "0")}`;

    const footerMeta = document.getElementById("footerMeta");
    footerMeta.textContent = `快照生成时间：${fmtBjTime(state.data.generated_at, true)}（北京时间） · 数据通道：${state.sourceLabel || "本地缓存"} · Schema v${state.data.schema_version || 1}`;
  }

  // ---------- Render: Quota Command Deck ----------
  function quotaHealthClass(rem) {
    if (rem === null || rem === undefined) return "";
    if (rem < 15) return "critical";
    if (rem < 35) return "caution";
    return "healthy";
  }

  function renderWindowRow(w) {
    const rem = w.remaining_percent;
    const pctText = rem === null || rem === undefined ? "未知" : `${Number(rem).toFixed(1)}%`;
    const widthPct = rem === null || rem === undefined ? 0 : Math.max(0, Math.min(100, Number(rem)));
    const cls = quotaHealthClass(rem);
    const cd = fmtCountdown(w.resets_at);
    const resetText = w.resets_at ? `${cd} · ${fmtBjTime(w.resets_at, true)}` : "无固定重置时间 / 满额";

    // Clean concise label when grouped
    let label = w.label || "额度";
    if (w.group && label.startsWith(w.group + " ")) {
      label = label.slice(w.group.length + 1);
    }

    return `
      <div class="win-item">
        <div class="win-top">
          <span class="win-label">${esc(label)}</span>
          <span class="win-pct ${cls}">剩 ${esc(pctText)}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${cls}" style="width:${widthPct}%"></div>
        </div>
        <div class="win-reset">${esc(resetText)}</div>
      </div>
    `;
  }

  function renderQuotaDeck() {
    const grid = document.getElementById("quotaGrid");
    const backends = state.data.backends || [];
    grid.innerHTML = backends.map((b) => {
      const q = b.quota || {};
      const wins = q.windows || [];
      let badgeHtml = `<span class="status-badge">实时在线</span>`;
      if (b.status === "local_only") {
        badgeHtml = `<span class="status-badge local-only">仅本地日志</span>`;
      } else if (b.status === "unavailable") {
        badgeHtml = `<span class="status-badge warn">暂不可用</span>`;
      } else if (q.stale) {
        badgeHtml = `<span class="status-badge warn">额度缓存偏旧</span>`;
      }

      let bodyHtml = "";
      if (wins.length > 0) {
        // Group windows if multiple groups exist (e.g. Antigravity: Gemini + Claude/GPT)
        const groups = new Map();
        for (const w of wins) {
          const g = w.group || b.name;
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(w);
        }
        const showGroupHeader = groups.size > 1;
        bodyHtml = `<div class="quota-windows">` + Array.from(groups.entries()).map(([gName, gWins]) => {
          return (showGroupHeader ? `<div class="quota-group-label">${esc(gName)}</div>` : "") +
            gWins.map(renderWindowRow).join("");
        }).join("") + `</div>`;
      } else {
        const cycleCd = q.cycle_reset ? fmtCountdown(q.cycle_reset) : null;
        const cycleLine = q.cycle_reset
          ? `当前周期重置：${fmtBjTime(q.cycle_reset, true)}（${cycleCd}）`
          : "未获取到在线额度窗口";
        const ruleLine = q.cycle_rule ? `规则：${q.cycle_rule}` : "本地用量与历史周期统计正常记录中";
        bodyHtml = `
          <div class="quota-empty-box">
            <strong>在线额度未连通</strong>
            <span>${esc(cycleLine)}</span>
            <span style="color:var(--text-muted)">${esc(ruleLine)}</span>
          </div>
        `;
      }

      const today = b.today || {};
      const d7 = b.d7 || {};
      return `
        <article class="card quota-card theme-${esc(b.id)}">
          <div>
            <div class="quota-head">
              <div class="backend-identity">
                <span class="backend-dot"></span>
                <span class="backend-name">${esc(b.name)}</span>
              </div>
              ${badgeHtml}
            </div>
          </div>
          ${bodyHtml}
          <div class="quota-foot">
            <div class="qfoot-item">
              <span class="qfoot-label">今日费用</span>
              <span class="qfoot-val">${fmtUsd(today.cost_usd)}</span>
            </div>
            <div class="qfoot-item">
              <span class="qfoot-label">今日 Token</span>
              <span class="qfoot-val">${fmtTokens(today.total_tokens)}</span>
            </div>
            <div class="qfoot-item">
              <span class="qfoot-label">近 7 天费用</span>
              <span class="qfoot-val">${fmtUsd(d7.cost_usd)}</span>
            </div>
          </div>
        </article>
      `;
    }).join("");
  }

  // ---------- Render: KPI Strip ----------
  function renderKpiStrip() {
    const summary = state.data.summary || {};
    const cur = summary[state.kpiRange] || {};
    const yesterday = summary.yesterday || {};

    let costSubHtml = "";
    if (state.kpiRange === "today") {
      const yCost = Number(yesterday.cost_usd || 0);
      const tCost = Number(cur.cost_usd || 0);
      if (yCost > 0) {
        const diffPct = ((tCost - yCost) / yCost) * 100;
        const cls = diffPct > 5 ? "up" : diffPct < -5 ? "down" : "";
        const sign = diffPct >= 0 ? "+" : "";
        costSubHtml = `<span class="delta-pill ${cls}">${sign}${diffPct.toFixed(0)}% vs 昨日</span><span>昨日 ${fmtUsd(yCost)}</span>`;
      } else {
        costSubHtml = `<span>昨日 ${fmtUsd(yCost)}</span>`;
      }
    } else if (state.kpiRange === "d7") {
      costSubHtml = `<span>日均 ${fmtUsd((cur.cost_usd || 0) / 7)}</span>`;
    } else {
      costSubHtml = `<span>日均 ${fmtUsd((cur.cost_usd || 0) / 30)}</span>`;
    }

    const totalTok = Number(cur.total_tokens || 0);
    const cachedTok = Number(cur.cached || 0);
    const outputTok = Number(cur.output || 0);
    const freshTok = Math.max(0, totalTok - cachedTok - outputTok);
    const pCached = totalTok > 0 ? (cachedTok / totalTok) * 100 : 0;
    const pFresh = totalTok > 0 ? (freshTok / totalTok) * 100 : 0;
    const pOut = totalTok > 0 ? (outputTok / totalTok) * 100 : 0;

    // Count active models in selected range
    const modelKey = state.kpiRange === "today" ? "models_today" : state.kpiRange === "d7" ? "models_7d" : "models_30d";
    const activeModels = new Set();
    for (const b of state.data.backends || []) {
      for (const m of b[modelKey] || []) {
        if (m.requests > 0 || m.total_tokens > 0) activeModels.add(`${b.id}:${m.model}`);
      }
    }

    const reasoningNote = cur.reasoning > 0 ? `含推理 ${fmtTokens(cur.reasoning)}` : `输出 ${fmtTokens(outputTok)}`;

    document.getElementById("kpiGrid").innerHTML = `
      <div class="card kpi-card">
        <div class="kpi-label"><span>API 等价估算费用</span></div>
        <div class="kpi-value">${fmtUsd(cur.cost_usd)}</div>
        <div class="kpi-sub">${costSubHtml}</div>
      </div>

      <div class="card kpi-card">
        <div class="kpi-label"><span>Token 总消耗</span><span>输出 ${fmtTokens(outputTok)}</span></div>
        <div class="kpi-value">${fmtTokens(totalTok)}</div>
        <div class="token-split-bar" title="缓存 ${pCached.toFixed(1)}% · 新输入 ${pFresh.toFixed(1)}% · 输出 ${pOut.toFixed(1)}%">
          <span class="split-cached" style="width:${pCached}%"></span>
          <span class="split-fresh" style="width:${pFresh}%"></span>
          <span class="split-output" style="width:${pOut}%"></span>
        </div>
        <div class="kpi-sub"><span>缓存 ${fmtTokens(cachedTok)}</span><span>· 新输入 ${fmtTokens(freshTok)}</span></div>
      </div>

      <div class="card kpi-card">
        <div class="kpi-label"><span>Prompt 缓存命中率</span></div>
        <div class="kpi-value">${fmtPct(cur.cache_hit_ratio)}</div>
        <div class="kpi-sub"><span>复用 ${fmtTokens(cachedTok)} tokens</span></div>
      </div>

      <div class="card kpi-card">
        <div class="kpi-label"><span>总调用次数</span></div>
        <div class="kpi-value">${fmtInt(cur.requests)}</div>
        <div class="kpi-sub"><span>${activeModels.size} 个活跃模型</span><span>· ${reasoningNote}</span></div>
      </div>
    `;
  }

  // ---------- Render: Interactive Stacked Trend Chart (Pure SVG) ----------
  function buildContinuousSeries() {
    const backends = state.data.backends || [];
    const span = state.trendSpan;
    const metric = state.trendMetric;
    const filter = state.trendBackend;
    const activeIds = filter === "all" ? ["codex", "antigravity", "claude"] : [filter];

    const now = new Date(state.data.generated_at || Date.now());
    const slots = [];

    if (span === "24h") {
      // Build 24 continuous Beijing hours ending at current hour
      const bjNowMs = now.getTime() + 8 * 3600 * 1000;
      const bjHourEnd = Math.floor(bjNowMs / 3600000) * 3600000;
      for (let i = 23; i >= 0; i--) {
        const ms = bjHourEnd - i * 3600000;
        const d = new Date(ms);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:00:00+08:00`;
        const shortLabel = `${String(d.getUTCHours()).padStart(2, "0")}:00`;
        const fullLabel = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${shortLabel}`;
        slots.push({ key, shortLabel, fullLabel, values: { codex: 0, antigravity: 0, claude: 0 }, total: 0 });
      }
      const slotMap = new Map(slots.map((s) => [s.key, s]));
      for (const b of backends) {
        if (!activeIds.includes(b.id)) continue;
        for (const item of b.hourly_24h || []) {
          const slot = slotMap.get(item.ts);
          if (slot) {
            const val = Number(item[metric] || 0);
            slot.values[b.id] += val;
            slot.total += val;
          }
        }
      }
    } else {
      const daysCount = span === "7d" ? 7 : 30;
      const bjNowMs = now.getTime() + 8 * 3600 * 1000;
      const bjDayEnd = Math.floor(bjNowMs / 86400000) * 86400000;
      for (let i = daysCount - 1; i >= 0; i--) {
        const ms = bjDayEnd - i * 86400000;
        const d = new Date(ms);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        const shortLabel = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        slots.push({ key, shortLabel, fullLabel: key, values: { codex: 0, antigravity: 0, claude: 0 }, total: 0 });
      }
      const slotMap = new Map(slots.map((s) => [s.key, s]));
      for (const b of backends) {
        if (!activeIds.includes(b.id)) continue;
        for (const item of b.daily_30d || []) {
          const slot = slotMap.get(item.date);
          if (slot) {
            const val = Number(item[metric] || 0);
            slot.values[b.id] += val;
            slot.total += val;
          }
        }
      }
    }
    return { slots, activeIds };
  }

  function renderTrendChart() {
    const svg = document.getElementById("trendSvg");
    const tooltip = document.getElementById("chartTooltip");
    tooltip.hidden = true;

    const spanText = state.trendSpan === "24h" ? "最近 24 小时（按小时）" : state.trendSpan === "7d" ? "近 7 天（按天）" : "近 30 天（按天）";
    document.getElementById("chartSubtitle").textContent = `${spanText}各后端消耗趋势 · 悬停或点击柱条查看明细`;

    const { slots, activeIds } = buildContinuousSeries();
    const totalSum = slots.reduce((acc, s) => acc + s.total, 0);
    const activeCount = slots.filter((s) => s.total > 0).length;
    const peakSlot = slots.reduce((best, s) => (s.total > (best ? best.total : -1) ? s : best), null);

    document.getElementById("chartStats").innerHTML = `
      <span>区间合计 <strong>${fmtMetric(state.trendMetric, totalSum)}</strong></span>
      <span>峰值 <strong>${peakSlot && peakSlot.total > 0 ? `${fmtShortMetric(state.trendMetric, peakSlot.total)} (${peakSlot.shortLabel})` : "--"}</strong></span>
      <span>活跃时段 <strong>${activeCount}/${slots.length}</strong></span>
    `;

    const W = 920;
    const H = 270;
    const padL = 56;
    const padR = 14;
    const padT = 16;
    const padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const maxVal = Math.max(1e-9, ...slots.map((s) => s.total));
    const yTicks = 4;

    const parts = [];
    // Grid lines & Y axis labels
    for (let i = 0; i <= yTicks; i++) {
      const ratio = i / yTicks;
      const y = padT + plotH * (1 - ratio);
      const val = maxVal * ratio;
      parts.push(`<line class="grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`);
      parts.push(`<text class="axis-label" x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(fmtShortMetric(state.trendMetric, val))}</text>`);
    }

    const n = slots.length;
    const step = plotW / n;
    const barW = Math.max(6, Math.min(34, step * 0.62));
    const labelEvery = n > 20 ? 4 : n > 12 ? 2 : 1;

    slots.forEach((slot, idx) => {
      const cx = padL + step * idx + step / 2;
      const x = cx - barW / 2;
      let curY = padT + plotH;

      // Stack bars bottom-up
      for (const bid of activeIds) {
        const v = slot.values[bid] || 0;
        if (v <= 0) continue;
        const h = Math.max(2, (v / maxVal) * plotH);
        curY -= h;
        parts.push(
          `<rect x="${x.toFixed(1)}" y="${curY.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" fill="${BACKEND_COLORS[bid]}"/>`
        );
      }

      // X axis label
      if (idx % labelEvery === 0 || idx === n - 1) {
        parts.push(
          `<text class="axis-label" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(slot.shortLabel)}</text>`
        );
      }

      // Invisible interactive hit target
      parts.push(
        `<rect class="bar-hit" data-idx="${idx}" x="${(padL + step * idx).toFixed(1)}" y="${padT}" width="${step.toFixed(1)}" height="${plotH}"/>`
      );
    });

    svg.innerHTML = parts.join("");

    // Tooltip interaction
    const stage = document.getElementById("chartStage");
    function showTooltip(idx, clientX) {
      const slot = slots[idx];
      if (!slot) return;
      const rowsHtml = activeIds.map((bid) => `
        <div class="tt-row">
          <span class="tt-name"><span class="chip-dot dot-${bid}"></span>${BACKEND_LABELS[bid]}</span>
          <span>${fmtMetric(state.trendMetric, slot.values[bid] || 0)}</span>
        </div>
      `).join("");

      tooltip.innerHTML = `
        <div class="tt-title">${esc(slot.fullLabel)}</div>
        ${rowsHtml}
        ${activeIds.length > 1 ? `<div class="tt-row tt-total"><span>合计</span><span>${fmtMetric(state.trendMetric, slot.total)}</span></div>` : ""}
      `;
      tooltip.hidden = false;

      const rect = stage.getBoundingClientRect();
      const relX = clientX - rect.left;
      const ttW = tooltip.offsetWidth || 190;
      const left = relX + 14 + ttW > rect.width ? Math.max(6, relX - ttW - 14) : relX + 14;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `12px`;
    }

    svg.querySelectorAll(".bar-hit").forEach((el) => {
      el.addEventListener("mouseenter", (e) => showTooltip(Number(el.dataset.idx), e.clientX));
      el.addEventListener("mousemove", (e) => showTooltip(Number(el.dataset.idx), e.clientX));
      el.addEventListener("click", (e) => showTooltip(Number(el.dataset.idx), e.clientX));
    });
    stage.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
    });
  }

  // ---------- Render: Model Leaderboard ----------
  function renderModelTable() {
    const rangeName = state.kpiRange === "today" ? "今日" : state.kpiRange === "d7" ? "近 7 天" : "近 30 天";
    document.getElementById("modelSubtitle").textContent = `当前范围：${rangeName} · 按 API 等价估算费用降序排列`;

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
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">当前筛选范围内暂无模型调用记录</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((r) => {
      const share = totalCost > 0 ? (Number(r.cost_usd || 0) / totalCost) * 100 : 0;
      return `
        <tr>
          <td>
            <div class="model-cell">
              <span class="backend-tag ${esc(r.backendId)}">${esc(r.backendName)}</span>
              <span class="model-name">${esc(r.model)}</span>
            </div>
          </td>
          <td class="num"><strong>${fmtUsd(r.cost_usd)}</strong></td>
          <td class="bar-col">
            <div class="share-bar-wrap">
              <div class="share-track">
                <div class="share-fill" style="width:${Math.max(share > 0 ? 2 : 0, share)}%;background:${BACKEND_COLORS[r.backendId]}"></div>
              </div>
              <span class="share-pct">${share.toFixed(1)}%</span>
            </div>
          </td>
          <td class="num">${fmtInt(r.requests)}</td>
          <td class="num">${fmtTokens(r.total_tokens)}</td>
          <td class="num">${fmtTokens(r.output)}</td>
          <td class="num">${fmtPct(r.cache_hit_ratio)}</td>
        </tr>
      `;
    }).join("");
  }

  // ---------- Render: Claude Billing Cycles ----------
  function renderClaudeCycles() {
    const grid = document.getElementById("cyclesGrid");
    const cycles = state.data.claude_cycles || [];
    if (cycles.length === 0) {
      grid.innerHTML = `<div class="card empty-state" style="grid-column:1/-1">暂无 Claude 历史计费周期数据</div>`;
      return;
    }

    // Show newest cycle first
    const ordered = [...cycles].reverse();
    grid.innerHTML = ordered.map((c) => {
      const tagClass = c.current ? "cycle-tag current" : "cycle-tag";
      const tagLabel = c.current ? "当前周期" : c.partial ? "部分记录" : "完整周期";
      const siteText = c.site_cost_usd !== null && c.site_cost_usd !== undefined ? fmtUsd(c.site_cost_usd) : "无网站快照";

      const topModels = (c.models || []).slice(0, 4).map((m) => `
        <div class="cycle-model-row">
          <span class="cycle-model-name">${esc(m.model)}</span>
          <span>${fmtUsd(m.site_cost_usd ?? m.local_cost_usd)} · ${fmtTokens(m.total_tokens)}</span>
        </div>
      `).join("");

      return `
        <article class="card cycle-card">
          <div class="cycle-head">
            <span class="cycle-period">${esc(c.period)}</span>
            <span class="${tagClass}">${tagLabel}</span>
          </div>
          <div class="cycle-metrics">
            <div>
              <div class="cm-label">本机估算费用</div>
              <div class="cm-val">${fmtUsd(c.local_cost_usd)}</div>
            </div>
            <div>
              <div class="cm-label">网站记录费用</div>
              <div class="cm-val">${siteText}</div>
            </div>
            <div>
              <div class="cm-label">总调用数</div>
              <div class="cm-val">${fmtInt(c.total_requests)}</div>
            </div>
            <div>
              <div class="cm-label">总 Token</div>
              <div class="cm-val">${fmtTokens(c.total_tokens)}</div>
            </div>
          </div>
          <div class="cycle-models">
            ${topModels || `<div class="cycle-model-row" style="color:var(--text-muted)">无模型明细</div>`}
          </div>
        </article>
      `;
    }).join("");
  }

  function renderAll() {
    if (!state.data) return;
    renderSyncStatus();
    renderQuotaDeck();
    renderKpiStrip();
    renderTrendChart();
    renderModelTable();
    renderClaudeCycles();
  }

  // ---------- Event Binding ----------
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
          renderKpiStrip();
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
        if (state.data) renderTrendChart();
      });
    });

    document.querySelectorAll("#trendMetricGroup .seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#trendMetricGroup .seg-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-selected", String(b === btn));
        });
        state.trendMetric = btn.dataset.metric;
        if (state.data) renderTrendChart();
      });
    });

    document.querySelectorAll("#backendFilterGroup .chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#backendFilterGroup .chip").forEach((b) => b.classList.toggle("active", b === btn));
        state.trendBackend = btn.dataset.backend;
        if (state.data) renderTrendChart();
      });
    });

    document.querySelectorAll("#modelBackendFilter .chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#modelBackendFilter .chip").forEach((b) => b.classList.toggle("active", b === btn));
        state.modelBackend = btn.dataset.backend;
        if (state.data) renderModelTable();
      });
    });
  }

  // ---------- Init ----------
  initTheme();
  bindControls();

  // Render cached snapshot immediately if available for instant paint
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      state.data = JSON.parse(cached);
      state.sourceLabel = "本地缓存";
      renderAll();
    }
  } catch (_) {}

  loadData(false);

  // Live countdown ticker (every second for refresh countdown, re-renders quota countdowns every minute)
  let tickCount = 0;
  setInterval(() => {
    tickCount += 1;
    if (state.data) {
      renderSyncStatus();
      if (tickCount % 60 === 0) {
        renderQuotaDeck();
      }
    }
    if (Date.now() >= state.nextRefreshAt && !state.loading) {
      loadData(false);
    }
  }, 1000);
})();
