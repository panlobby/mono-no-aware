#!/bin/bash
# Health-guard rollback proof: negative local-clone case.
# Same harness as scripts/local-e2e.sh (decodes banks + DLMM pool set from
# mainnet, clones them into solana-test-validator, injects fresh bank oracle
# accounts, deploys the local-test program build), except the PUMP bank
# oracle is injected HIGH (default +5% over the pool's ~$0.00407) so the
# crank's sale fill is worse than the bank oracle. Then scripts/health-rollback-e2e.ts
# runs a real combined crank at an amount marginfi accepts whose final
# initial HF lands below 1.5; the tx must revert with OUR program health
# error (0x1771), not marginfi's (0x1779), with full rollback of every
# account. Prints HEALTH_ROLLBACK_OK only on a full pass.
#
#   scripts/health-rollback-local.sh [--keep] [--skip-build] [--force-cleanup]
#
# --keep skips the final validator cleanup so you can inspect state.
# --skip-build skips `anchor build` (uses the existing target/deploy .so).
# --force-cleanup also kills any foreign process listening on 8899/9900.
#   By default only the validator this script started (PID file) is killed;
#   if the ports are busy otherwise, the script aborts rather than killing
#   processes it does not own.
# Needs mainnet RPC access for the initial decode + clone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/target/health-rollback-e2e"
mkdir -p "$OUT/pyth"

PROGRAM_ID="EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj"
MFV2="MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"
GROUP="4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"
SOL_BANK="CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh"
PUMP_BANK="61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK"
PUMP_MINT="pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
WSOL_MINT="So11111111111111111111111111111111111111112"
DLMM_PROGRAM="LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
DLMM_POOL="HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh"
# Local-only HIGH PUMP oracle (default live +5%: the sale fill is worse
# than the bank oracle, opening the [1.0, 1.5) window our guard needs, so a
# borrow marginfi accepts can still fail our 1.50 bound. Feed id stays the
# real mainnet one so any feed-id check passes; only price/conf are
# local-only. The live base is read after decode below; a hardcoded default
# would rot when mainnet moves and trip the 600 bps circuit breaker.
# Override with PUMP_PRICE=... PUMP_CONF=... in the environment.
PUMP_CONF="${PUMP_CONF:-315}"

KEEP=0
SKIP_BUILD=0
FORCE_CLEANUP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --force-cleanup) FORCE_CLEANUP=1 ;;
  esac
done

if [ -f "$OUT/validator.pid" ]; then
  kill "$(cat "$OUT/validator.pid")" 2>/dev/null || true
fi
for i in $(seq 1 15); do
  if [ ! -f "$OUT/validator.pid" ] || ! kill -0 "$(cat "$OUT/validator.pid")" 2>/dev/null; then break; fi
  sleep 2
done
if [ -n "$(lsof -ti:8899,9900 2>/dev/null || true)" ]; then
  if [ "$FORCE_CLEANUP" -eq 1 ]; then
    for holder in $(lsof -ti:8899,9900 2>/dev/null || true); do
      kill "$holder" 2>/dev/null || true
    done
    for i in $(seq 1 15); do
      if [ -z "$(lsof -ti:8899,9900 2>/dev/null || true)" ]; then break; fi
      sleep 2
      if [ "$i" -eq 15 ]; then echo "ports 8899/9900 still busy; aborting"; exit 1; fi
    done
  else
    echo "ports 8899/9900 are busy (not our validator); stop that process or re-run with --force-cleanup"
    exit 1
  fi
fi

cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    if [ -f "$OUT/validator.pid" ] && kill -0 "$(cat "$OUT/validator.pid")" 2>/dev/null; then
      kill "$(cat "$OUT/validator.pid")" 2>/dev/null || true
    fi
  else
    echo "keeping validator alive (pid $(cat "$OUT/validator.pid" 2>/dev/null)); kill it when done"
  fi
}
trap cleanup EXIT

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "== anchor build (local-test) =="
  anchor build -- --features local-test | tail -3
fi

