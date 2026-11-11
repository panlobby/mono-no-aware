// Devnet fee-side rehearsal for the Mono no Aware DBC launch.
// Dry-run by default: prints every planned step, no network calls.
// With --send: broadcasts each step to devnet and confirms every tx.
//
//   npx ts-node scripts/devnet-fees.ts                                   # dry run (default)
//   npx ts-node scripts/devnet-fees.ts --send --fee-claimer <PUBKEY>     # broadcast to devnet
//   npx ts-node scripts/devnet-fees.ts --send --fee-claimer <PUBKEY> \
//     --target-quote-sol 1 --max-sol-spend 2                             # small graduation loop
//   npm run devnet:fees -- --send --fee-claimer <PUBKEY>
//
// Flags:
//   --rpc URL             RPC endpoint (default https://api.devnet.solana.com).
//   --fee-claimer PUBKEY  Fee receiver. Devnet: test wallet. Mainnet: fee-short vault PDA.
//   --target-quote-sol N  Graduation loop target in SOL (default 85).
//   --buy-sol N           SOL per loop buy (default 0.5).
//   --max-sol-spend N     Stop the loop after spending this much SOL (default 4).
//                         The faucet cannot fund a full 85 SOL push.
//   --allow-mainnet       Required if --rpc is not devnet/localhost. Refused otherwise.
//
// Project 0 has no devnet deployment, so deposit / borrow / repay are out
// of scope here. Lending is covered by 009-local-clone-lending-e2e.
//
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LAUNCH_PARAMS } =
  require("../migrations/deploy") as typeof import("../migrations/deploy");

const DBC_PROGRAM = LAUNCH_PARAMS.programs.dbc;
const DAMM_V2_PROGRAM = LAUNCH_PARAMS.programs.dammV2;
const QUOTE_MINT = LAUNCH_PARAMS.token.quoteMint;
const DEVNET_RPC = "https://api.devnet.solana.com";
const MIGRATOR_URL = "https://migrator.meteora.ag";
const LAMPORTS_PER_SOL = 1_000_000_000;

type Step = { title: string; detail: string };

function buildPlan(feeClaimer: string): Step[] {
  const c = LAUNCH_PARAMS.curve;
  const f = LAUNCH_PARAMS.fee;
  return [
    {
      title: "0. Fund a fresh devnet wallet",
      detail:
        "solana airdrop 2 --url devnet (repeat to ~5 SOL). " +
        "Use a throwaway keypair. Never reuse a mainnet key.",
    },
    {
      title: "1. Build the 1-segment pump.fun parity curve",
      detail:
        `createSqrtPrices([${c.startPriceSolPerToken}, ${c.endPriceSolPerToken}], SIX, NINE). ` +
        `Human-scale check values: sqrt_start Q64 ${c.expectedSqrtStartQ64}, ` +
        `sqrt_end Q64 ${c.expectedSqrtEndQ64}. ` +
        `Note: the SDK returns raw scale (lamports per microtoken), e.g. sqrt_end raw ${c.expectedSqrtEndRawQ64}; ` +
        `compare raw SDK output against the raw check values, not the human ones. ` +
        `Expect swap_base_amount ~793,086,956.5 tokens, ` +
        `migration_quote_threshold ${c.expectedMigrationThresholdLamports} lamports (85 SOL).`,
    },
    {
      title: "2. Create DBC config (createConfig2)",
      detail:
        `quoteMint=wSOL, 1.25% flat base fee (numerator ${f.totalFeeNumerator}), ` +
        `collectFeeMode=${f.collectFeeMode}, creatorTradingFeePercentage=${f.creatorTradingFeePercentage} (max-short), ` +
        `migration MET_DAMM_V2 + FixedBps25, 100% locked LP (50/50 partner/creator), ` +
        `feeClaimer=${feeClaimer}, leftoverReceiver=${feeClaimer}, activationType=Timestamp.`,
    },
    {
      title: "3. Create DBC pool (1B SPL, 6 decimals)",
      detail:
        "createPool with fresh base mint, name/symbol/uri. " +
        "Record the virtual pool address from deriveDbcPoolAddress(wSOL, baseMint, config).",
    },
    {
      title: "4. Trade to accrue SOL fees",
      detail:
        "Buy --buy-sol SOL three times (ExactIn quote->base swap2), then sell " +
        "10% of the received base back (ExactIn base->quote swap2). " +
        "Each swap pays 1.25%; ~1.00% lands in partner+creator buckets in SOL. " +
        "Read getPoolFeeMetrics / getPoolFeeBreakdown after every swap. " +
        "Print payer base-token balance too.",
    },
    {
      title: "5. Claim partner + creator fees to the vault ATA",
      detail:
        "Send and confirm claimPartnerTradingFeeToReceiver AND " +
        "claimCreatorTradingFeeToReceiver to the wSOL ATA owned by the fee claimer, " +
        "then re-read the wSOL balance. " +
        "Checkpoint: after > before (fails otherwise). " +
        "Mainnet receiver is the fee-short vault PDA.",
    },
    {
      title: "6. Push the curve toward --target-quote-sol (default 85)",
      detail:
        "Loop: read pool quoteReserve; while below target lamports AND spent " +
        "below --max-sol-spend, buy --buy-sol SOL. " +
        "Track getPoolQuoteTokenCurveProgress. Curve stops at PostBondingCurve. " +
        "Meteora auto-keeper skips 85 SOL WSOL pools, so migration is manual. " +
        "The faucet cannot fund a full 85 SOL push; use a funded wallet or a small target for mechanics.",
    },
    {
      title: "7. Migrate manually",
      detail:
        `Open ${MIGRATOR_URL} (supports devnet), select the completed pool, ` +
        "migrate to DAMM v2. Expect 0.2% protocol liquidity migration fee " +
        "taken off the top, plus 25 bps DAMM v2 pool fee.",
    },
    {
      title: "8. Claim DAMM v2 locked LP fees",
      detail:
        "Send and confirm claimPositionFee on the locked position NFTs to the vault ATAs. " +
        "This is the post-graduation SOL inflow that keeps funding the short.",
    },
    {
      title: "OUT OF SCOPE (see 009)",
      detail:
        "Project 0 has no devnet deployment. deposit_sol, " +
        "borrow_sell_deposit_checked, repay_all, withdraw_all cannot run " +
        "on devnet and are not attempted here.",
    },
  ];
}

