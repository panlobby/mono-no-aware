// Full lifecycle for task 021 (local venue).
// Dry run (default): no network. Prints plan.
// With --send: real flow on a local validator with DBC + DAMM v2 cloned.
// Creates DBC config+pool (fee_claimer=vault), buys to 85 SOL,
// migrates via DBC migrationDammV2, accrues DAMM fees with a swap,
// then calls OUR PROGRAM claim_damm_fees and asserts delta.
//
//   npx ts-node scripts/full-lifecycle.ts
//   bash scripts/full-lifecycle-local.sh
//   bash scripts/full-lifecycle-local.sh --keep
//   npx ts-node scripts/full-lifecycle.ts --send --rpc http://127.0.0.1:8899
//
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LAUNCH_PARAMS } =
  require("../migrations/deploy") as typeof import("../migrations/deploy");

const DBC_PROGRAM = LAUNCH_PARAMS.programs.dbc;
const DAMM_PROGRAM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const WSOL_MINT = LAUNCH_PARAMS.token.quoteMint;
const FEE_SHORT_ID = "EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj";
// 25bps DBC migration DAMM config from mainnet (index 20000, static,
// collect OnlyB, Timestamp, permission CreatePoolWithoutMintValidation,
// pool_creator_authority = DBC pool authority FhVo...). Found by scanning
// cp-amm Config accounts (size 328) for pool_creator_authority == FhVo...;
// 7F6d... is the 25bps one (FixedBps25). Public 25bps configs (e.g.
// FzvMY...) fail migration with InvalidConfigAccount (6024).
const DAMM_CONFIG = "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd";
const DEVNET_RPC = "https://api.devnet.solana.com";
const LAMPORTS_PER_SOL = 1_000_000_000;

function printPlan(): void {
  console.log("DRY RUN (no network calls)");
  console.log(`DBC program: ${DBC_PROGRAM}`);
  console.log(`DAMM v2 program: ${DAMM_PROGRAM}`);
  console.log(`DAMM config (25bps): ${DAMM_CONFIG}`);
  console.log(`fee-short program: ${FEE_SHORT_ID}`);
  console.log("venue: local validator with DBC + DAMM v2 cloned (no faucet)");
  console.log("steps:");
  console.log("  1. create DBC config (fee_claimer=vault) + pool");
  console.log("  2. transfer pool creator to vault, init_state, vault ATAs");
  console.log("  3. buy loop to 85 SOL (1 SOL buys, assert reserve delta)");
  console.log("  4. migrateToDammV2 with the 25bps DAMM config");
  console.log("  5. confirm DAMM pool, positions, owners");
  console.log("  6. update_config with damm_pool + damm_position");
  console.log("  7. DAMM swap to accrue fees");
  console.log("  8. claim_damm_fees via OUR PROGRAM, assert delta > 0");
  console.log("CHECK_OK full-lifecycle dry-run printed the plan");
}

