#!/bin/bash
# Local DBC fee-claim e2e (020).
# Boots solana-test-validator with the DBC program cloned from mainnet,
# deploys the fee-short program, creates a real DBC config + pool locally
# with fee_claimer = vault PDA, accrues fees, then calls OUR PROGRAM's
# claim_dbc_fees (no SDK claim for the assertion path).
# No faucet needed: local airdrop funds the payer.
#
#   bash scripts/dbc-claim-local.sh [--keep] [--skip-build] [--force-cleanup]
#
# --keep keeps the validator alive for inspection; --force-cleanup also
# kills any foreign process listening on 8899/9900. By default only the
# validator this script started (PID file) is killed (035).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/target/dbc-claim-e2e"
mkdir -p "$OUT"

PROGRAM_ID="EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj"
DBC_PROGRAM="dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
WSOL_MINT="So11111111111111111111111111111111111111112"
METADATA_PROGRAM="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"

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

# Kill only the validator this script started (PID file). Foreign listeners
# on 8899/9900 are never touched unless --force-cleanup is passed (035).
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

echo "== start validator with DBC program clone =="
setsid nohup solana-test-validator --reset --ledger "$OUT/ledger" \
  --url https://api.mainnet-beta.solana.com \
  --clone-upgradeable-program "$DBC_PROGRAM" \
  --clone-upgradeable-program "$METADATA_PROGRAM" \
  --clone "$WSOL_MINT" \
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

echo "== wait for DBC clone =="
for i in $(seq 1 45); do
  if solana account "$DBC_PROGRAM" --url http://127.0.0.1:8899 >/dev/null 2>&1 && solana account "$METADATA_PROGRAM" --url http://127.0.0.1:8899 >/dev/null 2>&1; then
    echo "DBC + metadata programs cloned"
    break
  fi
  sleep 2
  if [ "$i" -eq 45 ]; then echo "DBC clone missing; see $OUT/validator.log"; exit 1; fi
done

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

echo "== run DBC claim e2e =="
ANCHOR_WALLET="$OUT/payer.json" ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
  npx ts-node scripts/dbc-claim-e2e.ts --send --venue local --rpc http://127.0.0.1:8899
echo "DBC_CLAIM_E2E_OK"
