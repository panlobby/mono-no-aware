# Mono no Aware (`$mono` · 物の哀れ)

![Mono no Aware](final.webp)

**Mono no Aware (物の哀れ)** is a Japanese aesthetic concept describing the quiet, bittersweet awareness of impermanence — the appreciation of things that are fleeting and temporary. Cherry blossoms scatter, light fades, and a moment that passes can never return. The awareness that nothing lasts is what gives it meaning.

In the hyper-accelerated cycle of Solana's token trenches, where narratives ignite and vanish in minutes, **`$mono`** turns that impermanence into an autonomous on-chain mechanism:

* **Familiar Curve, Different Fate:** `$mono` launches on a **Meteora Dynamic Bonding Curve (DBC)** configured to match `pump.fun`'s exact virtual-reserve curve (`30` virtual SOL + `1,073M` virtual tokens, graduating at `85 SOL` net inflow into a **100% permanently locked Meteora DAMM v2** pool).
* **Every Trade Shorts the Casino:** Instead of going to a creator wallet, **100% of non-protocol SOL trading fees** (`1.00%` on the bonding curve and `0.20%` on locked DAMM v2 LP after graduation) accrue directly to the on-chain `fee-short` vault PDA.
* **Keeperless Atomic Short Crank:** Anyone can permissionlessly claim accrued SOL fees, deposit them as collateral into **Project 0** (`marginfi v2`), and execute `borrow_sell_deposit_checked` — a single atomic instruction that borrows **`PUMP`**, sells it into the Meteora DLMM `PUMP/wSOL` pool, deposits the exact SOL proceeds back as collateral, refreshes the marginfi risk engine (`lending_account_pulse_health`), and enforces a hardcoded on-chain health factor (**`1.50x` initial / `1.25x` maintenance**).

What rises eventually fades — and every trade along the curve feeds an on-chain short position on `PUMP`.

---

## Mainnet & Protocol Addresses

