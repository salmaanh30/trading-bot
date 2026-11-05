/* Autopilot: a live paper-trading bot that runs in the browser.
 *
 * Prices:   Coinbase public API (no key) — REST for history, WebSocket for live ticks.
 * Strategy: EMA 9/21 crossover, only with the trend (price above EMA 50).
 *           Stop = entry − 1.5 × ATR(14), target = entry + 3 × ATR (2R). Exit early on a cross back down.
 * Risk:     risk % of equity per trade, max position size, daily loss limit, 0.1% fee each side.
 * Claude:   reads signals.json (written + pushed by the Claude session) and shows the trade plans.
 * Broker:   optional Alpaca PAPER account; keys live only in this browser's localStorage.
 */
(() => {
  "use strict";

  const STORE = "autopilot.v1";
  const FEE = 0.001; // 0.1% per side, roughly a crypto exchange's taker fee
  const CB_REST = "https://api.exchange.coinbase.com";
  const CB_WS = "wss://ws-feed.exchange.coinbase.com";
  const ALPACA = "https://paper-api.alpaca.markets"; // paper only, on purpose
  const ALPACA_DATA = "https://data.alpaca.markets";

  const DEFAULTS = {
    settings: { riskPct: 1, dailyLossPct: 3, maxPosPct: 25, startCash: 10000, symbols: "BTC-USD, ETH-USD, SOL-USD", alpacaKey: "", alpacaSecret: "" },
    cash: 10000,
    positions: {},
    trades: [],
    log: [],
    auto: false,
  };

  // ---------- state ----------
  let S = load();
  const market = {}; // sym -> { candles: [{t,o,h,l,c,v}], price, open24 }
  let selected = null;
  let ws = null;
  let pollTimer = null;
  let renderQueued = false;

  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const s = JSON.parse(raw);
        return { ...structuredClone(DEFAULTS), ...s, settings: { ...DEFAULTS.settings, ...(s.settings || {}) } };
      }
    } catch (e) { /* storage blocked: run in memory */ }
    return structuredClone(DEFAULTS);
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ }
  }
  const symbols = () => S.settings.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const money = (n, sign = false) => {
    const s = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
    if (!sign) return (n < 0 ? "−" : "") + s;
    return (n > 0 ? "+" : n < 0 ? "−" : "") + s;
  };
  const px = (n) => {
    if (n == null || !isFinite(n)) return "–";
    const d = n >= 1000 ? 2 : n >= 1 ? 3 : 5;
    return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const pct = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(2) + "%";
  const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
  const arrow = (n) => (n > 0 ? "▲ " : n < 0 ? "▼ " : "");
  const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date().toDateString();

  function log(msg) {
    S.log.unshift({ t: Date.now(), msg });
    S.log = S.log.slice(0, 80);
    save();
    queueRender();
  }

  // ---------- indicators ----------
  function ema(values, n) {
    const k = 2 / (n + 1);
    const out = [];
    let prev;
    values.forEach((v, i) => {
      prev = i === 0 ? v : v * k + prev * (1 - k);
      out.push(i < n - 1 ? null : prev);
    });
    return out;
  }
  function atr(c, n = 14) {
    const out = [];
    let sum = 0;
    const tr = c.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - c[i - 1].c), Math.abs(b.l - c[i - 1].c))));
    tr.forEach((v, i) => {
      sum += v;
      if (i >= n) sum -= tr[i - n];
      out.push(i >= n - 1 ? sum / n : null);
    });
    return out;
  }
  function indicators(c) {
    const closes = c.map((b) => b.c);
    return { e9: ema(closes, 9), e21: ema(closes, 21), e50: ema(closes, 50), atr: atr(c) };
  }

  // The one rule set, shared by the live bot and the backtest.
  function decide(c, ind, i) {
    if (i < 51 || ind.e50[i] == null || ind.atr[i] == null) return null;
    const crossUp = ind.e9[i - 1] <= ind.e21[i - 1] && ind.e9[i] > ind.e21[i];
    const crossDown = ind.e9[i - 1] >= ind.e21[i - 1] && ind.e9[i] < ind.e21[i];
    if (crossUp && c[i].c > ind.e50[i]) {
      const entry = c[i].c;
      const a = ind.atr[i];
      return { action: "buy", entry, stop: entry - 1.5 * a, target: entry + 3 * a };
    }
    if (crossDown) return { action: "exit" };
    return null;
  }

  // ---------- account ----------
  function equity() {
    let e = S.cash;
    for (const [sym, p] of Object.entries(S.positions)) e += p.qty * (market[sym]?.price ?? p.entry);
    return e;
  }
  function todayPnl() {
    const d = today();
    let realized = S.trades.filter((t) => new Date(t.closed).toDateString() === d).reduce((a, t) => a + t.pnl, 0);
    for (const [sym, p] of Object.entries(S.positions)) {
      if (new Date(p.opened).toDateString() === d) realized += p.qty * ((market[sym]?.price ?? p.entry) - p.entry) - p.fee;
    }
    return realized;
  }
  function sizeFor(entry, stop, eq, cash, st) {
    const riskPer = entry - stop;
    if (riskPer <= 0) return 0;
    let qty = (eq * st.riskPct / 100) / riskPer;
    qty = Math.min(qty, (eq * st.maxPosPct / 100) / entry, (cash / (1 + FEE)) / entry);
    return Math.floor(qty * 1e6) / 1e6;
  }

  function openPosition(sym, sig, why) {
    if (S.positions[sym]) return;
    const st = S.settings;
    const eq = equity();
    if (todayPnl() <= -eq * st.dailyLossPct / 100) { log(`${sym}: buy signal skipped, daily loss limit hit`); return; }
    const qty = sizeFor(sig.entry, sig.stop, eq, S.cash, st);
    if (qty * sig.entry < 10) { log(`${sym}: buy signal skipped, not enough cash`); return; }
    const fee = qty * sig.entry * FEE;
    S.cash -= qty * sig.entry + fee;
    S.positions[sym] = { qty, entry: sig.entry, stop: sig.stop, target: sig.target, fee, opened: Date.now() };
    log(`BUY ${qty} ${sym} @ ${px(sig.entry)} · stop ${px(sig.stop)} · target ${px(sig.target)} (${why})`);
    save();
  }
  function closePosition(sym, price, why) {
    const p = S.positions[sym];
    if (!p) return;
    const exitFee = p.qty * price * FEE;
    S.cash += p.qty * price - exitFee;
    const pnl = p.qty * (price - p.entry) - p.fee - exitFee;
    S.trades.unshift({ sym, qty: p.qty, entry: p.entry, exit: price, pnl, why, opened: p.opened, closed: Date.now() });
    delete S.positions[sym];
    log(`SELL ${p.qty} ${sym} @ ${px(price)} (${why}) ${money(pnl, true)}`);
    save();
  }

  // ---------- live engine ----------
  function onTick(sym, price, ts) {
    const m = market[sym];
    if (!m || !isFinite(price)) return;
    const prev = m.price;
    m.price = price;
    m.dir = price > prev ? 1 : price < prev ? -1 : m.dir;
    const bucket = Math.floor(ts / 60000) * 60;
    const last = m.candles[m.candles.length - 1];
    if (!last || bucket > last.t) {
      if (last) onCandleClose(sym);
      m.candles.push({ t: bucket, o: price, h: price, l: price, c: price, v: 0 });
      if (m.candles.length > 600) m.candles.shift();
    } else {
      last.h = Math.max(last.h, price);
      last.l = Math.min(last.l, price);
      last.c = price;
    }
    const p = S.positions[sym];
    if (p) {
      if (price <= p.stop) closePosition(sym, price, "stop hit");
      else if (price >= p.target) closePosition(sym, price, "target hit");
    }
    queueRender();
  }

  function onCandleClose(sym) {
    const c = market[sym].candles;
    const ind = indicators(c);
    const sig = decide(c, ind, c.length - 1);
    if (!sig || !S.auto) return;
    if (sig.action === "buy") openPosition(sym, sig, "EMA 9 crossed above 21, above EMA 50");
    else if (sig.action === "exit" && S.positions[sym]) closePosition(sym, c[c.length - 1].c, "trend flipped");
  }

  // ---------- data feed ----------
  async function loadHistory(sym) {
    const r = await fetch(`${CB_REST}/products/${encodeURIComponent(sym)}/candles?granularity=60`);
    if (!r.ok) throw new Error(`${sym}: ${r.status}`);
    const rows = await r.json();
    const candles = rows.map(([t, l, h, o, c, v]) => ({ t, o, h, l, c, v })).sort((a, b) => a.t - b.t);
    let open24 = null;
    try {
      const s = await (await fetch(`${CB_REST}/products/${encodeURIComponent(sym)}/stats`)).json();
      open24 = parseFloat(s.open);
    } catch (e) { /* optional */ }
    market[sym] = { candles, price: candles.at(-1)?.c, open24, dir: 0 };
  }

  function setStatus(kind, text) {
    const el = $("feedStatus");
    el.className = "status " + kind;
    el.lastElementChild.textContent = text;
  }

  function connect() {
    const syms = symbols().filter((s) => market[s]);
    if (!syms.length) return;
    try { ws?.close(); } catch (e) { /* ignore */ }
    clearInterval(pollTimer);
    ws = new WebSocket(CB_WS);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", product_ids: syms, channels: ["ticker"] }));
      setStatus("live", "Live");
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "ticker") onTick(m.product_id, parseFloat(m.price), Date.parse(m.time) || Date.now());
    };
    ws.onclose = () => {
      setStatus("off", "Reconnecting…");
      startPolling(syms); // keep prices moving while the socket is down
      setTimeout(connect, 5000);
    };
    ws.onerror = () => ws.close();
  }
  function startPolling(syms) {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      syms.forEach(async (s) => {
        try {
          const t = await (await fetch(`${CB_REST}/products/${encodeURIComponent(s)}/ticker`)).json();
          onTick(s, parseFloat(t.price), Date.now());
        } catch (e) { /* offline */ }
      });
    }, 5000);
  }

  async function boot() {
    const syms = symbols();
    const results = await Promise.allSettled(syms.map(loadHistory));
    results.forEach((r, i) => { if (r.status === "rejected") log(`Couldn't load ${syms[i]} (is the symbol right? e.g. BTC-USD)`); });
    if (!selected || !market[selected]) selected = syms.find((s) => market[s]) || null;
    if (!Object.keys(market).length) { setStatus("off", "Offline"); return; }
    connect();
    queueRender();
  }

  // ---------- backtest ----------
  function backtest() {
    const st = S.settings;
    const rows = [];
    let cash = st.startCash;
    const all = [];
    for (const sym of symbols()) {
      const c = market[sym]?.candles;
      if (!c || c.length < 60) continue;
      const ind = indicators(c);
      let pos = null;
      for (let i = 51; i < c.length; i++) {
        const b = c[i];
        if (pos) { // conservative: if a bar touches both, assume the stop hit first
          let exit = null, why = "";
          if (b.l <= pos.stop) { exit = Math.min(pos.stop, b.o); why = "stop hit"; }
          else if (b.h >= pos.target) { exit = Math.max(pos.target, b.o); why = "target hit"; }
          if (exit != null) { all.push(close(pos, exit, why, sym, b.t)); pos = null; continue; }
        }
        const sig = decide(c, ind, i);
        if (!sig) continue;
        if (sig.action === "exit" && pos) { all.push(close(pos, b.c, "trend flipped", sym, b.t)); pos = null; }
        else if (sig.action === "buy" && !pos) {
          const qty = sizeFor(sig.entry, sig.stop, st.startCash, st.startCash, st);
          if (qty > 0) pos = { ...sig, qty, fee: qty * sig.entry * FEE };
        }
      }
      if (pos) all.push(close(pos, c.at(-1).c, "still open (marked)", sym, c.at(-1).t));
    }
    function close(p, exit, why, sym, t) {
      const pnl = p.qty * (exit - p.entry) - p.fee - p.qty * exit * FEE;
      return { sym, qty: p.qty, entry: p.entry, exit, why, pnl, t: t * 1000 };
    }
    all.sort((a, b) => b.t - a.t);
    const net = all.reduce((a, t) => a + t.pnl, 0);
    const wins = all.filter((t) => t.pnl > 0).length;
    cash += net;
    const fees = all.reduce((a, t) => a + t.qty * (t.entry + t.exit) * FEE, 0);
    $("btCard").hidden = false;
    $("btCard").classList.add("in");
    $("btOut").innerHTML = `
      <div class="bt-stats">
        <div class="tile"><span class="label">Trades</span><span class="num">${all.length}</span></div>
        <div class="tile"><span class="label">Win rate</span><span class="num">${all.length ? Math.round((wins / all.length) * 100) + "%" : "–"}</span></div>
        <div class="tile"><span class="label">Net P&amp;L</span><span class="num ${cls(net)}">${arrow(net)}${money(net, true)}</span></div>
        <div class="tile"><span class="label">Fees paid</span><span class="num">${money(fees)}</span></div>
      </div>
      <p class="muted small">${all.length ? `On ${money(st.startCash)} each symbol tested separately, ending ${money(cash)}. ` : "No signals in the window. "}5 hours is a tiny sample: treat this as a sanity check, not proof.</p>
      ${all.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Symbol</th><th>Entry</th><th>Exit</th><th>Why</th><th>P&amp;L</th></tr></thead><tbody>${all.map((t) => `<tr><td>${hhmm(t.t)}</td><td>${esc(t.sym)}</td><td>${px(t.entry)}</td><td>${px(t.exit)}</td><td>${esc(t.why)}</td><td class="${cls(t.pnl)}">${money(t.pnl, true)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
    $("btCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- rendering ----------
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    const st = S.settings;
    const eq = equity();
    const total = eq - st.startCash;
    $("statEquity").textContent = money(eq);
    $("statEquitySub").innerHTML = `<span class="${cls(total)}">${arrow(total)}${money(total, true)}</span> since start ${money(st.startCash)}`;
    const tp = todayPnl();
    $("statToday").className = "num " + cls(tp);
    $("statToday").textContent = money(tp, true);
    $("statLimit").textContent = `limit −${money(eq * st.dailyLossPct / 100)} · ${tp <= -eq * st.dailyLossPct / 100 ? "HIT, no new trades" : "ok"}`;
    const wins = S.trades.filter((t) => t.pnl > 0).length;
    $("statWin").textContent = S.trades.length ? Math.round((wins / S.trades.length) * 100) + "%" : "–";
    $("statTrades").textContent = `${S.trades.length} closed trade${S.trades.length === 1 ? "" : "s"}`;
    const open = Object.entries(S.positions);
    $("statOpen").textContent = open.length;
    $("statExposure").textContent = money(open.reduce((a, [s, p]) => a + p.qty * (market[s]?.price ?? p.entry), 0)) + " invested";

    const btn = $("btnAuto");
    btn.textContent = S.auto ? "Pause autopilot" : "Start autopilot";
    btn.classList.toggle("on", S.auto);

    renderTickers();
    renderChart();
    // positions
    $("posBody").innerHTML = open.map(([s, p]) => {
      const now = market[s]?.price ?? p.entry;
      const pl = p.qty * (now - p.entry) - p.fee;
      return `<tr><td>${esc(s)}</td><td>${p.qty}</td><td>${px(p.entry)}</td><td>${px(p.stop)}</td><td>${px(p.target)}</td><td class="${cls(pl)}">${arrow(pl)}${money(pl, true)}</td><td><button class="btn small" data-close="${esc(s)}">Close</button></td></tr>`;
    }).join("");
    $("posEmpty").hidden = open.length > 0;
    // trades
    $("tradeBody").innerHTML = S.trades.slice(0, 50).map((t) => `<tr><td>${hhmm(t.closed)}</td><td>${esc(t.sym)}</td><td>${t.qty}</td><td>${px(t.entry)}</td><td>${px(t.exit)}</td><td>${esc(t.why)}</td><td class="${cls(t.pnl)}">${arrow(t.pnl)}${money(t.pnl, true)}</td></tr>`).join("");
    $("tradeEmpty").hidden = S.trades.length > 0;
    // log
    const logHtml = S.log.slice(0, 40).map((l) => `<li><time>${hhmm(l.t)}</time><span>${esc(l.msg)}</span></li>`).join("") || `<li><span>Nothing yet. Press “Start autopilot” and keep this page open.</span></li>`;
    if ($("log").dataset.html !== logHtml) { $("log").innerHTML = logHtml; $("log").dataset.html = logHtml; }
  }

  function renderTickers() {
    const box = $("tickers");
    const syms = symbols().filter((s) => market[s]);
    if (box.childElementCount !== syms.length) {
      box.innerHTML = syms.map((s) => `<button class="tk" data-sym="${esc(s)}"><div class="sym"><span>${esc(s)}</span><span class="tag"></span></div><div class="px"></div><div class="chg"></div></button>`).join("");
    }
    box.querySelectorAll(".tk").forEach((el) => {
      const s = el.dataset.sym;
      const m = market[s];
      el.classList.toggle("sel", s === selected);
      const pxEl = el.querySelector(".px");
      const txt = px(m.price);
      if (pxEl.textContent !== txt) {
        pxEl.textContent = txt;
        el.classList.remove("flash-up", "flash-down");
        void el.offsetWidth;
        if (m.dir) el.classList.add(m.dir > 0 ? "flash-up" : "flash-down");
      }
      const ch = m.open24 ? ((m.price - m.open24) / m.open24) * 100 : 0;
      const chEl = el.querySelector(".chg");
      chEl.className = "chg " + cls(ch);
      chEl.textContent = m.open24 ? `${arrow(ch)}${pct(ch)} 24h` : "";
      const tag = el.querySelector(".tag");
      const inPos = !!S.positions[s];
      tag.textContent = inPos ? "IN TRADE" : trendWord(m.candles);
      tag.className = "tag" + (inPos ? " long" : "");
    });
  }
  function trendWord(c) {
    const ind = indicators(c);
    const i = c.length - 1;
    if (ind.e50[i] == null) return "warming up";
    if (ind.e9[i] > ind.e21[i] && c[i].c > ind.e50[i]) return "uptrend";
    if (ind.e9[i] < ind.e21[i] && c[i].c < ind.e50[i]) return "downtrend";
    return "choppy";
  }

  // ---------- chart ----------
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  let hoverX = null;

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function renderChart() {
    const m = market[selected];
    $("chartTitle").textContent = selected || "–";
    if (!m) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = W < 500 ? 260 : 340;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = H + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const all = m.candles;
    const ind = indicators(all);
    const n = Math.min(all.length, W < 500 ? 70 : 120);
    const start = all.length - n;
    const c = all.slice(start);
    const pos = S.positions[selected];
    let lo = Math.min(...c.map((b) => b.l)), hi = Math.max(...c.map((b) => b.h));
    if (pos) { lo = Math.min(lo, pos.stop); hi = Math.max(hi, pos.target); }
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad; hi += pad;
    const axisW = 70;
    const plotW = W - axisW;
    const step = plotW / n;
    const y = (v) => H - 20 - ((v - lo) / (hi - lo)) * (H - 30);
    const x = (i) => i * step + step / 2;

    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "rgba(244,244,248,0.45)";
    ctx.font = "11px JetBrains Mono, monospace";
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.fillText(px(v), plotW + 6, yy + 4);
    }
    for (let i = 0; i < n; i += Math.ceil(n / 5)) ctx.fillText(hhmm(c[i].t * 1000), x(i) - 16, H - 4);

    // candles
    const up = cssVar("--up"), down = cssVar("--down");
    c.forEach((b, i) => {
      const col = b.c >= b.o ? up : down;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(x(i), y(b.h)); ctx.lineTo(x(i), y(b.l)); ctx.stroke();
      const top = y(Math.max(b.o, b.c)), bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x(i) - Math.max(1, step * 0.32), top, Math.max(2, step * 0.64), bh);
      ctx.globalAlpha = 1;
    });

    // EMAs
    [["e9", "--ema1"], ["e21", "--ema2"], ["e50", "--ema3"]].forEach(([k, col]) => {
      ctx.strokeStyle = cssVar(col); ctx.lineWidth = 2; ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = ind[k][start + i];
        if (v == null) continue;
        started ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v));
        started = true;
      }
      ctx.stroke();
    });

    // position levels
    if (pos) {
      [[pos.entry, "rgba(244,244,248,.7)", "entry"], [pos.stop, down, "stop"], [pos.target, up, "target"]].forEach(([v, col, lab]) => {
        ctx.strokeStyle = col; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(plotW, y(v)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col; ctx.fillText(lab, 6, y(v) - 4);
      });
    }

    // last price
    const last = c.at(-1).c;
    ctx.fillStyle = cssVar("--accent-2");
    ctx.fillRect(plotW, y(last) - 9, axisW, 18);
    ctx.fillStyle = "#08090f";
    ctx.fillText(px(last), plotW + 6, y(last) + 4);

    // crosshair
    const tip = $("tip");
    if (hoverX != null && hoverX < plotW) {
      const i = Math.max(0, Math.min(n - 1, Math.floor(hoverX / step)));
      const b = c[i];
      ctx.strokeStyle = "rgba(255,255,255,.25)";
      ctx.beginPath(); ctx.moveTo(x(i), 0); ctx.lineTo(x(i), H - 18); ctx.stroke();
      tip.hidden = false;
      tip.innerHTML = `${hhmm(b.t * 1000)}<br>O ${px(b.o)} H ${px(b.h)}<br>L ${px(b.l)} C ${px(b.c)}`;
      const left = x(i) + 12 + 150 > W ? x(i) - 162 : x(i) + 12;
      tip.style.left = left + "px"; tip.style.top = "10px";
    } else tip.hidden = true;

    // plain-language read of the strategy right now
    const i = all.length - 1;
    const e9 = ind.e9[i], e21 = ind.e21[i], e50 = ind.e50[i];
    let msg;
    if (e50 == null) msg = "Warming up: need 50 candles before the bot can trade this.";
    else if (pos) msg = `In a trade. Exits at ${px(pos.stop)} (stop), ${px(pos.target)} (target), or if EMA 9 drops under EMA 21.`;
    else if (all[i].c <= e50) msg = `Price is under EMA 50 (${px(e50)}), so the bot won't buy: it only trades with the trend.`;
    else if (e9 > e21) msg = "Uptrend, but the bot waits for a fresh cross (EMA 9 back under 21, then over) to enter.";
    else msg = `Above EMA 50. Buy triggers when EMA 9 (${px(e9)}) closes a candle above EMA 21 (${px(e21)}).`;
    $("signalNow").textContent = (S.auto ? "Autopilot ON. " : "Autopilot off. ") + msg;
  }

  canvas.addEventListener("pointermove", (e) => { hoverX = e.offsetX; queueRender(); });
  canvas.addEventListener("pointerleave", () => { hoverX = null; queueRender(); });
  window.addEventListener("resize", queueRender);

  // ---------- Claude's signals ----------
  let plans = [];
  async function loadSignals() {
    try {
      const r = await fetch("signals.json?t=" + Date.now(), { cache: "no-store" });
      const d = await r.json();
      plans = Array.isArray(d.plans) ? d.plans : [];
      $("sigMeta").textContent = `Updated ${d.updated ? new Date(d.updated).toLocaleString() : "never"}${d.note ? " · " + d.note : ""}`;
      renderPlans();
      refreshStockQuotes();
    } catch (e) {
      $("sigMeta").textContent = "Couldn't read signals.json.";
    }
  }
  const quotes = {};
  function renderPlans() {
    const keys = !!(S.settings.alpacaKey && S.settings.alpacaSecret);
    $("plans").innerHTML = plans.map((p, idx) => {
      const r = p.entry && p.stop ? p.entry - p.stop : null;
      const rr = r && p.target ? ((p.target - p.entry) / r).toFixed(1) : "–";
      const q = quotes[p.symbol];
      return `<article class="plan">
        <h3><span>${esc(p.symbol)}</span><span class="tag ${p.side === "long" ? "long" : ""}">${esc(p.status || p.side || "plan")}</span></h3>
        <p>${esc(p.setup || "")}</p>
        <dl>
          ${q ? `<dt>Last</dt><dd>${px(q)}</dd>` : ""}
          <dt>Entry</dt><dd>${px(p.entry)}</dd>
          <dt>Stop</dt><dd class="down">${px(p.stop)}</dd>
          <dt>Target</dt><dd class="up">${px(p.target)}</dd>
          <dt>Reward : risk</dt><dd>${rr}R</dd>
        </dl>
        ${p.notes ? `<p>${esc(p.notes)}</p>` : ""}
        ${keys && p.entry && p.stop && p.target ? `<button class="btn small" data-plan="${idx}">Send to Alpaca paper</button>` : ""}
      </article>`;
    }).join("") || `<p class="empty">No plans yet. Ask Claude in the trading session to scan and post plans.</p>`;
  }

  // ---------- Alpaca (paper) ----------
  function alpacaHeaders() {
    return { "APCA-API-KEY-ID": S.settings.alpacaKey, "APCA-API-SECRET-KEY": S.settings.alpacaSecret, "Content-Type": "application/json" };
  }
  async function alpaca(path, opts = {}) {
    const r = await fetch(ALPACA + path, { ...opts, headers: alpacaHeaders() });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.message || r.status);
    return body;
  }
  let alpacaEquity = null;
  async function refreshAlpaca() {
    const out = $("alpacaOut");
    if (!S.settings.alpacaKey || !S.settings.alpacaSecret) return;
    try {
      const [acct, positions] = await Promise.all([alpaca("/v2/account"), alpaca("/v2/positions")]);
      alpacaEquity = parseFloat(acct.equity);
      const dayPl = alpacaEquity - parseFloat(acct.last_equity);
      out.className = "";
      out.innerHTML = `
        <div class="bt-stats">
          <div class="tile"><span class="label">Equity</span><span class="num">${money(alpacaEquity)}</span></div>
          <div class="tile"><span class="label">Today</span><span class="num ${cls(dayPl)}">${arrow(dayPl)}${money(dayPl, true)}</span></div>
          <div class="tile"><span class="label">Buying power</span><span class="num">${money(parseFloat(acct.buying_power))}</span></div>
          <div class="tile"><span class="label">Positions</span><span class="num">${positions.length}</span></div>
        </div>
        ${positions.length ? `<div class="table-wrap"><table><thead><tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Last</th><th>P&amp;L</th></tr></thead><tbody>${positions.map((p) => { const pl = parseFloat(p.unrealized_pl); return `<tr><td>${esc(p.symbol)}</td><td>${esc(p.qty)}</td><td>${px(+p.avg_entry_price)}</td><td>${px(+p.current_price)}</td><td class="${cls(pl)}">${arrow(pl)}${money(pl, true)}</td></tr>`; }).join("")}</tbody></table></div>` : `<p class="empty">No open Alpaca positions.</p>`}`;
    } catch (e) {
      out.className = "muted small";
      out.textContent = `Alpaca paper: ${e.message}. Check the keys are PAPER keys.`;
    }
  }
  async function refreshStockQuotes() {
    if (!S.settings.alpacaKey || !plans.length) return;
    const syms = [...new Set(plans.map((p) => p.symbol).filter((s) => s && !s.includes("-")))];
    if (!syms.length) return;
    try {
      const r = await fetch(`${ALPACA_DATA}/v2/stocks/trades/latest?feed=iex&symbols=${syms.join(",")}`, { headers: alpacaHeaders() });
      const d = await r.json();
      for (const [s, t] of Object.entries(d.trades || {})) quotes[s] = t.p;
      renderPlans();
    } catch (e) { /* quotes are optional */ }
  }
  async function sendPlan(p) {
    const eq = alpacaEquity ?? S.settings.startCash;
    const qty = p.qty || Math.floor(sizeFor(p.entry, p.stop, eq, eq, S.settings));
    if (qty < 1) { alert("Size works out under 1 share with your risk settings."); return; }
    const maxLoss = qty * (p.entry - p.stop);
    const ok = confirm(`PAPER order on Alpaca:\n\nBUY ${qty} ${p.symbol} limit ${p.entry}\nStop-loss ${p.stop} · Take-profit ${p.target}\nMax loss at stop ≈ ${money(maxLoss)}\n\nSend it?`);
    if (!ok) return;
    try {
      const o = await alpaca("/v2/orders", {
        method: "POST",
        body: JSON.stringify({
          symbol: p.symbol, qty: String(qty), side: "buy", type: "limit", limit_price: String(p.entry), time_in_force: "day",
          order_class: "bracket", take_profit: { limit_price: String(p.target) }, stop_loss: { stop_price: String(p.stop) },
        }),
      });
      log(`Alpaca paper: sent BUY ${qty} ${p.symbol} bracket (${o.status})`);
      refreshAlpaca();
    } catch (e) {
      log(`Alpaca paper order failed: ${e.message}`);
    }
  }

  // ---------- UI wiring ----------
  $("tickers").addEventListener("click", (e) => {
    const b = e.target.closest(".tk");
    if (b) { selected = b.dataset.sym; queueRender(); }
  });
  $("posBody").addEventListener("click", (e) => {
    const s = e.target.closest("[data-close]")?.dataset.close;
    if (s) closePosition(s, market[s]?.price ?? S.positions[s].entry, "closed by you");
  });
  $("plans").addEventListener("click", (e) => {
    const i = e.target.closest("[data-plan]")?.dataset.plan;
    if (i != null) sendPlan(plans[+i]);
  });
  $("btnAuto").addEventListener("click", () => {
    S.auto = !S.auto;
    log(S.auto ? "Autopilot started. It trades while this page stays open." : "Autopilot paused. Open positions keep their stops and targets.");
    save();
  });
  $("btnBacktest").addEventListener("click", backtest);
  $("btnSignals").addEventListener("click", loadSignals);

  const form = $("settings");
  function fillForm() { for (const [k, v] of Object.entries(S.settings)) if (form.elements[k]) form.elements[k].value = v; }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = form.elements;
    const oldSyms = S.settings.symbols;
    S.settings = {
      riskPct: +f.riskPct.value || 1, dailyLossPct: +f.dailyLossPct.value || 3, maxPosPct: +f.maxPosPct.value || 25,
      startCash: +f.startCash.value || 10000, symbols: f.symbols.value || DEFAULTS.settings.symbols,
      alpacaKey: f.alpacaKey.value.trim(), alpacaSecret: f.alpacaSecret.value.trim(),
    };
    save();
    log("Settings saved.");
    if (S.settings.symbols !== oldSyms) boot();
    refreshAlpaca();
    loadSignals();
  });
  $("btnReset").addEventListener("click", () => {
    if (!confirm("Wipe the simulated account (cash, positions, trades)? Settings and keys stay.")) return;
    S = { ...structuredClone(DEFAULTS), settings: S.settings, cash: S.settings.startCash };
    log(`Paper account reset to ${money(S.cash)}.`);
    save();
  });

  // scroll reveal
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } }), { threshold: 0.08 }) : null;
  document.querySelectorAll(".reveal").forEach((el, i) => { el.style.transitionDelay = (i % 3) * 70 + "ms"; io ? io.observe(el) : el.classList.add("in"); });

  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

  fillForm();
  render();
  boot();
  loadSignals();
  refreshAlpaca();
  setInterval(refreshAlpaca, 30000);
  setInterval(loadSignals, 120000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && ws && ws.readyState > 1) connect(); });
})();
