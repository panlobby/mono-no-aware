# Mainnet launch runbook

Token metadata is final and pinned to Arweave. Do not run `--send` until the wallet is funded.

## Configuration

- Launch wallet (`deployer` / `state.admin` / `upgradeAuthority`): `DtNMDWy9dxrTSQxAruwbzSrY2NE3KFd4aDxMD79X9fLH` (`~/.config/solana/id.json`).
- No keeper daemon or server is required; operations use one-shot CLI scripts.
- Send RPC: `https://solana-rpc.publicnode.com`
- Read RPC: `https://api.mainnet-beta.solana.com`

If a send fails on PublicNode, retry the same idempotent stage with:

```bash
--rpc https://api.mainnet-beta.solana.com
```

## Required inputs

1. Fund the launch wallet. Preflight computes the exact minimum from the production `.so` size:
   - ProgramData rent: `2.633416120 SOL`
   - Temporary deploy buffer rent: `2.633416120 SOL` (refunded upon deploy completion)
   - Minimum upfront estimate: `5.766832240 SOL`
   - Recommended wallet balance before launch: **6.5–7 SOL** (covers DBC config/pool/token metadata, ATAs, state, marginfi account, and transaction fees).
2. Final token metadata:
   - name: `Mono no Aware`
   - symbol: `mono`
   - metadata JSON: `https://ar-io.dev/qG41oNKpHzh66gG7v55GwZJLAqhtv5xJ1ppLnclyc1M`
   - logo: `https://arweave.net/OUVC8SAMBggSjKooHrPidIDVmu4JuL-XPGahBOg9NDQ`
   - source repository: `https://github.com/panlobby/mono-no-aware`
3. Production artifact must match `scripts/production-artifact.json`.
4. Keep a backup of:
   - `~/.config/solana/id.json`
   - `target/deploy/fee_short-keypair.json`
   - `.keys/mainnet/launch/` after `prepare`

Never publish private key file contents.

## 0. Read-only checks

```bash
npm run verify:artifact
npx ts-node scripts/preflight.ts --stage predeploy \
  --rpc https://api.mainnet-beta.solana.com

npx ts-node scripts/launch.ts --stage plan
```

Expected:

- `PRODUCTION_ARTIFACT_OK`
- `PREFLIGHT_OK`
- `PLAN_OK no transaction sent`

Preflight fails if the wallet is below the computed funding floor.

## 1. Prepare: program, DBC config/pool, ATAs, paused state

This broadcasts real mainnet transactions:

```bash
npx ts-node scripts/launch.ts --stage prepare \
  --send --confirm-mainnet \
  --name "Mono no Aware" \
  --symbol "mono" \
  --uri "https://ar-io.dev/qG41oNKpHzh66gG7v55GwZJLAqhtv5xJ1ppLnclyc1M" \
  --rpc https://solana-rpc.publicnode.com \
  --read-rpc https://api.mainnet-beta.solana.com
```

The script is idempotent. It will:

1. verify the production artifact hash and source hashes;
2. run predeploy checks and require enough lamports;
3. deploy `target/production/fee_short.so` with `target/deploy/fee_short-keypair.json` only if the program is absent;
4. create the DBC config and pool with:
   - `fee_claimer = fee-short vault PDA`
   - `leftover_receiver = vault PDA`
   - canonical `pump.fun` parity curve and fees
5. transfer the DBC pool creator to the vault PDA;
6. create the canonical vault wSOL, PUMP and base ATAs;
7. call `init_state` and leave `paused = true`.

Generated keys and all signatures are stored under `.keys/mainnet/launch/`. Back them up.

Expected final line:

```text
PREPARE_OK program/config/pool/ATAs/state ready; state remains PAUSED
```

## 2. Post-init preflight

```bash
npx ts-node scripts/preflight.ts --stage postinit \
  --rpc https://api.mainnet-beta.solana.com \
  --base-mint <BASE_MINT_FROM_LAUNCH_RECORD>
```

Expected: `PREFLIGHT_OK`.

## 3. Go live: atomic unpause + marginfi account

This is the launch switch:

```bash
npx ts-node scripts/launch.ts --stage go-live \
  --send --confirm-mainnet \
  --rpc https://solana-rpc.publicnode.com \
  --read-rpc https://api.mainnet-beta.solana.com
```

The go-live transaction executes both operations atomically:

1. `update_config` sets `paused = false` while preserving DAMM config, sweep destination and DLMM pool;
2. `init_marginfi_account` creates the vault's marginfi account.

If either fails, the whole transaction reverts and the state stays paused.

Expected final line:

```text
GO_LIVE_OK state=... marginfi=...
```

## 4. Live verification

```bash
npx ts-node scripts/preflight.ts --stage live \
  --rpc https://api.mainnet-beta.solana.com
```

Expected: `PREFLIGHT_OK`, state unpaused, marginfi account owner `MFv2...`, length 2312.

## 5. First fee cycle

The strategy starts with zero collateral and uses accrued DBC trading fees. After the first trades:

```bash
npx ts-node scripts/manual-crank.ts \
  --send --claim --warn-claim-below 1000 \
  --deposit-vault-wsol --amount 1000000 \
  --rpc https://api.mainnet-beta.solana.com
```

This:

1. claims DBC/DAMM fees to the vault wSOL ATA;
2. deposits the vault's existing wSOL into Project 0 SOL Bank;
3. performs one combined `borrow_sell_deposit_checked` of 1 PUMP (`1,000,000` raw units);
4. prints the emitted event and health factors before/after.

## Failure recovery

- `prepare` fails before any tx: fix the reported check and rerun.
- `prepare` fails after program/config/pool creation: rerun the same command. The script reuses `.keys/mainnet/launch` and skips existing accounts.
- `go-live` fails: state stays paused because unpause + marginfi init are atomic. Fix the error and rerun the same command.
- Do not run `anchor test` and then deploy `target/deploy/fee_short.so`. The deploy source is always `target/production/fee_short.so`.
- To pause at any time after go-live: run `npx ts-node scripts/manual-crank.ts --mode pause --send`.
