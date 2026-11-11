# Marginfi health guard spec

Status: implemented (`MARGINFI_PROGRAM_VERSION = 3`).

Pins:

- Program `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`.
- Group `4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8`.
- SOL Bank `CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh`.
- PUMP Bank `61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK`.
- SOL oracle `7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE`.
- PUMP oracle `4KL8nVtrXmLjbbHtrDz5YCHNqmii62oHfr9bsUtx1bgi`.
- SDK `@0dotxyz/p0-ts-sdk` `2.11.0`.
- IDL `MARGINFI_IDL` name `marginfi` version `0.1.12` spec `0.1.0`.

## 1. pulse_health CPI

IDL name is snake case `lending_account_pulse_health`.

Discriminator:

```text
[186, 52, 117, 97, 34, 74, 39, 253]
```

Check:

```bash
python3 -c "import hashlib; print(list(hashlib.sha256(b'global:lending_account_pulse_health').digest()[:8]))"
```

Result matches the IDL list.

Inner accounts (order matters):

1. `marginfi_account` writable.
2. `group` readonly.

Args: none.

Remaining accounts:

- For each active balance in the marginfi account balance order, pass `[bank, oracle]`.
- Balance order is descending bank pubkey. Marginfi sorts balances this way.
- For our fresh SOL collateral plus PUMP debt account the order is:

```text
[sol_bank, sol_oracle, pump_bank, pump_oracle]
```

Proof:

- `SOL_BANK` bytes start `a657...`, `PUMP_BANK` bytes start `4a65...`.
- `Buffer.compare(SOL, PUMP)` is `1`. SOL is larger.
- Descending sort puts SOL first.
- Both banks have one set oracle key slot `[0]`. Other slots are default.
- `scripts/local-e2e.ts` builds `healthRemaining` the same way and the live crank passes.
- `scripts/check-health-layout.ts` asserts this order offline and, when a local account is given, checks the on-chain balances match it.

Outer ix must also pass the marginfi v2 program account. Without it the runtime fails with unknown program. The SDK helper is `makePulseHealthIx` with `remainingAccounts`.

No oracle refresh is forged. Pulse reads live bank oracles. Stale oracles make pulse fail or clear `ORACLE_OK`.

## 2. MarginfiAccount layout (fresh PDA)

Account length is `2312` bytes. Owner is the marginfi v2 program. First 8 bytes are the Anchor discriminator.

Layout from the IDL (`marginfiAccount`, `bytemuck`, `repr C`):

```text
8   discriminator
32  group                    (8..40)
32  authority                (40..72)
1728 lendingAccount          (72..1800)
8   accountFlags             (1800..1808)
32  emissionsDestination     (1808..1840)
304 healthCache              (1840..2144)
32  migratedFrom             (2144..2176)
32  migratedTo               (2176..2208)
8   lastUpdate               (2208..2216)
2   accountIndex             (2216..2218)
2   thirdPartyIndex          (2218..2220)
1   bump                     (2220..2221)
1   activeOrders             (2221..2222)
2   pad0                     (2222..2224)
32  liquidationRecord        (2224..2256)
24  indexerFlags             (2256..2280)
8   rebalanceExecutionSeq    (2280..2288)
8   liquidationTaggedAt      (2288..2296)
16  padding0                 (2296..2312)
```

`lendingAccount` is `1728` bytes:

- `16` balances of `104` bytes each = `1664`.
- Each balance: `active 1` + `bankPk 32` + `bankAssetTag 1` + `tag 2` + `premiumRateSnapshot 4` + `assetShares 16` + `liabilityShares 16` + `premiumOutstanding 16` + `lastUpdate 8` + `padding 8` = `104`.
- Plus `lastTagUsed 2` + `pad1 6` + `padding 7x8=56` = `64`.
- `1664 + 64 = 1728`.

`health_cache` offset is `1840`. This is the value for a fresh account created by `init_marginfi_account` on the local clone.

Observed on a local clone Nov 2026 (minimal clones, fresh oracles):

