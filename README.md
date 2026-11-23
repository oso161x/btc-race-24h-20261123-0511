[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/oso161x/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/oso161x/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# Three-arm cbBTC bot — btc-race-24h-20261123-0511

Long-only bot trading Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute
on-chain bars, for the make.fun `bars-replay/v1` harness. TypeScript (Node 22),
standard library only, plus the kit's TypeScript SDK shim vendored byte-identical
under `vendor/`.

## Strategy

One position at most, `max_slippage_bps` 100. Three entry arms, checked in
this order on every flat bar:

- **FALL arm (washout)** — buys a deep sell-off once it has started to turn:
  close at least 280 bps below the 240-bar high and at least 60 bps above
  the 15-bar low. Exits at +400 bps over the fill price, on a 150 bps
  trailing stop under the highest close since entry, on a 150 bps stop, or
  after 360 bars.
- **GRIND arm (falling-market insurance)** — the bounce-free arm. Buys a
  shallower dip while the market grinds down: close at least 100 bps below
  the 60-bar high and at least 60 bps below the close 10 bars ago, while
  the last 3 bars fell no more than 25 bps (the selling is decelerating, but
  the price may still be printing fresh lows). Quarter of the cash only,
  once per run, tight exits (+80 / -60 / 40 trail / 60 bars). Its job is to
  make sure the bot still takes at least one trade on a day with no washout
  and no uptrend — the previous race's bot made zero trades live on such a
  day and ranked below every bot that traded. A stopped-out grind trade
  costs about $1.50.
- **RISE arm (uptrend pullback)** — buys a shallow pullback inside an
  uptrend that is positive on three horizons at once: the 240-bar return at
  least +50 bps, the 60-bar return at least 0, and the return since the
  window's open at least 0. A 240-bar trend alone stays positive for hours
  into a day that is falling overall, and buying pullbacks into that fall is
  what bled the earlier design. The close must sit at least 45 bps below
  the 60-bar high, and the last 5 bars must not have fallen more than
  20 bps. Exits at +200 bps over the fill, on a 70 bps stop, on a 100 bps
  trailing stop, or after 180 bars. A small GRIND position never crowds out
  a RISE entry: when the RISE signal is on while a grind trade is held, the
  grind trade is exited at once so the full-size RISE buy can follow.

All decisions are integer basis-point comparisons on closes, so the bot is
exactly deterministic: the same bars give the same orders in every run. It
reads no clock, no environment and no file, and uses no randomness.

## Local verification (wire-protocol driver, real `main.ts`, two runs each)

The driver replays a window's bars through the bot over the wire protocol
and applies the harness's published fill model (4 bps fee, 2 bps slippage,
constant-product impact against the bar's open depth, fills at the next
bar's open). Reply logs are byte-identical across the two runs of each
window.

| window | BTC return | net PnL | trades | max drawdown |
| --- | --- | --- | --- | --- |
| 2026-11-12 | -2.29% | +0.85 USDC | 1 | 0.09% |
| 2026-11-13 | -4.91% | +8.93 USDC | 2 | 1.08% |
| 2026-11-15 | -4.00% | +31.34 USDC | 3 | 2.69% |
| 2026-11-22/23 dev (this race) | +3.63% | **+17.66 USDC** | 3 | 1.25% |

The dev gate needs net PnL above 0 on the 2026-11-22/23 dev window: this bot
clears it by $17.66, with 3 trades and 1.25% maximum drawdown (guardrail:
25%). Every tested window, falling or rising, makes at least one trade.

## Files

- `main.ts` — the bot (entrypoint).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's TypeScript SDK shim.
- `LICENSE` — MIT.
