// DBC claim e2e for task 020.
// Dry run (default): no network. Prints plan, derives vault PDA,
// builds hand-built claim ix data.
// With --send: runs the real flow and exits non-zero on mismatch.
// Venue is chosen by --venue or --rpc:
//   --venue local (or --rpc localhost/127.0.0.1): local validator with the
//     DBC program cloned, pool created locally, no faucet needed.
//     Run via bash scripts/dbc-claim-local.sh.
//   --venue devnet: devnet with a funded wallet (needs 2+ SOL).
//
//   npx ts-node scripts/dbc-claim-e2e.ts
//   npx ts-node scripts/dbc-claim-e2e.ts --send --venue local --rpc http://127.0.0.1:8899
//   npx ts-node scripts/dbc-claim-e2e.ts --send --venue devnet --rpc https://api.devnet.solana.com
//
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LAUNCH_PARAMS } =
  require("../migrations/deploy") as typeof import("../migrations/deploy");

// Hand-built discriminators from programs/fee-short/src/lib.rs.
const DISC_PARTNER = [8, 236, 89, 49, 152, 125, 177, 81];
const DISC_CREATOR = [82, 220, 250, 189, 3, 85, 107, 45];
const DBC_PROGRAM = LAUNCH_PARAMS.programs.dbc;
const DEVNET_RPC = "https://api.devnet.solana.com";
const FEE_SHORT_ID = "EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj";
const DBC_POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM";

function u64MaxLe(): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt("18446744073709551615"));
  return b;
}

function handPartnerData(): Buffer {
  return Buffer.concat([Buffer.from(DISC_PARTNER), u64MaxLe(), u64MaxLe()]);
}

function handCreatorData(): Buffer {
  return Buffer.concat([Buffer.from(DISC_CREATOR), u64MaxLe(), u64MaxLe()]);
}

function vaultPdas(programId: string): { state: string; vault: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const web3 = require("@solana/web3.js") as typeof import("@solana/web3.js");
  const pid = new web3.PublicKey(programId);
  const [state] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    pid
  );
  const [vault] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), state.toBuffer()],
    pid
  );
  return { state: state.toBase58(), vault: vault.toBase58() };
}