| Item | Address |
| :--- | :--- |
| **Token Mint (`mono`)** | [`FDiXHZyXjH2di3f5WJkTE51junrL5HRPrW8axhgd41Fv`](https://solscan.io/token/FDiXHZyXjH2di3f5WJkTE51junrL5HRPrW8axhgd41Fv) |
| **Meteora DBC Pool** | [`EtKb9MTjwaKzFBYWLNZsoF9Hptj3iD7QPhkUgB9J1aww`](https://solscan.io/account/EtKb9MTjwaKzFBYWLNZsoF9Hptj3iD7QPhkUgB9J1aww) |
| **Meteora DBC Config** | [`HRMPbehJrznLKYCCSeo5GZFTmUaudUP5ZuWGJUjnpc33`](https://solscan.io/account/HRMPbehJrznLKYCCSeo5GZFTmUaudUP5ZuWGJUjnpc33) |
| **Token Metadata (Arweave)** | [`ar-io.dev/qG41oNKpHzh66gG7v55GwZJLAqhtv5xJ1ppLnclyc1M`](https://ar-io.dev/qG41oNKpHzh66gG7v55GwZJLAqhtv5xJ1ppLnclyc1M) |
| **`fee-short` Program** | [`EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj`](https://solscan.io/account/EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj) |
| **Fee-Short State PDA** | [`HgEjPtFj8pHnoVdjsWMH5czDfTCHXuAeGvn9wf1t81oz`](https://solscan.io/account/HgEjPtFj8pHnoVdjsWMH5czDfTCHXuAeGvn9wf1t81oz) |
| **Fee-Short Vault PDA** | [`JqPHpFyqDWx6T3Krc4qTKRgUat6jzV4Nm9oVjT3CQVe`](https://solscan.io/account/JqPHpFyqDWx6T3Krc4qTKRgUat6jzV4Nm9oVjT3CQVe) |
| **Project 0 Marginfi Account** | [`5Vn7h4CPrRnhthnhbkMnp8DizFFP3GqmUAw99muwifMi`](https://solscan.io/account/5Vn7h4CPrRnhthnhbkMnp8DizFFP3GqmUAw99muwifMi) |
| **Vault wSOL ATA** | [`59NC6c2i6swgJWqhX7EHUCiFrxxVgCNgJSSFjQCsMZjm`](https://solscan.io/account/59NC6c2i6swgJWqhX7EHUCiFrxxVgCNgJSSFjQCsMZjm) |
| **Vault PUMP ATA (Token-2022)** | [`7J6UpDsUqF72qhJMyTEkKR7qLorXgCwsksSpxEhijPZW`](https://solscan.io/account/7J6UpDsUqF72qhJMyTEkKR7qLorXgCwsksSpxEhijPZW) |
| **Vault Base (`mono`) ATA** | [`BgP31YDZd4SNGgLwmdtxvkgvZ4WjWoS2SiaBTJHzSa2Q`](https://solscan.io/account/BgP31YDZd4SNGgLwmdtxvkgvZ4WjWoS2SiaBTJHzSa2Q) |
| **Project 0 (`marginfi v2`) Program** | [`MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`](https://solscan.io/account/MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA) |
| **Project 0 Mainnet Group** | [`4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8`](https://solscan.io/account/4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8) |
| **Project 0 SOL Bank** | [`CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh`](https://solscan.io/account/CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh) |
| **Project 0 PUMP Bank** | [`61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK`](https://solscan.io/account/61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK) |
| **Meteora DLMM `PUMP/wSOL` Pool** | [`HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh`](https://solscan.io/account/HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh) |

---

## How the Mechanism Works

### 1. Curve & Graduation (`Meteora DBC` → `DAMM v2`)
* **Supply:** `1,000,000,000` `$mono` (6 decimals, standard SPL Token).
* **Bonding Curve:** 1-segment constant-product curve (`30` virtual SOL × `1,073M` virtual tokens). `793,086,956.5` tokens are sold along the curve until `85 SOL` of net quote liquidity is collected (`27.96 SOL` starting market cap → `410.84 SOL` graduation market cap).
* **Fee Routing:** Swap fee on the curve is `1.25%` in quote token (`wSOL`). With `creatorTradingFeePercentage = 0` and the vault PDA set as both partner `fee_claimer` and pool `creator`, `100%` of non-protocol trading fees (`1.00%` of volume) are claimable only by the `fee-short` vault PDA.
* **Permanent LP Lock at Graduation:** Upon reaching `85 SOL`, the remaining `206,913,043.5` tokens and `85 SOL` migrate to a **Meteora DAMM v2** pool (`25 bps` fee) with **100% of LP permanently locked** (`50%` partner locked + `50%` creator locked) under the vault PDA, continuing to generate SOL fees for the vault indefinitely.

### 2. Permissionless Short Crank (`borrow_sell_deposit_checked`)
Anyone can trigger fee claims, collateral deposits, and the short crank without a keeper server or allowlist:
1. **Claim Fees:** `claim_dbc_fees` (bonding curve) and `claim_damm_fees` (post-graduation locked LP) pull accrued wSOL into `vault_wsol_ata`.
2. **Deposit Collateral:** `deposit_sol` supplies the vault's wSOL into the Project 0 SOL Bank (`CCKt...`).
3. **Borrow, Sell, Recycle & Pulse Health:** In a single atomic instruction (`borrow_sell_deposit_checked`), the program:
   * Borrows `amount` of `PUMP` (`pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn`, Token-2022) from the Project 0 PUMP Bank (`61Qx...`) into `vault_pump_ata`.
   * Swaps that exact `PUMP` amount for `wSOL` in the Meteora DLMM pool (`HbjY...`) via CPI (`swap2`).
   * Measures the exact `wSOL` proceeds (`actual_sol_out > 0`) and deposits them back into the Project 0 SOL Bank as additional collateral.
   * Calls `lending_account_pulse_health` on Project 0 and reads the refreshed `HealthCache` directly from the `MarginfiAccount`.
   * Enforces **`initial_hf >= 1.50x`** (`15,000 bps`) and **`maint_hf >= 1.25x`** (`12,500 bps`) using checked integer math. If either ratio is below threshold, or if oracle/engine flags are invalid, the entire transaction reverts (`0x1771`).

---

## Trust Model & Transparency

* **Zero User Deposits:** The program accepts no user deposits. Every lamport in the vault comes strictly from Meteora trading fees or the short position's own swap proceeds.
* **Immutable Core Bindings:** `group`, `sol_bank`, `pump_bank`, `dbc_pool`, `dbc_config`, `base_mint`, and the canonical vault ATAs (`vault_wsol_ata`, `vault_pump_ata`, `vault_base_ata`) are verified and bound once at `init_state` (gated by the program's `ProgramData` upgrade authority) and cannot be altered by `update_config`.
* **Auditable Events:** Every crank emits `EvtBorrowSellDeposit { pump_amount, sol_out, initial_hf_bps, maint_hf_bps }`. Any admin configuration update or unwind sweep (`repay_all`, `withdraw_all`, `sweep_out`, `sweep_base`) emits explicit on-chain events (`EvtConfig`, `EvtSweep`, `EvtSweepBase`).

### Documentation
* [`docs/dbc-pump-parity-spec.md`](docs/dbc-pump-parity-spec.md) — Bonding curve math, Q64.64 prices, and fee split specification.
* [`docs/fee-short-architecture.md`](docs/fee-short-architecture.md) — Architecture, Project 0 risk weights, trust boundaries, and manual close runbook.
* [`docs/program-cpi-spec.md`](docs/program-cpi-spec.md) — PDAs, state layout, and exact CPI account layouts for Meteora DBC, DAMM v2, DLMM, and Project 0.
* [`docs/marginfi-health-guard.md`](docs/marginfi-health-guard.md) — `lending_account_pulse_health` CPI, `HealthCache` byte offsets, and `I80F48` guard verification.
* [`docs/mainnet-launch.md`](docs/mainnet-launch.md) — Mainnet preflight, deployment, and crank execution runbook.

---

## Build & Verification

```bash
# Rust unit tests (55 tests)
cargo test -p fee-short --locked --features local-test

# Production compile check & Anchor build (excludes local-test mocks)
cargo check -p fee-short --locked
anchor build

# Verify pinned production artifact & IDL allowlist
npm run verify:artifact

# Verify curve math & launch parameters
npm run verify:params
npm run check
npm run lint

# Client integration test suite (31 tests on local validator)
anchor test -- --features local-test

# Read-only mainnet preflight & launch plan
npm run preflight
npm run launch:plan
```
