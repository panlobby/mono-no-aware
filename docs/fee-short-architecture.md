# Fee to short PUMP architecture

Goal: use SOL trading fees to short PUMP on Project 0 only.

PUMP mint: `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` (Token-2022, 6 decimals).
Market: `https://app.0.xyz/markets/pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`.
Program: marginfi v2 `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`.
Group (production): `4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8`.
SOL Bank (native, P0): `CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh`.
PUMP Bank (native, P0): `61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK`.
Source: AGENTS.md idea, Project 0 program addresses docs. Bank addresses verified live on Oct 26 2026 via `api.0.xyz/v0/bankMetrics` and `getAccountInfo` owner check. Full configs verified via `Project0Client.initialize` with `getConfig("production")`. See section 2.

PUMP can ONLY be borrowed on Project 0. Do not use Kamino Borrow or Jupiter Lend to borrow PUMP. They do not list PUMP as debt.
Project 0 unifies Kamino and Jupiter Lend collateral, but PUMP borrow is P0 native only.

Quote fees are in SOL. See `docs/dbc-pump-parity-spec.md`.
Max-short mode sends 100% of non-protocol fees to one program PDA.
That is `creator_trading_fee_percentage = 0`, or same PDA for partner and creator.

Post-graduation flow is included. After 85 SOL, DBC migrates to DAMM v2. Our program keeps funding the short from DAMM v2 locked LP fees (25 bps).

## 1. Flow

Keeperless. No keeper service. No daemon. No cron. One-shot manual ops only.

1. Trade happens on DBC curve. Fee accrues in SOL.
2. Anyone calls our program (permissionless, no holder gate). Program claims partner and creator fees to vault PDA. There is no on-chain min claim. The operator decides when to claim.
3. Program deposits SOL into Project 0 SOL Bank as collateral (`deposit_sol`).
4. Anyone calls `borrow_sell_deposit_checked` with any `amount > 0`. One instruction does all: borrow PUMP from Project 0 PUMP Bank to `vault_pump_ata`, sell it in the fixed DLMM pool to `vault_wsol_ata`, deposit exactly the sale proceeds into the SOL Bank, pulse marginfi health, read the health cache, enforce hardcoded HF 1.50 initial and 1.25 maintenance. Any failure reverts the whole instruction. No partial state.
5. Program holds SOL collateral + short PUMP debt. Repeats as more fees come.
6. After graduation at 85 SOL: DBC stops. DAMM v2 pool starts with 25 bps fee. Our locked LP positions earn fees. Program claims DAMM v2 fees to vault and repeats steps 3-4.
7. Later: buy back PUMP cheap, repay debt, keep spread. Or get liquidated if PUMP rises.

This is a borrow-and-sell short. No perp. All on chain.

Manual ops tool: `scripts/manual-crank.ts` (dry-run default, `--send` broadcasts). It runs as a one-shot CLI.

## 2. Parts

DBC pre-migration:

- `collect_fee_mode = 0` = QuoteToken. Fees land in SOL.
- `fee_claimer` = our program PDA. It claims partner fees.
- Creator = same PDA. It claims creator fees.
- Claims: `claimPartnerTradingFeeToReceiver`, `claimCreatorTradingFeeToReceiver`.
- Claim any time. No wait for migration.
  Source: DBC fees and TS SDK examples docs.

DAMM v2 post-migration:

- `migration_quote_threshold` = 85 SOL. `migration_fee_option` = 0 = 25 bps.
- 100% of LP is locked: partner locked + creator locked + vesting = 100%.
- Our PDA owns the locked positions. It claims DAMM v2 trading fees to vault.
- This keeps SOL inflow after curve ends.
  Source: `docs/dbc-pump-parity-spec.md` sections 2 and 5.

Fee-short program:

