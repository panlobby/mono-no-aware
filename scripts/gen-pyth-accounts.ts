// Generates solana-test-validator --account JSON files for fresh Pyth
// PriceUpdateV2 oracles at the EXACT bank oracle addresses from LAUNCH_PARAMS.
// Local-only: mainnet oracles would be stale within 70s, so we inject our own
// with a future publish_time plus the real feed ids and realistic prices.
//
//   npx ts-node scripts/gen-pyth-accounts.ts --out-dir <DIR>
//
// Optional local-only overrides (default = real Oct-Nov 2026 prices).
// A different price still uses the real feed id and a future publish_time,
// so marginfi's feed checks pass while the price is local-only:
//   npx ts-node scripts/gen-pyth-accounts.ts --out-dir <DIR> \
//     --pump-price 1000000 --pump-conf 737
//
// Writes <DIR>/sol-oracle.json and <DIR>/pump-oracle.json.

import * as fs from "fs";
import * as path from "path";

const SOL_ORACLE = "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE";
const PUMP_ORACLE = "4KL8nVtrXmLjbbHtrDz5YCHNqmii62oHfr9bsUtx1bgi";
// Real mainnet feed ids (kept so any feed-id check passes).
const SOL_FEED =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PUMP_FEED =
  "7a01fca212788bba7c5bf8c9efd576a8a722f070d2c17596ff7bb609b8d5c3b9";
// Test prices mirror mainnet Oct-Nov 2026 (SOL ~$94, PUMP ~$0.00407).
const SOL_PRICE = BigInt(9_400_000_000); // expo -8
const SOL_CONF = BigInt(4_000_000);
const PUMP_PRICE = BigInt(407_000); // expo -8
const PUMP_CONF = BigInt(300);
const EXPO = -8;
// Owner must match what marginfi v2 accepts for PythPushOracle banks.
// Mainnet oracle accounts are owned by rec2HH... (the live Pyth receiver),
// while our program skips the owner check under local-test, so rec2 keeps
// both sides happy locally.
const ORACLE_OWNER = "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp";

function u64le(v: bigint): number[] {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return [...b];
}

function i64le(v: bigint): number[] {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return [...b];
}

function i32le(v: number): number[] {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return [...b];
}

// Anchor PriceUpdateV2 layout: disc 8, write_authority 32,
// verification Full = single 0x01 byte, then PriceFeedMessage.
// The discriminator must be the real sha256("account:PriceUpdateV2")[..8]
// (22f123639d7ef4cd): marginfi validates it (PythPushInvalidAccount).
function buildBlob(
  feedHex: string,
  price: bigint,
  conf: bigint,
  publishTime: bigint
): Buffer {
  const out: number[] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];
  out.push(...new Array(32).fill(0)); // write_authority
  out.push(1); // VerificationLevel::Full
  out.push(...Buffer.from(feedHex, "hex"));
  out.push(...i64le(price));
  out.push(...u64le(conf));
  out.push(...i32le(EXPO));
  out.push(...i64le(publishTime));
  out.push(...i64le(publishTime - BigInt(1))); // prev_publish_time
  out.push(...i64le(price)); // ema_price
  out.push(...u64le(conf)); // ema_conf
  out.push(...u64le(BigInt(0))); // posted_slot
  return Buffer.from(out);
}

function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function main(): void {
  const outDir = argValue("--out-dir", "target/local-e2e");
  // Oracle addresses default to the canonical bank keys but SHOULD be passed
  // from scripts/decode-banks.ts output (banks.json) so injection always
  // targets the exact decoded bank oracle keys.
  const solOracle = argValue("--sol-oracle", SOL_ORACLE);
  const pumpOracle = argValue("--pump-oracle", PUMP_ORACLE);
  fs.mkdirSync(outDir, { recursive: true });
  // Future publish_time keeps both our 60s check and the banks' 70s
  // oracle_max_age happy for the whole test run. Local-only.
  // publish_offset_sec lets callers cover validator clock skew (e.g. a
  // --warp-slot validator runs ahead of wall time). Default keeps the
  // original +3600s behaviour.
  const publishOffset = BigInt(
    parseInt(argValue("--publish-offset-sec", "3600"), 10)
  );
  const publishTime = BigInt(Math.floor(Date.now() / 1000)) + publishOffset;
  // Local-only price overrides. Defaults mirror mainnet Oct-Nov 2026
  // (SOL ~$94, PUMP ~$0.00407). A health-rollback run passes a higher PUMP
  // price so the sale fill is worse than the bank oracle.
  const solPrice = BigInt(argValue("--sol-price", SOL_PRICE.toString()));
  const solConf = BigInt(argValue("--sol-conf", SOL_CONF.toString()));
  const pumpPrice = BigInt(argValue("--pump-price", PUMP_PRICE.toString()));
  const pumpConf = BigInt(argValue("--pump-conf", PUMP_CONF.toString()));
  const files: Array<[string, string, bigint, bigint]> = [
    ["sol-oracle.json", SOL_FEED, solPrice, solConf],
    ["pump-oracle.json", PUMP_FEED, pumpPrice, pumpConf],
  ];
  for (const [name, feed, price, conf] of files) {
    const blob = buildBlob(feed, price, conf, publishTime);
    if (blob.length !== 133) {
      throw new Error(`bad blob length: ${blob.length}`);
    }
    const pubkey = name.startsWith("sol") ? solOracle : pumpOracle;
    // solana-test-validator --account JSON shape (same as `solana account
    // --output json-compact` emits, including the space field).
    const doc = {
      pubkey,
      account: {
        lamports: 5_000_000,
        data: [blob.toString("base64"), "base64"],
        owner: ORACLE_OWNER,
        executable: false,
        rentEpoch: 18446744073709551615,
        space: blob.length,
      },
    };
    const p = path.join(outDir, name);
    // u64::MAX cannot survive JSON number round-trips; write it raw.
    const text =
      `{"pubkey": "${doc.pubkey}", "account": {"lamports": ${doc.account.lamports}, ` +
      `"data": ["${(doc.account.data as string[])[0]}", "base64"], "owner": "${
        doc.account.owner
      }", ` +
      `"executable": false, "rentEpoch": 18446744073709551615, "space": ${blob.length}}}`;
    fs.writeFileSync(p, text);
    console.log(
      `wrote ${p} (${blob.length} bytes, publish_time=${publishTime})`
    );
  }
  console.log("CHECK_OK gen-pyth-accounts wrote 2 oracle files");
}

main();
