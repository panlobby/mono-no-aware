// Read live bank oracle prices from mainnet so injected local oracles sit
// within marginfi's circuit-breaker tier (600 bps) of the cloned banks'
// stored reference. Hardcoded prices rot when mainnet moves; this runs at
// boot and prints shell assignments for eval. Read-only, no funds.
//
//   eval "$(npx ts-node scripts/live-oracle-prices.ts --sol-oracle <KEY> --pump-oracle <KEY>)"
//   # sets LIVE_SOL_PRICE and LIVE_PUMP_PRICE (expo -8 raw ints)
import { Connection, PublicKey } from "@solana/web3.js";

function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function readPrice(
  conn: Connection,
  key: string,
  label: string
): Promise<string> {
  const ai = await conn.getAccountInfo(new PublicKey(key));
  if (!ai) throw new Error(`${label} oracle missing ${key}`);
  const d = Buffer.from(ai.data);
  // PriceUpdateV2: disc 8 + write_authority 32 + Full 0x01 + feed_id 32,
  // then price i64 (expo -8), conf u64, expo i32.
  const disc = [...d.subarray(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (disc !== "22f123639d7ef4cd")
    throw new Error(`${label} oracle bad discriminator ${disc}`);
  const expo = d.readInt32LE(73 + 8 + 8);
  if (expo !== -8) throw new Error(`${label} oracle bad expo ${expo}`);
  const price = d.readBigInt64LE(73);
  if (price <= 0) throw new Error(`${label} oracle bad price ${price}`);
  return price.toString();
}

async function main(): Promise<void> {
  const solOracle = argValue("--sol-oracle", "");
  const pumpOracle = argValue("--pump-oracle", "");
  if (!solOracle || !pumpOracle)
    throw new Error("pass --sol-oracle and --pump-oracle");
  const rpc = argValue("--rpc", "https://api.mainnet-beta.solana.com");
  const conn = new Connection(rpc, "confirmed");
  const sol = await readPrice(conn, solOracle, "SOL");
  const pump = await readPrice(conn, pumpOracle, "PUMP");
  console.log(`LIVE_SOL_PRICE=${sol}`);
  console.log(`LIVE_PUMP_PRICE=${pump}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