- PDA vault holds SOL. Keeps ~0.1-0.2 SOL liquid for rent and crank costs. Deposits the rest to SOL Bank.
- PDA owns one Project 0 MarginfiAccount. Up to 16 Balances. Uses 2: SOL asset + PUMP liability.
- Crank is permissionless and uncapped. Anyone can call `borrow_sell_deposit_checked` with any `amount > 0`. No per-crank cap. No per-epoch cap. No cooldown. No min claim. The only on-chain bound is the hardcoded health guard. All signatures come from the vault PDA via CPI.
- Only admin can change params, including the DLMM pool. There is no on-chain unwind instruction; closing is a manual admin sequence (see Unwind below).
- Stores: 15 pubkeys (admin, dbc pool/config, damm pool/position, marginfi account, group, both banks, three vault ATAs, sweep destination, pump pool, base mint + base ATA), paused flag, two bumps. LEN = 483. No cap fields. No epoch fields. No min claim field.
- Both fee legs are canonical: DBC pays base->`vault_base_ata` + wSOL->`vault_wsol_ata`; DAMM pays {base,wSOL}->{`vault_base_ata`,`vault_wsol_ata`}. Base dust is recoverable via admin-only `sweep_base`.
- Emits `EvtBorrowSellDeposit { pump_amount, sol_out, initial_hf_bps, maint_hf_bps }` on every crank, `EvtSweep` on every `sweep_out`, `EvtSweepBase` on every `sweep_base`, `EvtConfig` on every `update_config` (all five fields; `EvtSweepDestinationChanged` / `EvtPoolChanged` fire only when those fields change, so indexers read `EvtConfig`), and lending legs rely on marginfi's own `LendingAccount*` events.
- Sale SOL never stays in the vault. The crank deposits exactly the sale proceeds in the same instruction. Collateral grows from two sources: new claims + past sale proceeds.

Project 0 (only borrow venue, verified live Oct 26 2026):

- Built on mrgnLendv2 `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`.
- Docs: `https://docs.0.xyz`.
- SDK: `@0dotxyz/p0-ts-sdk 2.11.0` (pinned), peers `@solana/web3.js 1.99.0`, `@coral-xyz/anchor 0.31.1`, `@anchor-lang/core 0.31.2`. Repo `github.com/0dotxyz/p0-ts-sdk`.
- Protocol repo: `github.com/0dotxyz/marginfi-v2` (also `github.com/0dotxyz/marginfi-v2` fork path `mrgnlabs/marginfi-v2` in old docs).
- App: `https://app.0.xyz`.
- Group: `4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8`, run by foundation. Owner on chain is MFv2 program.
- SOL Bank `CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh`: asset weights 0.80 Init / 0.90 Maint, liability 1.14 / 1.10, `assetTag` 1 (SOL), `riskTier` Collateral, `Operational`, depositLimit 2M SOL, borrowLimit 500k SOL, `totalAssetValueInitLimit` $227M, oracle `PythPushOracle` key `7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE`, `oracleMaxAge` 70s. Live: price ~$101.43, deposits $10.1M, borrows $9.6M, avail $524k, utilization 94.8%, supply APY ~6.06%, borrow APY ~6.41%.
- PUMP Bank `61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK`: asset 0.40 / 0.50, liability **1.60 Init / 1.42 Maint**, `assetTag` 0 (DEFAULT), `riskTier` Collateral (not Isolated, no one-isolated-borrow limit), `Operational`, depositLimit 600M PUMP, borrowLimit 60M PUMP (~$256k), `totalAssetValueInitLimit` $3.5M (only matters for PUMP as collateral, we do not use it), oracle `PythPushOracle` key `4KL8nVtrXmLjbbHtrDz5YCHNqmii62oHfr9bsUtx1bgi`, `oracleMaxAge` 70s. Live: price ~$0.004251, deposits $537k, borrows $32k, avail $505k, utilization 6.1%, borrow APY ~2.29%.
- SOL(1) + PUMP(0/DEFAULT) mix in one account is allowed. Both banks Collateral + Operational.
- MarginfiAccount: PDA from our program PDA + index. Holds up to 16 Balances. One Balance per Bank. No asset + liability in same Bank.
  Source: Project 0 architecture, program addresses, TS SDK getting-started docs, plus live `bankMetrics` + `Project0Client.initialize` read.

Swap (single fixed venue):

