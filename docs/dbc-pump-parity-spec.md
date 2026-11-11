# DBC pump.fun parity spec

Goal: match pump.fun curve and fees on Meteora DBC.

Quote mint is wSOL. Base token is SPL with 6 decimals.

## 1. pump.fun values (2026)

Total supply: 1B tokens.
Curve sells: ~793.1M tokens, not ~800M round number.
Left for migration: ~206.9M tokens.
Source: pump.fun virtual reserves math, solana.stackexchange curve progress, solbundler calculator, tradingcalc calculator.

Virtual reserves at launch:
- 30 virtual SOL.
- 1,073,000,000 virtual tokens.
Source: solbundler market-cap calculator, tradingcalc bonding-curve calculator, solana.stackexchange pumpfun thread.

Graduation rule: real SOL collected = 85 SOL. Virtual SOL goes 30 -> 115.
Then it migrates.
Old mcap tag: ~$69k. SOL price moved, but 85 SOL rule stays.
Source: soltokencreator graduation 2026, crypto.news, arxiv 2602.14860.

Fees on curve: 1.25% per swap. Buy and sell same.
Split: 0.30% creator, 0.95% protocol, 0% LP share.
Source: BloFin fees 2026, Froglabs fees 2026. Both cite pump.fun fee schedule May 20 2026.

Creation: 0 SOL. Only network fee.
Source: BloFin, pump.fun create-coin docs.

Graduation fee: flat 0.015 SOL at migration.
Old guides say 1.5 SOL. That is wrong now. 100x too high.
Migrates to PumpSwap, not Raydium.
Source: BloFin graduation fee guide, pump.fun fee schedule.

After graduation: PumpSwap ~0.25% per swap. Creator gets ~0.05%.
Source: soltokencreator graduation guide.

Stale numbers to ignore: 1% fee, 1.5 SOL graduation, Raydium migration. All are 2024.

## 2. DBC config to match

Program: `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`.
Source: Meteora DBC docs, MeteoraAg dynamic-bonding-curve README.

| DBC field | Parity value | Note |
|---|---|---|
| `quote_mint` | wSOL `So11111111111111111111111111111111111111112` | SOL pair like pump.fun |
| `token_type` | 0 = SPL | Simple. No Token-2022 |
| `token_decimal` | 6 | pump.fun uses 6 |
| `token_supply` fixed | pre 1B, post 1B | 1B = 1,000,000,000 * 10^6 units. Leftover to `leftover_receiver` |
| `swap_base_amount` target | 793,086,956.5 tokens | = 793086956500000 microtokens. Derived from curve |
| `migration_base_threshold` target | 206,913,043.5 tokens | 1B minus sold. For DAMM seed |
| `migration_quote_threshold` | 85 SOL = 85,000,000,000 lamports | Matches pump.fun 85 SOL real inflow |
| `migration_option` | 1 = DAMM v2 | DAMM v1 is dead for new configs |
| `migration_fee_option` | 0 = 25 bps | Matches PumpSwap 0.25% |
| `collect_fee_mode` | 0 = QuoteToken | Fees in SOL, like pump.fun |
| `pool_fees.base_fee` | fixed 1.25% = numerator 12,500,000 | Denominator is 1,000,000,000. Min is 0.25%, max total 99%. Source: DBC fees docs |
| `pool_fees.dynamic_fee` | off | Keep flat like pump.fun |
| `base_fee_mode` | fixed scheduler | Linear or exponential with same start and end = fixed |
| `activation_type` | 1 = timestamp | Simple |
| `creator_trading_fee_percentage` | 30 for parity, 0 for max short | See section 4. 30 mirrors pump.fun 0.30%. 0 sends all to fee-short program |
| `fee_claimer` | fee-short program PDA | Claims partner fees. For parity test can be wallet, for mission must be program |
| `creator` | fee-short program PDA or same as partner | Use same PDA to keep 100% in program when in max-short mode |
| `partner_lp_percentage` / `creator_lp_percentage` | 0 unlocked | Mimic burn. All locked or vesting |
| `partner_locked_lp_percentage` + `creator_locked_lp_percentage` + vesting | = 100% | Must sum to 100%. At least 10% locked after day 1. Source: DBC launch config docs |
| `migration_fee` partner share | 0% | Keep simple. Only DAMM 0.25% + DBC protocol fee |
| `pool creation fee` | 0 | pump.fun creation is free |
| `sqrt_start_price` + `curve` | 1 segment, pump.fun prices | See section 3. SDK inputs included |

## 3. Curve