function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function runLocal(rpcUrl: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const web3 = require("@solana/web3.js") as typeof import("@solana/web3.js");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const anchor =
    require("@anchor-lang/core") as typeof import("@anchor-lang/core");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const spl =
    require("@solana/spl-token") as typeof import("@solana/spl-token");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = require("@meteora-ag/dynamic-bonding-curve-sdk") as any;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BN = require("bn.js");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("os") as typeof import("os");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path") as typeof import("path");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const idlJson = require("../target/idl/fee_short.json");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dammIdl = require("./idl/cp_amm.json");

  const keyPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const payer = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")))
  );
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const bal = await connection.getBalance(payer.publicKey);
  console.log(`payer: ${payer.publicKey.toBase58()} balance: ${bal / 1e9} SOL`);
  if (bal < 95 * LAMPORTS_PER_SOL) {
    throw new Error(
      `BLOCKER funding: need ~95 SOL for the 85 SOL push, have ${
        bal / 1e9
      }. Airdrop locally and rerun.`
    );
  }

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payer),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = new anchor.Program(idlJson, provider);

  const [state] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    program.programId
  );
  const [vault] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), state.toBuffer()],
    program.programId
  );
  console.log(`state: ${state.toBase58()} vault: ${vault.toBase58()}`);

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
  const NATIVE_MINT = new web3.PublicKey(WSOL_MINT);
  const BPF_LOADER = new web3.PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
  );
  const c = LAUNCH_PARAMS.curve;
  const f = LAUNCH_PARAMS.fee;

  // 1. Config + pool, fee_claimer = vault.
  const sqrtPrices = sdk.createSqrtPrices(
    [c.startPriceSolPerToken, c.endPriceSolPerToken],
    sdk.TokenDecimal.SIX,
    sdk.TokenDecimal.NINE
  );
  const curveConfig = sdk.buildCurveWithCustomSqrtPrices({
    token: {
      tokenType: sdk.TokenType.SPLToken,
      tokenBaseDecimal: sdk.TokenDecimal.SIX,
      tokenQuoteDecimal: sdk.TokenDecimal.NINE,
      tokenAuthorityOption: 1,
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
          totalDuration: 0,
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
  console.log(`creating config ${configKp.publicKey.toBase58()} ...`);
  const configSig = await sendConfirm(
    await client.partner.createConfig2({
      config: configKp.publicKey,
      feeClaimer: vault,
      leftoverReceiver: vault,
      payer: payer.publicKey,
      quoteMint: NATIVE_MINT,
      ...curveConfig,
    }),
    [payer, configKp]
  );
  console.log(`createConfig: ${configSig}`);

  const baseMintKp = web3.Keypair.generate();
  console.log(`creating pool for mint ${baseMintKp.publicKey.toBase58()} ...`);
  const poolSig = await sendConfirm(
    await client.creator.createPool({
      baseMint: baseMintKp.publicKey,
      config: configKp.publicKey,
      name: "FULL-LIFECYCLE",
      symbol: "FULL-LOC",
      uri: "https://example.com/full.json",
      payer: payer.publicKey,
      poolCreator: payer.publicKey,
    }),
    [payer, baseMintKp]
  );
  console.log(`createPool: ${poolSig}`);
  const pool = sdk.deriveDbcPoolAddress(
    NATIVE_MINT,
    baseMintKp.publicKey,
    configKp.publicKey
  );
  console.log(`pool: ${pool.toBase58()}`);
  const transferSig = await sendConfirm(
    await client.creator.transferPoolCreator({
      pool,
      creator: payer.publicKey,
      newCreator: vault,
    }),
    [payer]
  );
  console.log(`transferPoolCreator: ${transferSig}`);

  // 2. Vault ATAs + init_state. Project 0 PUMP mint is not cloned here
  // (claim paths do not use it), so use a placeholder like 020 does.
  const baseMint = baseMintKp.publicKey;
  const baseAta = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    baseMint,
    vault,
    true
  );
  const wsolAta = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    NATIVE_MINT,
    vault,
    true
  );
  // Real PUMP ATA for init validation (claim does not use PUMP debt).
  // Use a fresh Token-2022 mint and mock the bank to skip bank checks.
  const pumpMintTmp = await spl.createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6,
    undefined,
    undefined,
    spl.TOKEN_2022_PROGRAM_ID
  );
  const pumpAtaTmp = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    pumpMintTmp,
    vault,
    true,
    undefined,
    undefined,
    spl.TOKEN_2022_PROGRAM_ID
  );
  const pumpAtaAddr = pumpAtaTmp.address;
  const mockPumpBankKp = web3.Keypair.generate();
  const mockAirdrop = await connection.requestAirdrop(
    mockPumpBankKp.publicKey,
    1_000_000
  );
  await connection.confirmTransaction(mockAirdrop);
  console.log(`vault base ATA: ${baseAta.address.toBase58()}`);
  console.log(`vault wSOL ATA: ${wsolAta.address.toBase58()}`);
  const group = new web3.PublicKey(LAUNCH_PARAMS.project0.group);
  const solBank = new web3.PublicKey(LAUNCH_PARAMS.project0.solBank);
  const pumpBank = mockPumpBankKp.publicKey;
  const pumpPool = new web3.PublicKey(LAUNCH_PARAMS.feeShort.pumpPool);
  const [programData] = web3.PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER
  );
  const initSig = await program.methods
    .initState(
      payer.publicKey,
      pool,
      configKp.publicKey,
      group,
      solBank,
      pumpBank,
      wsolAta.address,
      pumpAtaAddr,
      payer.publicKey,
      pumpPool,
      baseMint,
      baseAta.address
    )
    .accounts({
      state,
      vault,
      payer: payer.publicKey,
      admin: payer.publicKey,
      vaultWsolAta: wsolAta.address,
      vaultPumpAta: pumpAtaAddr,
      programData,
      dbcConfig: configKp.publicKey,
      quoteMint: NATIVE_MINT,
      pumpBank,
      solBank,
      group,
      dbcPool: pool,
      pumpMint: pumpMintTmp,
      vaultBaseAta: baseAta.address,
      baseMint,
    })
    .rpc();
  console.log(`init_state: ${initSig} (paused=true)`);
  await program.methods
    .updateConfig(
      anchor.web3.PublicKey.default,
      anchor.web3.PublicKey.default,
      payer.publicKey,
      pumpPool,
      false
    )
    .accounts({ state, admin: payer.publicKey })
    .rpc();
  console.log("unpaused after preflight");

  // 3. Buy loop to 85 SOL.
  const cfgRaw = await client.state.getPoolConfig(configKp.publicKey);
  const cfg = (cfgRaw as any).poolState ?? cfgRaw;
  const onChainThreshold = Number(cfg.migrationQuoteThreshold.toString());
  console.log(
    `migration threshold on-chain=${onChainThreshold} expected=${c.expectedMigrationThresholdLamports}`
  );
  const drift = Math.abs(
    onChainThreshold - c.expectedMigrationThresholdLamports
  );
  if (drift / c.expectedMigrationThresholdLamports > 0.01) {
    throw new Error(
      `threshold drift too large: ${onChainThreshold} vs ${c.expectedMigrationThresholdLamports}`
    );
  }
  const quoteReserveOf = async (): Promise<number> => {
    const raw = await client.state.getPool(pool);
    const st = (raw as any).poolState ?? raw;
    return Number(st.quoteReserve.toString());
  };
  const progressOf = async (): Promise<number> =>
    client.state.getPoolQuoteTokenCurveProgress(pool);
  let spent = 0;
  let reserve = await quoteReserveOf();
  let progress = await progressOf();
  console.log(
    `start reserve=${reserve} progress=${(progress * 100).toFixed(4)}%`
  );
  const maxSpend = 95 * LAMPORTS_PER_SOL;
  const buySizes = [
    LAMPORTS_PER_SOL,
    100_000_000,
    10_000_000,
    1_000_000,
    100_000,
    10_000,
    1_000,
    100,
    10,
    1,
  ];
  // Graduation target is the on-chain threshold (85,001,682,314), not 85e9.
  // Near the top the curve has little base left: a 100M quote can fail
  // while 1M still fills. Try sizes largest-first inside one step so a
  // failed quote falls through to a smaller size instead of looping.
  // Dust fix: 1-lamport buys can succeed with delta 0 (fee rounding eats
  // the whole lamport), which would loop forever. Break on repeated zero.
  let stallCount = 0;
  let zeroDeltaStreak = 0;
  while (reserve < onChainThreshold && spent < maxSpend) {
    const remaining = onChainThreshold - reserve;
    // Exact buy to cover the remaining reserve in one fill, fee-adjusted.
    // Round up so the quote reserve lands at or above the threshold.
    const exactBuy = Math.ceil(remaining / 0.9875);
    let startIdx = buySizes.length - 1;
    for (let i = 0; i < buySizes.length; i++) {
      if (remaining >= buySizes[i] * 0.5) {
        startIdx = i;
        break;
      }
    }
    // Candidate sizes: exact amount first (if sane), then the ladder.
    const candidates: number[] = [];
    if (exactBuy > 0 && exactBuy <= LAMPORTS_PER_SOL) {
      candidates.push(exactBuy);
    }
    for (let i = startIdx; i < buySizes.length; i++) {
      if (!candidates.includes(buySizes[i])) candidates.push(buySizes[i]);
    }
    let quote: any = null;
    let buyLamports = 0;
    let quoteErr = "";
    for (const s of candidates) {
      try {
        const vpool = await client.state.getPool(pool);
        const pcfg = await client.state.getPoolConfig(configKp.publicKey);
        quote = await client.pool.swapQuote2({
          virtualPool: vpool,
          config: pcfg,
          swapBaseForQuote: false,
          swapMode: sdk.SwapMode.ExactIn,
          amountIn: new BN(s),
          slippageBps: 100,
          hasReferral: false,
          eligibleForFirstSwapWithMinFee: false,
          currentPoint: new BN(Math.floor(Date.now() / 1000)),
        });
        buyLamports = s;
        if (s !== candidates[0]) {
          console.log(`quote fell through to smaller size ${s}`);
        }
        break;
      } catch (e) {
        quoteErr = String(e);
        if (!quoteErr.includes("insufficient")) throw e;
        console.log(`quote for ${s} failed (insufficient), trying smaller`);
      }
    }
    if (quote === null) {
      console.log(
        `all quote sizes failed at reserve=${reserve} (${quoteErr.slice(
          0,
          120
        )}). curve sold out.`
      );
      break;
    }
    const swapTx = await client.pool.swap2({
      owner: payer.publicKey,
      payer: payer.publicKey,
      pool,
      swapBaseForQuote: false,
      amountIn: new BN(buyLamports),
      minimumAmountOut: quote.minimumAmountOut,
      swapMode: sdk.SwapMode.ExactIn,
      referralTokenAccount: null,
    });
    let sig = "";
    try {
      sig = await sendConfirm(swapTx, [payer]);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("insufficient")) {
        stallCount++;
        console.log(
          `buy ${buyLamports} failed (insufficient curve liquidity), stall ${stallCount}`
        );
        if (stallCount > 20) {
          console.log("too many stalled buys, curve sold out.");
          break;
        }
        continue;
      }
      throw e;
    }
    stallCount = 0;
    spent += buyLamports;
    const next = await quoteReserveOf();
    const delta = next - reserve;
    progress = await progressOf();
    console.log(
      `buy ${buyLamports / 1e9} SOL ${sig.slice(
        0,
        8
      )} reserve ${reserve} -> ${next} (delta ${delta}) progress ${(
        progress * 100
      ).toFixed(4)}% spent ${spent / 1e9} SOL`
    );
    if (!(delta >= 0 && delta <= buyLamports)) {
      throw new Error(`reserve sanity failed: delta ${delta}`);
    }
    if (delta === 0) {
      zeroDeltaStreak++;
      console.log(
        `zero-delta buy ${zeroDeltaStreak}/5 (dust, no reserve move)`
      );
      if (zeroDeltaStreak >= 5) {
        console.log("repeated zero-delta buys, curve sold out at dust.");
        break;
      }
    } else {
      zeroDeltaStreak = 0;
    }
    reserve = next;
    if (spent % (10 * LAMPORTS_PER_SOL) === 0) {
      console.log(`... spent ${spent / 1e9} SOL, reserve ${reserve}`);
    }
  }
  console.log(
    `graduation loop done: reserve=${reserve} progress=${(
      progress * 100
    ).toFixed(4)}% spent=${spent / 1e9} SOL`
  );
  try {
    const rawPool = await client.state.getPool(pool);
    const pst = (rawPool as any).poolState ?? rawPool;
    console.log(
      `pool migration_progress=${
        pst.migrationProgress ?? pst.migration_progress
      } base_reserve=${pst.baseReserve ?? pst.base_reserve} quote_reserve=${
        pst.quoteReserve ?? pst.quote_reserve
      }`
    );
  } catch (e) {
    console.log(`pool state read failed: ${String(e).slice(0, 120)}`);
  }
  // True graduation gate is the migration instruction itself. Allow dust
  // (0.05% under threshold) here so a sold-out curve at 99.99% still
  // attempts migration; migration reverts if the pool is not complete.
  if (reserve < onChainThreshold * 0.9995) {
    throw new Error(
      `BLOCKER graduation: reserve ${reserve} below 85 SOL after spending ${
        spent / 1e9
      } SOL`
    );
  }

  // Fund the DBC pool authority PDA for migration rent. The DAMM pool
  // creation CPI is paid by the DBC pool authority (creator = payer =
  // pool_authority in create_pool), not by our wallet. On mainnet it holds
  // SOL; on a fresh local validator it starts at 0 and InitializePool
  // fails with "insufficient lamports 0, need 2770080".
  const DBC_POOL_AUTH = new web3.PublicKey(
    "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
  );
  const DAMM_POOL_AUTH = new web3.PublicKey(
    "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
  );
  for (const [label, key] of [
    ["dbc pool authority", DBC_POOL_AUTH],
    ["damm pool authority", DAMM_POOL_AUTH],
  ] as Array<[string, any]>) {
    const bal = await connection.getBalance(key);
    console.log(`${label} balance=${bal}`);
    if (bal < 1_000_000_000) {
      const fundTx = new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: key,
          lamports: 2_000_000_000,
        })
      );
      await sendConfirm(fundTx, [payer]);
      console.log(`funded ${label} with 2 SOL`);
    }
  }

  // 4. Migrate to DAMM v2 with the 25bps config.
  const dammConfig = new web3.PublicKey(DAMM_CONFIG);
  const dammConfigAi = await connection.getAccountInfo(dammConfig);
  if (!dammConfigAi) {
    throw new Error(
      `BLOCKER dammConfig missing: ${DAMM_CONFIG} not cloned. Clone it in the shell wrapper.`
    );
  }
  console.log(
    `dammConfig ok: ${DAMM_CONFIG} owner=${dammConfigAi.owner.toBase58()}`
  );
  const DAMM_V2 = new web3.PublicKey(DAMM_PROGRAM);
  if (!dammConfigAi.owner.equals(DAMM_V2)) {
    throw new Error(
      `BLOCKER dammConfig owner ${dammConfigAi.owner.toBase58()} != DAMM program`
    );
  }
  console.log("migrating to DAMM v2 ...");
  let migrateResp: any;
  try {
    migrateResp = await client.migration.migrateToDammV2({
      pool,
      dammConfig,
      payer: payer.publicKey,
    });
  } catch (e) {
    console.error(`MIGRATION_BUILD_FAIL: ${String(e).slice(0, 500)}`);
    throw new Error(
      `BLOCKER migration build failed: ${String(e).slice(0, 200)}`
    );
  }
  const migrateTx = migrateResp.transaction;
  migrateTx.feePayer = payer.publicKey;
  const firstNft = migrateResp.firstPositionNftKeypair;
  const secondNft = migrateResp.secondPositionNftKeypair;
  console.log(`first position NFT mint: ${firstNft.publicKey.toBase58()}`);
  console.log(`second position NFT mint: ${secondNft.publicKey.toBase58()}`);
  let migrateSig = "";
  try {
    migrateSig = await connection.sendTransaction(
      migrateTx,
      [payer, firstNft, secondNft],
      { skipPreflight: false, preflightCommitment: "confirmed" }
    );
    await connection.confirmTransaction(migrateSig, "confirmed");
  } catch (e) {
    console.error(`MIGRATION_SEND_FAIL: ${String(e).slice(0, 1000)}`);
    throw new Error(
      `BLOCKER migration send failed (see log above): ${String(e).slice(
        0,
        200
      )}`
    );
  }
  console.log(`migrateToDammV2: ${migrateSig}`);

  // 5. Confirm DAMM pool + positions.
  const dammPool = sdk.deriveDammV2PoolAddress(
    dammConfig,
    baseMint,
    NATIVE_MINT
  );
  console.log(`dammPool (derived): ${dammPool.toBase58()}`);
  const dammPoolAi = await connection.getAccountInfo(dammPool);
  if (!dammPoolAi) throw new Error("BLOCKER dammPool missing after migration");
  console.log(
    `dammPool owner=${dammPoolAi.owner.toBase58()} len=${
      dammPoolAi.data.length
    }`
  );
  const posAddr = (mint: any): any => {
    const [p] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position"), mint.toBuffer()],
      DAMM_V2
    );
    return p;
  };
  const posNftAddr = (mint: any): any => {
    const [p] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("position_nft_account"), mint.toBuffer()],
      DAMM_V2
    );
    return p;
  };
  const firstPos = posAddr(firstNft.publicKey);
  const secondPos = posAddr(secondNft.publicKey);
  const firstNftAcc = posNftAddr(firstNft.publicKey);
  const secondNftAcc = posNftAddr(secondNft.publicKey);
  for (const [label, key] of [
    ["first position", firstPos],
    ["second position", secondPos],
    ["first nft account", firstNftAcc],
    ["second nft account", secondNftAcc],
  ] as Array<[string, any]>) {
    const ai = await connection.getAccountInfo(key);
    console.log(
      `${label}: ${key.toBase58()} ${
        ai ? `owner=${ai.owner.toBase58()} len=${ai.data.length}` : "MISSING"
      }`
    );
    if (!ai) throw new Error(`BLOCKER ${label} missing after migration`);
  }

  // Position ownership + lock proof (021 review): the DBC migration sets
  // the bigger liquidity side to first position and locks both 50/50
  // shares permanently. Both positions must point at the migrated pool,
  // carry their own NFT mint, hold permanent locked liquidity and no
  // unlocked liquidity.
  const dammProgram = new anchor.Program(dammIdl, provider);
  const assertPosLocked = async (
    label: string,
    posKey: any,
    nftMint: any
  ): Promise<void> => {
    const pos = (await (dammProgram.account as any).position.fetch(
      posKey
    )) as any;
    const poolOk = (pos.pool as any).equals(dammPool);
    const mintOk = (pos.nftMint as any).equals(nftMint);
    const perm = BigInt(pos.permanentLockedLiquidity.toString());
    const unlocked = BigInt(pos.unlockedLiquidity.toString());
    console.log(
      `${label}: pool_match=${poolOk} nft_match=${mintOk} permanent_locked=${perm} unlocked=${unlocked}`
    );
    if (!poolOk) throw new Error(`${label} pool mismatch`);
    if (!mintOk) throw new Error(`${label} nft mint mismatch`);
    if (!(perm > BigInt(0)))
      throw new Error(`${label} permanent locked liquidity is 0`);
    // DAMM keeps 1 unit of dead liquidity unlocked in the first position
    // (the migration adds dead_liquidity to the first position only), so
    // allow dust of at most 1 and require everything else locked.
    if (unlocked > BigInt(1))
      throw new Error(`${label} unlocked liquidity != dust (${unlocked})`);
  };
  await assertPosLocked("first position", firstPos, firstNft.publicKey);
  await assertPosLocked("second position", secondPos, secondNft.publicKey);

  // NFT token accounts: each holds exactly 1 position NFT and its
  // token-account authority is the vault PDA (the account itself is owned
  // by the Token-2022 program).
  const assertNftAccount = async (
    label: string,
    accKey: any,
    nftMint: any
  ): Promise<void> => {
    // Position NFTs are Token-2022 mints, so read with the Token-2022
    // program id (default SPL Token program rejects the account owner).
    const acc = (await spl.getAccount(
      connection,
      accKey,
      "confirmed",
      spl.TOKEN_2022_PROGRAM_ID
    )) as any;
    const amount = BigInt(acc.amount.toString());
    const mintOk = (acc.mint as any).equals(nftMint);
    const authOk = (acc.owner as any).equals(vault);
    console.log(
      `${label}: amount=${amount} mint_match=${mintOk} authority_is_vault=${authOk}`
    );
    if (amount !== BigInt(1)) throw new Error(`${label} amount != 1`);
    if (!mintOk) throw new Error(`${label} mint mismatch`);
    if (!authOk) throw new Error(`${label} authority is not the vault`);
  };
  await assertNftAccount("first nft account", firstNftAcc, firstNft.publicKey);
  await assertNftAccount(
    "second nft account",
    secondNftAcc,
    secondNft.publicKey
  );

  // 6. update_config with damm_pool + first position.
  const cur = await (program.account as any).feeShortState.fetch(state);
  const updSig = await program.methods
    .updateConfig(dammPool, firstPos, cur.sweepDestination, cur.pumpPool, false)
    .accounts({ state, admin: payer.publicKey })
    .rpc();
  console.log(`update_config damm_pool+position: ${updSig}`);

  // 7. DAMM swap to accrue fees (quote -> base, 0.1 SOL).
  // dammProgram was created in step 5 for the position proof.
  const poolAuthority = new web3.PublicKey(
    "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
  );
  const [dammEventAuth] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DAMM_V2
  );
  const tokenVault = (mint: any): any => {
    const [p] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), mint.toBuffer(), dammPool.toBuffer()],
      DAMM_V2
    );
    return p;
  };
  // DAMM pool token order: fetch pool to learn token_a/b mints.
  const dammPoolState = await (dammProgram.account as any).pool.fetch(dammPool);
  const tokenAMint = dammPoolState.tokenAMint as any;
  const tokenBMint = dammPoolState.tokenBMint as any;
  console.log(
    `pool before swap: feeB_per_liq=${Buffer.from(
      dammPoolState.feeBPerLiquidity
    )
      .toString("hex")
      .slice(0, 16)} liquidity=${dammPoolState.liquidity
      .toString()
      .slice(0, 20)}`
  );
  const prePos = await (dammProgram.account as any).position.fetch(firstPos);
  console.log(
    `first position before swap: pending_a=${prePos.feeAPending.toString()} pending_b=${prePos.feeBPending.toString()} perm=${prePos.permanentLockedLiquidity
      .toString()
      .slice(0, 20)} checkpointB=${Buffer.from(prePos.feeBPerTokenCheckpoint)
      .toString("hex")
      .slice(0, 16)}`
  );
  const vaultA = tokenVault(tokenAMint);
  const vaultB = tokenVault(tokenBMint);
  console.log(
    `damm tokenA=${tokenAMint.toBase58()} tokenB=${tokenBMint.toBase58()}`
  );
  const isQuoteA = tokenAMint.equals(NATIVE_MINT);
  const inMint = NATIVE_MINT;
  const outMint = baseMint;
  const inVault = isQuoteA ? vaultA : vaultB;
  const outVault = isQuoteA ? vaultB : vaultA;
  void inVault;
  void outVault;
  const payerInAta = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    inMint,
    payer.publicKey,
    false
  );
  const payerOutAta = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    outMint,
    payer.publicKey,
    false
  );
  // Wrap 0.5 SOL for the swap payer.
  const wrapTx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payerInAta.address,
      lamports: 500_000_000,
    }),
    spl.createSyncNativeInstruction(payerInAta.address)
  );
  await sendConfirm(wrapTx, [payer]);
  const swapAmount = 100_000_000;
  const swapSig = await (dammProgram.methods as any)
    .swap({ amountIn: new BN(swapAmount), minimumAmountOut: new BN(0) })
    .accounts({
      poolAuthority,
      pool: dammPool,
      inputTokenAccount: payerInAta.address,
      outputTokenAccount: payerOutAta.address,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      tokenAMint,
      tokenBMint,
      payer: payer.publicKey,
      tokenAProgram: spl.TOKEN_PROGRAM_ID,
      tokenBProgram: spl.TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
      eventAuthority: dammEventAuth,
      program: DAMM_V2,
    })
    .rpc();
  console.log(`damm swap (fee accrual): ${swapSig}`);

  // 8. claim_damm_fees via OUR PROGRAM.
  const feeA = tokenAMint.equals(NATIVE_MINT)
    ? wsolAta.address
    : baseAta.address;
  const feeB = tokenBMint.equals(NATIVE_MINT)
    ? wsolAta.address
    : baseAta.address;
  // If both legs are the same ATA (can happen when pool order differs),
  // create the missing base/wSOL pairing explicitly.
  void feeA;
  void feeB;
  const vaultBaseAta = baseAta.address;
  const vaultWsolAtaAddr = wsolAta.address;
  const feeTokenA = tokenAMint.equals(baseMint)
    ? vaultBaseAta
    : vaultWsolAtaAddr;
  const feeTokenB = tokenBMint.equals(baseMint)
    ? vaultBaseAta
    : vaultWsolAtaAddr;
  const tokenAProgram = spl.TOKEN_PROGRAM_ID;
  const tokenBProgram = spl.TOKEN_PROGRAM_ID;
  // Position NFT account: the PDA derived above holds the NFT.
  // The program expects the token account holding 1 NFT.
  const positionNftAccount = firstNftAcc;
  const wsolBefore = BigInt(
    (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
  );
  const baseBefore = BigInt(
    (await connection.getTokenAccountBalance(baseAta.address)).value.amount
  );
  console.log(`vault wSOL before=${wsolBefore} base before=${baseBefore}`);
  const claimSig = await program.methods
    .claimDammFees()
    .accounts({
      state,
      vault,
      poolAuthority,
      dammPool,
      position: firstPos,
      feeTokenAAccount: feeTokenA,
      feeTokenBAccount: feeTokenB,
      vaultA,
      vaultB,
      tokenAMint,
      tokenBMint,
      positionNftAccount,
      tokenAProgram,
      tokenBProgram,
      eventAuthority: dammEventAuth,
      dammProgram: DAMM_V2,
    })
    .rpc();
  console.log(`claim_damm_fees (OUR PROGRAM): ${claimSig}`);
  const wsolAfter = BigInt(
    (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
  );
  const baseAfter = BigInt(
    (await connection.getTokenAccountBalance(baseAta.address)).value.amount
  );
  console.log(`vault wSOL after=${wsolAfter} base after=${baseAfter}`);
  const deltaWsol = wsolAfter - wsolBefore;
  const deltaBase = baseAfter - baseBefore;
  console.log(`delta wSOL=${deltaWsol} base=${deltaBase}`);
  if (deltaWsol <= 0 && deltaBase <= 0) {
    throw new Error("claim checkpoint failed: no fee delta on either leg");
  }
  // Post-claim exactness (021 review): the position must be fully drained
  // and its lifetime claimed metrics must equal the vault ATA deltas.
  const posAfter = (await (dammProgram.account as any).position.fetch(
    firstPos
  )) as any;
  const pendA = BigInt(posAfter.feeAPending.toString());
  const pendB = BigInt(posAfter.feeBPending.toString());
  const claimedA = BigInt(posAfter.metrics.totalClaimedAFee.toString());
  const claimedB = BigInt(posAfter.metrics.totalClaimedBFee.toString());
  console.log(
    `position after claim: fee_a_pending=${pendA} fee_b_pending=${pendB} total_claimed_a=${claimedA} total_claimed_b=${claimedB}`
  );
  if (pendA !== BigInt(0) || pendB !== BigInt(0)) {
    throw new Error(
      `claim checkpoint failed: pending not drained (a=${pendA} b=${pendB})`
    );
  }
  if (claimedA !== deltaBase || claimedB !== deltaWsol) {
    throw new Error(
      `claim conservation failed: metrics a=${claimedA} b=${claimedB} vs deltas base=${deltaBase} wsol=${deltaWsol}`
    );
  }
  console.log(
    `config=${configKp.publicKey.toBase58()} pool=${pool.toBase58()} baseMint=${baseMint.toBase58()}`
  );
  console.log(
    `txs: config=${configSig} pool=${poolSig} migrate=${migrateSig} swap=${swapSig} claim=${claimSig}`
  );
  console.log(
    `dammPool=${dammPool.toBase58()} position=${firstPos.toBase58()}`
  );
  console.log("CHECK_OK local full lifecycle passed");
  console.log("FULL_LIFECYCLE_OK");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--send")) {
    printPlan();
    return;
  }
  const rpc = argValue("--rpc", DEVNET_RPC);
  const isLocal = rpc.includes("127.0.0.1") || rpc.includes("localhost");
  if (!isLocal && !args.includes("--allow-mainnet")) {
    throw new Error("refusing non-local --send without --allow-mainnet");
  }
  if (!isLocal) {
    throw new Error(
      "BLOCKER devnet: local venue only. Run bash scripts/full-lifecycle-local.sh"
    );
  }
  await runLocal(rpc);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
