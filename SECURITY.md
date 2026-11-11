# Security Policy (`Mono no Aware` / `fee-short`)

## Reporting a Vulnerability

Do not open a public issue for a suspected security vulnerability. Contact the repository maintainers privately with:

- A clear description of the issue and the commit SHA reviewed,
- Exact steps or scripts to reproduce it (accounts, instructions, parameters),
- Assessment of impact (fund loss, permanent state lock, or griefing).

The maintainers will review the report and coordinate a fix before public disclosure.

## Scope

- **In scope:** `programs/fee-short/src/lib.rs`, `scripts/launch.ts`, `scripts/preflight.ts`, and `scripts/manual-crank.ts`.
- **Out of scope:** Third-party protocols invoked via CPI (Meteora DBC `dbcij...`, Meteora DAMM v2 `cpamdp...`, Meteora DLMM `LBUZKh...`, and Project 0 / marginfi v2 `MFv2hW...`).

## Design & Risk Guarantees

- **No user deposits:** The `fee-short` vault holds only accrued Meteora trading fees and swap proceeds from its own short position.
- **Immutable core accounts:** Mints, vault ATAs, DBC pool/config, and Project 0 group/banks are verified and bound once at initialization (`init_state`, gated by the program's `ProgramData` upgrade authority).
- **Atomic health factor guard:** `borrow_sell_deposit_checked` executes the borrow, DLMM swap, SOL collateral deposit, and `lending_account_pulse_health` in a single atomic instruction and reverts (`0x1771`) unless post-crank initial health is at least `1.50x` (`15,000 bps`) and maintenance health is at least `1.25x` (`12,500 bps`).