pump.fun does NOT start near zero. It starts at virtual price.

Math: `x * y = k`.
- `x0 = 30 SOL` virtual.
- `y0 = 1,073,000,000` tokens virtual.
- `k = 30 * 1,073,000,000 = 32,190,000,000`.
Source: solbundler, tradingcalc, solana.stackexchange.

Start price:
- `P0 = 30 / 1,073,000,000 = 2.7958993476e-08 SOL per token`.
- `sqrt(P0) = 1.67209429986e-04`.
- Start mcap = `P0 * 1B = 27.959 SOL`.

End price at 85 SOL collected:
- Virtual SOL = 115. Virtual tokens = `k / 115 = 279,913,043.5`.
- Sold = `1,073,000,000 - 279,913,043.5 = 793,086,956.5`.
- For 1B supply, migration tokens = `206,913,043.5`.
- `P1 = 115 / 279,913,043.5 = 4.1084187636e-07 SOL per token`.
- `sqrt(P1) = 6.40969481613e-04`.
- End mcap = `P1 * 1B = 410.842 SOL`.

DBC 1-segment match. Formulas from DBC formulas docs:
- `Quote = L * (sqrt(P1) - sqrt(P0))`.
- `Base = L * (1/sqrt(P0) - 1/sqrt(P1))`.

Solve for `L` with Quote = 85 SOL:
- `L_human = 85 / (6.40969481613e-04 - 1.67209429986e-04) = 179,415.718`.
- Check Base = `179,415.718 * (1/sqrt(P0) - 1/sqrt(P1)) = 793,086,956.5`. Matches.

Raw units (lamports and microtokens, 6-dec base, 9-dec quote):
- `P0_raw = P0 * 1000 = 2.7958993476e-05`.
- `P1_raw = 4.1084187636e-04`.
- `L_raw = 85e9 / (sqrt(P1_raw) - sqrt(P0_raw)) = 5,673,623,181,001.7`.
- Base raw = `793,086,956,500,000` microtokens.

On-chain Q64.64 (2^64 scale):
- Human-price scale: `sqrt_start ≈ 3,084,469,561,662,146`, `sqrt_end ≈ 11,823,799,986,371,562`.
- Raw-price scale: `sqrt_start_raw ≈ 97,539,491,883,135,584`, `sqrt_end_raw ≈ 373,901,385,552,019,776`.
- SDK is source of truth. Use SDK call below and log outputs. Our numbers are the check values.

SDK inputs (TypeScript SDK 2.0):
```ts
import { TokenDecimal, buildCurveWithCustomSqrtPrices, createSqrtPrices } from "@meteora-ag/dynamic-bonding-curve-sdk";

const P0 = 30 / 1_073_000_000; // 2.7958993476e-08
const P1 = 115 / 279913043.5; // 4.1084187636e-07

const sqrtPrices = createSqrtPrices(
  [P0, P1],
  TokenDecimal.SIX,
  TokenDecimal.NINE
);

const curve = buildCurveWithCustomSqrtPrices({
  // ... token, fee, migration, liquidityDistribution ...
  sqrtPrices, // index 0 = start, index 1 = end
  liquidityWeights: [1], // 1 segment
  // activationType: Timestamp
});
// Expect: config.sqrt_start_price ~ start Q64 above
// Expect: config.curve[0].sqrt_price ~ end Q64 above
// Expect: config.curve[0].liquidity ~ 5.67e12 raw scale
// Expect: derived swap_base_amount ~ 793,086,956.5 tokens
// Expect: derived migration_quote_threshold = 85 SOL
```

Rules:
- Max 16 points allowed, 20 stored on chain. We use 1 segment, 2 prices.
- Prices must rise. `P1 > P0`. Yes, ~14.7x.
- Start sqrt price >= `4295048016`. Yes, ours is ~3e15.
- Migration sqrt price < `79226673521066979257578248091`. Yes.
- Threshold must be reachable. Yes by construction.
Source: DBC universal curve docs, DBC program accounts docs.

Do not hardcode by hand in prod. Compute with SDK, print config, test on devnet that 85 SOL in gives ~793.1M out.

## 4. Fee math

DBC total = base + dynamic. We use base only = 1.25%.

Numerator: 0.0125 * 1,000,000,000 = 12,500,000.

Split in DBC:
- Protocol 20% of total = 0.25%. Referral gets 20% of protocol if present.
- Rest 80% = 1.00% split partner / creator.
Source: DBC fees docs.

pump.fun split: creator 0.30%, protocol 0.95%.