function printPlan(feeClaimer: string): void {
  console.log("DRY RUN (no network calls)");
  console.log(`DBC program: ${DBC_PROGRAM}`);
  console.log(`DAMM v2 program: ${DAMM_V2_PROGRAM}`);
  console.log(`quote mint: ${QUOTE_MINT}`);
  console.log(`fee claimer: ${feeClaimer}`);
  console.log(`migrator: ${MIGRATOR_URL}`);
  for (const [i, s] of buildPlan(feeClaimer).entries()) {
    console.log(`\n[Step ${i}] ${s.title}\n  ${s.detail}`);
  }
  console.log("\nCHECK_OK dry-run printed all planned steps");
}

function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function argNum(name: string, fallback: number): number {
  const v = Number(argValue(name, String(fallback)));
  if (!Number.isFinite(v) || v <= 0)
    throw new Error(`${name} must be a positive number`);
  return v;
}

async function send(rpcUrl: string, feeClaimer: string): Promise<void> {
  const isDev =
    rpcUrl.includes("devnet") ||
    rpcUrl.includes("127.0.0.1") ||
    rpcUrl.includes("localhost");
  if (!isDev && !process.argv.includes("--allow-mainnet")) {
    throw new Error(
      "refusing --send to non-devnet RPC without --allow-mainnet"
    );
  }
  // Lazy-load heavy deps only when broadcasting.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const web3 = require("@solana/web3.js") as typeof import("@solana/web3.js");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = require("@meteora-ag/dynamic-bonding-curve-sdk") as any;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const spl =
    require("@solana/spl-token") as typeof import("@solana/spl-token");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BN = require("bn.js");
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");

  const targetQuoteLamports = Math.round(
    argNum("--target-quote-sol", 85) * LAMPORTS_PER_SOL
  );
  const buyLamports = Math.round(argNum("--buy-sol", 0.5) * LAMPORTS_PER_SOL);
  const maxSpendLamports = Math.round(
    argNum("--max-sol-spend", 4) * LAMPORTS_PER_SOL
  );

  const keyPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const payer = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")))
  );
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const bal = await connection.getBalance(payer.publicKey);
  console.log(`payer: ${payer.publicKey.toBase58()} balance: ${bal / 1e9} SOL`);

  const sendConfirm = async (tx: any, signers: any[]): Promise<string> => {
    tx.feePayer = payer.publicKey;
    const sig: string = await connection.sendTransaction(tx, signers, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  };

  const client = new sdk.DynamicBondingCurveClient(connection, "confirmed");
  const NATIVE_MINT = new web3.PublicKey(QUOTE_MINT);
  const c = LAUNCH_PARAMS.curve;
  const f = LAUNCH_PARAMS.fee;

  // 1. Curve + config.
  const sqrtPrices = sdk.createSqrtPrices(
    [c.startPriceSolPerToken, c.endPriceSolPerToken],
    sdk.TokenDecimal.SIX,
    sdk.TokenDecimal.NINE
  );
  console.log(
    `sqrtPrices: ${sqrtPrices.map((v: unknown) => String(v)).join(", ")}`
  );
  for (const [i, key] of [
    "expectedSqrtStartRawQ64",
    "expectedSqrtEndRawQ64",
  ].entries()) {
    const got = BigInt(String(sqrtPrices[i]));
    const exp = BigInt((c as unknown as Record<string, string>)[key]);
    const diff = got > exp ? got - exp : exp - got;
    // Relative tolerance 1e-9: float JS inputs, exact on-chain math.
    if (diff * BigInt(1_000_000_000) > exp) {
      throw new Error(`sqrtPrices[${i}] drift too large: ${got} vs ${exp}`);
    }
  }
  const curveConfig = sdk.buildCurveWithCustomSqrtPrices({
    token: {
      tokenType: sdk.TokenType.SPLToken,
      tokenBaseDecimal: sdk.TokenDecimal.SIX,
      tokenQuoteDecimal: sdk.TokenDecimal.NINE,
      tokenAuthorityOption: 1, // Immutable: no lingering mint authority.
      totalTokenSupply: LAUNCH_PARAMS.token.totalSupplyTokens,
      leftover: 1_000,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: sdk.BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: f.startingFeeBps,
          endingFeeBps: f.endingFeeBps,
          numberOfPeriod: 0,
          totalDuration: 0, // constant fee (start == end): both must be zero
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: sdk.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: f.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: sdk.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: sdk.MigrationFeeOption.FixedBps25,
      migrationFee: {
        feePercentage: LAUNCH_PARAMS.migration.feePercentage,
        creatorFeePercentage: LAUNCH_PARAMS.migration.creatorFeePercentage,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: sdk.ActivationType.Timestamp,
    sqrtPrices,
    liquidityWeights: [1],
  });
  const configKp = web3.Keypair.generate();
  const claimer = new web3.PublicKey(feeClaimer);
  console.log(`creating config ${configKp.publicKey.toBase58()} ...`);
  const createConfigTx = await client.partner.createConfig2({
    config: configKp.publicKey,
    feeClaimer: claimer,
    leftoverReceiver: claimer,
    payer: payer.publicKey,
    quoteMint: NATIVE_MINT,
    ...curveConfig,
  });
  console.log(
    "createConfig sig:",
    await sendConfirm(createConfigTx, [payer, configKp])
  );

  // 2. Pool.
  const baseMintKp = web3.Keypair.generate();
  console.log(`creating pool for mint ${baseMintKp.publicKey.toBase58()} ...`);
  const createPoolTx = await client.creator.createPool({
    baseMint: baseMintKp.publicKey,
    config: configKp.publicKey,
    name: "FUCKPUMP-DEVNET",
    symbol: "FPUMP-DEV",
    uri: "https://example.com/fpump.json",
    payer: payer.publicKey,
    poolCreator: payer.publicKey,
  });
  console.log(
    "createPool sig:",
    await sendConfirm(createPoolTx, [payer, baseMintKp])
  );
  const pool = sdk.deriveDbcPoolAddress(
    NATIVE_MINT,
    baseMintKp.publicKey,
    configKp.publicKey
  );
  console.log(`pool: ${pool.toBase58()}`);
  try {
    fs.writeFileSync(
      "target/devnet-fees-state.json",
      JSON.stringify(
        {
          config: configKp.publicKey.toBase58(),
          pool: pool.toBase58(),
          baseMint: baseMintKp.publicKey.toBase58(),
          feeClaimer: claimer.toBase58(),
          rpcUrl,
        },
        null,
        2
      )
    );
    console.log("saved run state to target/devnet-fees-state.json");
  } catch (e) {
    console.log("state save skipped:", String(e).slice(0, 120));
  }

  const quoteNow = async (): Promise<number> => {
    // getPool returns a wrapper: raw state lives under .poolState.
    // Reading .quoteReserve off the wrapper is undefined and silently
    // falls back to a wrong scale, so always unwrap first.
    const raw = await client.state.getPool(pool);
    const st = (raw as unknown as { poolState?: unknown }).poolState ?? raw;
    const q = (st as { quoteReserve: { toString: () => string } }).quoteReserve;
    return Number(q.toString());
  };
  const progressOf = async (): Promise<number> => {
    // SDK returns 0..1 (quoteReserve / migrationQuoteThreshold).
    const pct: number = await client.state.getPoolQuoteTokenCurveProgress(pool);
    return pct;
  };
  const feeSnapshot = async (tag: string): Promise<void> => {
    const metrics = await client.state.getPoolFeeMetrics(pool);
    const breakdown = await client.state.getPoolFeeBreakdown(pool);
    console.log(`${tag} feeMetrics:`, JSON.stringify(metrics).slice(0, 400));
    console.log(
      `${tag} feeBreakdown:`,
      JSON.stringify(breakdown).slice(0, 400)
    );
  };
  const buyerBaseAta = async (): Promise<{
    address: unknown;
    amount: bigint;
  }> => {
    const ata = await spl.getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      baseMintKp.publicKey,
      payer.publicKey
    );
    return { address: ata.address, amount: BigInt(ata.amount.toString()) };
  };
  const buySol = async (lamports: number): Promise<void> => {
    const vpool = await client.state.getPool(pool);
    const cfg = await client.state.getPoolConfig(configKp.publicKey);
    const quote = await client.pool.swapQuote2({
      virtualPool: vpool,
      config: cfg,
      swapBaseForQuote: false,
      swapMode: sdk.SwapMode.ExactIn,
      amountIn: new BN(lamports),
      slippageBps: 100,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(Math.floor(Date.now() / 1000)),
    });
    const swapTx = await client.pool.swap2({
      owner: payer.publicKey,
      payer: payer.publicKey,
      pool,
      swapBaseForQuote: false,
      amountIn: new BN(lamports),
      minimumAmountOut: quote.minimumAmountOut,
      swapMode: sdk.SwapMode.ExactIn,
      referralTokenAccount: null,
    });
    console.log("buy sig:", await sendConfirm(swapTx, [payer]));
  };
  const getWsol = async (): Promise<bigint> => {
    const ata = await spl.getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      NATIVE_MINT,
      claimer,
      true
    );
    return BigInt(ata.amount.toString());
  };

  // 3. Buy + sell to accrue fees both directions.
  const spent: { total: number } = { total: 0 };
  for (let i = 0; i < 3; i++) {
    await buySol(buyLamports);
    spent.total += buyLamports;
  }
  await feeSnapshot("after-buys");
  const baseBefore = (await buyerBaseAta()).amount;
  console.log(`payer base balance after buys: ${baseBefore}`);
  const sellAmount = Number(baseBefore / BigInt(10));
  if (sellAmount > 0) {
    const vpool = await client.state.getPool(pool);
    const cfg = await client.state.getPoolConfig(configKp.publicKey);
    const quote = await client.pool.swapQuote2({
      virtualPool: vpool,
      config: cfg,
      swapBaseForQuote: true,
      swapMode: sdk.SwapMode.ExactIn,
      amountIn: new BN(sellAmount),
      slippageBps: 100,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(Math.floor(Date.now() / 1000)),
    });
    const sellTx = await client.pool.swap2({
      owner: payer.publicKey,
      payer: payer.publicKey,
      pool,
      swapBaseForQuote: true,
      amountIn: new BN(sellAmount),
      minimumAmountOut: quote.minimumAmountOut,
      swapMode: sdk.SwapMode.ExactIn,
      referralTokenAccount: null,
    });
    console.log("sell sig:", await sendConfirm(sellTx, [payer]));
    console.log(
      `payer base balance after sell: ${(await buyerBaseAta()).amount}`
    );
  }
  await feeSnapshot("after-sell");

  // 4. Claim partner AND creator fees, confirm, re-read NATIVE balance.
  // Note: with a native-SOL quote the SDK claims into the fee claimer's
  // wSOL ATA and unwraps it to the receiver in the same tx, closing the ATA.
  // So the wSOL ATA reads 0 afterwards: track the receiver NATIVE balance.
  const nativeBefore = await connection.getBalance(claimer);
  const wsolBefore = await getWsol();
  console.log(
    `vault wSOL ATA before=${wsolBefore} (expected 0: ATA may not exist yet)`
  );
  const U64_MAX = "18446744073709551615";
  const claimP = await client.partner.claimPartnerTradingFeeToReceiver({
    feeClaimer: claimer,
    payer: payer.publicKey,
    pool,
    maxBaseAmount: new BN(U64_MAX, 10),
    maxQuoteAmount: new BN(U64_MAX, 10),
    receiver: claimer,
  });
  console.log("claim partner sig:", await sendConfirm(claimP, [payer]));
  const claimC = await client.creator.claimCreatorTradingFeeToReceiver({
    creator: payer.publicKey,
    payer: payer.publicKey,
    pool,
    maxBaseAmount: new BN(U64_MAX, 10),
    maxQuoteAmount: new BN(U64_MAX, 10),
    receiver: claimer,
  });
  console.log("claim creator sig:", await sendConfirm(claimC, [payer]));
  const wsolAfter = await getWsol();
  const nativeAfter = await connection.getBalance(claimer);
  console.log(
    `vault wSOL ATA before=${wsolBefore} after=${wsolAfter} (unwrap closes it)`
  );
  console.log(`receiver native before=${nativeBefore} after=${nativeAfter}`);
  if (nativeAfter <= nativeBefore) {
    throw new Error("fee claim checkpoint failed: native after <= before");
  }

  // 5. Graduation loop until quote reserve >= target (default 85 SOL).
  // Unit-safe: the loop condition uses progress fraction (0..1) times the
  // ON-CHAIN migration threshold, never a raw reserve guess. Raw reserve is
  // logged every step plus a sanity assert (0 <= delta <= last buy), which
  // catches unit mistakes like reading a scaled value.
  let onChainThreshold: number = c.expectedMigrationThresholdLamports;
  let thresholdReadOk = false;
  try {
    const cfgRaw = await client.state.getPoolConfig(configKp.publicKey);
    const cfg =
      (cfgRaw as unknown as { poolState?: unknown }).poolState ?? cfgRaw;
    const t = (cfg as { migrationQuoteThreshold: { toString: () => string } })
      .migrationQuoteThreshold;
    onChainThreshold = Number(t.toString());
    thresholdReadOk = true;
    console.log(
      `migration_quote_threshold on-chain=${onChainThreshold} expected=${c.expectedMigrationThresholdLamports}`
    );
  } catch (e) {
    console.log(
      "threshold read failed, using LAUNCH_PARAMS value:",
      String(e).slice(0, 160)
    );
  }
  if (thresholdReadOk) {
    const drift = Math.abs(
      onChainThreshold - c.expectedMigrationThresholdLamports
    );
    if (drift / c.expectedMigrationThresholdLamports > 0.01) {
      throw new Error(
        `migration threshold drift too large: ${onChainThreshold} vs ${c.expectedMigrationThresholdLamports}`
      );
    }
  }
  let reserve = await quoteNow();
  let lastReserve = reserve;
  let progress = await progressOf();
  while (
    progress * onChainThreshold < targetQuoteLamports &&
    spent.total < maxSpendLamports
  ) {
    await buySol(buyLamports);
    spent.total += buyLamports;
    reserve = await quoteNow();
    const delta = reserve - lastReserve;
    progress = await progressOf();
    console.log(
      `quote reserve ${reserve} / target ${targetQuoteLamports} ` +
        `(progress ${(progress * 100).toFixed(4)}%, spent ${spent.total})`
    );
    if (!(delta >= 0 && delta <= buyLamports)) {
      throw new Error(
        `reserve sanity failed: delta ${delta} not in [0, ${buyLamports}]. ` +
          "Reserve units changed or buys are not landing; aborting."
      );
    }
    lastReserve = reserve;
  }
  if (progress * onChainThreshold >= targetQuoteLamports) {
    console.log(
      `target ${targetQuoteLamports} reached at reserve ${reserve}. ` +
        "Full graduation completes at 85 SOL (PostBondingCurve)."
    );
  } else {
    console.log(
      `stopped at reserve ${reserve}: max spend ${maxSpendLamports} reached. ` +
        "Fund the wallet and rerun with a higher --max-sol-spend to finish the 85 SOL push."
    );
  }
  console.log(
    "NEXT: migrate manually at",
    MIGRATOR_URL,
    "then claim DAMM v2 locked LP fees."
  );
  console.log("CHECK_OK send path reached end of scripted steps");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const feeClaimerIdx = args.indexOf("--fee-claimer");
  const feeClaimer =
    feeClaimerIdx >= 0 && args[feeClaimerIdx + 1]
      ? args[feeClaimerIdx + 1]
      : "FEE_CLAIMER_PUBKEY (pass --fee-claimer; mainnet uses the fee-short vault PDA)";
  if (!args.includes("--send")) {
    printPlan(feeClaimer);
    return;
  }
  const rpc = argValue("--rpc", DEVNET_RPC);
  if (feeClaimer.startsWith("FEE_CLAIMER")) {
    throw new Error(
      "--send needs a real --fee-claimer pubkey (test wallet or vault PDA)"
    );
  }
  await send(rpc, feeClaimer);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
