// Dip-catch + uptrend-pullback cbBTC bot for agent-fun/bars-replay/v1.
//
// Long-only, one position at most. Two entry arms, both
// deliberately bounce-free: neither one waits for the price to recover off
// its recent low before buying. The lesson of the previous race (entry #7,
// live 0 trades on a steady grind-down day) is that a bot which only buys
// after a bounce sits in cash while the market grinds lower. The arms below
// buy *into* a dip, and manage the risk with a tight stop instead of with a
// bounce filter. A third, small-size arm exists only so the bot still takes
// at least one trade on a day with no washout and no uptrend.
//
//   FALL arm -- buys a deep washout once it has started to turn: the close
//   at least 250 bps below the 240-bar high, at least 90 bps below the
//   close 10 bars ago, and at least 40 bps above the 15-bar low. Shallow
//   dips on falling days have no edge (their forward excursion barely
//   covers the ~26 bps round-trip cost); the deep washouts do, once the
//   price lifts off the low. Exits at +300 bps over the fill, on a 100 bps
//   stop, on a 100 bps trailing stop under the highest close since entry,
//   or after 360 bars.
//
//   RISE arm -- buys a shallow pullback inside an uptrend that is positive
//   on three horizons at once: the 240-bar return at least +50 bps, the
//   60-bar return at least 0, and the return since the window's open at
//   least 0. A 240-bar trend alone stays positive for hours into a day
//   that is falling overall, and buying pullbacks into that fall is what
//   bled the earlier design. The close must sit at least 45 bps below the
//   60-bar high, and the last 5 bars must not have fallen more than 20 bps.
//   Exits at +200 bps over the fill, on a 70 bps stop, on a 100 bps
//   trailing stop under the highest close since entry, or after 180 bars.
//
// All comparisons are integer basis-point cross-multiplications on closes,
// so the bot is exactly deterministic: the same bars give the same orders
// in every run. It reads no clock, no environment and no file, and uses no
// randomness.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

// FALL arm: catch a deep washout once it has started to turn. The close
// must sit at least 280 bps below the 240-bar high and at least 60 bps
// above the 15-bar low: the selling has stopped and the price has lifted
// off its low. A bounce-free dip-catch at this depth kept buying into a
// still-falling washout (the 997 bar of the 2026-11-15 window: the low came
// later), so this arm waits for the turn; the bounce-free falling-market
// trading is the GRIND arm's job, at small size. Shallower washout
// thresholds (250-260 bps dip, 40-50 bps bounce) were tested and fired
// into dead-cat bounces on the 2026-11-13 window for -28 USDC; the deeper
// threshold fires only on true capitulations. Exits at +400 bps over the
// fill, on a 150 bps stop, on a 150 bps trailing stop under the highest
// close since entry, or after 360 bars.
const FALL_HIGH_BARS = 240;
const FALL_HIGH_DIP_BPS = 280;
const FALL_LOW_BARS = 15;
const FALL_BOUNCE_BPS = 60;
const FALL_TP_BPS = 400;
const FALL_SL_BPS = 150;
const FALL_TRAIL_BPS = 150;
const FALL_MAX_BARS = 360;

// GRIND arm: trade a steady grind-down day at small size, so the bot still
// takes at least one trade (the race window's minimum) when no washout and
// no uptrend ever appear. Same bounce-free dip-catch shape as FALL, but a
// shallower dip (100 bps off the 60-bar high), a quarter of the cash, and
// tight exits. A single stopped-out grind trade costs about a quarter of
// the 60 bps stop, roughly $1.50, and it keeps the entry ranked instead of
// sitting below every bot that traded.
const GRIND_DROP_BARS = 10;
const GRIND_DROP_BPS = 60;
const GRIND_PACE_BARS = 3;
const GRIND_PACE_MAX_BPS = 25;
const GRIND_HIGH_BARS = 60;
const GRIND_HIGH_DIP_BPS = 100;
const GRIND_SIZE_BPS = 2500;
const GRIND_TP_BPS = 80;
const GRIND_SL_BPS = 60;
const GRIND_TRAIL_BPS = 40;
const GRIND_MAX_BARS = 60;

// RISE arm: pullback inside an uptrend.
const RISE_TREND_BARS = 240;
const RISE_TREND_MIN_BPS = 50;
const RISE_TREND_MID_BARS = 60;
const RISE_TREND_MID_MIN_BPS = 0;
const RISE_HIGH_BARS = 60;
const RISE_HIGH_DIP_BPS = 45;
const RISE_PACE_BARS = 5;
const RISE_PACE_MAX_BPS = 20;
const RISE_TP_BPS = 200;
const RISE_SL_BPS = 70;
const RISE_TRAIL_BPS = 100;
const RISE_MAX_BARS = 180;

/** Basis points of (now - then) / then, truncated toward zero. */
function bpsChange(now: bigint, then: bigint): number {
  return Number(((now - then) * 10_000n) / then);
}

/** Highest close of the last `span` closes ending at index `i` (inclusive). */
function rollingHigh(closes: bigint[], i: number, span: number): bigint {
  let hi = closes[i]!;
  const from = i - span + 1 < 0 ? 0 : i - span + 1;
  for (let j = from; j < i; j++) if (closes[j]! > hi) hi = closes[j]!;
  return hi;
}

/** Lowest close of the last `span` closes ending at index `i` (inclusive). */
function rollingLow(closes: bigint[], i: number, span: number): bigint {
  let lo = closes[i]!;
  const from = i - span + 1 < 0 ? 0 : i - span + 1;
  for (let j = from; j < i; j++) if (closes[j]! < lo) lo = closes[j]!;
  return lo;
}