- Fresh PDA `A4rSyFngyyr2wHeJHxuk7Kn6tZ1JifpkB1CLDNWY6JAq`, authority `8tRVP2Dorvkzt2S7AxQQAWxUXvaARH9ppsGABJMzNdvW`, init sig `j2ptw1WMghwJMDbbBpnsx8iK9oCzPDNQxfLG8fiSxVCi6B3kpN8hviYUFjEuN1jnuzMtdZ1YpCtyNfGRST9z1cv`.
- Owner is `MFv2...`, length is `2312`.
- Empty cache before pulse: all zero, `timestamp 0`, `flags 0`, `programVersion 0`. Guard must reject this.
- After `1 SOL` deposit (`5ncjbVdH6GLFmdkTur4wyW6ybkvjfxUCPCDwSrNvdukFah4CNqJw3T2i3YQxDnjgm9ZTYV8WiKGYbfBYENhfipJ7`), `1 PUMP` borrow (`42QeiE3Larj1uX8SzMMeaHbnkp71Wzi9wMUx5jqXpoisGjrbneVTWsicKK4DbQDsJXrWNWqH6CQkbNxoJ9DCZq3f`) and pulse (`3fabahRNSoMNiR2rL8149Agh2ASNuV31pyizStu3cGEhSg1phjBLyornUunxX1eGvHSYzYzQRTCVZRS2QeSbNK4B`):
- Raw `asset 21147823301348400`, `liab 1835829337700`, `maint 23791300229244702/1629298537209`, `timestamp 1794005220`, `flags 7`, `mrgn_err 0`, `programVersion 3`.
- SDK parse agrees on sign and scale (`asset ~75.13 USD`).
- Active balances are `2`, order is `[SOL_BANK, PUMP_BANK]`, so remaining is `[sol_bank, sol_oracle, pump_bank, pump_oracle]`.
- `flags 7` means `1 + 2 + 4` (healthy, engine ok, oracle ok).
- `programVersion 3` is the version seen on the fresh account, now pinned exactly (041).

Drift note:

- Some older mainnet accounts place the health cache `64` bytes earlier, at `1776`.
- A fresh PDA from the current program uses `1840`.
- The guard must fail closed on layout drift. It checks length `2312`, offset `1840`, and exact `programVersion == 3` (041). Any other shape reverts.

## 3. HealthCache layout

`HealthCache` is `304` bytes (`bytemuck`, `repr C`). Offsets are relative to `1840`. Absolute in brackets.

```text
rel 0..16    asset_value            (1840..1856)  I80F48
rel 16..32   liability_value        (1856..1872)  I80F48
rel 32..48   asset_value_maint      (1872..1888)  I80F48
rel 48..64   liability_value_maint  (1888..1904)  I80F48
rel 64..80   asset_value_equity     (1904..1920)  I80F48
rel 80..96   liability_value_equity (1920..1936)  I80F48
rel 96..104  timestamp              (1936..1944)  i64 LE
rel 104..108 flags                  (1944..1948)  u32 LE
rel 108..112 mrgn_err               (1948..1952)  u32 LE
rel 112..240 prices                 (1952..2080)  16 x 8 bytes
rel 240..244 internal_err           (2080..2084)  u32 LE
rel 244..245 err_index              (2084..2085)  u8
rel 245..246 program_version        (2085..2086)  u8
rel 246..248 pad0                   (2086..2088)  2 bytes
rel 248..252 internal_liq_err       (2088..2092)  u32 LE
rel 252..256 internal_bankruptcy_err (2092..2096) u32 LE
rel 256..288 reserved0              (2096..2128)  32 bytes
rel 288..304 reserved1              (2128..2144)  16 bytes
```

`WrappedI80F48` is `16` bytes LE. It is signed `I80F48`. Scale is `2^48`. Integer part is upper `80` bits. Fractional part is lower `48` bits.

Flags bits (u32 LE at `1944`):

- `1` HEALTHY. Set means not liquidatable.
- `2` ENGINE_STATUS_OK. Clear means engine errored. Cache may be bad.
- `4` ORACLE_OK. Clear means bad bank, bad oracle order, or stale oracle.
- `8` EMODE_BOOSTED. Info only. Written by maintenance pass.
- Other bits are reserved.

`programVersion` is `u8` at `2085`. Since `0.1.3` the version is stored here. Since 041 the guard requires exactly `3`; any other version fails closed.

`mrgn_err` is `u32` LE at `1948`. Must be `0`. Any error code reverts.

## 4. Guard formulas and thresholds

User confirmed:

- `MIN_INITIAL_HF_BPS = 15_000` (1.50).
- `MIN_MAINT_HF_BPS = 12_500` (1.25).

Use raw `I80F48` `i128` values. The `2^48` scale cancels.

```text
asset_value * 10_000 >= liability_value * 15_000
asset_value_maint * 10_000 >= liability_value_maint * 12_500
```

Both must hold. Use checked `i128` mul. Overflow reverts.

Reject and fail closed when:

- Data length is not `2312`.
- Health offset is not `1840`.
- `liability_value <= 0` or `liability_value_maint <= 0`.
- `asset_value < 0` or `asset_value_maint < 0` or any raw value is negative.
- Malformed or short data.
- Checked mul overflows.
- `timestamp` is stale vs `Clock::get()`. Max age is `60` seconds.
- `timestamp` is in the future (greater than now).
- `flags & 2 == 0` (engine error).
- `flags & 4 == 0` (oracle error).
- `mrgn_err != 0`.
- `programVersion != 3`.