- One DLMM pool holds the PUMP/wSOL liquidity: `HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh` (PUMP/wSOL, X=PUMP, Y=wSOL).
- The crank CPIs `swap2` into that pool from the program: borrow PUMP to `vault_pump_ata`, then swap `vault_pump_ata` -> `vault_wsol_ata` with the vault PDA as signer (no keeper delegate, no approve/revoke, no keeper).
- No same-tx sysvar trick. Borrow, sell, deposit, pulse are one instruction, so they cannot be split. `min_out_amount = 0`: there is no price floor. The hardcoded health guard on resulting leverage is the only bound, because the pool is fixed and admin-chosen.
- No per-crank cap. Size is limited by policy and the health guard only. Verified Nov 2026: 1 PUMP -> 43,331 lamports on a local clone (1 bin touched); 10k PUMP (~$42.5) -> 0.455 SOL at ~0.18% impact; 100k PUMP -> 4.55 SOL.

Health guard (hardcoded, no oracle in our program):

- After borrow + sell + deposit, the crank CPIs `lending_account_pulse_health`, then reads the marginfi `health_cache` at offset 1840 (len 2312) and enforces initial HF >= 1.50 and maintenance HF >= 1.25 with checked i128 math.
- Rejects on liability <= 0, negative values, short data, overflow, stale or future timestamp (max age 60s vs `Clock::get()`), engine or oracle flags clear, or `mrgn_err != 0`. Fail closed.
- Full spec: `docs/marginfi-health-guard.md`. CPI bytes: `docs/program-cpi-spec.md`.

Manual monitoring (no keeper):

- No background daemon is required. Anyone or the operator can run one-shot commands via `scripts/manual-crank.ts` (dry-run, claim, deposit, crank, pause, unwind).
- Check bank oracle staleness (70s), pool TVL, and health distance from 1.50/1.25 before each crank.

## 3. Money math

DBC fee: 1.25% per swap.

- Protocol 20% = 0.25%.
- Ours 80% = 1.00% in max-short mode.

Example:

- 1,000 SOL volume -> ~10 SOL to vault.
- 10,000 SOL volume -> ~100 SOL to vault.

After graduation, DAMM v2 fee 25 bps on locked LP also flows to vault. Rate depends on post-migration volume.

Project 0 max borrow uses live weights, not plain LTV:

- `max_borrow_value = collateral_value * 0.80 / 1.60 = collateral_value * 0.50`.
- SOL $100 -> max $50 of PUMP. SOL $1000 -> max $500, working size at 50% buffer ~$250 (~59k PUMP at $0.00425).
- Liquidation line: `SOL * 0.90 < PUMP_debt * 1.42`. At full max, PUMP can rise only +26.7% before liquidation. At 50% buffer, it takes x2.53 PUMP rise, or SOL drop to 39% of start.
- Keep buffer. Borrow delta only, 30-50% of max per crank. Target initial HF >= 1.50 and maintenance >= 1.25; the guard reverts below these.
- Use `computeMaxBorrowForBank` from SDK before each crank. Do not hardcode. Weights above are the check values from Oct 26 2026 read.

Borrow APY eats profit. If PUMP borrow APY is high and fees are slow, debt grows fast.

## 4. Steps in detail

Claim pre-migration:

- Read `partnerUnclaimedQuoteFee` + `creatorUnclaimedQuoteFee`.
- Operator decides when to claim. No on-chain threshold.
- Claim to vault PDA.

Claim post-migration:

- Read DAMM v2 locked position fees.
- Claim to same vault PDA. Then same deposit-crank loop.

Deposit:

- Vault deposits SOL to SOL Bank via `makeDepositTx(bankAddress, amount)`.
- Keep small SOL reserve for rent and crank costs.
- SDK: `Project0Client.initialize`, `getConfig("production")`, `createMarginfiAccountTx`, `makeDepositTx`.
  Source: Project 0 TS SDK getting-started.

Borrow + sell + deposit + health check:

- Pass any `amount > 0`. No on-chain cap. The operator sizes by policy and the health guard enforces 1.50/1.25.
- Call `borrow_sell_deposit_checked`. It borrows PUMP, sells it in the fixed DLMM pool, deposits exactly the sale proceeds, pulses health, checks the guard, emits the event. See `docs/program-cpi-spec.md`.
- Borrow PUMP only. No other debt.

Sell:

- Sale SOL never stays in the vault. The crank deposits exactly the wSOL delta in the same instruction. `actual_sol_out` must be > 0.
- Keep ~0.1-0.2 SOL liquid. Deposit the rest via separate `deposit_sol` calls.
- One loop only at start. No leverage loop.
- The admin can move realized wSOL proceeds out of the vault with the `sweep_out` instruction (plain transfer to the configured `sweep_destination` ATA, vault ATA stays open). See docs/program-cpi-spec.md section 2d.