Option A - parity (mirrors pump.fun):
- creator share = 0.30 / 1.00 = 30%.
- Set `creator_trading_fee_percentage = 30`.
- Partner gets 70% of rest = 0.70% absolute.
- Protocol gets 0.25% absolute.

Option B - max short (funds mission):
- Set `creator_trading_fee_percentage = 0`.
- Or set creator address = partner address = fee-short program PDA.
- Then full 1.00% non-protocol fee goes to one program PDA.
- This maximizes SOL for borrowing and shorting PUMP.
- Use this for launch. Use Option A only for parity test.

Total still 1.25% in both. But protocol share differs from pump.fun:
- DBC protocol 0.25% vs pump.fun protocol 0.95%.
- Difference goes to our program (0.70% or 1.00%). This funds the fee-short mission.

Claim anytime. No need to wait for migration.
Partner, creator, protocol balances are tracked on virtual pool.

Extra DBC cost with no pump.fun match:
- 0.2% protocol liquidity migration fee at migration. Reduces DAMM liquidity by 20 bps.
Source: DBC fees and migration docs.

## 5. Graduation and migration

pump.fun: stop curve, move SOL + 206.9M tokens to PumpSwap, burn LP.
DBC: stop swaps at 85 SOL, state `PostBondingCurve`, then migrate to DAMM v2.
Source: DBC what-is-DBC docs, migration docs.

Parity settings:
- Threshold 85 SOL.
- DAMM v2 fee 25 bps.
- Lock 100% LP to mimic burn. Partner and creator can still claim DAMM fees via locked positions. Pump.fun burns LP, so this is close but not exact. Note it in UI.
- No pool creation fee.
- No custom `migrated_pool_fee`. Use option 0.

Migration gap (Meteora auto-migration):
- Meteora auto-migration only migrates WSOL pools at 10 SOL, USDC at 750, and others. See migration docs table.
- 85 SOL WSOL pool is NOT auto migrated.
- Plan: manual migrate via migrator.meteora.ag or a one-shot script.

## 6. What is NOT parity

- Protocol share: 0.25% vs 0.95%. Intentional. Funds our mission.
- Graduation fee: DBC takes 0.2% liquidity + optional migration fee. pump.fun takes flat 0.015 SOL.
- Target DEX: DAMM v2 vs PumpSwap.
- LP burn vs LP lock. DBC locks, does not burn.
- Referral: DBC supports referral from protocol share. pump.fun has no match.

## 7. Sources

- Virtual reserves 30 SOL + 1,073M: solbundler market-cap calculator, tradingcalc bonding-curve calculator, solana.stackexchange pumpfun thread.
- 793.1M sold / 206.9M migration math: `k = 32.19B`, `115 SOL` end, derived above.
- 85 SOL threshold: soltokencreator graduation 2026, crypto.news, arxiv 2602.14860.
- 1.25% fee split 0.30 / 0.95: BloFin fees 2026, Froglabs fees 2026, pump.fun fee schedule May 20 2026.
- 0.015 SOL graduation, free creation, PumpSwap: BloFin fees 2026, BloFin graduation fee guide.
- DBC program id, curve, fees, migration: docs.meteora.ag DBC what-is, universal curve, formulas, launch config, fees overview, migration and liquidity, MeteoraAg dynamic-bonding-curve README, TypeScript SDK examples.
- DBC limits: FEE_DENOMINATOR 1,000,000,000, MIN_FEE_BPS 25, MAX_CURVE_POINT 16: DBC program accounts docs.

## 8. Done check

- [x] Config matches table in section 2 (`migrations/deploy.ts` `LAUNCH_PARAMS`, `npm run verify:params` `CHECK_OK`).
- [x] Curve sells 793,086,956.5 for 85 SOL. Start mcap 27.96 SOL, end mcap 410.84 SOL (`scripts/full-lifecycle-local.sh` `FULL_LIFECYCLE_OK`).
- [x] SDK Q64 outputs match section 3 check values (`migrations/check.ts` asserts, `CHECK_OK`).
- [x] Swap fee is 1.25% flat, quote mode, no dynamic (`numerator 12,500,000`, `collectFeeMode QuoteToken`).
- [x] Parity mode uses creator 30%. Max-short mode uses 0 or same PDA and gets 100% of non-protocol fees (`creator 0`, section 4).
- [x] Migrated pool fee is 25 bps on DAMM v2 (`migration_fee_option 0`).
- [x] Manual migration path tested (`scripts/full-lifecycle-local.sh` `FULL_LIFECYCLE_OK`).
