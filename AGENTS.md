# Repository Guide (`mono-no-aware`)

**Mono no Aware (`$mono` · 物の哀れ)** is a Solana token launched on a Meteora Dynamic Bonding Curve (DBC) paired with `fee-short` — an on-chain Anchor program that routes SOL trading fees into an autonomous, health-guarded `PUMP` short position on Project 0 (`marginfi v2`) and Meteora DLMM.

## Concept

*Mono no Aware* (物の哀れ) is the Japanese aesthetic appreciation of impermanence — the gentle recognition that every bloom scatters and every cycle fades. In the context of Solana's meme-token frenzy, `$mono` uses the exact curve and fee structure of `pump.fun` on Meteora DBC, but directs 100% of non-protocol SOL trading fees into an on-chain vault that borrows `PUMP` on Project 0 and sells it into Meteora DLMM, recycling the proceeds as collateral under a hardcoded on-chain health guard (`1.50x` initial / `1.25x` maintenance).

## Repository Layout

* `programs/fee-short/src/lib.rs` — On-chain Anchor program that claims Meteora DBC and DAMM v2 SOL trading fees, deposits SOL into Project 0 (`CCKt...`), and executes the permissionless atomic short crank (`borrow_sell_deposit_checked`): borrows Token-2022 `PUMP` (`61Qx...`), swaps it for `wSOL` in the Meteora DLMM pool (`HbjY...`), deposits the exact proceeds back into the SOL Bank, pulses the marginfi health cache, and enforces the `1.50x` / `1.25x` health factor guard.
* `migrations/deploy.ts` — Canonical launch parameters (`LAUNCH_PARAMS`).
* `migrations/check.ts` — Verification script for curve math, Q64.64 values, and mainnet addresses.
* `metadata/token.json` & `final.webp` — Token metadata and artwork pinned to Arweave.
* `tests/fee-short.ts` — Anchor client integration test suite (31 tests).
* `scripts/preflight.ts` — Read-only mainnet preflight verifier.
* `scripts/launch.ts` — Idempotent mainnet launch driver (`plan`, `prepare`, `go-live`).
* `scripts/manual-crank.ts` — One-shot CLI for claiming fees, depositing SOL, running the short crank, and unwinding.
* `scripts/check-production-artifact.ts` & `scripts/production-artifact.json` — Verifies the production `.so` binary, IDL instruction allowlist, and source SHA-256 hashes.
* `docs/` — Technical specifications (`dbc-pump-parity-spec.md`, `fee-short-architecture.md`, `program-cpi-spec.md`, `marginfi-health-guard.md`, `mainnet-launch.md`).

## Build & Verification Commands

* **Program unit tests (55 tests):**
  ```bash
  cargo test -p fee-short --locked --features local-test
  ```
* **Production check & build (excludes `local-test` helpers):**
  ```bash
  cargo check -p fee-short --locked
  anchor build
  ```
* **Production artifact verification:**
  ```bash
  npm run verify:artifact
  ```
* **TypeScript check, lint & launch parameter verification:**
  ```bash
  npm run check
  npm run lint
  npm run verify:params
  ```
* **Client integration tests (31 tests, local validator):**
  ```bash
  anchor test -- --features local-test
  ```
* **Local-clone end-to-end proofs (requires mainnet RPC):**
  ```bash
  bash scripts/local-e2e.sh
  bash scripts/health-rollback-local.sh
  bash scripts/launch-local.sh
  ```