echo "== decode banks from mainnet (vaults + oracles, never guessed) =="
npx ts-node scripts/decode-banks.ts --out "$OUT"
SOL_VAULT="$(node -e "console.log(require('$OUT/banks.json').solBank.liquidityVault)")"
SOL_INS="$(node -e "console.log(require('$OUT/banks.json').solBank.insuranceVault)")"
SOL_FEE="$(node -e "console.log(require('$OUT/banks.json').solBank.feeVault)")"
PUMP_VAULT="$(node -e "console.log(require('$OUT/banks.json').pumpBank.liquidityVault)")"
PUMP_INS="$(node -e "console.log(require('$OUT/banks.json').pumpBank.insuranceVault)")"
PUMP_FEE="$(node -e "console.log(require('$OUT/banks.json').pumpBank.feeVault)")"
SOL_ORACLE="$(node -e "console.log(require('$OUT/banks.json').solBank.oracles[0])")"
PUMP_ORACLE="$(node -e "console.log(require('$OUT/banks.json').pumpBank.oracles[0])")"
echo "SOL vault=$SOL_VAULT oracle=$SOL_ORACLE"
echo "PUMP vault=$PUMP_VAULT oracle=$PUMP_ORACLE (HIGH local price)"

echo "== read DLMM pool set from mainnet (reserves, oracle, bitmap, bins) =="
npx ts-node scripts/dlmm-clone-addrs.ts --out "$OUT/dlmm-clones.json"
DLMM_RX="$(node -e "console.log(require('$OUT/dlmm-clones.json').reserveX)")"
DLMM_RY="$(node -e "console.log(require('$OUT/dlmm-clones.json').reserveY)")"
DLMM_ORACLE="$(node -e "console.log(require('$OUT/dlmm-clones.json').oracle)")"
DLMM_BITMAP="$(node -e "console.log(require('$OUT/dlmm-clones.json').bitmap)")"
DLMM_BINS="$(node -e "console.log(require('$OUT/dlmm-clones.json').binArrays.join(' '))")"
echo "DLMM pool=$DLMM_POOL oracle=$DLMM_ORACLE"
# shellcheck disable=SC2086
DLMM_BIN_FLAGS=""
for b in $DLMM_BINS; do
  DLMM_BIN_FLAGS="$DLMM_BIN_FLAGS --clone $b"
done

echo "== gen bank oracle files (PUMP is the local-only HIGH price) =="
echo "Our program reads no oracle; these files keep the marginfi health"
echo "checks fresh (bank oracle_max_age 70s) and set the PUMP valuation."
echo "== read live bank oracle prices (circuit-breaker freshness) =="
eval "$(npx ts-node scripts/live-oracle-prices.ts --sol-oracle "$SOL_ORACLE" --pump-oracle "$PUMP_ORACLE")"
PUMP_PRICE="${PUMP_PRICE:-$((LIVE_PUMP_PRICE * 105 / 100))}"
export PUMP_PRICE_RAW="$PUMP_PRICE" PUMP_CONF_RAW="$PUMP_CONF"
export SOL_PRICE_RAW="$LIVE_SOL_PRICE"
echo "live SOL=$LIVE_SOL_PRICE PUMP=$LIVE_PUMP_PRICE HIGH pump=$PUMP_PRICE (expo -8)"
npx ts-node scripts/gen-pyth-accounts.ts --out-dir "$OUT/pyth" --sol-oracle "$SOL_ORACLE" --pump-oracle "$PUMP_ORACLE" --sol-price "$LIVE_SOL_PRICE" --pump-price "$PUMP_PRICE" --pump-conf "$PUMP_CONF"
echo "== verify oracle files =="
node -e "
const fs = require('fs');
for (const f of ['sol-oracle.json', 'pump-oracle.json']) {
  const d = JSON.parse(fs.readFileSync('$OUT/pyth/' + f, 'utf8'));
  const a = d.account;
  if (!d.pubkey || !a || !Array.isArray(a.data) || a.data[1] !== 'base64') throw new Error(f + ': bad shape');
  const raw = Buffer.from(a.data[0], 'base64');
  if (raw.length !== a.space) throw new Error(f + ': data/space mismatch');
  console.log(f + ' ok (' + raw.length + ' bytes, owner=' + a.owner.slice(0,8) + ')');
}
console.log('CHECK_OK oracle files valid');
"