Manage:

- Track both Initial health (can borrow) and Maintenance health (can be liquidated).
- If Maintenance health nears 1.25, add SOL or repay PUMP. Do not wait.
- If PUMP borrow cap is hit, stop. Hold SOL.
- Pause on oracle gaps, PUMP delist, or exploit news.

Unwind (manual, no on-chain unwind instruction):

- Buy PUMP -> repay -> withdraw SOL.
- Only admin can run the close (all steps are admin-signed).
- Partial cover allowed to save health.
- Full sequence with SOL sweep: see the close runbook (Trust model section).

## 5. Risks

Liquidation:

- Health = sum(asset _ weight) - sum(liability _ weight). Initial uses low asset + high liability weights. Maintenance uses higher asset + lower liability weights.
- Borrow needs Initial health > 0. Liquidation happens when Maintenance health < 0. Our crank needs post-crank HF >= 1.50 initial and >= 1.25 maintenance, or the whole tx reverts.
- If PUMP rises, debt value rises. Position can be liquidated. Classic liquidation takes 2.5% to liquidator + 2.5% to insurance. Receivership can take up to 10%.
- Mitigation: low borrow, high health target, manual top-up, pause in spikes.
  Source: Project 0 risk engine and liquidation docs.

Permissionless uncapped crank (accepted):

- Anyone can call `borrow_sell_deposit_checked` with any size. There is no cap, no epoch budget, no cooldown, no allowlist. No oracle or `min_out` is implemented by design. A bad fill still passes if health passes.
- Accepted because the health guard limits resulting leverage, not execution loss per crank: post-crank HF must stay >= 1.50/1.25 or the tx reverts with `0x1771` and every account rolls back (`scripts/health-rollback-local.sh` proof), though a caller can consume equity down to the 1.25 floor in one crank.
- Residual: sandwich/MEV per crank, griefing gas, dust spam. No automatic stop. Admin can pause if needed.
- Revisit triggers: crank above ~$5k, pool TVL drop, health near 1.25, repeated bad fills.

Thin PUMP sell liquidity + `min_out = 0`:

- Sale and buy-back slip against one pool instead of an aggregator. `min_out_amount = 0` means no price floor.
- Mitigation: small manual sizes, single fixed pool with measured depth, pause on gaps, admin can point the pool elsewhere with `update_config` (emits `EvtPoolChanged`). Revisit trigger: crank above ~$5k or pool TVL drop.
- Accepted by user. Owner: user.

Health-cache layout risk:

- The guard pins fresh-account layout (len 2312, offset 1840, version 3). Older mainnet accounts use 1776. A marginfi upgrade can move it.
- Guard fails closed on drift. Crank reverts. No funds move.
- Revisit on any marginfi upgrade, version bump, or `CHECK_FAIL` from `scripts/check-health-layout.ts`. Owner: user.

Oracle risk (Project 0 banks, not our program):

- Our program reads no oracle except the health cache after pulse. There is no on-chain price floor.
- Each Bank still has a Pyth push or Scope oracle. EMA is used for borrows. Spot is used for liquidations. Assets use lower bound `P - c`. Debts use upper bound `P + c`. Confidence capped at 5%.
- Switchboard is deprecated. Support ends Sept 25 2026. Do not use Switchboard banks.
- Bank oracle staleness (70s) still blocks marginfi borrows/deposits. The operator passes fresh oracles per crank.
  Source: Project 0 oracles docs.

Lending contract risk:

- Only marginfi v2 `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`. Bugs, admin keys, bank freeze, Group admin changes weights or caps.
- Mitigation: one market only, small size first, admin pause, watch Group admin updates. Audits are on Project 0 audits page.

DBC and DAMM risk:

- Curve may never hit 85 SOL. Fees may be tiny. Manual migration needed.
- 0.2% protocol migration fee cuts liquidity. Locked LP means no quick exit.
- Mitigation: test manual migration on devnet, budget crank costs.

No keeper monitoring:

