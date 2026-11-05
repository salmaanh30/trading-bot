# Autopilot Trading Bot

Live paper-trading bot that runs in the browser. Live site: https://salmaanh30.github.io/trading-bot/

- **Live prices:** Coinbase public feed (no key), 1-minute candles.
- **Strategy:** EMA 9 crosses above EMA 21 while price is above EMA 50 → buy. Stop = entry − 1.5×ATR(14), target = entry + 3×ATR (2R). Exits early if EMA 9 crosses back under 21.
- **Risk rules:** 1% of equity risked per trade, max 25% of equity per position, 3% daily loss limit, 0.1% fee per side. All editable in Settings.
- **Simulated money** by default. The autopilot only runs while the page is open.
- **Alpaca paper** (optional): paste paper keys in Settings. They're stored only in that browser. Every order asks first. Live trading is deliberately not wired up.

## Claude's trade plans: `signals.json`

The Claude session `salmaan-first-trail-trade-test` writes trade plans here and pushes; the site shows them within 2 minutes (or on Refresh).

```json
{
  "updated": "2026-11-05T14:45:00Z",
  "source": "salmaan-first-trail-trade-test",
  "note": "one-line summary of the scan",
  "plans": [
    {
      "symbol": "TSLA",
      "side": "long",
      "status": "watching | triggered | done",
      "setup": "Opening-range breakout above 15-min high",
      "entry": 250.10,
      "stop": 247.80,
      "target": 254.70,
      "qty": 10,
      "notes": "why, news, time-machine odds"
    }
  ]
}
```

`qty` is optional (the site sizes it from your risk % if left out). Numbers, not strings.

## Run locally

```
python "C:\reppy repo\serve.py"
```
then open http://localhost:5500/trading-bot/

*Education and paper trading only. No strategy is guaranteed to make money.*