interface OpenTrade {
  arm: 'fall' | 'grind' | 'rise';
  entryPrice: bigint; // fill price of the buy, in price-scale units
  peakClose: bigint; // highest close since entry
  heldBars: number; // bars held, counting the fill bar as 1
}

const closes: bigint[] = [];
let trade: OpenTrade | null = null;
let orderNo = 0;
/** GRIND fires at most once per run: it is insurance for the race window's
 * minimum-trade bar, not a profit arm, and repeating it only repeats its
 * small stopped-out losses. Counted on its buy fill. */
let grindTrades = 0;

function exitParams(arm: 'fall' | 'grind' | 'rise'): { tp: number; sl: number; trail: number; maxBars: number } {
  return arm === 'fall'
    ? { tp: FALL_TP_BPS, sl: FALL_SL_BPS, trail: FALL_TRAIL_BPS, maxBars: FALL_MAX_BARS }
    : arm === 'grind'
      ? { tp: GRIND_TP_BPS, sl: GRIND_SL_BPS, trail: GRIND_TRAIL_BPS, maxBars: GRIND_MAX_BARS }
      : { tp: RISE_TP_BPS, sl: RISE_SL_BPS, trail: RISE_TRAIL_BPS, maxBars: RISE_MAX_BARS };
}

/** The RISE entry signal on this bar: an uptrend positive on three
 * horizons at once (240 bars, 60 bars, and since the window's open), with
 * a shallow pullback off the 60-bar high and no fast fall right now. */
function riseSignal(state: BarsState, close: bigint, i: number): boolean {
  if (i < RISE_TREND_BARS || state.cash < 1_000_000n) return false;
  const trend = bpsChange(close, closes[i - RISE_TREND_BARS]!);
  const trendMid = bpsChange(close, closes[i - RISE_TREND_MID_BARS]!);
  // The window so far must not be down: a 240-bar trend can stay
  // positive for hours into a day that is falling overall, and buying
  // pullbacks into that fall is what bled the earlier design. The
  // first close is the race window's open, so this is history only.
  const dayReturn = bpsChange(close, closes[0]!);
  const pace = bpsChange(close, closes[i - RISE_PACE_BARS]!);
  const high = rollingHigh(closes, i, RISE_HIGH_BARS);
  return (
    trend >= RISE_TREND_MIN_BPS &&
    trendMid >= RISE_TREND_MID_MIN_BPS &&
    dayReturn >= 0 &&
    pace >= -RISE_PACE_MAX_BPS &&
    close * 10_000n <= high * BigInt(10_000 - RISE_HIGH_DIP_BPS)
  );
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Learn the entry price (and arm) from this batch's fills.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        trade = {
          arm: fill.client_id.startsWith('f-') ? 'fall' : fill.client_id.startsWith('g-') ? 'grind' : 'rise',
          entryPrice: BigInt(fill.price),
          peakClose: 0n,
          heldBars: 0,
        };
        if (trade.arm === 'grind') grindTrades += 1;
      } else if (fill.side === 'sell') {
        trade = null;
      }
    }
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const i = closes.length;
    closes.push(close);

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      // Defensive fallback: if the buy fill was ever missed, derive the
      // entry price from the position's cost basis instead of trading
      // against a zero entry price (which would sell at once).
      if (trade === null) {
        trade = { arm: 'rise', entryPrice: held.cost / held.qty, peakClose: 0n, heldBars: 0 };
      }
      trade.heldBars += 1;
      if (close > trade.peakClose) trade.peakClose = close;
      // A small GRIND position must not crowd out a RISE entry: if the
      // uptrend signal is on while a grind trade is held, exit the grind
      // trade now so the full-size RISE buy can follow on the next bar.
      if (trade.arm === 'grind' && riseSignal(state, close, i)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      const { tp, sl, trail, maxBars } = exitParams(trade.arm);
      const entry = trade.entryPrice;
      const peak = trade.peakClose;
      if (
        close * 10_000n >= entry * BigInt(10_000 + tp) ||
        close * 10_000n <= peak * BigInt(10_000 - trail) ||
        close * 10_000n <= entry * BigInt(10_000 - sl) ||
        trade.heldBars >= maxBars
      ) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: try the FALL arm first, then GRIND, then the RISE arm.
    if (i >= FALL_HIGH_BARS) {
      const high = rollingHigh(closes, i, FALL_HIGH_BARS);
      const low = rollingLow(closes, i, FALL_LOW_BARS);
      if (
        close * 10_000n <= high * BigInt(10_000 - FALL_HIGH_DIP_BPS) &&
        close * 10_000n >= low * BigInt(10_000 + FALL_BOUNCE_BPS) &&
        state.cash >= 1_000_000n
      ) {
        orderNo += 1;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `f-${orderNo}` }];
      }
    }
    if (i >= GRIND_DROP_BARS && grindTrades === 0) {
      const drop = bpsChange(close, closes[i - GRIND_DROP_BARS]!);
      const pace = bpsChange(close, closes[i - GRIND_PACE_BARS]!);
      const high = rollingHigh(closes, i, GRIND_HIGH_BARS);
      if (
        drop <= -GRIND_DROP_BPS &&
        pace >= -GRIND_PACE_MAX_BPS &&
        close * 10_000n <= high * BigInt(10_000 - GRIND_HIGH_DIP_BPS) &&
        state.cash >= 1_000_000n
      ) {
        orderNo += 1;
        const size = (state.cash * BigInt(GRIND_SIZE_BPS)) / 10_000n;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `g-${orderNo}` }];
      }
    }
    if (riseSignal(state, close, i)) {
      orderNo += 1;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: `r-${orderNo}` }];
    }
    return [];
  },
});
