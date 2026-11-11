# Fee-short program CPI spec

Goal: define PDAs, CPIs, and the keeperless health-guarded crank for the fee-short program.

Programs:

- DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`.
- DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`.
- Project 0 marginfi v2 `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`.
- Meteora DLMM `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
  (LB-CLMM v0.12.0, `@meteora-ag/dlmm` 1.9.14).

Group, banks, mints, pool:

- Group `4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8`.
- SOL Bank `CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh`.
- PUMP Bank `61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK`.
- PUMP mint `pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn` (Token-2022).
- wSOL mint `So11111111111111111111111111111111111111112`.
- DLMM pool `HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh`
  (PUMP/wSOL, X=PUMP, Y=wSOL).
- DLMM bitmap extension `HC5P78TaKkkGaCU14Wk5S8x4G5Pqx2jt1fyvJPbvcQbv`.
  Source: `docs/fee-short-architecture.md`, `docs/dbc-pump-parity-spec.md`, Project 0 architecture and program addresses docs.

## 1. PDAs and state

Program owns all signatures. The caller only pays gas. No holder gate.

Seeds (fee-short program id = to be set in `Anchor.toml`):

- `state`: `["state"]`. One global config.
- `vault`: `["vault", state]`. PDA authority for tokens and MarginfiAccount.
- `vault_wsol_ata`: SPL ATA of `vault` for wSOL. Holds claimed SOL as wSOL before deposit. Net zero after each crank (proceeds are deposited same ix).
- `vault_pump_ata`: Token-2022 ATA of `vault` for PUMP. Holds borrowed PUMP for one crank only, then must be empty after sell.
- `marginfi_account`: PDA created by marginfi program via `marginfi_account_initialize_pda`. Seeds on marginfi side: `[group, authority=vault, account_index=0, third_party_id]`. Our program stores its address in state after init. It holds max 16 Balances. We use 2: SOL asset + PUMP liability.

State layout (keeperless, 037):

```rust
pub struct FeeShortState {
  pub admin: Pubkey,              // launch hot wallet, can update config
  pub dbc_pool: Pubkey,           // DBC VirtualPool
  pub dbc_config: Pubkey,         // DBC PoolConfig
  pub damm_pool: Pubkey,          // DAMM v2 pool after migration, default before
  pub damm_position: Pubkey,      // our locked position NFT account, default before
  pub marginfi_account: Pubkey,   // Project 0 account, set after init
  pub group: Pubkey,              // 4qp6...
  pub sol_bank: Pubkey,           // CCKt...
  pub pump_bank: Pubkey,          // 61Qx...
  pub vault_wsol_ata: Pubkey,
  pub vault_pump_ata: Pubkey,
  pub sweep_destination: Pubkey, // owner of the ATA that receives sweep_out
  pub pump_pool: Pubkey,          // fixed DLMM pool (HbjY...), set at init
  pub base_mint: Pubkey,          // our token mint (DBC/DAMM base), set at init
  pub vault_base_ata: Pubkey,     // canonical vault ATA for base_mint
  pub paused: bool,
  pub bump_state: u8,
  pub bump_vault: u8,
}
```

Init space is `8 + FeeShortState::LEN` with `LEN = 15 * 32 + 1 + 1 + 1
= 483` (15 Pubkeys, bool, two bumps). A unit test asserts the exact
byte count; do not guess.

Crank rules (single instruction, no cross-tx state):

- `borrow_sell_deposit_checked(amount)` does marginfi borrow + DLMM swap + marginfi deposit + marginfi pulse + health guard in ONE instruction. Guards: not paused, `amount > 0`, permissionless caller. No cap. No epoch. No cooldown. No Clock account (uses `Clock::get()` only for health-cache freshness).
- Address checks: group, marginfi account, both banks, both vault ATAs, `dlmm_pool == state.pump_pool`, DLMM program, token programs, memo program, event authority PDA. SOL bank liquidity vault is bound by marginfi's bank relation.
- Remaining accounts: `[pump_mint, health banks + oracles (4 total), bin arrays...]`. The first 5 go to the marginfi borrow (mint-first for Token-2022, then health pairs in descending bank order `[sol_bank, sol_oracle, pump_bank, pump_oracle]`); pulse reuses the 4 health pairs; the rest are the DLMM bin arrays touched by the quote (at least 1).
- No `PendingSell`, no keeper delegate, no approve/revoke, no `sysvar::instructions`, no oracle accounts in our ix, no `borrow_and_sell_pump`, no `verify_sell_pump`. The vault PDA signs all CPIs via seeds.
- `min_out_amount = 0`: there is no price floor. The hardcoded health guard on resulting leverage (1.50 initial, 1.25 maintenance) is the only bound, because the pool is fixed and admin-chosen.
- `actual_sol_out = wsol_after - wsol_before` must be > 0. Exactly that amount is deposited. Pre-existing wSOL is never deposited.
- `EvtBorrowSellDeposit { pump_amount, sol_out, initial_hf_bps, maint_hf_bps }` is emitted from the vault wSOL ATA delta and the health cache ratios.
- Only admin can `update_config`, `sweep_out`, `sweep_base`. `init_state` is permissionless-once: anyone can call it, but the payer must equal the program's current upgrade authority (proved from the ProgramData account), and the first successful init wins the fixed `state` PDA.
- Anyone can crank claim, deposit, borrow-sell-deposit. There is no `unwind` instruction; closing is manual (see Unwind in docs/fee-short-architecture.md).

## 2. CPI discriminators and account lists

Anchor discriminator = first 8 bytes of `sha256("global:<ix_name>")`.
Verify with:

```bash
python3 -c "import hashlib; print(hashlib.sha256(b'global:lending_account_borrow').hexdigest()[:16])"
```

Check against IDL JSON:

- DBC: `@meteora-ag/dynamic-bonding-curve-sdk` `DynamicBondingCurveIdl`.
- DAMM v2: `@meteora-ag/cp-amm-sdk` IDL, program `cpamdp...`.
- Project 0: `github.com/0dotxyz/marginfi-v2` `target/idl/marginfi.json`, program `MFv2...`.

Computed discriminators (verify before code):

- `claim_trading_fee` (DBC partner): `08ec5931987db151` = `[8,236,89,49,152,125,177,81]`.
- `claim_creator_trading_fee` (DBC creator): `52dcfabd03556b2d` = `[82,220,250,189,3,85,107,45]`.
- `claim_position_fee` (DAMM v2): `b4269a118521a2d3` = `[180,38,154,17,133,33,162,211]`.
- `marginfi_account_initialize`: `2b4e3dff9434f99a` = `[43,78,61,255,148,52,249,154]`.
- `marginfi_account_initialize_pda`: `57b15b50da77f51f` = `[87,177,91,80,218,119,245,31]`.
- `lending_account_deposit`: `ab5eeb675240d48c` = `[171,94,235,103,82,64,212,140]`.
- `lending_account_borrow`: `047e74353005d41f` = `[4,126,116,53,48,5,212,31]`.
- `lending_account_repay`: `4fd1acb1de33ad97` = `[79,209,172,177,222,51,173,151]`.
- `lending_account_withdraw`: `24484a13d2d2c0c0` = `[36,72,74,19,210,210,192,192]`.
- `lending_account_pulse_health`: `ba34756122474bfd` = `[186,52,117,97,34,74,39,253]`.
- DLMM `swap2` (v0.12.0, `@meteora-ag/dlmm` 1.9.14): `414b3f4ceb5b5b88` =
  `[65,75,63,76,235,91,91,136]`.

### 2a. DBC fee claim

Use `claimPartnerTradingFeeToReceiver` and `claimCreatorTradingFeeToReceiver` builders, or CPI with same accounts. Implemented inner lists (asserted by `scripts/check-claim-accounts.ts` against DBC IDL 0.2.2; the checker fails the build on any drift):

Partner `claim_trading_fee` (14, IDL order) — our Rust metas in the same
order: `pool_authority` (fixed `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`),
`dbc_config`, `dbc_pool` (mut), `token_a_account` (mut, must equal
`state.vault_base_ata`), `vault_wsol_ata` (mut, must equal
`state.vault_wsol_ata`), `base_vault` (mut), `quote_vault` (mut),
`base_mint` (must equal `state.base_mint`), `quote_mint`, `vault` PDA
(signer, fee_claimer), `token_base_program`, `token_quote_program`,
`event_authority` (PDA `["__event_authority"]`), `dbc_program`
(address-checked, also the inner `program`).
Args: `max_base_amount`, `max_quote_amount` = `u64::MAX` to claim all.

Creator `claim_creator_trading_fee` (13): same minus `config`; `creator` =
our `vault` PDA (signer). Args: `max_base_amount`, `max_quote_amount`.

Outer Anchor context `ClaimDbc` (15): `state`, `vault`, `pool_authority`,
`dbc_config`, `dbc_pool`, `token_a_account`, `vault_wsol_ata`,
`base_vault`, `quote_vault`, `base_mint`, `quote_mint`,
`token_base_program`, `token_quote_program`, `event_authority`,
`dbc_program`.

Notes:

- Quote mode collects in wSOL. Receiver must be canonical wSOL ATA owned by vault.
- Base leg must be canonical base ATA owned by vault (`state.vault_base_ata`
  for `state.base_mint`). A second vault-owned base ATA reverts, so base
  fees cannot strand outside sweep reach (030).
- Claim any time. No migration wait.
- Verify in test with `getPoolFeeBreakdown` before and after.
  Source: DBC program instructions docs, TS SDK reference `PartnerService` and `CreatorService`.

### 2b. DAMM v2 locked LP fee claim

Use `claimPositionFee` / `claimPositionFee2` from `@meteora-ag/cp-amm-sdk`.

`claim_position_fee` (15, IDL order) — our Rust metas in the same
order: `pool_authority` (fixed `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC`),
`damm_pool`, `position` (mut, must equal `state.damm_position`),
`fee_token_a_account` (mut), `fee_token_b_account` (mut), `vault_a` (mut),
`vault_b` (mut), `token_a_mint`, `token_b_mint`, `position_nft_account`,
`vault` PDA (signer), `token_a_program`, `token_b_program`,
`event_authority` (PDA `["__event_authority"]`), `damm_program`
(address-checked, also the inner `program`). No `system_program`: the IDL
list has 15 accounts without it. No args.
Outer Anchor context `ClaimDamm` (16): `state`, `vault`,
`pool_authority`, `damm_pool`, `position`, `fee_token_a_account`,
`fee_token_b_account`, `vault_a`, `vault_b`, `token_a_mint`,
`token_b_mint`, `position_nft_account`, `token_a_program`,
`token_b_program`, `event_authority`, `damm_program`.

Guards enforced by OUR program before the CPI (022 + 030):

- Each fee ATA owner must equal the `vault` PDA and its mint must equal
  the pool mint on the same leg. DAMM pays fees to any token_a/b
  account when the NFT owner signs, so without this check anyone could
  direct the vault's fee revenue to their own accounts.
- Pool mints must include `state.base_mint` exactly once; the other leg
  is wSOL (mock wSOL in tests). Per-leg mint checks plus the canonical
  fee set below force the other leg to match the vault wSOL ATA mint.
- Fee destinations must equal exactly `{state.vault_base_ata,
state.vault_wsol_ata}` in any order. Owner plus mint checks alone
  still allow a second vault-owned ATA, which DAMM would pay while
  sweep only reads the canonical ATAs, stranding revenue. Base dust is
  recoverable via `sweep_base`.
- Each token program must equal the program that owns the pool mint on
  the same leg, so a fake program cannot swallow the transfer.

Rules:

- 100% of LP is locked. Claim does not unlock. Permanent lock stays.
- Claim post-migration only. Before migration `damm_pool` is default and claim is skipped.
- If delegate path is used later, set `PositionDelegatePermission::ClaimPositionFee` bit 3 and SPL approve amount `0`. Start with owner path for simplicity.
  Source: DAMM v2 instructions docs positions and fees tables, DAMM v2 SDK reference.

### 2c. Project 0 marginfi v2

All CPIs target `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`. Authority signer is `vault` PDA via CPI seeds. Amounts are base units.

`marginfi_account_initialize` (keypair version, for reference):

- Accounts: `group`, `marginfi_account` (new keypair signer, mut), `authority` (signer), `fee_payer` (signer), `system_program`.
- Args: none. We use PDA path for new accounts. This is only for reading old tooling.

`marginfi_account_initialize_pda` (our path, verified Oct 2026 against
`@0dotxyz/p0-ts-sdk` 2.11.0 IDL and a live local validator with the cloned
mainnet Group):

- Inner CPI accounts (6, order matters): `group` (readonly), `marginfi_account`
  (writable PDA to init), `authority` = `vault` PDA (signer via CPI seeds),
  `fee_payer` (writable signer, caller pays), `instructions_sysvar`
  (`Sysvar1nstructions...`, the marginfi program uses it for PDA init
  validation), `system_program`.
- Args: `account_index: u16 = 0`, `third_party_id: Option<u16> = None`.
  Borsh `None` is a single `0x00` byte, so the 11-byte data
  (`disc + u16LE(0) + 0x00`) matches the IDL. Discriminator confirmed
  `[87, 177, 91, 80, 218, 119, 245, 31]`.
- After init, store address in `FeeShortState.marginfi_account`.
- Marginfi PDA seeds: `[b"marginfi_account", group, authority, u16LE(account_index),
u16LE(third_party_id.unwrap_or(0))]`. Authority is our `vault` PDA, so the
  client derives it with the vault key and both zero buffers.
- Outer ix must ALSO pass `instructions_sysvar` and the marginfi v2 program
  account (readonly). The runtime resolves the CPI target from the outer
  transaction: without the program account it fails with
  `Unknown program MFv2...` + `InstructionError [0, MissingAccount`.
  This applies to every real CPI in this program, not just init.

`lending_account_deposit` (wSOL -> SOL Bank):

- Accounts: `group`, `marginfi_account` (mut), `authority` = vault (signer), `bank` = SOL Bank (mut), `signer_token_account` = `vault_wsol_ata` (mut), `liquidity_vault` = SOL Bank liquidity vault (mut), `token_program` (SPL Token for wSOL).
- Remaining: nothing required (SOL bank is SPL Token, `maybe_take_bank_mint`
  takes nothing). Health pairs may be passed; marginfi ignores them.
- Args: `amount: u64` lamports, `deposit_up_to_limit: None`.
- No health check. Always improves health.
  Source: Project 0 `deposit.rs` `LendingAccountDeposit` struct.

`lending_account_borrow` (PUMP from PUMP Bank, inside the combined crank):

- Accounts: `group`, `marginfi_account` (mut), `authority` = vault (signer), `bank` = PUMP Bank (mut), `destination_token_account` = `vault_pump_ata` Token-2022 (mut), `bank_liquidity_vault_authority` (PDA, seeds `[LIQUIDITY_VAULT_AUTHORITY_SEED, bank]`), `liquidity_vault` = PUMP Bank vault (mut), `token_program` = Token-2022 program.
- Remaining accounts: the PUMP mint FIRST (`maybe_take_bank_mint` takes
  `remaining[0]` for Token-2022 banks, `T22MintRequired` otherwise), then
  health-check banks + oracles in the same order as the marginfi account
  balances (descending bank pubkey): `[pump_mint, sol_bank, sol_oracles...,
pump_bank, pump_oracles...]`. Each Bank contributes `bank, oracle_keys[0]`
  (bank oracle). No Kamino reserve needed for native banks. Include group rate limiter oracle group if enabled.
- Args: `amount: u64` PUMP base units (6 decimals, Token-2022).
- Health uses Initial weights. Fails if Initial health < 0. Also runs circuit-breaker price gate and premium snapshot update.
- Must pass fresh bank oracles. Borrow uses EMA price. The local clone
  injects fresh bank oracle accounts (`scripts/local-e2e.sh`); on mainnet
  the caller tops them up when needed.
  Source: Project 0 `borrow.rs` `LendingAccountBorrow` struct, risk engine docs (Initial vs Maintenance), oracles docs (EMA for borrow, staleness).

Token-2022 note:

- PUMP is Token-2022. Use Token-2022 program for `destination_token_account`, `liquidity_vault`, `token_program`. Handle transfer fee on PUMP via `maybe_take_bank_mint` path. Keep chunk small so fee is tiny. Verify PUMP Bank `mint` equals `pumpCmXq...Dfn` on-chain before borrow.

`lending_account_repay` (cover short, admin close only):

- Accounts: `group`, `marginfi_account` (mut), `authority` = vault (signer), `bank` = PUMP Bank (mut), `signer_token_account` = `vault_pump_ata` Token-2022 (mut, holds cover PUMP), `liquidity_vault` = PUMP Bank vault (mut), `token_program` = Token-2022 program.
- Remaining: the PUMP mint FIRST (`maybe_take_bank_mint` takes
  `remaining[0]` for Token-2022 banks), then health pairs as in borrow.
- Args: `amount: u64`, `repay_all: Option<bool>`. Use `repay_all = true` to close debt. Amount is estimate. Program settles exact debt.
- No health check on repay. Always improves health.
- Our flow: admin buys PUMP on the open market to `vault_pump_ata`, then CPI repay in same or later tx. No delegate needed for repay since vault signs CPI.

`lending_account_withdraw` (remove SOL collateral, admin close only):

- Accounts: `group`, `marginfi_account` (mut), `authority` = vault (signer), `bank` = SOL Bank (mut), `destination_token_account` = `vault_wsol_ata` (mut), `bank_liquidity_vault_authority` (PDA), `liquidity_vault` = SOL Bank vault (mut), `token_program` = SPL Token program.
- Remaining: health-check banks + oracles, same order as borrow (descending
  bank pubkey). For 2-balance account: `[sol_bank, sol_oracles, pump_bank,
pump_oracles]`. No mint first: SOL bank is SPL Token (`maybe_take_bank_mint`
  takes nothing).
- Args: `amount: u64`, `withdraw_all: Option<bool>`. Use `withdraw_all = true` only when debt is zero.
- Health uses Initial weights. Fails if it would make Initial health < 0. Admin must repay PUMP first, then withdraw SOL.

### 2c2. Project 0 pulse_health + on-chain health guard

Inside `borrow_sell_deposit_checked`, after borrow + swap + deposit, the program pulses health and enforces it. Full spec: `docs/marginfi-health-guard.md`.

`lending_account_pulse_health`:

- Discriminator `[186,52,117,97,34,74,39,253]`. No args.
- Inner accounts (order matters): `marginfi_account` (writable), `group` (readonly).
- Remaining: for each active balance in marginfi balance order, `[bank, oracle]`. For our SOL + PUMP account: `[sol_bank, sol_oracle, pump_bank, pump_oracle]` (descending bank pubkey, SOL first).
- Outer ix must also pass the marginfi v2 program account (readonly). Without it the runtime fails with unknown program.

Health cache read (fail closed):

- Account len must be 2312. Health offset 1840. `HealthCache` 304 bytes.
- Fields: `asset_value` (1840..1856), `liability_value` (1856..1872), `asset_value_maint` (1872..1888), `liability_value_maint` (1888..1904), all I80F48 i128 LE. Then `timestamp` i64 (1936..1944), `flags` u32 (1944..1948), `mrgn_err` u32 (1948..1952), `program_version` u8 at 2085.
- Flags: bit 2 `ENGINE_STATUS_OK`, bit 4 `ORACLE_OK`. Both must be set.
- Formulas (2^48 scale cancels): `asset * 10_000 >= liability * 15_000` (1.50) and `asset_maint * 10_000 >= liability_maint * 12_500` (1.25). Checked i128 mul. Overflow reverts.
- Reject on liability <= 0, any negative, short data, stale timestamp (> 60s vs `Clock::get()`), future timestamp, flags clear, `mrgn_err != 0`, `program_version == 0`, or layout drift.
- Unit test builds exact CPI data and metas. Local-clone proof in `scripts/local-e2e.sh` (positive) and `scripts/health-rollback-local.sh` (`HEALTH_ROLLBACK_OK` negative).

### 2d. Sweep out (admin only, no CPI to lending)

`sweep_out(amount: u64)` moves wSOL proceeds out of the vault to the
configured `sweep_destination`:

- Accounts: `state` (mut, `has_one = admin`), `admin` (signer), `vault` PDA
  (signer via seeds), `vault_wsol_ata` (mut, must equal
  `state.vault_wsol_ata`), `destination` (mut, must already exist),
  `token_program` (must be the SPL Token program).
- Checks: signer is admin; works while paused (029, no unpause race); amount > 0 (`ZeroAmount`
  otherwise, no silent no-op); destination owner == `sweep_destination`
  (`Unauthorized`); destination mint == vault ATA mint (`BadMint`).
  A missing or closed destination ATA (empty account data) also fails here
  with `BadMint`; `sweep_out` never creates it.
- Transfer, NOT close: plain SPL Token `Transfer` CPI signed by the vault
  PDA, so the vault ATA survives and future fee claims keep working.
  The destination is never created by this instruction.
- Modes: the owner check is a plain pubkey comparison, so both modes work
  with the same code — (a) a wallet pubkey owning its wSOL ATA, (b) a
  program PDA owning its wSOL ATA. No keypair assumptions.
- Events: `EvtSweep { destination, amount }` on every sweep. Here
  `destination` is the destination ATA that received the funds, not the
  configured `sweep_destination` owner pubkey; derive the owner from the ATA
  if an indexer needs it.
  `EvtSweepDestinationChanged { old_destination, new_destination }` when
  `update_config` changes the destination.

### 2e. Sweep base (admin only, non-wSOL recovery)

`09` `sweep_base(amount: u64)` moves base fee dust out of the vault to the
configured `sweep_destination` (030):

- Accounts: `state` (mut, `has_one = admin`), `admin` (signer), `vault` PDA
  (signer via seeds), `vault_base_ata` (mut, must equal
  `state.vault_base_ata`), `destination` (mut, must already exist),
  `base_mint` (must equal `state.base_mint`), `token_program` (must own
  `base_mint`, SPL or Token-2022).
- Checks: signer is admin; works while paused; amount > 0 (`ZeroAmount`);
  `vault_base_ata` owner == vault and mint == `base_mint`;
  destination owner == `sweep_destination` (`Unauthorized`); destination
  mint == `base_mint` (`BadMint`). Never creates or closes accounts.
- Transfer, NOT close: plain token `Transfer` CPI signed by the vault PDA.
- Decision: DBC collects in `QuoteToken` mode so base fees are dust, and
  DAMM base fees are dust too. Instead of enforcing quote-only on-chain
  via config parsing, the program stores the canonical base ATA and
  provides this admin-only recovery path so base fees can never strand.
  No sale: the admin sells manually if needed.
- Event: `EvtSweepBase { destination, amount }` on every sweep.

### 2f. update_config guards and events (admin only)

`update_config(damm_pool, damm_position, sweep_destination, pump_pool, paused)` rewrites the tunable config. All guards run before any write, so a failed update leaves the old config intact:

- `sweep_destination == default` reverts (`Unauthorized`): no real ATA is owned by the default key, so sweep_out/sweep_base could never succeed.
- `pump_pool == default` reverts (`Unauthorized`): the DLMM CPI would fail on every crank.
- `damm_pool` / `damm_position` must be both default (pre-migration, claim skipped) or both set; a half-set pair reverts (`Unauthorized`) because `claim_damm_fees` would fail closed later.
- There are no cap, epoch, cooldown, or min-claim fields since 037. The remaining guards are default sweep/pump and the DAMM pair.
- Events: `EvtSweepDestinationChanged` / `EvtPoolChanged` fire only when those fields change, but `EvtConfig` (all five fields: damm_pool, damm_position, sweep_destination, pump_pool, paused) fires on EVERY successful update. Indexers must read `EvtConfig`, not the conditional pair.

## 3. DLMM swap2 CPI (single fixed pool)

Target: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
(LB-CLMM v0.12.0, as installed via `@meteora-ag/dlmm` 1.9.14).
Pool: `HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh`
(PUMP/wSOL, X=PUMP, Y=wSOL). Swap direction is always X -> Y
(`swapForY = true`).

Discriminator: `414b3f4ceb5b5b88` = `[65, 75, 63, 76, 235, 91, 91, 136]`
(`global:swap2`). Data layout: disc 8 + `amount_in` u64 le + `min_out_amount`
u64 le + `RemainingAccountsInfo` Borsh (`vec len` u32 le, then
`(accounts_type u8, length u8)` per slice). Our pool has no transfer hooks,
so slices are always `[{TransferHookX, 0}, {TransferHookY, 0}]`, encoded as
`02 00 00 00 00 00 01 00`. Total 32 bytes. Example for 1,000,000 PUMP in,
min out 0:
`414b3f4ceb5b5b88` + `40420f0000000000` + `0000000000000000` +
`0200000000000100`.

Account order (exactly the installed IDL order; `user` = vault PDA via
`invoke_signed`):

1. `lb_pair` (`dlmm_pool`, mut) — must equal `state.pump_pool`.
2. `bin_array_bitmap_extension` (`dlmm_bitmap`, mut).
3. `reserve_x` (mut), 4. `reserve_y` (mut).
4. `user_token_in` = `vault_pump_ata` (mut), 6. `user_token_out` = `vault_wsol_ata` (mut).
5. `token_x_mint` (PUMP), 8. `token_y_mint` (wSOL).
6. `oracle` (mut). 10. `host_fee_in` = DLMM program id (readonly
   placeholder for `None`). 11. `user` = `vault` PDA (readonly, signer).
7. `token_x_program` (Token-2022), 13. `token_y_program` (SPL Token).
8. `memo_program`. 15. `event_authority` PDA `["__event_authority"]`
   (`D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6`, checked on-chain).
9. `program` = DLMM program id. Then remaining: bin arrays (writable,
   at least 1).

Bin-array rule: remaining accounts after the 5 marginfi health accounts are
the DLMM bin arrays touched by the runtime quote (`swapQuote` with
`getBinArrayForSwap(true)`). At 1 PUMP the quote touches 1-2 bins; at
10k-100k PUMP it touches 1 bin. The program passes through whatever the
caller supplies; the DLMM program validates coverage and fails the whole
crank otherwise.

`min_out_amount = 0`: there is no price floor. The hardcoded health guard
on resulting leverage (1.50 initial, 1.25 maintenance) is the only bound,
because the pool is fixed and admin-chosen. No oracle is read and no
slippage check runs;
`EvtBorrowSellDeposit` reports the realized `sol_out` from the vault wSOL
ATA delta plus the guard ratios.

Byte proof: for the same amount the hand-built bytes above equal the ix
produced by `@meteora-ag/dlmm` `program.methods.swap2(amount, 0, {slices})`,
and the account order/flags match the SDK ix exactly.

## 4. Single-ix crank (borrow + sell + deposit + pulse + guard)

Why one CPI into one pool:

- An aggregator top-level swap needs 45-67 accounts and 1335-1741 bytes
  even with LUTs: it cannot fit with borrow + verify in one tx.
- A DLMM `swap2` into one pool needs 36 accounts / 14 writable in the combined shape. With the DLMM ALT it serializes
  to ~541 bytes with headroom.

Pattern (one crank = one program ix, permissionless, uncapped):

1. `borrow_sell_deposit_checked(amount)`: checks paused, `amount > 0`. Reads `vault_wsol_ata` as `wsol_before`. CPIs marginfi `lending_account_borrow` into `vault_pump_ata` (health remaining `[pump_mint, sol_bank, sol_oracle, pump_bank, pump_oracle]` + quote bins). CPIs DLMM `swap2` `vault_pump_ata` -> `vault_wsol_ata` with the vault PDA as `user`. Reads `vault_wsol_ata` as `wsol_after`, `actual_sol_out = after - before` must be > 0. CPIs marginfi `lending_account_deposit` of exactly `actual_sol_out`. CPIs marginfi `pulse_health` with the 4 health pairs. Reads the health cache, enforces 1.50/1.25, emits `EvtBorrowSellDeposit`.
2. If any leg fails, the whole tx reverts. No partial state, no pending account, no keeper delegate to revoke.

Crank tx size: the caller prepends a compute-budget ix
(400k units covers the ~365k measured). No ALT is required: the E2E proves
a legacy tx with no ALTs fits (36 accounts, 14 writable, 1119 bytes, 365,822 CU). The
DLMM ALT and a project ALT are optional headroom only.

Tests (keeperless, 55 unit / 31 client):

- Unit: state space exact (483), crank guards (zero/paused, no cap), health guard boundaries (both ratios, zero liab, negative, short, overflow, stale/future, flags clear, mrgn_err, raw vectors), version pin (exactly 3), bank/pool parsers + binding helpers, group discriminator, `dlmm_swap2_data` discriminator + Borsh bytes, `pulse_health` data + metas, marginfi data builders, sweep guards, token readers.
- Local-test: mock DBC/marginfi/DLMM skips (SystemProgram-owned mocks),
  `borrow_sell_deposit_checked` guards + mock-path success + `EvtBorrowSellDeposit`, old `borrowAndSellPump` absent.

Sources:

- DBC instructions and reference: `docs.meteora.ag/developer-guides/dbc/program/instructions`, TS SDK reference.
- DAMM v2 instructions: `docs.meteora.ag/developer-guides/damm-v2/program/instructions`, program `cpamdp...`.
- Project 0: `docs.0.xyz/protocol-overview/architecture`, risk engine, oracles, liquidation, program addresses, TS SDK getting-started and lending-and-borrowing, repos `0dotxyz/p0-ts-sdk` and `0dotxyz/marginfi-v2`, `deposit.rs` and `borrow.rs` account structs, `docs/marginfi-health-guard.md`.
- DLMM: `@meteora-ag/dlmm` 1.9.14 SDK + LB-CLMM v0.12.0 IDL, pool
  `HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh`.
