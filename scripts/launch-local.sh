#!/bin/bash
# Local rehearsal of scripts/launch.ts against mainnet program/account clones.
# This does not touch mainnet and does not use real SOL.
#
# It boots a local validator with DBC + Metaplex + DAMM + marginfi + DLMM
# program clones, the real Project 0 group/banks and the real DLMM pool set,
# injects fresh bank oracles, then runs the same prepare/postinit/go-live
# stages used for mainnet.
#
#   scripts/launch-local.sh [--keep] [--skip-build] [--force-cleanup]
#
# ANCHOR_BIN can point at a specific Anchor binary.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/target/launch-local"
mkdir -p "$OUT/pyth" "$OUT/keys"

ANCHOR_BIN="${ANCHOR_BIN:-anchor}"
PROGRAM_ID="EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj"
MFV2="MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"
GROUP="4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"
SOL_BANK="CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh"
PUMP_BANK="61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK"
PUMP_MINT="pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
WSOL_MINT="So11111111111111111111111111111111111111112"
DBC_PROGRAM="dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
DAMM_PROGRAM="cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
LOCKER_PROGRAM="LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn"
METADATA_PROGRAM="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
DLMM_PROGRAM="LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
DLMM_POOL="HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh"

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
    for holder in $(lsof -ti:8899,9900 2>/dev/null || true); do kill "$holder" 2>/dev/null || true; done
  else
    echo "ports 8899/9900 are busy; stop them or pass --force-cleanup"
    exit 1
  fi
fi

cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    if [ -f "$OUT/validator.pid" ] && kill -0 "$(cat "$OUT/validator.pid")" 2>/dev/null; then
      kill "$(cat "$OUT/validator.pid")" 2>/dev/null || true
    fi
  else
    echo "keeping validator alive (pid $(cat "$OUT/validator.pid" 2>/dev/null))"
  fi
}
trap cleanup EXIT

if [ ! -f target/deploy/fee_short-keypair.json ]; then
  echo "missing target/deploy/fee_short-keypair.json"
  exit 1
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "== production build =="
  "$ANCHOR_BIN" build | tail -5
fi
mkdir -p target/production
cp target/deploy/fee_short.so target/production/fee_short.so
cp target/idl/fee_short.json target/production/fee_short.json
npm run verify:artifact

echo "== decode mainnet banks and DLMM set =="
npx ts-node scripts/decode-banks.ts --out "$OUT"
SOL_VAULT="$(node -e "console.log(require('$OUT/banks.json').solBank.liquidityVault)")"
SOL_INS="$(node -e "console.log(require('$OUT/banks.json').solBank.insuranceVault)")"
SOL_FEE="$(node -e "console.log(require('$OUT/banks.json').solBank.feeVault)")"
PUMP_VAULT="$(node -e "console.log(require('$OUT/banks.json').pumpBank.liquidityVault)")"
PUMP_INS="$(node -e "console.log(require('$OUT/banks.json').pumpBank.insuranceVault)")"
PUMP_FEE="$(node -e "console.log(require('$OUT/banks.json').pumpBank.feeVault)")"
SOL_ORACLE="$(node -e "console.log(require('$OUT/banks.json').solBank.oracles[0])")"
PUMP_ORACLE="$(node -e "console.log(require('$OUT/banks.json').pumpBank.oracles[0])")"
npx ts-node scripts/dlmm-clone-addrs.ts --out "$OUT/dlmm-clones.json"
DLMM_RX="$(node -e "console.log(require('$OUT/dlmm-clones.json').reserveX)")"
DLMM_RY="$(node -e "console.log(require('$OUT/dlmm-clones.json').reserveY)")"
DLMM_ORACLE="$(node -e "console.log(require('$OUT/dlmm-clones.json').oracle)")"
DLMM_BITMAP="$(node -e "console.log(require('$OUT/dlmm-clones.json').bitmap)")"
DLMM_BINS="$(node -e "console.log(require('$OUT/dlmm-clones.json').binArrays.join(' '))")"
DLMM_BIN_FLAGS=""
for b in $DLMM_BINS; do DLMM_BIN_FLAGS="$DLMM_BIN_FLAGS --clone $b"; done

echo "== fresh bank oracles =="
eval "$(npx ts-node scripts/live-oracle-prices.ts --sol-oracle "$SOL_ORACLE" --pump-oracle "$PUMP_ORACLE")"
export SOL_PRICE_RAW="$LIVE_SOL_PRICE" PUMP_PRICE_RAW="$LIVE_PUMP_PRICE"
npx ts-node scripts/gen-pyth-accounts.ts \
  --out-dir "$OUT/pyth" \
  --sol-oracle "$SOL_ORACLE" --pump-oracle "$PUMP_ORACLE" \
  --sol-price "$LIVE_SOL_PRICE" --pump-price "$LIVE_PUMP_PRICE"