function printPlan(): void {
  console.log("DRY RUN (no network calls)");
  console.log(`DBC program: ${DBC_PROGRAM}`);
  const pdas = vaultPdas(FEE_SHORT_ID);
  console.log(`fee-short state PDA: ${pdas.state}`);
  console.log(`fee-short vault PDA: ${pdas.vault}`);
  console.log(`hand partner data: ${handPartnerData().toString("hex")}`);
  console.log(`hand creator data: ${handCreatorData().toString("hex")}`);
  console.log(
    "SDK discriminators match hand discriminators (see docs/dbc-claim-e2e.md)."
  );
  console.log(
    "Accounts after 020b fix: partner 14, creator 13, match DBC IDL."
  );
  console.log("Base ATA (token_a) must exist even when base fees are zero;");
  console.log("send mode creates it with getOrCreateAssociatedTokenAccount.");
  console.log("Quote ATA is vault_wsol_ata.");
  console.log(
    "Venue: --venue local (no faucet) or --venue devnet (needs funds)."
  );
  console.log("CHECK_OK dry-run printed the plan");
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

  const keyPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const payer = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")))
  );
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const bal = await connection.getBalance(payer.publicKey);
  console.log(`payer: ${payer.publicKey.toBase58()} balance: ${bal / 1e9} SOL`);
  console.log(`rpc: ${rpcUrl}`);
  console.log(
    "venue: local validator with DBC program cloned (no faucet needed)"
  );

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
  console.log(`state PDA: ${state.toBase58()}`);
  console.log(`vault PDA (fee_claimer): ${vault.toBase58()}`);

  const client = new sdk.DynamicBondingCurveClient(connection, "confirmed");
  const NATIVE_MINT = new web3.PublicKey(LAUNCH_PARAMS.token.quoteMint);
  const c = LAUNCH_PARAMS.curve;
  const f = LAUNCH_PARAMS.fee;

  const sendConfirm = async (tx: any, signers: any[]): Promise<string> => {
    tx.feePayer = payer.publicKey;
    const sig: string = await connection.sendTransaction(tx, signers, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  };

  // 1. Curve + config with fee_claimer = vault PDA.
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
  const claimer = vault;
  console.log(`creating config ${configKp.publicKey.toBase58()} ...`);
  const createConfigTx = await client.partner.createConfig2({
    config: configKp.publicKey,
    feeClaimer: claimer,
    leftoverReceiver: claimer,
    payer: payer.publicKey,
    quoteMint: NATIVE_MINT,
    ...curveConfig,
  });
  const configSig = await sendConfirm(createConfigTx, [payer, configKp]);
  console.log(`createConfig sig: ${configSig}`);

  // 2. Pool with a fresh base mint.
  const baseMintKp = web3.Keypair.generate();
  console.log(`creating pool for mint ${baseMintKp.publicKey.toBase58()} ...`);
  const createPoolTx = await client.creator.createPool({
    baseMint: baseMintKp.publicKey,
    config: configKp.publicKey,
    name: "FUCKPUMP-LOCAL",
    symbol: "FPUMP-LOC",
    uri: "https://example.com/fpump.json",
    payer: payer.publicKey,
    poolCreator: payer.publicKey,
  });
  const poolSig = await sendConfirm(createPoolTx, [payer, baseMintKp]);
  console.log(`createPool sig: ${poolSig}`);
  const pool = sdk.deriveDbcPoolAddress(
    NATIVE_MINT,
    baseMintKp.publicKey,
    configKp.publicKey
  );
  console.log(`pool: ${pool.toBase58()}`);

  // 2b. Transfer pool creator to the vault PDA so OUR PROGRAM's creator
  // leg is authorized. Pool creation needs a signer creator, so the payer
  // starts as creator; max-short ends with the vault as creator.
  const transferTx = await client.creator.transferPoolCreator({
    pool,
    creator: payer.publicKey,
    newCreator: claimer,
  });
  const transferSig = await sendConfirm(transferTx, [payer]);
  console.log(`transferPoolCreator sig: ${transferSig} (new creator: vault)`);

  // 3. Pool vaults and mints.
  const rawPool = await client.state.getPool(pool);
  const st = (rawPool as any).poolState ?? rawPool;
  const baseVault = new web3.PublicKey(st.baseVault.toString());
  const quoteVault = new web3.PublicKey(st.quoteVault.toString());
  const baseMint = new web3.PublicKey(st.baseMint.toString());
  console.log(`baseVault: ${baseVault.toBase58()}`);
  console.log(`quoteVault: ${quoteVault.toBase58()}`);
  console.log(`baseMint: ${baseMint.toBase58()}`);

  // 4. Vault ATAs: token_a (base) must exist even when base fees are zero.
  // Quote ATA is vault_wsol_ata.
  const tokenBaseProgram = spl.TOKEN_PROGRAM_ID;
  const tokenQuoteProgram = spl.TOKEN_PROGRAM_ID;
  const baseAta = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    baseMint,
    vault,
    true,
    undefined,
    undefined,
    tokenBaseProgram
  );
  const wsolAta = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    NATIVE_MINT,
    vault,
    true,
    undefined,
    undefined,
    tokenQuoteProgram
  );
  console.log(`vault base ATA (token_a): ${baseAta.address.toBase58()}`);
  console.log(`vault wSOL ATA (token_b): ${wsolAta.address.toBase58()}`);

  // 5. init_state with the real pool/config and vault ATAs.
  // Project 0 is mocked here (claim does not use banks).
  const group = new web3.PublicKey(LAUNCH_PARAMS.project0.group);
  const solBank = new web3.PublicKey(LAUNCH_PARAMS.project0.solBank);
  const mockPumpBankKp = web3.Keypair.generate();
  const mockAirdrop = await connection.requestAirdrop(
    mockPumpBankKp.publicKey,
    1_000_000
  );
  await connection.confirmTransaction(mockAirdrop);
  const pumpBank = mockPumpBankKp.publicKey;
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
  const placeholderPumpAta = pumpAtaTmp.address;
  const pumpPool = new web3.PublicKey(LAUNCH_PARAMS.feeShort.pumpPool);
  const BPF_LOADER = new web3.PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
  );
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
      placeholderPumpAta,
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
      vaultPumpAta: placeholderPumpAta,
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
  console.log(`init_state sig: ${initSig} (paused=true)`);
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

  // 6. Accrue fees: 3 buys + 1 sell.
  const buyLamports = 100_000_000;
  const buyOne = async (lamports: number): Promise<string> => {
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
    return sendConfirm(swapTx, [payer]);
  };
  const buySigs: string[] = [];
  for (let i = 0; i < 3; i++) {
    buySigs.push(await buyOne(buyLamports));
  }
  console.log(`buy sigs: ${buySigs.join(", ")}`);
  const payerBaseAta = await spl.getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    baseMint,
    payer.publicKey
  );
  const baseBal = BigInt(payerBaseAta.amount.toString());
  console.log(`payer base balance: ${baseBal}`);
  const sellAmount = Number(baseBal / BigInt(10));
  let sellSig = "";
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
    sellSig = await sendConfirm(sellTx, [payer]);
    console.log(`sell sig: ${sellSig}`);
  }

  const feeBefore = await client.state.getPoolFeeMetrics(pool);
  console.log(`feeMetrics before: ${JSON.stringify(feeBefore).slice(0, 400)}`);
  const wsolBefore = BigInt(
    (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
  );
  console.log(`vault wSOL before: ${wsolBefore}`);

  // 7. Call OUR PROGRAM's claim_dbc_fees (no SDK claim for the assertion path).
  const poolAuthority = new web3.PublicKey(DBC_POOL_AUTHORITY);
  const [eventAuthority] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    new web3.PublicKey(DBC_PROGRAM)
  );
  const dbcProgram = new web3.PublicKey(DBC_PROGRAM);
  const claimSig = await program.methods
    .claimDbcFees()
    .accounts({
      state,
      vault,
      poolAuthority,
      dbcConfig: configKp.publicKey,
      dbcPool: pool,
      tokenAAccount: baseAta.address,
      vaultWsolAta: wsolAta.address,
      baseVault,
      quoteVault,
      baseMint,
      quoteMint: NATIVE_MINT,
      tokenBaseProgram,
      tokenQuoteProgram,
      eventAuthority,
      dbcProgram,
    })
    .rpc();
  console.log(`claim_dbc_fees sig: ${claimSig}`);

  const feeAfter = await client.state.getPoolFeeMetrics(pool);
  console.log(`feeMetrics after: ${JSON.stringify(feeAfter).slice(0, 400)}`);
  const wsolAfter = BigInt(
    (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
  );
  console.log(`vault wSOL after: ${wsolAfter}`);
  // Fee counters may be BN objects (live SDK, decimal String()) or hex
  // strings (JSON logs show hex without 0x). Normalize both to lamports.
  const num = (v: unknown): bigint => {
    if (typeof v === "string") return BigInt("0x" + v);
    return BigInt(String(v));
  };
  const claimed =
    num((feeBefore as any).current.partnerQuoteFee) -
    num((feeAfter as any).current.partnerQuoteFee) +
    (num((feeBefore as any).current.creatorQuoteFee) -
      num((feeAfter as any).current.creatorQuoteFee));
  console.log(`claimed quote fees (hex-decoded): ${claimed}`);
  if (wsolAfter <= wsolBefore) {
    throw new Error(
      `claim checkpoint failed: wSOL after (${wsolAfter}) <= before (${wsolBefore})`
    );
  }
  if (wsolAfter - wsolBefore !== claimed) {
    throw new Error(
      `claim conservation failed: vault delta ${
        wsolAfter - wsolBefore
      } != claimed ${claimed}`
    );
  }
  console.log(
    `config=${configKp.publicKey.toBase58()} pool=${pool.toBase58()} baseMint=${baseMint.toBase58()}`
  );
  console.log(
    `txs: config=${configSig} pool=${poolSig} transferCreator=${transferSig} buys=${buySigs.join(
      ","
    )} sell=${sellSig} claim=${claimSig}`
  );
  console.log("CHECK_OK local DBC claim through the program passed");
}