No fallback to computed health. No soft pass.

## 5. Test vectors

I80F48 LE hex from the SDK (`bigNumberToWrappedI80F48`):

```text
0     00000000000000000000000000000000
1     00000000000001000000000000000000
1.25  00000000004001000000000000000000
1.5   00000000008001000000000000000000
100   00000000000064000000000000000000
```

Negative values use on-chain bytemuck `I80F48` bytes. That is a standard signed `i128` little-endian with scale `2^48`. The guard rejects any negative raw. On-chain `-1` means raw `-2^48`:

```text
000000000000ffffffffffffffffffff
```

Do not use the SDK helper `bigNumberToWrappedI80F48("-1")` for on-chain tests. That helper returns `7ffffffffffffeffffffffffffffffff`, which is not the on-chain encoding. The positive vectors above match on-chain. Task `037` must use the on-chain raw above for negative tests.

Guard boundary vectors (raw units, scale cancels):

```text
initial pass: asset 150, liab 100 -> 150*10000=1500000 >= 100*15000=1500000
initial fail: asset 149, liab 100 -> 1490000 < 1500000
maint pass:   asset 125, liab 100 -> 1250000 >= 100*12500=1250000
maint fail:   asset 124, liab 100 -> 1240000 < 1250000
liab zero:    liab 0 -> reject
negative:     asset -5 -> reject
overflow:     i128::MAX * 15000 -> reject
```

Pulse CPI data vector:

```text
disc [186,52,117,97,34,74,39,253]
inner [marginfi_account(w), group]
args []
remaining [sol_bank, sol_oracle, pump_bank, pump_oracle]
```

Health cache raw vector (synthetic, offsets above):

- Put `1.5` bytes at `1840..1856` for `asset_value`.
- Put `1.0` bytes at `1856..1872` for `liability_value`.
- Put `1.25` bytes at `1872..1888` for `asset_value_maint`.
- Put `1.0` bytes at `1888..1904` for `liability_value_maint`.
- `timestamp` = now, `flags` = `7`, `mrgn_err` = `0`, `programVersion` = `3`.
- Raw parse must equal the SDK `wrappedI80F48toBigNumber` parse.
- `scripts/check-health-layout.ts` checks these vectors offline.

## 6. How the guard maps to Project 0 weights

Live weights Nov 2026 from mainnet bank decode:

- SOL Bank: asset `0.80` init / `0.90` maint. Liability `1.14` / `1.10`.
- PUMP Bank: asset `0.40` / `0.50`. Liability `1.60` / `1.42`.

The health cache already includes:

- Asset weight times price for collateral.
- Liability weight times price for debt.
- Confidence interval discount.
- EMA price for initial, spot price for maintenance.
- Premium snapshot recompute at pulse time.

The guard does not recompute weights. It trusts the engine output but enforces `1.50` and `1.25` on that output. This keeps the on-chain check small and avoids a second oracle read.

## 7. Failure modes

- Pulse succeeds but cache is stale or malformed. Guard rejects by timestamp, flags, or length.
- Marginfi upgrade changes layout. Guard rejects by length, offset, and version. Revisit triggers below.
- Bank oracle stale. Pulse fails or clears `ORACLE_OK`. Guard rejects.
- Empty debt. `liability <= 0` reverts. No free pass.
- Partial write. Short data reverts.

## 8. Accepted risk

- Pulse writes the cache. The guard reads it in the same ix. If pulse has a bug, the guard inherits it. Owner is the user who accepts this.
- No `min_out` floor. A bad fill still passes if health passes. The hard health floor bounds loss per crank but not price.
- No keeper monitoring. Monitoring is manual via `scripts/manual-crank.ts`.

## 9. Revisit triggers

- Any `health_cache` offset or length change.
- Any `programVersion` bump.
- Any marginfi program upgrade.
- Any bank weight, oracle, or cap change that moves health near `1.25`.
- Any DLMM pool TVL drop or crank above about `$5k`.
- Any failed `CHECK_FAIL` from `scripts/check-health-layout.ts`.

## 10. Reproduce

```bash
npm run check
npm run lint
npx ts-node scripts/check-health-layout.ts
npx ts-node scripts/check-health-layout.ts --account <MARGINFI_ACCOUNT>
```

With `RPC_URL` set, the script reads the given account from the local clone and compares raw vs SDK parse. Without an account it runs offline checks only. It exits non-zero on any mismatch.

Script: `scripts/check-health-layout.ts`.