- No bot watches health. Fees sit idle if nobody cranks. Health decays with borrow APY.
- Mitigation: permissionless crank (anyone can run it) and one-shot `scripts/manual-crank.ts`.

Key and admin risk:

- Admin can pause, update non-core config (`damm_pool`, `damm_position`, `sweep_destination`, `pump_pool`, `paused`), repay debt, withdraw collateral, and sweep realized proceeds.
- The launch wallet is payer, `state.admin`, and upgrade authority. Core accounts (mints, banks, group, DBC pool/config, canonical vault ATAs) are immutable after `init_state`.

Narrative and market risk:

- Shorting `PUMP` on-chain is directional: if `PUMP` rallies sharply against `SOL`, the vault's short position can face liquidation.
- Mitigation: clear documentation, no profit promise, no user deposits, only fee-funded collateral.

No user deposits:

- Vault only holds DBC and DAMM fees. Loss capped to fees earned.

## 6. Trust model and manual close

There is no on-chain `unwind` instruction. Closing is a manual admin sequence below. Trust is explicit: the admin is powerful but bounded.

### What the admin can do

- Pause and unpause the crank (`paused`, emits `EvtConfig`).
- Change config (`damm_pool`, `damm_position`, `sweep_destination`, `pump_pool`, `paused`). Every successful update emits `EvtConfig` with all five fields. Unsafe values revert before any write: default sweep destination or pump pool, half-set DAMM pair (see `docs/program-cpi-spec.md` section 2f). There are no caps or min claim to change; they were removed in 037.
- Change the DLMM pool (emits `EvtPoolChanged`). The admin chooses the single sell venue; there is no on-chain price floor.
- Change the sweep destination (emits `EvtSweepDestinationChanged`).
- Move realized wSOL out with `sweep_out` (emits `EvtSweep`) and base dust out with `sweep_base` (emits `EvtSweepBase`, admin-only, works while paused).
- Repay PUMP debt (`repay_all`) and pull SOL collateral (`withdraw_all`).

### What the admin cannot do

- Change the mint. The PUMP mint is not a state field; it is fixed by the PUMP bank account, and `update_config` cannot change the bank. The base mint (`base_mint`) and vault ATAs (`vault_wsol_ata`, `vault_pump_ata`, `vault_base_ata`) are set once at `init_state`; `update_config` cannot change them.
- Swap banks or the group outside init. Bank and group addresses are set once at `init_state`; `update_config` cannot change them.
- Set a price floor or a cap. The sell runs at the pool quote (`min_out = 0`); the only on-chain bound is the health guard on resulting leverage (1.50/1.25), not on execution loss. There is no cap to tighten.
- Mint tokens. The program has no mint authority anywhere.
- Move funds without an on-chain trace. Every admin fund move emits an event: `sweep_out` emits `EvtSweep`, `sweep_base` emits `EvtSweepBase`, every sweep destination change emits `EvtSweepDestinationChanged`, and each marginfi leg (deposit, borrow, repay, withdraw) emits its own `LendingAccount*` event.

### What removes trust later

- Timelock on `update_config` (no instant param changes).
- Multisig admin instead of one key.
- `sweep_destination` set to a distributor program instead of a wallet, so proceeds split on-chain instead of landing in one pocket.

### No user deposits

There are no user deposits. The vault holds only accrued Meteora fees and every lamport in it came from fees or the fee-short's own swap proceeds. Loss is capped at fees earned.

### Manual close runbook

Exact order, and why each step exists:

1. Buy PUMP on the open market for debt + buffer. `repay_all` pulls `ceil(debt)`, and debt can exceed the bare borrow by interest dust (seen locally: +1 unit), so an exact cover reverts. Buy debt plus a buffer.
2. Transfer the bought PUMP into `vault_pump_ata`. Repay pulls only from this ATA, so the cover must sit here first.
3. Call `repay_all`. Closes the PUMP liability on the marginfi account. Needs the full debt present; leftover dust stays as change.
4. Call `withdraw_all`. Pulls the SOL collateral back to `vault_wsol_ata`. Only works with zero debt (health check), hence after repay.
5. Call `sweep_out` to the destination ATA. Moves realized wSOL to the configured `sweep_destination`. Plain transfer, vault ATA stays open.
6. Unwrap wSOL in the destination wallet (close the wSOL ATA) to get native SOL.

