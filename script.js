/* Autopilot: a live paper-trading app that runs in the browser.
 *
 * Prices:   Coinbase public API (no key): REST for history + 24h stats, WebSocket for live ticks.
 * Strategy: EMA 9/21 crossover, only with the trend (price above EMA 50).
 *           Stop = entry − 1.5 × ATR(14), target = entry + 3 × ATR (2R). Exit early on a cross back down.
 * Risk:     risk % of equity per trade, max position size, daily loss limit, 0.1% fee each side.
 * Coach:    rule-based insights (good / bad / watch) that update live; optional Claude chat with
 *           the user's own Anthropic key (kept in this browser only).
 * Claude:   reads signals.json, written by the Claude trading session, and reviews each plan.
 * Broker:   optional Alpaca PAPER account; keys live only in this browser's localStorage.
 */
(() => {
  "use strict";

  const STORE = "autopilot.v1";
  const FEE = 0.001; // 0.1% per side
  const CB_REST = "https://api.exchange.coinbase.com";
  const CB_WS = "wss://ws-feed.exchange.coinbase.com";
  const ALPACA = "https://paper-api.alpaca.markets"; // paper only, on purpose
  const ALPACA_DATA = "https://data.alpaca.markets";
  const TF_NAME = { 60: "1m", 300: "5m", 900: "15m" };

  const DEFAULTS = {
    settings: { riskPct: 1, dailyLossPct: 3, maxPosPct: 50, startCash: 28, symbols: "BTC-USD, ETH-USD, SOL-USD, PAXG-USD", tf: 300, alpacaKey: "", alpacaSecret: "", anthropicKey: "" },
    v: 3,
    signals: [],
    cash: 28,
    positions: {},
    trades: [],
    log: [],
    eqHist: [],
    auto: false,
  };

  // ---------- state ----------
  let S = load();
  const market = {}; // sym -> { candles, price, stats, dir }
  let selected = null;
  let ws = null, pollTimer = null, reconnectTimer = null;
  let renderQueued = false;
  let fng = null; // [{value, label, t}]
  let btSummary = null;
  let plans = [];
  let sigInfo = {};
  const quotes = {};
  let alpacaEquity = null;
  let insights = [];
  let verdict = { lvl: "watch", title: "Reading the market…" };

  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const s = JSON.parse(raw);
        const st = { ...structuredClone(DEFAULTS), ...s, settings: { ...DEFAULTS.settings, ...(s.settings || {}) } };
        if (s.v !== DEFAULTS.v) {
          if (!(s.v >= 2)) { // v2: the account moved to a $28 budget, so start it fresh at $28
            Object.assign(st.settings, { startCash: DEFAULTS.settings.startCash, maxPosPct: DEFAULTS.settings.maxPosPct });
            Object.assign(st, { cash: DEFAULTS.cash, positions: {}, trades: [], eqHist: [] });
          }
          if (!/PAXG-USD/i.test(st.settings.symbols)) st.settings.symbols += ", PAXG-USD"; // v3: gold joins the bot
          st.v = DEFAULTS.v;
          try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) { /* ignore */ }
        }
        return st;
      }
    } catch (e) { /* storage blocked: run in memory */ }
    return structuredClone(DEFAULTS);
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } }
  const symbols = () => S.settings.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const tf = () => +S.settings.tf || 300;

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const money = (n, sign = false) => {
    if (n == null || !isFinite(n)) return "–";
    const s = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
    if (!sign) return (n < 0 ? "−" : "") + s;
    return (n > 0 ? "+" : n < 0 ? "−" : "") + s;
  };
  const px = (n) => {
    if (n == null || !isFinite(n)) return "–";
    const d = n >= 1000 ? 2 : n >= 1 ? 3 : 5;
    return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  const pct = (n, d = 2) => (n == null || !isFinite(n) ? "–" : (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(d) + "%");
  const compact = (n) => (n == null ? "–" : Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n));
  const cls = (n) => (n > 0 ? "up" : n < 0 ? "down" : "");
  const arrow = (n) => (n > 0 ? "▲ " : n < 0 ? "▼ " : "");
  const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => new Date().toDateString();
  const coin = (sym) => (sym === "PAXG-USD" ? "GOLD" : sym.split("-")[0]);
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const dur = (mins) => (mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h` : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`);

  function log(msg) {
    S.log.unshift({ t: Date.now(), msg });
    S.log = S.log.slice(0, 100);
    save();
    queueRender();
  }

  // ---------- indicators ----------
  function ema(values, n) {
    const k = 2 / (n + 1);
    let prev;
    return values.map((v, i) => { prev = i === 0 ? v : v * k + prev * (1 - k); return i < n - 1 ? null : prev; });
  }
  function atr(c, n = 14) {
    const tr = c.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - c[i - 1].c), Math.abs(b.l - c[i - 1].c))));
    let sum = 0;
    return tr.map((v, i) => { sum += v; if (i >= n) sum -= tr[i - n]; return i >= n - 1 ? sum / n : null; });
  }
  function rsi(v, n = 14) {
    const out = new Array(v.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i < v.length; i++) {
      const d = v[i] - v[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
      else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    }
    return out;
  }
  function indicators(c) {
    const closes = c.map((b) => b.c);
    return { e9: ema(closes, 9), e21: ema(closes, 21), e50: ema(closes, 50), atr: atr(c), rsi: rsi(closes) };
  }

  // The one rule set, shared by the live bot and the backtest.
  function decide(c, ind, i) {
    if (i < 51 || ind.e50[i] == null || ind.atr[i] == null) return null;
    const crossUp = ind.e9[i - 1] <= ind.e21[i - 1] && ind.e9[i] > ind.e21[i];
    const crossDown = ind.e9[i - 1] >= ind.e21[i - 1] && ind.e9[i] < ind.e21[i];
    if (crossUp && c[i].c > ind.e50[i]) {
      const entry = c[i].c, a = ind.atr[i];
      return { action: "buy", entry, stop: entry - 1.5 * a, target: entry + 3 * a };
    }
    if (crossDown) return { action: "exit" };
    return null;
  }

  // Everything the coach and the markets table need for one symbol.
  function metrics(sym) {
    const m = market[sym];
    if (!m || m.candles.length < 60) return null;
    const c = m.candles, ind = indicators(c), i = c.length - 1, price = m.price ?? c[i].c;
    const e9 = ind.e9[i], e21 = ind.e21[i], e50 = ind.e50[i], a = ind.atr[i], r = ind.rsi[i];
    const trend = e9 > e21 && price > e50 ? "up" : e9 < e21 && price < e50 ? "down" : "chop";
    const vol = (from, to) => { const s = c.slice(from, to); return s.reduce((x, b) => x + b.v, 0) / Math.max(1, s.length); };
    const volRatio = vol(i - 5, i) / (vol(i - 55, i - 5) || 1); // last 5 closed candles vs the 50 before
    let crosses = 0;
    for (let k = Math.max(1, i - 60); k <= i; k++) if (ind.e9[k - 1] != null && ind.e21[k - 1] != null && Math.sign(ind.e9[k] - ind.e21[k]) !== Math.sign(ind.e9[k - 1] - ind.e21[k - 1])) crosses++;
    const mom = ((price - c[Math.max(0, i - 20)].c) / c[Math.max(0, i - 20)].c) * 100;
    const chg24 = m.stats?.open ? ((price - m.stats.open) / m.stats.open) * 100 : null;
    const atrPct = (a / price) * 100;
    const stopPct = 1.5 * atrPct;
    const feeShare = (2 * FEE * 100) / stopPct; // round-trip fee as a share of the risk per trade
    let score = trend === "up" ? 40 : trend === "down" ? -40 : 0;
    score += Math.max(-20, Math.min(20, mom * 10));
    score += r >= 50 && r <= 70 ? 15 : r > 75 ? -5 : r < 30 ? 0 : r < 50 ? -10 : 5;
    if (volRatio > 1.3) score += trend === "down" ? -10 : 10;
    if (chg24 != null) score += chg24 > 0 ? 10 : -10;
    if (crosses > 6) score *= 0.6;
    score = Math.round(Math.max(-100, Math.min(100, score)));
    const label = score >= 50 ? "Strong" : score >= 20 ? "Good" : score > -20 ? "Neutral" : score > -50 ? "Weak" : "Avoid";
    return { sym, price, trend, rsi: r, atrPct, stopPct, feeShare, volRatio, crosses, mom, chg24, score, label, e50, e9, e21 };
  }
  const scoreLvl = (s) => (s >= 20 ? "good" : s <= -20 ? "bad" : "watch");

  // ---------- account ----------
  function equity() {
    let e = S.cash;
    for (const [sym, p] of Object.entries(S.positions)) e += p.qty * (market[sym]?.price ?? p.entry);
    return e;
  }
  function todayPnl() {
    const d = today();
    let v = S.trades.filter((t) => new Date(t.closed).toDateString() === d).reduce((a, t) => a + t.pnl, 0);
    for (const [sym, p] of Object.entries(S.positions)) v += p.qty * ((market[sym]?.price ?? p.entry) - p.entry) - p.fee;
    return v;
  }
  const dailyLimit = () => equity() * S.settings.dailyLossPct / 100;
  function sizeFor(entry, stop, eq, cash, st) {
    const riskPer = entry - stop;
    if (riskPer <= 0) return 0;
    let qty = (eq * st.riskPct / 100) / riskPer;
    qty = Math.min(qty, (eq * st.maxPosPct / 100) / entry, (cash / (1 + FEE)) / entry);
    return Math.floor(qty * 1e6) / 1e6;
  }
  function stats() {
    const t = S.trades;
    const wins = t.filter((x) => x.pnl > 0), losses = t.filter((x) => x.pnl <= 0);
    const gw = wins.reduce((a, x) => a + x.pnl, 0), gl = losses.reduce((a, x) => a + x.pnl, 0);
    const fees = t.reduce((a, x) => a + (x.fees ?? x.qty * (x.entry + x.exit) * FEE), 0);
    let peak = S.settings.startCash, eq = S.settings.startCash, dd = 0;
    [...t].reverse().forEach((x) => { eq += x.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); });
    let streak = 0;
    for (const x of t) { if (x.pnl <= 0) streak++; else break; }
    return {
      n: t.length, wins: wins.length, net: gw + gl, winRate: t.length ? wins.length / t.length : null,
      pf: gl < 0 ? gw / -gl : wins.length ? Infinity : null, avgWin: wins.length ? gw / wins.length : null,
      avgLoss: losses.length ? gl / losses.length : null, exp: t.length ? (gw + gl) / t.length : null, dd, fees, lossStreak: streak,
    };
  }

  function openPosition(sym, sig, why) {
    if (S.positions[sym]) return;
    const st = S.settings, eq = equity();
    if (todayPnl() <= -dailyLimit()) { log(`${sym}: buy signal skipped, daily loss limit hit`); return; }
    const qty = sizeFor(sig.entry, sig.stop, eq, S.cash, st);
    if (qty * sig.entry < 1) { log(`${sym}: buy signal skipped, order would be under $1 (exchange minimum)`); return; }
    const fee = qty * sig.entry * FEE;
    S.cash -= qty * sig.entry + fee;
    S.positions[sym] = { qty, entry: sig.entry, stop: sig.stop, target: sig.target, fee, opened: Date.now() };
    log(`BUY ${qty} ${sym} @ ${px(sig.entry)} · stop ${px(sig.stop)} · target ${px(sig.target)} (${why})`);
  }
  function closePosition(sym, price, why) {
    const p = S.positions[sym];
    if (!p) return;
    const exitFee = p.qty * price * FEE;
    S.cash += p.qty * price - exitFee;
    const pnl = p.qty * (price - p.entry) - p.fee - exitFee;
    S.trades.unshift({ sym, qty: p.qty, entry: p.entry, exit: price, pnl, fees: p.fee + exitFee, why, opened: p.opened, closed: Date.now() });
    delete S.positions[sym];
    log(`SELL ${p.qty} ${sym} @ ${px(price)} (${why}) ${money(pnl, true)}`);
  }

  // ---------- live engine ----------
  function onTick(sym, price, ts, size = 0) {
    const m = market[sym];
    if (!m || !isFinite(price)) return;
    const prev = m.price;
    m.price = price;
    m.dir = price > prev ? 1 : price < prev ? -1 : m.dir;
    const bucket = Math.floor(ts / 1000 / tf()) * tf();
    const last = m.candles[m.candles.length - 1];
    if (!last || bucket > last.t) {
      if (last) onCandleClose(sym);
      m.candles.push({ t: bucket, o: price, h: price, l: price, c: price, v: size });
      if (m.candles.length > 600) m.candles.shift();
    } else {
      last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; last.v += size;
    }
    const p = S.positions[sym];
    if (p) {
      if (price <= p.stop) closePosition(sym, price, "stop hit");
      else if (price >= p.target) closePosition(sym, price, "target hit");
    }
    queueRender();
  }
  function onCandleClose(sym) {
    const c = market[sym].candles, ind = indicators(c);
    const sig = decide(c, ind, c.length - 1);
    if (sig && sig.action === "buy") logSignal(sym, "strategy", sig);
    if (!sig || !S.auto) return;
    if (sig.action === "buy") openPosition(sym, sig, "EMA 9 crossed above 21, above EMA 50");
    else if (sig.action === "exit" && S.positions[sym]) closePosition(sym, c[c.length - 1].c, "trend flipped");
  }

  // ---------- data feeds ----------
  async function loadHistory(sym) {
    const r = await fetch(`${CB_REST}/products/${encodeURIComponent(sym)}/candles?granularity=${tf()}`);
    if (!r.ok) throw new Error(`${sym}: ${r.status}`);
    const rows = await r.json();
    const candles = rows.map(([t, l, h, o, c, v]) => ({ t, o, h, l, c, v })).sort((a, b) => a.t - b.t);
    let st = null;
    try {
      const s = await (await fetch(`${CB_REST}/products/${encodeURIComponent(sym)}/stats`)).json();
      st = { open: +s.open, high: +s.high, low: +s.low, volume: +s.volume };
    } catch (e) { /* optional */ }
    const old = market[sym];
    market[sym] = { candles, price: old?.price ?? candles.at(-1)?.c, stats: st, dir: 0 };
  }
  async function refreshStats() {
    for (const sym of Object.keys(market)) {
      try {
        const s = await (await fetch(`${CB_REST}/products/${encodeURIComponent(sym)}/stats`)).json();
        market[sym].stats = { open: +s.open, high: +s.high, low: +s.low, volume: +s.volume };
      } catch (e) { /* offline */ }
    }
  }
  function setStatus(kind, text) {
    const el = $("feedStatus");
    el.className = "pill " + kind;
    el.lastElementChild.textContent = text;
  }
  function connect() {
    const syms = symbols().filter((s) => market[s]);
    if (!syms.length) return;
    clearTimeout(reconnectTimer);
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) { /* ignore */ } }
    clearInterval(pollTimer);
    ws = new WebSocket(CB_WS);
    ws.onopen = () => { ws.send(JSON.stringify({ type: "subscribe", product_ids: syms, channels: ["ticker"] })); setStatus("live", "Live"); clearInterval(pollTimer); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "ticker") onTick(m.product_id, parseFloat(m.price), Date.parse(m.time) || Date.now(), parseFloat(m.last_size) || 0);
    };
    ws.onclose = () => { setStatus("off", "Reconnecting…"); startPolling(syms); reconnectTimer = setTimeout(connect, 5000); };
    ws.onerror = () => ws.close();
  }
  function startPolling(syms) {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => syms.forEach(async (s) => {
      try { const t = await (await fetch(`${CB_REST}/products/${encodeURIComponent(s)}/ticker`)).json(); onTick(s, parseFloat(t.price), Date.now()); } catch (e) { /* offline */ }
    }), 5000);
  }
  async function boot() {
    const syms = symbols();
    for (const k of Object.keys(market)) if (!syms.includes(k)) delete market[k];
    const results = await Promise.allSettled(syms.map(loadHistory));
    results.forEach((r, i) => { if (r.status === "rejected") log(`Couldn't load ${syms[i]} (is the symbol right? e.g. BTC-USD)`); });
    if (!selected || !market[selected]) selected = syms.find((s) => market[s]) || null;
    if (!Object.keys(market).length) { setStatus("off", "Offline"); return; }
    connect();
    queueRender();
  }
  async function loadFng() {
    try {
      const d = await (await fetch("https://api.alternative.me/fng/?limit=7")).json();
      fng = d.data.map((x) => ({ value: +x.value, label: x.value_classification, t: +x.timestamp * 1000 }));
      queueRender();
    } catch (e) { /* optional */ }
  }

  // ---------- all-markets board: gold, stocks, forex, more crypto ----------
  // cb = Coinbase (free, no key) · stk = Alpaca data (needs paper keys) · fx = ECB rates via Frankfurter (daily)
  const BOARD = {
    metals: ["Gold & commodities", [["PAXG-USD", "Gold · 1 oz (PAXG)", "cb"], ["GLD", "Gold ETF", "stk"], ["SLV", "Silver ETF", "stk"], ["USO", "Oil ETF", "stk"], ["UNG", "Natural gas ETF", "stk"], ["CPER", "Copper ETF", "stk"]]],
    stocks: ["Stocks & indices", [["SPY", "S&P 500", "stk"], ["QQQ", "Nasdaq 100", "stk"], ["DIA", "Dow 30", "stk"], ["IWM", "Russell 2000", "stk"], ["TLT", "US bonds 20y", "stk"], ["NVDA", "Nvidia", "stk"], ["AAPL", "Apple", "stk"], ["MSFT", "Microsoft", "stk"], ["TSLA", "Tesla", "stk"], ["AMZN", "Amazon", "stk"], ["META", "Meta", "stk"]]],
    forex: ["Forex", [["USD/ZAR", "Dollar → Rand", "fx"], ["EUR/USD", "Euro", "fx"], ["GBP/USD", "Pound", "fx"], ["USD/JPY", "Yen", "fx"], ["USD/CHF", "Swiss franc", "fx"], ["AUD/USD", "Aussie dollar", "fx"]]],
    crypto: ["Crypto", [["BTC-USD", "Bitcoin", "cb"], ["ETH-USD", "Ethereum", "cb"], ["SOL-USD", "Solana", "cb"], ["XRP-USD", "XRP", "cb"], ["DOGE-USD", "Dogecoin", "cb"], ["ADA-USD", "Cardano", "cb"], ["AVAX-USD", "Avalanche", "cb"], ["LINK-USD", "Chainlink", "cb"], ["LTC-USD", "Litecoin", "cb"]]],
  };
  const board = {}; // sym -> {price, chg}
  let boardCat = "metals";
  const boardRows = (src) => Object.values(BOARD).flatMap(([, r]) => r).filter((r) => r[2] === src);
  async function loadBoard() {
    await Promise.allSettled(boardRows("cb").map(async ([s]) => {
      const d = await (await fetch(`${CB_REST}/products/${s}/stats`)).json();
      const last = +d.last, open = +d.open;
      if (last) board[s] = { price: last, chg: open ? ((last - open) / open) * 100 : 0 };
    }));
    if (S.settings.alpacaKey && S.settings.alpacaSecret) {
      try {
        const syms = boardRows("stk").map((r) => r[0]).join(",");
        const d = await (await fetch(`${ALPACA_DATA}/v2/stocks/snapshots?feed=iex&symbols=${syms}`, { headers: alpacaHeaders() })).json();
        for (const [s, x] of Object.entries(d || {})) {
          const p = x?.latestTrade?.p, prev = x?.prevDailyBar?.c;
          if (p) board[s] = { price: p, chg: prev ? ((p - prev) / prev) * 100 : 0 };
        }
      } catch (e) { /* optional */ }
    }
    queueRender();
  }
  async function loadFx() {
    try {
      const from = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
      const d = await (await fetch(`https://api.frankfurter.dev/v1/${from}..?base=USD&symbols=ZAR,EUR,GBP,JPY,CHF,AUD`)).json();
      const days = Object.keys(d.rates).sort(), a = d.rates[days.at(-2)], b = d.rates[days.at(-1)];
      for (const r of boardRows("fx")) {
        const [x, y] = r[0].split("/"), q = x === "USD" ? y : x, inv = x !== "USD";
        const now = inv ? 1 / b[q] : b[q], then = inv ? 1 / a[q] : a[q];
        board[r[0]] = { price: now, chg: ((now - then) / then) * 100 };
      }
      queueRender();
    } catch (e) { /* optional */ }
  }
  function riskMood() {
    const g = board["PAXG-USD"]?.chg, btc = board["BTC-USD"]?.chg, spy = board.SPY?.chg;
    if (g == null || btc == null) return null;
    const risk = spy != null ? (btc + spy) / 2 : btc;
    if (risk > 0.5 && g < risk) return { lvl: "good", title: "Risk-on day", text: `Crypto${spy != null ? " and stocks" : ""} are beating gold (${pct(risk)} vs ${pct(g)}). Buyers are confident, so trend trades work better.` };
    if (risk < -0.5 && g > risk) return { lvl: "bad", title: "Risk-off day", text: `Money is hiding in gold (${pct(g)}) while crypto${spy != null ? " and stocks" : ""} slide (${pct(risk)}). Long trades are fighting the tide.` };
    return { lvl: "watch", title: "No clear money flow", text: `Gold ${pct(g)}, crypto ${pct(btc)}${spy != null ? `, S&P ${pct(spy)}` : ""}. Nothing is leading, so expect chop.` };
  }
  const moodTag = (c) => (c > 1 ? ["good", "Strong"] : c > 0.2 ? ["good", "Up"] : c < -1 ? ["bad", "Weak"] : c < -0.2 ? ["bad", "Down"] : ["watch", "Flat"]);
  const fmtBoard = (s, p) => (s.includes("/") ? p.toFixed(s.includes("JPY") || s.includes("ZAR") ? 3 : 4) : px(p));
  function renderBoard() {
    const [title, rows] = BOARD[boardCat], inBot = symbols();
    document.querySelectorAll("#boardTabs button").forEach((b) => b.classList.toggle("on", b.dataset.cat === boardCat));
    const needKeys = rows.some((r) => r[2] === "stk") && !S.settings.alpacaKey;
    $("boardBody").innerHTML = rows.map(([s, name, src]) => {
      const b = board[s];
      if (!b) return src === "stk" && needKeys ? "" : `<div class="brow"><div><b>${esc(name)}</b><span>${esc(s)}</span></div><span class="muted">loading…</span></div>`;
      const [lvl, word] = moodTag(b.chg);
      const act = src === "cb" ? (inBot.includes(s) ? `<span class="tag">In bot</span>` : `<button class="addbot" data-add="${esc(s)}">+ Bot</button>`) : "";
      return `<div class="brow"><div><b>${esc(name)}</b><span>${esc(s)}</span></div><div class="num">${fmtBoard(s, b.price)}</div><div class="num ${cls(b.chg)}">${arrow(b.chg)}${pct(b.chg)}</div><span class="tag ${lvl}">${word}</span>${act}</div>`;
    }).join("") + (needKeys ? `<p class="muted small">Add your Alpaca <b>paper</b> keys in Settings to see live ${esc(title.toLowerCase())} prices (free).</p>` : "");
    const rm = riskMood();
    $("bigPic").innerHTML = rm ? `<span class="tag ${rm.lvl}">${rm.title}</span> ${esc(rm.text)}` : "Reading gold vs crypto…";
    // home ticker
    const all = Object.entries(board);
    // Build the scrolling strip once; afterwards only swap the numbers so the animation never restarts.
    const tk = $("ticker"), keys = all.map(([s]) => s).join();
    const inner = (s, b) => `<b>${esc(s === "PAXG-USD" ? "GOLD" : s.replace("-USD", ""))}</b> ${fmtBoard(s, b.price)} <i class="${cls(b.chg)}">${arrow(b.chg)}${pct(b.chg)}</i>`;
    if (all.length && tk.dataset.keys !== keys) {
      const items = all.map(([s, b]) => `<span data-s="${esc(s)}">${inner(s, b)}</span>`).join("");
      tk.innerHTML = `<div class="track">${items}${items}</div>`;
      tk.dataset.keys = keys;
    } else if (all.length && Date.now() - (tk._t || 0) > 3000) {
      tk._t = Date.now();
      tk.querySelectorAll("span[data-s]").forEach((el) => { const s = el.dataset.s; if (board[s]) el.innerHTML = inner(s, board[s]); });
    }
  }

  // ---------- bot brain: rings, AI signal per market, thought feed, movers ----------
  const setHTML = (el, h) => { if (el && el._h !== h) { el._h = h; el.innerHTML = h; } };
  const shortName = (s) => (s === "PAXG-USD" ? "Gold" : s.replace("-USD", ""));
  const sigAction = (m) => (m.score >= 30 && m.trend === "up" ? { word: "BUY ZONE", lvl: "good" } : m.score <= -30 ? { word: "AVOID", lvl: "bad" } : { word: "WAIT", lvl: "watch" });
  const RING_COL = { good: "var(--up)", bad: "var(--down)", watch: "var(--warn)" };
  function brainState() {
    const ms = symbols().map(metrics).filter(Boolean);
    if (!ms.length) return null;
    const avg = (f) => ms.reduce((a, m) => a + f(m), 0) / ms.length;
    const trend = avg((m) => (m.score + 100) / 2);
    const mom = avg((m) => Math.max(0, Math.min(100, 100 - Math.abs(m.rsi - 60) * 2.5))); // sweet spot ≈ RSI 60
    const lim = dailyLimit() || 1, risk = 100 - Math.min(100, Math.max(0, (-todayPnl() / lim) * 100));
    const conf = Math.round(trend * 0.5 + mom * 0.3 + risk * 0.2);
    return { trend, mom, risk, conf, ms };
  }
  const thoughts = [], lastThought = {};
  function think(ms) {
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    for (const m of ms) {
      const a = sigAction(m), key = a.word + m.trend;
      if (lastThought[m.sym] === key) continue;
      lastThought[m.sym] = key;
      if (a.word === "BUY ZONE") logSignal(m.sym, "ring", { entry: m.price, stop: m.price * (1 - (1.5 * m.atrPct) / 100), target: m.price * (1 + (3 * m.atrPct) / 100) });
      const why = `${m.trend === "up" ? "trend up" : m.trend === "down" ? "trend down" : "choppy"}, RSI ${m.rsi.toFixed(0)}, volume ${m.volRatio.toFixed(1)}× normal`;
      thoughts.unshift({ t, lvl: a.lvl, txt: `${shortName(m.sym)}: ${why} → ${a.word === "BUY ZONE" ? "looking for an entry" : a.word === "AVOID" ? "staying out" : "waiting for a cleaner setup"}` });
    }
    const rm = riskMood();
    if (rm && lastThought._mood !== rm.title) { lastThought._mood = rm.title; thoughts.unshift({ t, lvl: rm.lvl, txt: `Big picture: ${rm.title.toLowerCase()}. ${rm.text}` }); }
    thoughts.length = Math.min(thoughts.length, 14);
  }
  function renderBrain() {
    const b = brainState();
    if (!b) return;
    think(b.ms);
    if ($("view-home").hidden) return;
    const svg = $("brainRings"), rings = [[84, b.trend, "var(--blue-2)"], [64, b.mom, "var(--ember)"], [44, b.risk, "var(--up)"]];
    if (!svg.firstChild) svg.innerHTML = rings.map(([r, , c]) => `<circle cx="100" cy="100" r="${r}" class="rt"/><circle cx="100" cy="100" r="${r}" pathLength="100" stroke="${c}" stroke-dasharray="0 100" class="rv" transform="rotate(-90 100 100)"/>`).join("");
    svg.querySelectorAll(".rv").forEach((el, i) => el.setAttribute("stroke-dasharray", `${Math.max(0.5, rings[i][1]).toFixed(1)} 100`));
    $("brainPct").textContent = b.conf + "%";
    $("brainWord").textContent = b.conf >= 65 ? "hunting" : b.conf >= 45 ? "patient" : "defensive";
    setHTML($("brainKey"), [["Trend", b.trend, "--blue-2", "how many markets point up"], ["Momentum", b.mom, "--ember", "RSI near the 60 sweet spot"], ["Risk left", b.risk, "--up", "daily loss budget unused"]]
      .map(([n, v, c, d]) => `<div><i style="background:var(${c})"></i><b>${n}</b><span class="num">${v.toFixed(0)}%</span><small>${d}</small></div>`).join(""));
    setHTML($("thoughts"), thoughts.map((x) => `<li class="${x.lvl}"><time>${x.t}</time>${esc(x.txt)}</li>`).join(""));
    setHTML($("sigRings"), b.ms.map((m) => {
      const a = sigAction(m), v = Math.max(3, Math.abs(m.score));
      return `<button class="sr" data-sym="${esc(m.sym)}"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" class="rt"/><circle cx="32" cy="32" r="26" pathLength="100" stroke="${RING_COL[a.lvl]}" stroke-dasharray="${v} 100" class="rv" transform="rotate(-90 32 32)"/><text x="32" y="36" text-anchor="middle">${esc(shortName(m.sym))}</text></svg>
        <b class="${a.lvl}">${a.word}</b><span class="num">${m.score > 0 ? "+" : ""}${m.score} · ${pct(m.chg24)}</span></button>`;
    }).join(""));
  }
  function renderMovers() {
    const el = $("movers");
    if (!el || $("view-markets").hidden) return;
    const rows = Object.entries(board).sort((a, b) => b[1].chg - a[1].chg);
    const mx = Math.max(0.5, ...rows.map(([, b]) => Math.abs(b.chg)));
    setHTML(el, rows.map(([s, b]) => `<div class="mv"><span>${esc(shortName(s))}</span><div class="mv-bar"><i class="${b.chg >= 0 ? "pos" : "neg"}" style="width:${((Math.abs(b.chg) / mx) * 50).toFixed(1)}%"></i></div><b class="num ${cls(b.chg)}">${pct(b.chg)}</b></div>`).join("") || `<p class="muted small">Loading…</p>`);
  }

  // ---------- signal scorecard: log every buy signal, grade it against what price did next ----------
  const SRC_NAME = { strategy: "EMA cross (bot's buy rule)", ring: "BUY ZONE ring" };
  const FEE_RT = 0.2; // % round trip, same as the bot
  function logSignal(sym, src, { entry, stop, target }) {
    if (!S.signals) S.signals = [];
    if (!(entry > stop) || S.signals.some((s) => s.sym === sym && s.src === src && s.status === "open")) return;
    S.signals.push({ id: Date.now() + sym + src, sym, src, t: Date.now(), entry, stop, target, status: "open" });
    if (S.signals.length > 300) S.signals.splice(0, S.signals.length - 300);
    save();
  }
  function gradeSignals() {
    let changed = false;
    for (const s of S.signals || []) {
      if (s.status !== "open") continue;
      const m = market[s.sym];
      if (!m) continue;
      let exit = null, status = null;
      for (const c of m.candles) {
        if ((c.t + tf()) * 1000 <= s.t) continue; // only candles after the signal
        if (c.l <= s.stop) { exit = s.stop; status = "loss"; break; } // stop checked first: the honest assumption
        if (c.h >= s.target) { exit = s.target; status = "win"; break; }
      }
      if (!status && Date.now() - s.t > 24 * 3600e3 && m.price) { exit = m.price; status = "expired"; }
      if (!status) continue;
      Object.assign(s, { status, exit, res: ((exit - s.entry) / s.entry) * 100 - FEE_RT, r: (exit - s.entry) / (s.entry - s.stop), done: Date.now() });
      changed = true;
    }
    if (changed) save();
  }
  function sgStats(list) {
    const g = list.filter((s) => s.status !== "open");
    return {
      n: g.length, open: list.length - g.length,
      win: g.length ? (g.filter((s) => s.res > 0).length / g.length) * 100 : null,
      avg: g.length ? g.reduce((a, s) => a + s.res, 0) / g.length : null,
      R: g.reduce((a, s) => a + s.r, 0),
    };
  }
  const sgVerdict = (st) => (st.n < 20 ? ["watch", `Need more data (${st.n}/20)`] : st.avg > 0 && st.R > 0 ? ["good", "Working"] : st.avg < 0 ? ["bad", "Losing"] : ["watch", "Break-even"]);
  function renderScore() {
    if ($("view-bot").hidden) return;
    const list = S.signals || [], st = sgStats(list), [lvl, word] = sgVerdict(st);
    const v = $("sgVerdict"); v.className = `tag ${lvl}`; v.textContent = word;
    const svg = $("sgRing");
    if (!svg.firstChild) svg.innerHTML = `<circle cx="100" cy="100" r="80" class="rt"/><circle cx="100" cy="100" r="80" pathLength="100" stroke-dasharray="0 100" class="rv" transform="rotate(-90 100 100)"/>`;
    const rv = svg.querySelector(".rv"); rv.setAttribute("stroke", RING_COL[lvl]); rv.setAttribute("stroke-dasharray", `${Math.max(0.5, st.win || 0).toFixed(1)} 100`);
    $("sgWin").textContent = st.win == null ? "–" : st.win.toFixed(0) + "%";
    $("sgN").textContent = st.n; $("sgOpen").textContent = st.open;
    $("sgAvg").textContent = st.avg == null ? "–" : pct(st.avg);
    $("sgR").textContent = st.n ? (st.R > 0 ? "+" : "") + st.R.toFixed(1) + "R" : "–";
    const groups = [...Object.keys(SRC_NAME).map((k) => [SRC_NAME[k], list.filter((s) => s.src === k)]), ...[...new Set(list.map((s) => s.sym))].map((y) => [coin(y), list.filter((s) => s.sym === y)])];
    setHTML($("sgBreak"), groups.map(([name, l]) => { const g = sgStats(l), [gl, gw] = sgVerdict(g); return `<tr><td>${esc(name)}</td><td>${g.n}</td><td>${g.win == null ? "–" : g.win.toFixed(0) + "%"}</td><td class="${cls(g.avg)}">${g.avg == null ? "–" : pct(g.avg)}</td><td>${g.n ? g.R.toFixed(1) + "R" : "–"}</td><td><span class="tag ${gl}">${esc(gw)}</span></td></tr>`; }).join(""));
    const badge = { open: ["watch", "Open"], win: ["good", "Target hit"], loss: ["bad", "Stopped out"], expired: ["watch", "Expired 24h"] };
    setHTML($("sgList"), [...list].reverse().slice(0, 40).map((s) => {
      const [bl, bw] = badge[s.status], when = new Date(s.t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
      return `<div class="r"><div><div class="t">${esc(coin(s.sym))} · ${esc(SRC_NAME[s.src])}</div><div class="s">${when} · in ${px(s.entry)} · stop ${px(s.stop)} · target ${px(s.target)}</div></div><div class="v"><span class="tag ${bl}">${bw}</span>${s.res != null ? ` <b class="num ${cls(s.res)}">${pct(s.res)}</b>` : ""}</div></div>`;
    }).join("") || `<p class="empty">No signals yet. They appear here automatically while the app is open.</p>`);
  }

  // ---------- market hours ----------
  function sessionState(tz, oh, om, ch, cm) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const wd = days.indexOf(parts.weekday), now = +parts.hour * 60 + +parts.minute;
    const open = oh * 60 + om, close = ch * 60 + cm, weekday = (d) => d >= 1 && d <= 5;
    if (weekday(wd) && now >= open && now < close) return { open: true, mins: close - now };
    for (let k = 0; k <= 7; k++) {
      const d = (wd + k) % 7;
      if (!weekday(d)) continue;
      if (k === 0 && now >= open) continue;
      return { open: false, mins: k * 1440 + open - now };
    }
    return { open: false, mins: 0 };
  }
  const nyse = () => sessionState("America/New_York", 9, 30, 16, 0);

  // ---------- backtest ----------
  function backtest() {
    const st = S.settings, all = [];
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
      const fees = p.fee + p.qty * exit * FEE;
      return { sym, qty: p.qty, entry: p.entry, exit, why, pnl: p.qty * (exit - p.entry) - fees, fees, t: t * 1000 };
    }
    all.sort((a, b) => b.t - a.t);
    const net = all.reduce((a, t) => a + t.pnl, 0), fees = all.reduce((a, t) => a + t.fees, 0);
    const wins = all.filter((t) => t.pnl > 0).length;
    const hours = Math.round((300 * tf()) / 3600);
    btSummary = { tf: TF_NAME[tf()], hours, trades: all.length, wins, net, fees, grossBeforeFees: net + fees };
    $("btCard").hidden = false;
    $("btH").textContent = `Last ${hours} hours on ${TF_NAME[tf()]} candles`;
    $("btOut").innerHTML = `
      <div class="bt-stats">
        <div class="kpi"><span class="label">Trades</span><span class="num">${all.length}</span></div>
        <div class="kpi"><span class="label">Win rate</span><span class="num">${all.length ? Math.round((wins / all.length) * 100) + "%" : "–"}</span></div>
        <div class="kpi"><span class="label">Net P&amp;L</span><span class="num ${cls(net)}">${arrow(net)}${money(net, true)}</span></div>
        <div class="kpi"><span class="label">Fees paid</span><span class="num">${money(fees)}</span></div>
      </div>
      <p class="muted small">${all.length ? `Before fees the strategy made ${money(net + fees, true)}; fees took ${money(fees)}. ` : "No signals in this window. "}Each symbol tested on ${money(st.startCash)}. A small sample: a sanity check, not proof.</p>
      <div class="rows">${all.map((t) => `<div class="r"><div><div class="t">${esc(coin(t.sym))} <span class="muted small">${esc(t.why)}</span></div><div class="s">${hhmm(t.t)} · ${px(t.entry)} → ${px(t.exit)}</div></div><div class="v ${cls(t.pnl)}">${money(t.pnl, true)}</div></div>`).join("")}</div>`;
    queueRender();
    $("btCard").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- coach ----------
  function buildInsights() {
    const out = [];
    const add = (lvl, title, text) => out.push({ lvl, title, text });
    const ms = symbols().map(metrics).filter(Boolean);
    const st = stats(), eq = equity(), tp = todayPnl(), lim = dailyLimit();

    if (tp <= -lim) add("bad", "Daily loss limit hit", `Down ${money(tp)} today. The bot won't open new trades until tomorrow. That's the rule doing its job.`);
    else if (tp < -lim * 0.5) add("bad", "Over half your daily loss limit used", `Down ${money(tp)} of a ${money(lim)} limit. Smaller or fewer trades for the rest of today.`);
    else if (tp > 0 && st.n) add("good", "Green day so far", `${money(tp, true)} today. Don't give it back by forcing trades.`);

    const ups = ms.filter((m) => m.trend === "up").map((m) => coin(m.sym));
    const downs = ms.filter((m) => m.trend === "down").map((m) => coin(m.sym));
    const list = (a) => (a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a.at(-1) : a[0]);
    if (ups.length) add("good", `${list(ups)} ${ups.length > 1 ? "are" : "is"} trending up`, "Price is above the 50-period average and EMA 9 is over EMA 21. This is the only setup the bot buys.");
    if (downs.length) add("bad", `${list(downs)} ${downs.length > 1 ? "are" : "is"} trending down`, "Price is under the 50-period average. The bot only buys, so it sits this out.");
    for (const m of ms) {
      const c = coin(m.sym);
      if (m.crosses > 6) add("bad", `${c} is choppy`, `The averages crossed ${m.crosses} times in the last 60 candles. Crossover strategies get chopped up in this.`);
      if (m.rsi > 75) add("watch", `${c} looks overbought (RSI ${m.rsi.toFixed(0)})`, `It has run hard. Buying here is chasing; pullbacks are common.`);
      else if (m.rsi < 25) add("watch", `${c} looks oversold (RSI ${m.rsi.toFixed(0)})`, `Sold hard. Bounces happen but catching a falling knife is risky.`);
      if (m.volRatio > 1.8) add("watch", `${c} volume surge (${m.volRatio.toFixed(1)}× normal)`, m.trend === "up" ? "Buyers stepping in: breakouts on volume tend to hold better." : "Big volume in a weak market often means selling pressure.");
    }
    if (ms.length) {
      const avgFee = ms.reduce((a, m) => a + m.feeShare, 0) / ms.length;
      if (avgFee > 0.25) add("bad", `Fees eat ${Math.round(avgFee * 100)}% of each trade's risk on ${TF_NAME[tf()]}`, `Stops are only ~${(ms.reduce((a, m) => a + m.stopPct, 0) / ms.length).toFixed(2)}% away, but a round trip costs 0.2%. Switch to a longer timeframe (15m) so moves are bigger than fees.`);
      else if (avgFee < 0.1) add("good", "Moves are big enough to beat fees", `Fees are ~${Math.round(avgFee * 100)}% of the risk per trade on ${TF_NAME[tf()]}. Healthy.`);
      const best = [...ms].sort((a, b) => b.score - a.score)[0];
      if (best.score >= 20) add("good", `Best looking: ${coin(best.sym)} (score ${best.score})`, `${best.label}. ${best.trend === "up" ? "Trend and momentum agree." : "Momentum is decent but the trend isn't confirmed."}`);
      if (ms.every((m) => m.score <= -20)) add("bad", "Everything on the watchlist is weak", "Sitting in cash is a position. Nothing here favours buying.");
    }
    if (fng?.length) {
      const f = fng[0];
      if (f.value <= 25) add("watch", `Extreme fear (${f.value}/100)`, "Crypto mood is panicky. Sharp bounces happen, but trends are weak and fakeouts common.");
      else if (f.value >= 75) add("watch", `Extreme greed (${f.value}/100)`, "Everyone is euphoric. Late buyers often get caught in pullbacks; keep stops tight.");
      else if (fng[1] && f.value - fng[1].value >= 10) add("good", `Mood improving (${fng[1].value} → ${f.value})`, "Sentiment is turning up from yesterday.");
      else if (fng[1] && fng[1].value - f.value >= 10) add("bad", `Mood worsening (${fng[1].value} → ${f.value})`, "Sentiment dropped since yesterday.");
    }
    if (st.lossStreak >= 3) add("bad", `${st.lossStreak} losses in a row`, "Consider pausing the autopilot and checking whether the market is choppy.");
    if (st.n >= 5) {
      if (st.pf != null && st.pf < 1) add("bad", `Losing strategy so far (profit factor ${st.pf.toFixed(2)})`, `Every $1 lost has only won back $${st.pf.toFixed(2)} across ${st.n} trades. ${st.fees > Math.abs(st.net) ? "Fees are a big part of it." : ""}`);
      else if (st.pf > 1.3) add("good", `Strategy is profitable so far (PF ${st.pf === Infinity ? "∞" : st.pf.toFixed(2)})`, `${st.n} trades, ${Math.round(st.winRate * 100)}% winners. Keep paper trading to grow the sample.`);
    }
    const inv = Object.entries(S.positions).reduce((a, [s, p]) => a + p.qty * (market[s]?.price ?? p.entry), 0);
    if (inv / eq > 0.6) add("watch", `${Math.round((inv / eq) * 100)}% of the account is invested`, "Crypto coins move together; a market drop hits every position at once.");
    if (btSummary) {
      if (btSummary.net < 0) add("bad", `Backtest lost ${money(btSummary.net)} (${btSummary.tf}, ${btSummary.hours}h)`, btSummary.grossBeforeFees > 0 ? "It was profitable before fees. Fees are the problem: try a longer timeframe." : "It lost even before fees on this timeframe. The setup isn't working in this market.");
      else if (btSummary.trades) add("good", `Backtest made ${money(btSummary.net, true)} (${btSummary.tf}, ${btSummary.hours}h)`, `${btSummary.trades} trades. Promising, but small samples lie.`);
    }
    const n = nyse();
    if (!n.open && plans.some((p) => p.status !== "done" && p.status !== "example")) add("watch", "US stock market is closed", `Claude's stock plans can't fill until the open in ${dur(n.mins)}.`);
    const rm = riskMood();
    if (rm) add(rm.lvl, rm.title, rm.text);
    if (!S.auto) add("watch", "Autopilot is off", "The bot is watching but won't trade. Start it on the Home or Bot tab.");

    const g = out.filter((x) => x.lvl === "good").length, b = out.filter((x) => x.lvl === "bad").length;
    let v;
    if (tp <= -lim) v = { lvl: "bad", title: "Stop for today: loss limit hit" };
    else if (b > g) v = { lvl: "bad", title: "Be careful: more bad than good right now" };
    else if (g > b) v = { lvl: "good", title: "Conditions look good for the bot" };
    else v = { lvl: "watch", title: "Mixed: be picky, small size" };
    insights = out;
    verdict = v;
  }

  function reviewPlan(p) {
    const r = p.entry - p.stop, rr = r > 0 ? (p.target - p.entry) / r : null;
    if (p.status === "example") return { lvl: "watch", text: "Example plan, not a real signal." };
    if (p.status === "done") return { lvl: "watch", text: "Closed out. Kept for the record." };
    if (rr == null || r <= 0) return { lvl: "bad", text: "Stop must be below entry. Don't trade this as written." };
    if (rr < 1.5) return { lvl: "bad", text: `Only ${rr.toFixed(1)}R: the reward is too small for the risk.` };
    const q = quotes[p.symbol];
    if (q && q < p.stop) return { lvl: "bad", text: "Price is already below the stop. The setup has failed." };
    if (q && q > p.target) return { lvl: "watch", text: "Price is already past the target. Too late to chase." };
    const n = nyse();
    if (!n.open) return { lvl: "watch", text: `${rr.toFixed(1)}R plan. Market closed: opens in ${dur(n.mins)}.` };
    return { lvl: "good", text: `${rr.toFixed(1)}R reward-to-risk. Solid if it triggers.` };
  }

  // Offline coach: answers from the same live data, no API key needed.
  function localAnswer(q) {
    const s = q.toLowerCase();
    const ms = symbols().map(metrics).filter(Boolean).sort((a, b) => b.score - a.score);
    const st = stats();
    const bads = insights.filter((x) => x.lvl === "bad"), goods = insights.filter((x) => x.lvl === "good");
    const bullet = (arr) => arr.slice(0, 4).map((x) => `• ${x.title}`).join("\n");
    if (/best|which|coin|strong|pick/.test(s)) {
      return ms.length ? `Ranked by score right now (${TF_NAME[tf()]}):\n` + ms.map((m, i) => `${i + 1}. ${coin(m.sym)}: ${m.score} (${m.label}), ${m.trend === "up" ? "uptrend" : m.trend === "down" ? "downtrend" : "choppy"}, RSI ${m.rsi.toFixed(0)}`).join("\n") + `\n\n${ms[0].score >= 20 ? `${coin(ms[0].sym)} is the best of the bunch.` : "Nothing scores well. Waiting is fine."}` : "Still loading prices.";
    }
    if (/los|lost|why|bad/.test(s)) {
      if (!st.n) return `No closed trades yet, so nothing has been lost.\n\nWhat's working against us right now:\n${bullet(bads) || "• nothing major"}`;
      return `${st.n} trades, ${Math.round(st.winRate * 100)}% winners, net ${money(st.net, true)}.\nAverage win ${money(st.avgWin)} vs average loss ${money(st.avgLoss)}. Fees paid: ${money(st.fees)}.\n\n${st.fees > Math.abs(st.net) / 2 ? "Fees are a big chunk of the damage: a longer timeframe means fewer, bigger trades.\n" : ""}${bads.length ? "Current problems:\n" + bullet(bads) : ""}`;
    }
    if (/plan|claude|signal/.test(s)) {
      if (!plans.length) return "Claude hasn't posted any plans yet.";
      return `${sigInfo.note || ""}\n\n` + plans.map((p) => { const r = reviewPlan(p); return `• ${p.symbol}: ${r.text}`; }).join("\n");
    }
    if (/risk|size|safe|limit/.test(s)) {
      const inv = Object.entries(S.positions).reduce((a, [k, p]) => a + p.qty * (market[k]?.price ?? p.entry), 0);
      return `Your rules: risk ${S.settings.riskPct}% per trade (${money(equity() * S.settings.riskPct / 100)}), max ${S.settings.maxPosPct}% in one position, stop for the day at −${money(dailyLimit())}.\nToday: ${money(todayPnl(), true)}. Invested: ${money(inv)} of ${money(equity())}.\n\n${S.settings.riskPct > 2 ? "Over 2% per trade is aggressive. 0.5–1% is the usual range." : "That's a sensible risk level for learning."}`;
    }
    if (/fear|greed|mood|sentiment/.test(s)) {
      return fng ? `Fear & Greed is ${fng[0].value}/100 (${fng[0].label}). A week ago: ${fng.at(-1).value}.` : "Sentiment data isn't loaded.";
    }
    return `${verdict.title}.\n\nGood:\n${bullet(goods) || "• nothing stands out"}\n\nBad:\n${bullet(bads) || "• nothing major"}\n\nThe bot ${S.auto ? "is ON and will act on its own signals" : "is OFF"}.${S.settings.anthropicKey ? "" : "\n\n(Add an Anthropic API key in Settings for full Claude answers.)"}`;
  }

  // Claude chat: the user's own key, called straight from the browser.
  let convo = []; // append-only; assistant turns are replayed exactly as returned
  function snapshot() {
    const n = nyse();
    return {
      time: new Date().toISOString(),
      timeframe: TF_NAME[tf()],
      us_stock_market: n.open ? `open, closes in ${dur(n.mins)}` : `closed, opens in ${dur(n.mins)}`,
      fear_greed: fng ? fng.map((f) => f.value) : null,
      all_markets_today: Object.fromEntries(Object.entries(board).map(([k, b]) => [k, { price: +b.price.toFixed(4), change_pct: +b.chg.toFixed(2) }])),
      big_picture: riskMood()?.title || "unknown",
      signal_scorecard: { ...sgStats(S.signals || []), verdict: sgVerdict(sgStats(S.signals || []))[1] },
      markets: symbols().map(metrics).filter(Boolean).map((m) => ({ symbol: m.sym, price: +m.price.toFixed(4), change_24h_pct: m.chg24 && +m.chg24.toFixed(2), rsi: +m.rsi.toFixed(1), atr_pct: +m.atrPct.toFixed(3), trend: m.trend, score: m.score, volume_vs_normal: +m.volRatio.toFixed(2), ema_crosses_last_60: m.crosses })),
      account: { equity: +equity().toFixed(2), cash: +S.cash.toFixed(2), today_pnl: +todayPnl().toFixed(2), daily_loss_limit: +dailyLimit().toFixed(2), autopilot: S.auto, rules: { risk_pct: S.settings.riskPct, max_pos_pct: S.settings.maxPosPct } },
      positions: Object.entries(S.positions).map(([s, p]) => ({ symbol: s, qty: p.qty, entry: p.entry, stop: p.stop, target: p.target, now: market[s]?.price })),
      stats: stats(),
      recent_trades: S.trades.slice(0, 10).map((t) => ({ symbol: t.sym, entry: t.entry, exit: t.exit, pnl: +t.pnl.toFixed(2), why: t.why })),
      backtest: btSummary,
      coach_insights: insights.map((i) => `${i.lvl.toUpperCase()}: ${i.title}`),
      claude_plans: plans,
    };
  }
  const SYSTEM = `You are the coach inside Autopilot, a paper-trading app (fake money) used by a beginner. Each question comes with a live JSON snapshot of their markets, account, bot stats, coach insights and trade plans from another Claude session.

Answer in plain English, short (under 150 words unless they ask for more), concrete and honest. Use the numbers in the snapshot. Say clearly what is good and bad for them right now. Never promise profits or certainty; point out when a sample is too small to judge. You are not a licensed financial advisor: give education and analysis about their paper account, not personal investment advice for real money. No markdown headings; short lines or bullets are fine.`;

  async function askClaude(q) {
    if (convo.length >= 20) convo = []; // start a fresh thread rather than editing history
    convo.push({ role: "user", content: `Live snapshot:\n${JSON.stringify(snapshot())}\n\nQuestion: ${q}` });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": S.settings.anthropicKey,
        "anthropic-version": "2026-10-21",
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 16000, output_config: { effort: "low" }, fallbacks: "default", system: SYSTEM, messages: convo }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { convo.pop(); throw new Error(d.error?.message || `HTTP ${r.status}`); }
    convo.push({ role: "assistant", content: d.content });
    if (d.stop_reason === "refusal") return "Claude declined to answer that one. Try rephrasing it.";
    return d.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || "(no answer)";
  }

  function addMsg(who, text) {
    const el = document.createElement("div");
    el.className = "msg " + who;
    el.textContent = text;
    $("msgs").appendChild(el);
    $("msgs").scrollTop = $("msgs").scrollHeight;
    return el;
  }
  async function ask(q) {
    q = q.trim();
    if (!q) return;
    addMsg("me", q);
    if (!S.settings.anthropicKey) { buildInsights(); addMsg("ai", localAnswer(q)); return; }
    const el = addMsg("ai thinking", "Thinking…");
    try {
      buildInsights();
      el.textContent = await askClaude(q);
    } catch (e) {
      el.textContent = `Claude couldn't answer (${e.message}). Here's the built-in coach instead:\n\n${localAnswer(q)}`;
    }
    el.classList.remove("thinking");
    $("msgs").scrollTop = $("msgs").scrollHeight;
  }

  // ---------- Claude's plans + Alpaca ----------
  async function loadSignals() {
    try {
      const d = await (await fetch("signals.json?t=" + Date.now(), { cache: "no-store" })).json();
      plans = Array.isArray(d.plans) ? d.plans : [];
      sigInfo = d;
      $("sigMeta").textContent = `Updated ${d.updated ? new Date(d.updated).toLocaleString() : "never"}${d.note ? " · " + d.note : ""}`;
      renderPlans();
      refreshStockQuotes();
    } catch (e) { $("sigMeta").textContent = "Couldn't read signals.json."; }
  }
  function renderPlans() {
    const keys = !!(S.settings.alpacaKey && S.settings.alpacaSecret);
    $("plans").innerHTML = plans.map((p, idx) => {
      const r = p.entry && p.stop ? p.entry - p.stop : null;
      const rr = r && p.target ? ((p.target - p.entry) / r).toFixed(1) : "–";
      const q = quotes[p.symbol], rev = reviewPlan(p);
      return `<article class="plan">
        <h3><span>${esc(p.symbol)}</span><span class="tag ${rev.lvl}">${esc(p.status || p.side || "plan")}</span></h3>
        <p>${esc(p.setup || "")}</p>
        <div class="review ${rev.lvl}">Coach: ${esc(rev.text)}</div>
        <dl>
          ${q ? `<dt>Last</dt><dd>${px(q)}</dd>` : ""}
          <dt>Entry</dt><dd>${px(p.entry)}</dd>
          <dt>Stop</dt><dd class="down">${px(p.stop)}</dd>
          <dt>Target</dt><dd class="up">${px(p.target)}</dd>
          <dt>Reward : risk</dt><dd>${rr}R</dd>
          ${p.qty ? `<dt>Size</dt><dd>${esc(p.qty)} sh · max loss ${money(p.qty * r)}</dd>` : ""}
        </dl>
        ${p.notes ? `<p>${esc(p.notes)}</p>` : ""}
        ${keys && p.entry && p.stop && p.target && p.status !== "done" && p.status !== "example" ? `<button class="btn small" data-plan="${idx}">Send to Alpaca paper</button>` : ""}
      </article>`;
    }).join("") || `<p class="empty">No plans yet. Ask Claude in the trading session to scan and post plans.</p>`;
  }
  function alpacaHeaders() { return { "APCA-API-KEY-ID": S.settings.alpacaKey, "APCA-API-SECRET-KEY": S.settings.alpacaSecret, "Content-Type": "application/json" }; }
  async function alpaca(path, opts = {}) {
    const r = await fetch(ALPACA + path, { ...opts, headers: alpacaHeaders() });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.message || r.status);
    return body;
  }
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
          <div class="kpi"><span class="label">Equity</span><span class="num">${money(alpacaEquity)}</span></div>
          <div class="kpi"><span class="label">Today</span><span class="num ${cls(dayPl)}">${arrow(dayPl)}${money(dayPl, true)}</span></div>
          <div class="kpi"><span class="label">Buying power</span><span class="num">${money(parseFloat(acct.buying_power))}</span></div>
          <div class="kpi"><span class="label">Positions</span><span class="num">${positions.length}</span></div>
        </div>
        <div class="rows">${positions.map((p) => { const pl = parseFloat(p.unrealized_pl); return `<div class="r"><div><div class="t">${esc(p.symbol)}</div><div class="s">${esc(p.qty)} @ ${px(+p.avg_entry_price)} · now ${px(+p.current_price)}</div></div><div class="v ${cls(pl)}">${arrow(pl)}${money(pl, true)}</div></div>`; }).join("") || `<p class="empty">No open Alpaca positions.</p>`}</div>`;
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
      const d = await (await fetch(`${ALPACA_DATA}/v2/stocks/trades/latest?feed=iex&symbols=${syms.join(",")}`, { headers: alpacaHeaders() })).json();
      for (const [s, t] of Object.entries(d.trades || {})) quotes[s] = t.p;
      renderPlans();
    } catch (e) { /* quotes are optional */ }
  }
  async function sendPlan(p) {
    const eq = alpacaEquity ?? S.settings.startCash;
    const qty = p.qty || Math.floor(sizeFor(p.entry, p.stop, eq, eq, S.settings));
    if (qty < 1) { alert("Size works out under 1 share with your risk settings."); return; }
    const ok = confirm(`PAPER order on Alpaca:\n\nBUY ${qty} ${p.symbol} limit ${p.entry}\nStop-loss ${p.stop} · Take-profit ${p.target}\nMax loss at stop ≈ ${money(qty * (p.entry - p.stop))}\n\nSend it?`);
    if (!ok) return;
    try {
      const o = await alpaca("/v2/orders", {
        method: "POST",
        body: JSON.stringify({ symbol: p.symbol, qty: String(qty), side: "buy", type: "limit", limit_price: String(p.entry), time_in_force: "day", order_class: "bracket", take_profit: { limit_price: String(p.target) }, stop_loss: { stop_price: String(p.stop) } }),
      });
      log(`Alpaca paper: sent BUY ${qty} ${p.symbol} bracket (${o.status})`);
      refreshAlpaca();
    } catch (e) { log(`Alpaca paper order failed: ${e.message}`); }
  }

  // ---------- rendering ----------
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
  let lastCoach = 0;
  function render() {
    const st = S.settings, eq = equity(), total = eq - st.startCash, tp = todayPnl(), lim = dailyLimit();
    const s = stats();
    if (Date.now() - lastCoach > 1500) { buildInsights(); lastCoach = Date.now(); renderCoach(); }

    $("statEquity").textContent = money(eq);
    $("statTotal").className = cls(total); $("statTotal").textContent = arrow(total) + money(total, true);
    $("statToday").className = cls(tp); $("statToday").textContent = arrow(tp) + money(tp, true);
    const open = Object.entries(S.positions);
    const inv = open.reduce((a, [k, p]) => a + p.qty * (market[k]?.price ?? p.entry), 0);
    $("kCash").textContent = money(S.cash);
    $("kInv").textContent = money(inv);
    $("kWin").textContent = s.n ? `${Math.round(s.winRate * 100)}% · ${s.n}` : "–";
    const used = Math.max(0, Math.min(1, -tp / lim));
    $("kLoss").textContent = `${Math.round(used * 100)}% of ${money(lim)}`;
    $("kLossBar").style.width = used * 100 + "%";
    $("kLossBar").style.background = used > 0.75 ? "var(--down)" : used > 0.4 ? "var(--warn)" : "var(--up)";

    for (const id of ["btnAuto", "btnAuto2"]) { $(id).textContent = S.auto ? "Pause autopilot" : "Start autopilot"; $(id).classList.toggle("on", S.auto); }

    // bot stats
    $("sNet").className = "num " + cls(s.net); $("sNet").textContent = s.n ? money(s.net, true) : "–";
    $("sPF").textContent = s.pf == null ? "–" : s.pf === Infinity ? "∞" : s.pf.toFixed(2);
    $("sAvg").textContent = s.n ? `${money(s.avgWin ?? 0)} / ${money(s.avgLoss ?? 0)}` : "–";
    $("sExp").className = "num " + cls(s.exp); $("sExp").textContent = s.exp == null ? "–" : money(s.exp, true);
    $("sDD").textContent = s.n ? pct(-s.dd * 100) : "–";
    $("sFees").textContent = money(s.fees);

    renderChips();
    renderChart();
    renderSpark();
    renderMarkets();
    renderBoard();
    renderMovers();
    renderBrain();
    gradeSignals();
    renderScore();
    renderNyse();

    $("posList").innerHTML = open.map(([k, p]) => {
      const now = market[k]?.price ?? p.entry, pl = p.qty * (now - p.entry) - p.fee, plPct = ((now - p.entry) / p.entry) * 100;
      return `<div class="r"><div><div class="t">${esc(coin(k))} <span class="muted small">${p.qty}</span></div><div class="s">in ${px(p.entry)} · stop ${px(p.stop)} · target ${px(p.target)}</div></div><div class="v ${cls(pl)}">${arrow(pl)}${money(pl, true)}<small>${pct(plPct)} · <button class="btn small" data-close="${esc(k)}">Close</button></small></div></div>`;
    }).join("") || `<p class="empty">No open positions. ${S.auto ? "The bot is watching for its setup." : "Start the autopilot to let the bot trade."}</p>`;

    const tl = S.trades.slice(0, 40).map((t) => `<div class="r"><div><div class="t">${esc(coin(t.sym))} <span class="muted small">${esc(t.why)}</span></div><div class="s">${hhmm(t.closed)} · ${px(t.entry)} → ${px(t.exit)}</div></div><div class="v ${cls(t.pnl)}">${arrow(t.pnl)}${money(t.pnl, true)}</div></div>`).join("") || `<p class="empty">No closed trades yet.</p>`;
    if ($("tradeList").dataset.h !== tl) { $("tradeList").innerHTML = tl; $("tradeList").dataset.h = tl; }
    const lg = S.log.slice(0, 50).map((l) => `<li><time>${hhmm(l.t)}</time><span>${esc(l.msg)}</span></li>`).join("") || `<li><span>Nothing yet. Press “Start autopilot” and keep this page open.</span></li>`;
    if ($("log").dataset.h !== lg) { $("log").innerHTML = lg; $("log").dataset.h = lg; }
  }

  const ICON = { good: "✓", bad: "!", watch: "~" };
  function renderCoach() {
    for (const n of ["", "2"]) {
      $("vIcon" + n).className = "v-icon " + verdict.lvl; $("vIcon" + n).textContent = ICON[verdict.lvl];
      $("vTitle" + n).textContent = verdict.title;
    }
    const li = (x) => `<li class="${x.lvl}"><strong>${esc(x.title)}</strong><span>${esc(x.text)}</span></li>`;
    const order = { bad: 0, good: 1, watch: 2 };
    $("vList").innerHTML = [...insights].sort((a, b) => order[a.lvl] - order[b.lvl]).slice(0, 3).map(li).join("");
    for (const [lvl, id] of [["good", "insGood"], ["bad", "insBad"], ["watch", "insWatch"]]) {
      $(id).innerHTML = insights.filter((x) => x.lvl === lvl).map(li).join("") || `<li class="none">Nothing right now.</li>`;
    }
    const bad = insights.filter((x) => x.lvl === "bad").length;
    $("coachBadge").hidden = !bad; $("coachBadge").textContent = bad;
    $("aiMode").textContent = S.settings.anthropicKey ? "Coach · Claude Opus 5.5" : "Coach · built-in rules (add a key in Settings for Claude)";
  }

  function renderChips() {
    const box = $("symChips"), syms = symbols().filter((s) => market[s]);
    if (box.childElementCount !== syms.length) box.innerHTML = syms.map((s) => `<button class="chip" data-sym="${esc(s)}"><span>${esc(coin(s))}</span><span class="num"></span></button>`).join("");
    box.querySelectorAll(".chip").forEach((el) => {
      const m = market[el.dataset.sym], ch = m.stats?.open ? ((m.price - m.stats.open) / m.stats.open) * 100 : 0;
      el.classList.toggle("sel", el.dataset.sym === selected);
      const n = el.querySelector(".num"); n.className = "num " + cls(ch); n.textContent = pct(ch);
    });
    document.querySelectorAll("#tfSeg button").forEach((b) => b.classList.toggle("on", +b.dataset.tf === tf()));
  }

  function renderMarkets() {
    if ($("view-markets").hidden) return;
    $("tfNote").textContent = `indicators on ${TF_NAME[tf()]} candles`;
    $("mktBody").innerHTML = symbols().filter((s) => market[s]).map((sym) => {
      const m = market[sym], k = metrics(sym), st = m.stats;
      const pos = st && st.high > st.low ? ((m.price - st.low) / (st.high - st.low)) * 100 : 50;
      return `<tr data-sym="${esc(sym)}">
        <td>${esc(coin(sym))}</td><td class="${m.dir > 0 ? "up" : m.dir < 0 ? "down" : ""}">${px(m.price)}</td><td class="${cls(k?.chg24)}">${pct(k?.chg24)}</td>
        <td title="${st ? `${px(st.low)} – ${px(st.high)}` : ""}"><div class="range"><i style="left:${Math.max(0, Math.min(100, pos))}%"></i></div></td>
        <td>${compact(st?.volume)}</td>
        <td>${k ? k.rsi.toFixed(0) : "–"}</td><td>${k ? k.atrPct.toFixed(2) + "%" : "–"}</td>
        <td>${k ? `<span class="tag ${k.trend === "up" ? "good" : k.trend === "down" ? "bad" : "watch"}">${k.trend === "up" ? "Up" : k.trend === "down" ? "Down" : "Choppy"}</span>` : "–"}</td>
        <td>${k ? `<span class="tag ${scoreLvl(k.score)}">${k.score > 0 ? "+" : ""}${k.score} ${k.label}</span>` : "–"}</td></tr>`;
    }).join("");
    // fear & greed
    if (fng) {
      const f = fng[0];
      $("fngVal").textContent = f.value; $("fngLab").textContent = f.label;
      $("fngWeek").innerHTML = [...fng].reverse().map((x) => `<div><b>${x.value}</b>${new Date(x.t).toLocaleDateString([], { weekday: "short" })}</div>`).join("");
      drawGauge(f.value);
    }
    // sessions
    const ses = [["New York (NYSE)", "America/New_York", 9, 30, 16, 0], ["London", "Europe/London", 8, 0, 16, 30], ["Tokyo", "Asia/Tokyo", 9, 0, 15, 0]];
    $("sessions").innerHTML = ses.map(([n, tz, a, b, c, d]) => {
      const x = sessionState(tz, a, b, c, d);
      return `<div class="r"><div><div class="t">${n}</div><div class="s">${x.open ? "closes" : "opens"} in ${dur(x.mins)}</div></div><div class="v"><span class="tag ${x.open ? "good" : ""}">${x.open ? "Open" : "Closed"}</span></div></div>`;
    }).join("") + `<div class="r"><div><div class="t">Crypto</div><div class="s">24/7</div></div><div class="v"><span class="tag good">Open</span></div></div>`;
  }
  function drawGauge(v) {
    const c = $("fngGauge"), g = c.getContext("2d"), W = c.width, H = c.height, cx = W / 2, cy = H - 10, r = 90;
    g.clearRect(0, 0, W, H);
    const stops = [["#f87171", 0], ["#fb923c", 0.25], ["#fbbf24", 0.5], ["#a3e635", 0.75], ["#34d399", 1]];
    for (let i = 0; i < 50; i++) {
      const a0 = Math.PI + (i / 50) * Math.PI, a1 = Math.PI + ((i + 1) / 50) * Math.PI, t = i / 49;
      let col = stops[0][0];
      for (const [cc, p] of stops) if (t >= p - 0.001) col = cc;
      g.strokeStyle = col; g.globalAlpha = 0.85; g.lineWidth = 14;
      g.beginPath(); g.arc(cx, cy, r, a0, a1 + 0.01); g.stroke();
    }
    g.globalAlpha = 1;
    const a = Math.PI + (v / 100) * Math.PI;
    g.strokeStyle = "#f4f4f8"; g.lineWidth = 3; g.lineCap = "round";
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (r - 18), cy + Math.sin(a) * (r - 18)); g.stroke();
    g.fillStyle = "#f4f4f8"; g.beginPath(); g.arc(cx, cy, 5, 0, Math.PI * 2); g.fill();
  }
  function renderNyse() {
    const n = nyse(), el = $("nyse");
    el.className = "pill " + (n.open ? "live" : "");
    el.lastElementChild.textContent = n.open ? `NYSE open · ${dur(n.mins)}` : `NYSE opens ${dur(n.mins)}`;
  }

  // ---------- charts ----------
  const canvas = $("chart"), ctx = canvas.getContext("2d");
  let hoverX = null;
  function fitCanvas(cv, h) {
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + "px"; }
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, h);
    return [g, W];
  }
  function renderChart() {
    const m = market[selected];
    if (!m || $("view-home").hidden) return;
    $("chartSym").textContent = selected;
    $("chartPx").textContent = px(m.price);
    const ch = m.stats?.open ? ((m.price - m.stats.open) / m.stats.open) * 100 : null;
    $("chartChg").className = "num " + cls(ch); $("chartChg").textContent = ch == null ? "" : `${arrow(ch)}${pct(ch)} 24h`;
    const H = canvas.clientWidth < 500 ? 330 : 420;
    const [g, W] = fitCanvas(canvas, H);
    const all = m.candles, ind = indicators(all);
    const n = Math.min(all.length, W < 500 ? 60 : 110), start = all.length - n, c = all.slice(start);
    const pos = S.positions[selected];
    let lo = Math.min(...c.map((b) => b.l)), hi = Math.max(...c.map((b) => b.h));
    if (pos) { lo = Math.min(lo, pos.stop); hi = Math.max(hi, pos.target); }
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const axisW = 66, plotW = W - axisW, step = plotW / n;
    const pTop = 6, pH = H * 0.64, vTop = pTop + pH + 4, vH = H * 0.1, rTop = vTop + vH + 14, rH = H - rTop - 18;
    const y = (v) => pTop + pH - ((v - lo) / (hi - lo)) * pH;
    const x = (i) => i * step + step / 2;
    const up = cssVar("--up"), down = cssVar("--down");

    g.font = "10.5px JetBrains Mono, monospace"; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4, yy = Math.round(y(v)) + 0.5;
      g.strokeStyle = "rgba(255,255,255,0.05)"; g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
      g.fillStyle = "rgba(244,244,248,0.45)"; g.fillText(px(v), plotW + 6, yy + 4);
    }
    for (let i = 0; i < n; i += Math.ceil(n / 5)) g.fillText(hhmm(c[i].t * 1000), x(i) - 15, H - 3);

    // candles
    c.forEach((b, i) => {
      const col = b.c >= b.o ? up : down;
      g.strokeStyle = col; g.fillStyle = col;
      g.beginPath(); g.moveTo(x(i), y(b.h)); g.lineTo(x(i), y(b.l)); g.stroke();
      const top = y(Math.max(b.o, b.c)), bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      g.fillRect(x(i) - Math.max(1, step * 0.32), top, Math.max(2, step * 0.64), bh);
    });
    // EMAs
    [["e9", "--ema1"], ["e21", "--ema2"], ["e50", "--ema3"]].forEach(([k, col]) => {
      g.strokeStyle = cssVar(col); g.lineWidth = 1.6; g.beginPath();
      let s0 = false;
      for (let i = 0; i < n; i++) { const v = ind[k][start + i]; if (v == null) continue; s0 ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)); s0 = true; }
      g.stroke();
    });
    // volume
    const vmax = Math.max(...c.map((b) => b.v)) || 1;
    c.forEach((b, i) => { g.fillStyle = b.c >= b.o ? "rgba(52,211,153,.35)" : "rgba(248,113,113,.35)"; const h = (b.v / vmax) * vH; g.fillRect(x(i) - Math.max(1, step * 0.32), vTop + vH - h, Math.max(2, step * 0.64), h); });
    // RSI panel
    g.strokeStyle = "rgba(255,255,255,0.08)"; g.strokeRect(0.5, rTop + 0.5, plotW - 1, rH);
    const ry = (v) => rTop + rH - (v / 100) * rH;
    g.fillStyle = "rgba(255,255,255,0.03)"; g.fillRect(0, ry(70), plotW, ry(30) - ry(70));
    g.setLineDash([3, 3]); g.strokeStyle = "rgba(255,255,255,0.15)";
    [30, 70].forEach((v) => { g.beginPath(); g.moveTo(0, ry(v)); g.lineTo(plotW, ry(v)); g.stroke(); g.fillStyle = "rgba(244,244,248,0.4)"; g.fillText(String(v), plotW + 6, ry(v) + 4); });
    g.setLineDash([]);
    g.strokeStyle = cssVar("--rsi"); g.lineWidth = 1.5; g.beginPath();
    let r0 = false;
    for (let i = 0; i < n; i++) { const v = ind.rsi[start + i]; if (v == null) continue; r0 ? g.lineTo(x(i), ry(v)) : g.moveTo(x(i), ry(v)); r0 = true; }
    g.stroke();
    // position levels
    if (pos) {
      [[pos.entry, "rgba(244,244,248,.7)", "entry"], [pos.stop, down, "stop"], [pos.target, up, "target"]].forEach(([v, col, lab]) => {
        g.strokeStyle = col; g.setLineDash([5, 4]); g.lineWidth = 1; g.beginPath(); g.moveTo(0, y(v)); g.lineTo(plotW, y(v)); g.stroke(); g.setLineDash([]);
        g.fillStyle = col; g.fillText(lab, 6, y(v) - 4);
      });
    }
    // last price tag
    const last = c.at(-1).c;
    g.fillStyle = last >= c.at(-1).o ? up : down; g.fillRect(plotW, y(last) - 9, axisW, 18);
    g.fillStyle = "#07080d"; g.fillText(px(last), plotW + 5, y(last) + 4);
    // crosshair
    const tip = $("tip");
    if (hoverX != null && hoverX < plotW) {
      const i = Math.max(0, Math.min(n - 1, Math.floor(hoverX / step))), b = c[i], rv = ind.rsi[start + i];
      g.strokeStyle = "rgba(255,255,255,.25)"; g.beginPath(); g.moveTo(x(i), 0); g.lineTo(x(i), H - 14); g.stroke();
      tip.hidden = false;
      tip.innerHTML = `${hhmm(b.t * 1000)}<br>O ${px(b.o)} H ${px(b.h)}<br>L ${px(b.l)} C ${px(b.c)}<br>Vol ${compact(b.v)} · RSI ${rv == null ? "–" : rv.toFixed(0)}`;
      tip.style.left = (x(i) + 170 > W ? x(i) - 172 : x(i) + 12) + "px"; tip.style.top = "8px";
    } else tip.hidden = true;

    const k = metrics(selected);
    let msg;
    if (!k) msg = "Warming up: need 60 candles before the bot can trade this.";
    else if (pos) msg = `In a trade. Exits at ${px(pos.stop)} (stop), ${px(pos.target)} (target), or if EMA 9 drops under EMA 21.`;
    else if (k.price <= k.e50) msg = `Price is under EMA 50 (${px(k.e50)}), so the bot won't buy: it only trades with the trend.`;
    else if (k.e9 > k.e21) msg = "Uptrend, but the bot waits for a fresh cross (EMA 9 back under 21, then over) to enter.";
    else msg = `Above EMA 50. Buy triggers when EMA 9 (${px(k.e9)}) closes a candle above EMA 21 (${px(k.e21)}).`;
    $("signalNow").textContent = (S.auto ? "Autopilot ON. " : "Autopilot off. ") + msg;
  }
  function renderSpark() {
    if ($("view-home").hidden) return;
    const cv = $("spark"), h = cv.clientHeight || 70;
    const [g, W] = fitCanvas(cv, h);
    const pts = [...S.eqHist, { t: Date.now(), eq: equity() }];
    if (pts.length < 2) { g.strokeStyle = "rgba(255,255,255,.15)"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, h / 2); g.lineTo(W, h / 2); g.stroke(); g.setLineDash([]); return; }
    const lo = Math.min(...pts.map((p) => p.eq)), hi = Math.max(...pts.map((p) => p.eq)), span = hi - lo || 1;
    const t0 = pts[0].t, t1 = pts.at(-1).t || t0 + 1;
    const X = (t) => ((t - t0) / (t1 - t0 || 1)) * W, Y = (v) => h - 4 - ((v - lo) / span) * (h - 8);
    // glowing bars: one per time slot, height = equity in that slot
    const n = Math.max(12, Math.min(48, Math.floor(W / 9))), bw = W / n;
    const slots = Array.from({ length: n }, (_, i) => { const t = t0 + ((t1 - t0) * (i + 1)) / n; let v = pts[0].eq; for (const p of pts) if (p.t <= t) v = p.eq; return v; });
    const grad = g.createLinearGradient(0, 0, 0, h); const sc = getComputedStyle(cv).getPropertyValue("--spark").trim() || cssVar("--accent-1");
    grad.addColorStop(0, sc); grad.addColorStop(1, "rgba(255,255,255,.12)");
    g.shadowColor = sc; g.shadowBlur = 10; g.fillStyle = grad;
    slots.forEach((v, i) => { const y = Y(v); g.beginPath(); g.roundRect(i * bw + bw * 0.28, y, bw * 0.44, h - y, 3); g.fill(); });
    g.shadowBlur = 0; void X;
  }

  canvas.addEventListener("pointermove", (e) => { hoverX = e.offsetX; queueRender(); });
  canvas.addEventListener("pointerleave", () => { hoverX = null; queueRender(); });
  window.addEventListener("resize", queueRender);

  // ---------- navigation ----------
  function route() {
    const v = (location.hash || "#home").slice(1);
    const view = ["home", "markets", "bot", "coach", "settings"].includes(v) ? v : "home";
    document.querySelectorAll(".view").forEach((el) => (el.hidden = el.dataset.view !== view));
    document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === view));
    window.scrollTo(0, 0);
    queueRender();
  }
  window.addEventListener("hashchange", route);

  // ---------- UI wiring ----------
  $("symChips").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) { selected = b.dataset.sym; queueRender(); } });
  $("mktBody").addEventListener("click", (e) => { const r = e.target.closest("tr"); if (r) { selected = r.dataset.sym; location.hash = "#home"; } });
  $("tfSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || +b.dataset.tf === tf()) return;
    S.settings.tf = +b.dataset.tf; btSummary = null; $("btCard").hidden = true; save();
    log(`Timeframe switched to ${TF_NAME[tf()]} candles.`);
    boot();
  });
  $("posList").addEventListener("click", (e) => { const s = e.target.closest("[data-close]")?.dataset.close; if (s) closePosition(s, market[s]?.price ?? S.positions[s].entry, "closed by you"); });
  $("plans").addEventListener("click", (e) => { const i = e.target.closest("[data-plan]")?.dataset.plan; if (i != null) sendPlan(plans[+i]); });
  const toggleAuto = () => { S.auto = !S.auto; log(S.auto ? "Autopilot started. It trades while this page stays open." : "Autopilot paused. Open positions keep their stops and targets."); };
  $("btnAuto").addEventListener("click", toggleAuto);
  $("btnAuto2").addEventListener("click", toggleAuto);
  $("btnBacktest").addEventListener("click", backtest);
  $("btnSignals").addEventListener("click", loadSignals);
  $("quick").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) ask(b.textContent); });
  $("askForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("askInput").value; $("askInput").value = ""; ask(q); });

  const form = $("settings");
  function fillForm() { for (const [k, v] of Object.entries(S.settings)) if (form.elements[k]) form.elements[k].value = v; }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = form.elements, oldSyms = S.settings.symbols;
    S.settings = {
      ...S.settings,
      riskPct: +f.riskPct.value || 1, dailyLossPct: +f.dailyLossPct.value || 3, maxPosPct: +f.maxPosPct.value || 25,
      startCash: +f.startCash.value || 10000, symbols: f.symbols.value || DEFAULTS.settings.symbols,
      alpacaKey: f.alpacaKey.value.trim(), alpacaSecret: f.alpacaSecret.value.trim(), anthropicKey: f.anthropicKey.value.trim(),
    };
    convo = [];
    log("Settings saved.");
    if (S.settings.symbols !== oldSyms) boot();
    refreshAlpaca(); loadSignals();
  });
  $("btnReset").addEventListener("click", () => {
    if (!confirm("Wipe the simulated account (cash, positions, trades)? Settings and keys stay.")) return;
    S = { ...structuredClone(DEFAULTS), settings: S.settings, cash: S.settings.startCash };
    log(`Paper account reset to ${money(S.cash)}.`);
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // record equity once a minute for the sparkline
  setInterval(() => {
    if (!Object.keys(market).length) return;
    S.eqHist.push({ t: Date.now(), eq: +equity().toFixed(2) });
    if (S.eqHist.length > 2000) S.eqHist.shift();
    save();
  }, 60000);

  fillForm();
  route();
  addMsg("ai", "Hi! I'm your coach. I watch the market and your bot and tell you what's good and bad for us. Tap a question below or ask your own.");
  boot();
  loadSignals();
  loadFng();
  loadBoard(); loadFx();
  setInterval(loadBoard, 60000);
  setInterval(loadFx, 60 * 60000);
  $("sigRings").addEventListener("click", (e) => { const b = e.target.closest("[data-sym]"); if (b) { selected = b.dataset.sym; queueRender(); $("chart").scrollIntoView({ behavior: "smooth", block: "center" }); } });
  $("boardTabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { boardCat = b.dataset.cat; renderBoard(); } });
  $("boardBody").addEventListener("click", (e) => {
    const s = e.target.closest("[data-add]")?.dataset.add;
    if (!s) return;
    S.settings.symbols = [...symbols(), s].join(", "); save(); fillForm();
    log(`${coin(s)} added to the bot's markets.`); boot();
  });
  refreshAlpaca();
  setInterval(refreshAlpaca, 30000);
  setInterval(loadSignals, 120000);
  setInterval(refreshStats, 60000);
  setInterval(loadFng, 30 * 60000);
  setInterval(queueRender, 30000); // keep clocks fresh when the market is quiet
  document.addEventListener("visibilitychange", () => { if (!document.hidden && (!ws || ws.readyState > 1)) connect(); });
})();
