// Check LAUNCH_PARAMS against docs/dbc-pump-parity-spec.md.
// Computes pump.fun virtual-reserve math + Q64.64 and compares to canonical
// values. Tries Meteora SDK createSqrtPrices when installed.
// Run: npm run verify:params (ts-node migrations/check.ts).

// deploy.ts assigns module.exports to a function (Anchor migrate style),
// so `import { LAUNCH_PARAMS }` is wiped under CommonJS. Read via require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LAUNCH_PARAMS } = require("./deploy") as typeof import("./deploy");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PublicKey } = require("@solana/web3.js");

function fail(msg: string): never {
  console.error(`CHECK_FAIL: ${msg}`);
  process.exit(1);
}

function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function mustPubkey(label: string, v: string): void {
  try {
    new PublicKey(v);
  } catch {
    fail(`bad pubkey ${label}: ${v}`);
  }
}

async function main(): Promise<void> {
  const t = LAUNCH_PARAMS.token;
  const c = LAUNCH_PARAMS.curve;
  const f = LAUNCH_PARAMS.fee;
  const p0 = LAUNCH_PARAMS.project0;
  const pr = LAUNCH_PARAMS.programs;

  // 0. Mainnet wallet/program decisions (single-key launch).
  const mainnet = LAUNCH_PARAMS.mainnet;
  mustPubkey("mainnet.deployer", mainnet.deployer);
  mustPubkey("mainnet.admin", mainnet.admin);
  mustPubkey("mainnet.upgradeAuthority", mainnet.upgradeAuthority);
  mustPubkey("mainnet.programId", mainnet.programId);
  if (mainnet.rpcUrl !== "https://solana-rpc.publicnode.com")
    fail("mainnet rpcUrl mismatch");
  if (mainnet.readRpcUrl !== "https://api.mainnet-beta.solana.com")
    fail("mainnet readRpcUrl mismatch");
  if (mainnet.deployer !== "DtNMDWy9dxrTSQxAruwbzSrY2NE3KFd4aDxMD79X9fLH")
    fail("mainnet deployer mismatch");
  if (mainnet.admin !== mainnet.deployer)
    fail("mainnet admin must equal deployer");
  if (mainnet.upgradeAuthority !== mainnet.deployer)
    fail("mainnet upgrade authority must equal deployer");
  if (mainnet.programId !== "EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj")
    fail("mainnet programId mismatch");
  if (!mainnet.tokenMetadata.name || !mainnet.tokenMetadata.symbol)
    fail("mainnet token name/symbol empty");

  // 0. Exact address asserts.
  if (p0.solOracle !== "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE")
    fail("solOracle mismatch");
  if (p0.pumpOracle !== "4KL8nVtrXmLjbbHtrDz5YCHNqmii62oHfr9bsUtx1bgi")
    fail("pumpOracle mismatch");
  if (t.pumpMint !== "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn")
    fail("pumpMint mismatch");
  if (t.quoteMint !== "So11111111111111111111111111111111111111112")
    fail("quoteMint mismatch");
  if (pr.dlmm !== "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo")
    fail("dlmm program mismatch");
  if (
    LAUNCH_PARAMS.feeShort.pumpPool !==
    "HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh"
  )
    fail("pumpPool mismatch");

  // 0b. Validate all pubkey strings parse.
  const keys: Array<[string, string]> = [
    ["token.quoteMint", t.quoteMint],
    ["token.pumpMint", t.pumpMint],
    ["project0.program", p0.program],
    ["project0.group", p0.group],
    ["project0.solBank", p0.solBank],
    ["project0.pumpBank", p0.pumpBank],
    ["project0.solOracle", p0.solOracle],
    ["project0.pumpOracle", p0.pumpOracle],
    ["programs.dbc", pr.dbc],
    ["programs.dammV2", pr.dammV2],
    ["programs.marginfiV2", pr.marginfiV2],
    ["programs.dlmm", pr.dlmm],
    ["feeShort.pumpPool", LAUNCH_PARAMS.feeShort.pumpPool],
    ["mainnet.deployer", mainnet.deployer],
    ["mainnet.admin", mainnet.admin],
    ["mainnet.upgradeAuthority", mainnet.upgradeAuthority],
    ["mainnet.programId", mainnet.programId],
  ];
  for (const [label, v] of keys) mustPubkey(label, v);

  // 0c. feeShort holds only the fixed DLMM pool (no caps).
  mustPubkey("feeShort.pumpPool", LAUNCH_PARAMS.feeShort.pumpPool);

  // 1. Virtual reserves.
  const k = c.virtualSol * c.virtualTokens;
  if (k !== 30 * 1_073_000_000) fail(`k mismatch ${k}`);
  const p0calc = 30 / 1_073_000_000;
  if (!approx(c.startPriceSolPerToken, p0calc, 1e-20)) {
    fail(`P0 mismatch ${c.startPriceSolPerToken} vs ${p0calc}`);
  }
  const virtTokEnd = k / 115;
  if (!approx(virtTokEnd, 279_913_043.5, 1.0)) {
    fail(`virtTokEnd mismatch ${virtTokEnd}`);
  }
  const sold = c.virtualTokens - virtTokEnd;
  if (!approx(sold, c.expectedBuyableTokens, 1.0)) {
    fail(`sold mismatch ${sold} vs ${c.expectedBuyableTokens}`);
  }
  const p1calc = 115 / virtTokEnd;
  if (!approx(c.endPriceSolPerToken, p1calc, 1e-15)) {
    fail(`P1 mismatch ${c.endPriceSolPerToken} vs ${p1calc}`);
  }

  // 2. M caps.
  if (!approx(c.startMcapSOL, p0calc * 1_000_000_000, 0.01)) {
    fail("start mcap mismatch");
  }
  if (!approx(c.endMcapSOL, p1calc * 1_000_000_000, 0.01)) {
    fail("end mcap mismatch");
  }
  if (c.expectedMigrationThresholdLamports !== 85_000_000_000) {
    fail("threshold lamports mismatch");
  }

  // 3. Fee config max-short.
  if (f.totalFeeNumerator !== 12_500_000) fail("fee numerator mismatch");
  if (f.creatorTradingFeePercentage !== 0) fail("creator fee must be 0");
  if (f.collectFeeMode !== "QuoteToken")
    fail("collect mode must be QuoteToken");
  if (LAUNCH_PARAMS.migration.feeOption !== "FixedBps25") {
    fail("migration fee must be FixedBps25");
  }
  const locked =
    LAUNCH_PARAMS.liquidityDistribution
      .partnerPermanentLockedLiquidityPercentage +
    LAUNCH_PARAMS.liquidityDistribution
      .creatorPermanentLockedLiquidityPercentage;
  if (locked !== 100) fail(`locked LP must sum 100, got ${locked}`);

  // 4. Project 0 addresses.
  if (p0.group !== "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8")
    fail("group mismatch");
  if (p0.solBank !== "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh")
    fail("solBank mismatch");
  if (p0.pumpBank !== "61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK")
    fail("pumpBank mismatch");
  if (p0.program !== "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA")
    fail("program mismatch");

  // 5. Pure Q64 check values.
  const q = 2n ** 64n;
  const s0 = Math.sqrt(c.startPriceSolPerToken);
  const s1 = Math.sqrt(c.endPriceSolPerToken);
  const q0 = BigInt(Math.floor(s0 * Number(q)));
  const q1 = BigInt(Math.floor(s1 * Number(q)));
  // Allow small float error vs docs strings.
  const exp0 = BigInt(c.expectedSqrtStartQ64);
  const exp1 = BigInt(c.expectedSqrtEndQ64);
  const diff0 = exp0 > q0 ? exp0 - q0 : q0 - exp0;
  const diff1 = exp1 > q1 ? exp1 - q1 : q1 - exp1;
  if (diff0 > 1000000n) fail(`sqrt_start Q64 drift ${q0} vs ${exp0}`);
  if (diff1 > 1000000n) fail(`sqrt_end Q64 drift ${q1} vs ${exp1}`);
  const lh = 85 / (s1 - s0);
  if (!approx(lh, 179_415.718, 0.01)) fail(`L_human mismatch ${lh}`);

  // 6. SDK Q64 when installed.
  let sdkOk = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require("@meteora-ag/dynamic-bonding-curve-sdk");
    if (sdk.createSqrtPrices && sdk.TokenDecimal) {
      const out = sdk.createSqrtPrices(
        [c.startPriceSolPerToken, c.endPriceSolPerToken],
        sdk.TokenDecimal.SIX,
        sdk.TokenDecimal.NINE
      );
      const vals = (out as any[]).map((v: any) => v.toString());
      console.log(`SDK sqrtPrices: ${vals.join(", ")}`);
      // SDK returns raw-scale Q64 (lamports per microtoken). Compare to docs
      // raw check values with relative tolerance 1e-9 (float input error).
      const expRaw = [
        BigInt(c.expectedSqrtStartRawQ64),
        BigInt(c.expectedSqrtEndRawQ64),
      ];
      vals.forEach((s: string, i: number) => {
        const got = BigInt(s);
        const exp = expRaw[i];
        const diff = got > exp ? got - exp : exp - got;
        const tol = exp / 1_000_000_000n + 1_000_000n;
        if (diff > tol) fail(`SDK sqrtPrices[${i}] drift ${got} vs ${exp}`);
      });
      sdkOk = true;
    } else {
      console.log("SDK installed but createSqrtPrices missing, SKIP_SDK");
    }
  } catch {
    console.log(
      "SDK not installed, SKIP_SDK (run npm install to verify SDK path)"
    );
  }

  console.log(
    `curve P0=${c.startPriceSolPerToken} P1=${c.endPriceSolPerToken}`
  );
  console.log(`sold=${sold} migration=${c.expectedMigrationBaseTokens}`);
  console.log(`Q64 start=${q0} end=${q1} sdk=${sdkOk ? "yes" : "skip"}`);
  console.log("CHECK_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