async function sendMode(rpcUrl: string, venue: string): Promise<void> {
  const isLocal =
    venue === "local" ||
    rpcUrl.includes("127.0.0.1") ||
    rpcUrl.includes("localhost");
  if (isLocal) {
    await runLocal(rpcUrl);
    return;
  }
  const isDev =
    rpcUrl.includes("devnet") ||
    rpcUrl.includes("127.0.0.1") ||
    rpcUrl.includes("localhost");
  if (!isDev && !process.argv.includes("--allow-mainnet")) {
    throw new Error(
      "refusing --send to non-devnet RPC without --allow-mainnet"
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const web3 = require("@solana/web3.js") as typeof import("@solana/web3.js");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("os") as typeof import("os");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require("path") as typeof import("path");
  const keyPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const payer = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")))
  );
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const bal = await connection.getBalance(payer.publicKey);
  console.log(`payer: ${payer.publicKey.toBase58()} balance: ${bal / 1e9} SOL`);
  console.log(`rpc: ${rpcUrl}`);
  console.log("venue: devnet (needs funded wallet)");
  if (bal < 2_000_000_000) {
    throw new Error(
      `BLOCKER funding: payer has ${bal} lamports, need at least 2 SOL. ` +
        `Fund ${payer.publicKey.toBase58()} and rerun with --send.`
    );
  }
  throw new Error(
    "BLOCKER deploy: devnet flow needs a funded wallet and a deployed program. " +
      "Use --venue local (bash scripts/dbc-claim-local.sh) with no faucet."
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--send")) {
    printPlan();
    return;
  }
  const rpc = argValue("--rpc", DEVNET_RPC);
  const venue = argValue(
    "--venue",
    rpc.includes("127.0.0.1") ? "local" : "devnet"
  );
  await sendMode(rpc, venue);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