### PUMP buffer rule

Keep 1-5% of outstanding debt as PUMP in the vault when closing, so the position can still close if PUMP liquidity disappears mid-unwind.
Verified locally: 1 PUMP debt needed a 0.1 PUMP (10%) simulated buy to cover `ceil` dust; on mainnet 1-5% covers rate drift plus one retry.
Never start a close with an exact-cover amount.

## 7. Verification summary

- [x] Project 0 production Group `4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8`, SOL Bank `CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh`, PUMP Bank `61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK` for `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`. Weights: SOL asset 0.80/0.90 liab 1.14/1.10, PUMP asset 0.40/0.50 liab 1.60/1.42. Both Collateral + Operational. Oracles: Pyth push, 70s max age. Caps: SOL deposit 2M / borrow 500k, PUMP deposit 600M / borrow 60M (~$256k).
- [x] PUMP -> SOL route on the fixed DLMM pool has depth for chunk size: 1 PUMP -> 43,331 lamports (1 bin touched); 10k PUMP -> 0.455 SOL at ~0.18% impact; 100k PUMP -> 4.55 SOL.
- [x] DBC fee claim PDAs and DAMM v2 locked position owner can sign CPI to Project 0 and DLMM (`scripts/dbc-claim-local.sh` `DBC_CLAIM_E2E_OK`, `scripts/full-lifecycle-local.sh` `FULL_LIFECYCLE_OK`).
- [x] Local crank: claim, deposit to SOL Bank, combined borrow-sell-deposit with health guard (`scripts/local-e2e.sh` `LOCAL_E2E_OK` and `scripts/health-rollback-local.sh` `HEALTH_ROLLBACK_OK`).
- [x] Manual DBC migration works while Project 0 position is open, and DAMM fee claim works after migration (`scripts/full-lifecycle-local.sh` `FULL_LIFECYCLE_OK`).
- [x] SDK `2.11.0` pinned with `@solana/web3.js 1.99.0` and `@coral-xyz/anchor 0.31.1`.

## 8. Sources

- PUMP mint `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` and market: Solscan token page, `https://app.0.xyz/markets/pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`.
- Project 0 only venue: Project 0 architecture and program addresses (`MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`).
- Risk model Group, Banks, MarginfiAccount up to 16 Balances, asset and liability weights, health formula: Project 0 architecture and risk engine docs.
- Oracles (banks only): Pyth and Scope, EMA vs spot, confidence, staleness: Project 0 oracles docs.
- Liquidation classic 2.5% + 2.5%, receivership up to 10%, bankruptcy: Project 0 liquidation docs.
- SDK `@0dotxyz/p0-ts-sdk`, `Project0Client`, `getConfig("production")`, `makeDepositTx`, `makeBorrowTx`, `computeMaxBorrowForBank`: Project 0 TS SDK getting-started, GitHub `0dotxyz/p0-ts-sdk`, protocol `0dotxyz/marginfi-v2`.
- DBC fees, DAMM 25 bps, migration gap: docs.meteora.ag DBC fees, formulas, migration, TS SDK examples, `docs/dbc-pump-parity-spec.md`.
- Health guard: `docs/marginfi-health-guard.md`, `scripts/health-rollback-local.sh` (`HEALTH_ROLLBACK_OK`).

## 9. Done check

- [x] SOL-only fee flow from DBC pre-migration and DAMM v2 post-migration to vault (`claim_dbc_fees`, `claim_damm_fees`).
- [x] Borrow PUMP on Project 0 PUMP Bank, sell in fixed DLMM pool, deposit proceeds, pulse health, enforce 1.50/1.25 (`LOCAL_E2E_OK` + `HEALTH_ROLLBACK_OK`).
- [x] Project 0 details set: program id, docs, SDK, repo, Group, SOL Bank, PUMP Bank, MarginfiAccount 16 Balances.
- [x] Weight math and Initial vs Maintenance health rules are set (`docs/marginfi-health-guard.md`).
- [x] Bank oracle rules set: Pyth and Scope only, bank `oracleMaxAge` 70s.
- [x] Risks cover liquidation, uncapped crank, `min_out = 0`, health-cache layout, no keeper monitoring, bank oracles, contracts, admin.