echo "== start validator (up to 3 attempts) =="
BOOT_OK=0
for attempt in 1 2 3; do
  echo "-- boot attempt $attempt --"
  # shellcheck disable=SC2086
  setsid nohup solana-test-validator --reset --ledger "$OUT/ledger" \
    --url https://api.mainnet-beta.solana.com \
    --clone-upgradeable-program "$MFV2" \
    --clone-upgradeable-program "$DLMM_PROGRAM" \
    --clone "$GROUP" \
    --clone "$SOL_BANK" --clone "$PUMP_BANK" \
    --clone "$SOL_VAULT" --clone "$SOL_INS" --clone "$SOL_FEE" \
    --clone "$PUMP_VAULT" --clone "$PUMP_INS" --clone "$PUMP_FEE" \
    --clone "$PUMP_MINT" --clone "$WSOL_MINT" \
    --clone "$DLMM_POOL" \
    --clone "$DLMM_RX" --clone "$DLMM_RY" \
    --clone "$DLMM_ORACLE" --clone "$DLMM_BITMAP" \
    $DLMM_BIN_FLAGS \
    --account "$SOL_ORACLE" "$OUT/pyth/sol-oracle.json" \
    --account "$PUMP_ORACLE" "$OUT/pyth/pump-oracle.json" \
    > "$OUT/validator.log" 2>&1 < /dev/null &
  echo $! > "$OUT/validator.pid"
  disown || true

  echo "== wait for validator =="
  for i in $(seq 1 60); do
    if solana slot --url http://127.0.0.1:8899 >/dev/null 2>&1; then
      echo "validator up"
      break
    fi
    sleep 2
    if [ "$i" -eq 60 ]; then echo "validator did not start; see $OUT/validator.log"; exit 1; fi
  done

  echo "== wait for clones + injected accounts =="
  GATE_OK=1
  for i in $(seq 1 45); do
    GATE_OK=1
    for a in "$SOL_ORACLE" "$PUMP_ORACLE" "$SOL_VAULT" "$PUMP_VAULT" "$GROUP" "$SOL_BANK" "$PUMP_BANK" "$PUMP_MINT" "$DLMM_POOL" "$DLMM_RX" "$DLMM_RY" "$DLMM_ORACLE" "$DLMM_BITMAP"; do
      if ! solana account "$a" --url http://127.0.0.1:8899 >/dev/null 2>&1; then
        GATE_OK=0
        break
      fi
    done
    if [ "$GATE_OK" -eq 1 ]; then
      for b in $DLMM_BINS; do
        if ! solana account "$b" --url http://127.0.0.1:8899 >/dev/null 2>&1; then
          GATE_OK=0
          break
        fi
      done
    fi
    if [ "$GATE_OK" -eq 1 ]; then echo "all clone + injected accounts present"; break; fi
    sleep 2
  done
  if [ "$GATE_OK" -eq 1 ]; then BOOT_OK=1; break; fi
  echo "attempt $attempt: accounts missing; killing validator and retrying fresh"
  kill "$(cat "$OUT/validator.pid")" 2>/dev/null || true
  sleep 5
done
if [ "$BOOT_OK" -eq 0 ]; then echo "validator never served all accounts; see $OUT/validator.log"; exit 1; fi

echo "== payer + airdrop =="
if [ ! -f "$OUT/payer.json" ]; then
  solana-keygen new --no-bip39-passphrase --silent -o "$OUT/payer.json" >/dev/null
fi
solana airdrop 1000 "$(solana-keygen pubkey "$OUT/payer.json")" --url http://127.0.0.1:8899 >/dev/null
solana balance "$(solana-keygen pubkey "$OUT/payer.json")" --url http://127.0.0.1:8899

echo "== deploy fee-short (local-test build) =="
solana program deploy --url http://127.0.0.1:8899 target/deploy/fee_short.so
# 027: transfer upgrade authority to the script payer so init_state (ProgramData check) passes.
PAYER_PUBKEY="$(solana-keygen pubkey "$OUT/payer.json")"
solana program set-upgrade-authority "$PROGRAM_ID" --new-upgrade-authority "$PAYER_PUBKEY" --skip-new-upgrade-authority-signer-check --url http://127.0.0.1:8899
DEPLOYED="$(solana program show "$PROGRAM_ID" --url http://127.0.0.1:8899 2>/dev/null | grep "Program Id" | awk '{print $3}')"
if [ "$DEPLOYED" != "$PROGRAM_ID" ]; then echo "deployed program id mismatch: $DEPLOYED"; exit 1; fi

echo "== run health-rollback crank (must revert on OUR guard) =="
ANCHOR_WALLET="$OUT/payer.json" ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
  npx ts-node scripts/health-rollback-e2e.ts
echo "HEALTH_ROLLBACK_OK full negative run passed"