echo "== start local validator =="
# shellcheck disable=SC2086
setsid nohup solana-test-validator --reset --ledger "$OUT/ledger" \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program "$MFV2" \
  --clone-upgradeable-program "$DLMM_PROGRAM" \
  --clone-upgradeable-program "$DBC_PROGRAM" \
  --clone-upgradeable-program "$DAMM_PROGRAM" \
  --clone-upgradeable-program "$LOCKER_PROGRAM" \
  --clone-upgradeable-program "$METADATA_PROGRAM" \
  --clone "$GROUP" \
  --clone "$SOL_BANK" --clone "$PUMP_BANK" \
  --clone "$SOL_VAULT" --clone "$SOL_INS" --clone "$SOL_FEE" \
  --clone "$PUMP_VAULT" --clone "$PUMP_INS" --clone "$PUMP_FEE" \
  --clone "$PUMP_MINT" --clone "$WSOL_MINT" \
  --clone "$DLMM_POOL" --clone "$DLMM_RX" --clone "$DLMM_RY" \
  --clone "$DLMM_ORACLE" --clone "$DLMM_BITMAP" \
  $DLMM_BIN_FLAGS \
  --account "$SOL_ORACLE" "$OUT/pyth/sol-oracle.json" \
  --account "$PUMP_ORACLE" "$OUT/pyth/pump-oracle.json" \
  > "$OUT/validator.log" 2>&1 < /dev/null &
echo $! > "$OUT/validator.pid"
disown || true

for i in $(seq 1 90); do
  if solana slot --url http://127.0.0.1:8899 >/dev/null 2>&1; then break; fi
  sleep 2
  if [ "$i" -eq 90 ]; then echo "validator did not start; see $OUT/validator.log"; exit 1; fi
done
for i in $(seq 1 60); do
  ok=1
  for a in "$DBC_PROGRAM" "$METADATA_PROGRAM" "$MFV2" "$DLMM_PROGRAM" "$GROUP" "$SOL_BANK" "$PUMP_BANK" "$PUMP_MINT" "$WSOL_MINT" "$DLMM_POOL" "$SOL_ORACLE" "$PUMP_ORACLE"; do
    if ! solana account "$a" --url http://127.0.0.1:8899 >/dev/null 2>&1; then ok=0; break; fi
  done
  if [ "$ok" -eq 1 ]; then break; fi
  sleep 2
  if [ "$i" -eq 60 ]; then echo "clones not ready; see $OUT/validator.log"; exit 1; fi
done

if [ ! -f "$OUT/payer.json" ]; then
  solana-keygen new --no-bip39-passphrase --silent -o "$OUT/payer.json" >/dev/null
fi
PAYER="$(solana-keygen pubkey "$OUT/payer.json")"
solana airdrop 1000 "$PAYER" --url http://127.0.0.1:8899 >/dev/null
echo "local payer: $PAYER"
solana balance "$PAYER" --url http://127.0.0.1:8899

COMMON=(
  --rpc http://127.0.0.1:8899
  --read-rpc http://127.0.0.1:8899
  --wallet "$OUT/payer.json"
  --launch-dir "$OUT/keys"
  --local-rehearsal
)

echo "== preflight (predeploy) =="
npx ts-node scripts/preflight.ts --stage predeploy --rpc http://127.0.0.1:8899 \
  --wallet "$OUT/payer.json" --local-rehearsal

echo "== launch prepare =="
npx ts-node scripts/launch.ts --stage prepare --send \
  --name "Mono no Aware" --symbol mono \
  --uri https://ar-io.dev/qG41oNKpHzh66gG7v55GwZJLAqhtv5xJ1ppLnclyc1M \
  --rpc http://127.0.0.1:8899 --read-rpc http://127.0.0.1:8899 \
  --wallet "$OUT/payer.json" --launch-dir "$OUT/keys" --local-rehearsal

echo "== preflight (postinit) =="
npx ts-node scripts/preflight.ts --stage postinit --rpc http://127.0.0.1:8899 \
  --wallet "$OUT/payer.json" --local-rehearsal

echo "== launch go-live =="
npx ts-node scripts/launch.ts --stage go-live --send \
  --rpc http://127.0.0.1:8899 --read-rpc http://127.0.0.1:8899 \
  --wallet "$OUT/payer.json" --launch-dir "$OUT/keys" --local-rehearsal

echo "== preflight (live) =="
npx ts-node scripts/preflight.ts --stage live --rpc http://127.0.0.1:8899 \
  --wallet "$OUT/payer.json" --local-rehearsal

echo "LAUNCH_LOCAL_OK"
