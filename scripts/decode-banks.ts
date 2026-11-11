// Reads marginfi Bank accounts (mainnet by default, local RPC via RPC_URL)
// and prints the vault + oracle addresses the local clone needs.
// The PUMP bank liquidity_vault MUST come from this decode, never from a
// hardcoded guess (see docs/local-e2e.md). Exits non-zero when a bank is
// missing or undecodable, or when oracle_keys has more than slot [0] set
// (injection only covers set slots; extend this script if that changes).
//
//   npx ts-node scripts/decode-banks.ts --out target/local-e2e/banks.json
//   RPC_URL=http://127.0.0.1:8899 npx ts-node scripts/decode-banks.ts
//
// Writes banks.json: { solBank: {...}, pumpBank: {...} } with
// liquidityVault, insuranceVault, feeVault, oracles (set slots only),
// oracleSetup, borrowLimit, depositLimit.

import * as fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require("@0dotxyz/p0-ts-sdk") as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BorshCoder } =
  require("@coral-xyz/anchor") as typeof import("@coral-xyz/anchor");

const SOL_BANK = "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh";
const PUMP_BANK = "61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK";
const DEFAULT_KEY = "11111111111111111111111111111111";

function arg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const outDir = arg("--out", "");
  const connection = new Connection(rpcUrl, "confirmed");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = new BorshCoder(sdk.MARGINFI_IDL as any);
  const out: Record<string, unknown> = {};
  for (const [name, addr] of [
    ["solBank", SOL_BANK],
    ["pumpBank", PUMP_BANK],
  ] as Array<[string, string]>) {
    let ai = null;
    for (let attempt = 1; attempt <= 10; attempt++) {
      ai = await connection.getAccountInfo(new PublicKey(addr));
      if (ai !== null) break;
      console.log(`retry ${attempt}: ${name} null on ${rpcUrl}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (ai === null) {
      throw new Error(`ASSERT FAILED: ${name} ${addr} missing on ${rpcUrl}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = coder.accounts.decode("Bank", Buffer.from(ai.data)) as any;
    const oracles: string[] = (raw.config.oracle_keys as PublicKey[])
      .map((k) => k.toBase58())
      .filter((k) => k !== DEFAULT_KEY);
    if (oracles.length === 0) {
      throw new Error(`ASSERT FAILED: ${name} has no set oracle key`);
    }
    const setCount = (raw.config.oracle_keys as PublicKey[]).filter(
      (k) => k.toBase58() !== DEFAULT_KEY
    ).length;
    if (setCount > 1) {
      throw new Error(
        `ASSERT FAILED: ${name} has ${setCount} set oracle keys, script covers 1`
      );
    }
    const entry = {
      bank: addr,
      mint: (raw.mint as PublicKey).toBase58(),
      group: (raw.group as PublicKey).toBase58(),
      liquidityVault: (raw.liquidity_vault as PublicKey).toBase58(),
      insuranceVault: (raw.insurance_vault as PublicKey).toBase58(),
      feeVault: (raw.fee_vault as PublicKey).toBase58(),
      oracleSetup: Object.keys(raw.config.oracle_setup)[0] as string,
      oracles,
      borrowLimit: (
        raw.config.borrow_limit as { toString: () => string }
      ).toString(),
      depositLimit: (
        raw.config.deposit_limit as { toString: () => string }
      ).toString(),
    };
    out[name] = entry;
    console.log(
      `${name}: vault=${entry.liquidityVault.slice(0, 6)} ` +
        `ins=${entry.insuranceVault.slice(0, 6)} fee=${entry.feeVault.slice(
          0,
          6
        )} ` +
        `oracle=${oracles[0].slice(0, 6)} setup=${entry.oracleSetup}`
    );
  }
  // Criterion 1: the decoded PUMP vault must exist on mainnet and hold
  // PUMP. A --clone of a null account succeeds silently, so check here.
  const pumpVaultAddr = (out.pumpBank as Record<string, unknown>)
    .liquidityVault as string;
  let vaultAi = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    vaultAi = await connection.getAccountInfo(new PublicKey(pumpVaultAddr));
    if (vaultAi !== null) break;
    console.log(`retry ${attempt}: PUMP vault null on ${rpcUrl}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (vaultAi === null) {
    throw new Error(
      `LAUNCH BLOCKER: decoded PUMP liquidity vault ${pumpVaultAddr} has no mainnet account. ` +
        `Decoded pumpBank fields: ${JSON.stringify(out.pumpBank)}`
    );
  }
  const vData = Buffer.from(vaultAi.data);
  const vMint = new PublicKey(vData.slice(0, 32)).toBase58();
  const vAmount = vData.readBigUInt64LE(64);
  const pumpMint = (out.pumpBank as Record<string, unknown>).mint as string;
  if (vMint !== pumpMint || vAmount === BigInt(0)) {
    throw new Error(
      `LAUNCH BLOCKER: PUMP vault ${pumpVaultAddr} mint=${vMint} amount=${vAmount}, ` +
        `expected mint=${pumpMint} amount>0`
    );
  }
  console.log(`PUMP vault holds ${vAmount} units of ${vMint.slice(0, 6)}`);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outDir + "/banks.json", JSON.stringify(out, null, 2));
    console.log(`wrote ${outDir}/banks.json`);
  }
  console.log("CHECK_OK decode-banks decoded both banks");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
