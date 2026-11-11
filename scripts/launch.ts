// Idempotent mainnet launch driver for fee-short.
//
// Default is a read-only plan. Nothing is signed or sent without BOTH
// `--send` and `--confirm-mainnet`.
//
// Stages:
//   plan      read current state and print the next actions (default)
//   prepare   deploy the program, create DBC config/pool, vault ATAs and
//             init_state. Leaves the state PAUSED.
//   go-live   run post-init preflight, then atomically unpause and
//             initialize the marginfi account. This is the actual launch.
//
// Examples:
//   npx ts-node scripts/launch.ts
//   npx ts-node scripts/launch.ts --stage prepare
//   npx ts-node scripts/launch.ts --stage prepare --send --confirm-mainnet \
//     --name "Mono no Aware" --symbol "mono" \
//     --uri "https://ar-io.dev/qG41oNKpHzh66gG7v55GwZJLAqhtv5xJ1ppLnclyc1M"
//   npx ts-node scripts/launch.ts --stage go-live --send --confirm-mainnet
//
// No keeper, no multisig. The configured wallet is payer, admin and upgrade
// authority. The launch stops at PAUSED after prepare so the caller can run
// preflight and choose when to unpause.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import * as spl from "@solana/spl-token";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LAUNCH_PARAMS } =
  require("../migrations/deploy") as typeof import("../migrations/deploy");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbcSdk = require("@meteora-ag/dynamic-bonding-curve-sdk") as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BN = require("bn.js");

const PROGRAM_ID = new PublicKey(LAUNCH_PARAMS.mainnet.programId);
const PAYER_PUBKEY = new PublicKey(LAUNCH_PARAMS.mainnet.deployer);
const GROUP = new PublicKey(LAUNCH_PARAMS.project0.group);
const SOL_BANK = new PublicKey(LAUNCH_PARAMS.project0.solBank);
const PUMP_BANK = new PublicKey(LAUNCH_PARAMS.project0.pumpBank);
const MARGINFI_V2 = new PublicKey(LAUNCH_PARAMS.project0.program);
const NATIVE_MINT = new PublicKey(LAUNCH_PARAMS.token.quoteMint);
const PUMP_MINT = new PublicKey(LAUNCH_PARAMS.token.pumpMint);
const DLMM_POOL = new PublicKey(LAUNCH_PARAMS.feeShort.pumpPool);
const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSVAR_IX = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const TOKEN_PROGRAM = spl.TOKEN_PROGRAM_ID;
const TOKEN_2022_PROGRAM = spl.TOKEN_2022_PROGRAM_ID;
const DEFAULT_KEY = PublicKey.default;
const STAGES = ["plan", "prepare", "go-live"] as const;
type Stage = (typeof STAGES)[number];

interface LaunchRecord {
  payer: string;
  programId: string;
  configKeypairPath?: string;
  config?: string;
  baseMintKeypairPath?: string;
  baseMint?: string;
  pool?: string;
  vault?: string;
  state?: string;
  vaultWsolAta?: string;
  vaultPumpAta?: string;
  vaultBaseAta?: string;
  marginfiAccount?: string;
  tokenMetadata?: { name: string; symbol: string; uri: string };
  programDeployOutput?: string;
  txs: Record<string, string>;
  updatedAt: string;
}

function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function fail(msg: string): never {
  console.error(`LAUNCH_FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`ok - ${msg}`);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function loadKeypair(file: string): Keypair {
  if (!fs.existsSync(file)) fail(`missing keypair ${file}`);
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[])
  );
}

function loadOrCreateKeypair(file: string): Keypair {
  if (fs.existsSync(file)) return loadKeypair(file);
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  ok(`created keypair ${file} (${kp.publicKey.toBase58()})`);
  return kp;
}

function writeRecord(file: string, record: LaunchRecord): void {
  record.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", {
    mode: 0o600,
  });
}

function loadRecord(file: string, payer: PublicKey): LaunchRecord {
  if (!fs.existsSync(file)) {
    return {
      payer: payer.toBase58(),
      programId: PROGRAM_ID.toBase58(),
      txs: {},
      updatedAt: new Date().toISOString(),
    };
  }
  const r = readJson<LaunchRecord>(file);
  if (r.payer !== payer.toBase58())
    fail(`record payer ${r.payer} != ${payer.toBase58()}`);
  if (r.programId !== PROGRAM_ID.toBase58())
    fail(`record program ${r.programId} mismatch`);
  if (!r.txs) r.txs = {};
  return r;
}

function canonicalAta(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey
): PublicKey {
  return spl.getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

function programDataPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBuffer()],
    BPF_LOADER
  )[0];
}

function statePda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    PROGRAM_ID
  )[0];
}

function vaultPda(state: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), state.toBuffer()],
    PROGRAM_ID
  )[0];
}

function marginfiPda(group: PublicKey, vault: PublicKey): PublicKey {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(0);
  const tp = Buffer.alloc(2);
  tp.writeUInt16LE(0);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("marginfi_account"),
      group.toBuffer(),
      vault.toBuffer(),
      idx,
      tp,
    ],
    MARGINFI_V2
  )[0];
}

function parseProgramDataAuthority(data: Buffer): PublicKey {
  if (data.length < 45) fail("ProgramData too short");
  if (data.readUInt32LE(0) !== 3) fail("not a ProgramData account");
  if (data[12] !== 1) fail("program has no upgrade authority");
  return new PublicKey(data.subarray(13, 45));
}

async function accountWithRetry(
  connection: Connection,
  key: PublicKey,
  label: string
): Promise<Buffer | null> {
  for (let i = 1; i <= 5; i++) {
    const ai = await connection.getAccountInfo(key);
    if (ai) return Buffer.from(ai.data);
    if (i < 5) await new Promise((r) => setTimeout(r, 1000 * i));
  }
  console.log(`warn - ${label} ${key.toBase58()} not found`);
  return null;
}

function assertEq(
  actual: string | PublicKey,
  expected: string | PublicKey,
  label: string
): void {
  const a = typeof actual === "string" ? actual : actual.toBase58();
  const e = typeof expected === "string" ? expected : expected.toBase58();
  if (a !== e) fail(`${label} mismatch: ${a} != ${e}`);
}

async function ensureAta(
  sendConn: Connection,
  readConn: Connection,
  payer: Keypair,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  label: string,
  send: boolean,
  record: LaunchRecord,
  recordFile: string
): Promise<PublicKey> {
  const key = canonicalAta(owner, mint, tokenProgram);
  const ai = await readConn.getAccountInfo(key);
  if (ai) {
    if (ai.data.length < 64) fail(`${label} ATA data too short`);
    const aiMint = new PublicKey(ai.data.subarray(0, 32));
    const aiOwner = new PublicKey(ai.data.subarray(32, 64));
    assertEq(aiMint, mint, `${label} ATA mint`);
    assertEq(aiOwner, owner, `${label} ATA owner`);
    return key;
  }
  if (!send) {
    console.log(`plan - create ${label} ATA ${key.toBase58()}`);
    return key;
  }
  const ix = spl.createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey,
    key,
    owner,
    mint,
    tokenProgram
  );
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (
    await sendConn.getLatestBlockhash("confirmed")
  ).blockhash;
  tx.sign(payer);
  const sig = await sendConn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await sendConn.confirmTransaction(sig, "confirmed");
  record.txs[`create_ata_${label}`] = sig;
  writeRecord(recordFile, record);
  ok(`created ${label} ATA ${key.toBase58()} sig=${sig}`);
  return key;
}

async function verifyProgram(
  readConn: Connection,
  sender: PublicKey,
  required: boolean
): Promise<boolean> {
  const ai = await readConn.getAccountInfo(PROGRAM_ID);
  if (!ai) {
    if (required) fail(`fee-short program missing: ${PROGRAM_ID.toBase58()}`);
    return false;
  }
  if (!ai.executable) fail("fee-short program is not executable");
  if (!ai.owner.equals(BPF_LOADER))
    fail(`unexpected program owner ${ai.owner.toBase58()}`);
  const pd = programDataPda();
  const pdAi = await readConn.getAccountInfo(pd);
  if (!pdAi) fail(`missing ProgramData ${pd.toBase58()}`);
  assertEq(
    parseProgramDataAuthority(Buffer.from(pdAi.data)),
    sender,
    "upgrade authority"
  );
  ok(
    `program deployed: ${PROGRAM_ID.toBase58()} upgradeAuthority=${sender.toBase58()}`
  );
  return true;
}

async function deployProgram(
  rpcUrl: string,
  walletPath: string,
  programKeypairPath: string,
  soPath: string
): Promise<string> {
  const programKp = loadKeypair(programKeypairPath);
  assertEq(programKp.publicKey, PROGRAM_ID, "program keypair id");
  if (!fs.existsSync(soPath)) fail(`missing production artifact ${soPath}`);
  console.log(`deploying production program ${soPath} ...`);
  const out = execFileSync(
    "solana",
    [
      "program",
      "deploy",
      soPath,
      "--url",
      rpcUrl,
      "--keypair",
      walletPath,
      "--program-id",
      programKeypairPath,
      "--use-rpc",
      "--with-compute-unit-price",
      "1000",
      "--output",
      "json",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  console.log(out.trim());
  ok("solana program deploy returned");
  return out.trim();
}

async function buildCurveConfig(): Promise<any> {
  const c = LAUNCH_PARAMS.curve;
  const f = LAUNCH_PARAMS.fee;
  const sqrtPrices = dbcSdk.createSqrtPrices(
    [c.startPriceSolPerToken, c.endPriceSolPerToken],
    dbcSdk.TokenDecimal.SIX,
    dbcSdk.TokenDecimal.NINE
  );
  return dbcSdk.buildCurveWithCustomSqrtPrices({
    token: {
      tokenType: dbcSdk.TokenType.SPLToken,
      tokenBaseDecimal: dbcSdk.TokenDecimal.SIX,
      tokenQuoteDecimal: dbcSdk.TokenDecimal.NINE,
      tokenAuthorityOption: 1, // Immutable
      totalTokenSupply: LAUNCH_PARAMS.token.totalSupplyTokens,
      leftover: 1_000,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: dbcSdk.BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: f.startingFeeBps,
          endingFeeBps: f.endingFeeBps,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: dbcSdk.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: f.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: dbcSdk.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: dbcSdk.MigrationFeeOption.FixedBps25,
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
    activationType: dbcSdk.ActivationType.Timestamp,
    sqrtPrices,
    liquidityWeights: [1],
  });
}

async function main(): Promise<void> {
  const stage = argValue("--stage", "plan") as Stage;
  if (!STAGES.includes(stage)) fail(`bad --stage ${stage}`);
  const send = has("--send");
  const confirmMainnet = has("--confirm-mainnet");
  const localRehearsal = has("--local-rehearsal");
  const rpcUrl = argValue("--rpc", LAUNCH_PARAMS.mainnet.rpcUrl);
  const readRpcUrl = argValue("--read-rpc", LAUNCH_PARAMS.mainnet.readRpcUrl);
  const walletPath =
    argValue("--wallet", "") ||
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config/solana/id.json");
  const launchDir = argValue(
    "--launch-dir",
    path.join(".keys", "mainnet", "launch")
  );
  const recordFile = path.join(launchDir, "launch-record.json");
  const configFile = path.join(launchDir, "config-keypair.json");
  const baseMintFile = path.join(launchDir, "base-mint-keypair.json");
  const programKeypairPath = argValue(
    "--program-keypair",
    path.join("target", "deploy", "fee_short-keypair.json")
  );
  const productionSo = argValue(
    "--so",
    path.join("target", "production", "fee_short.so")
  );
  const name = argValue("--name", LAUNCH_PARAMS.mainnet.tokenMetadata.name);
  const symbol = argValue(
    "--symbol",
    LAUNCH_PARAMS.mainnet.tokenMetadata.symbol
  );
  const uri = argValue("--uri", LAUNCH_PARAMS.mainnet.tokenMetadata.uri);
  const firstBuySol = Number(argValue("--first-buy-sol", "0"));
  if (!Number.isFinite(firstBuySol) || firstBuySol < 0)
    fail(`bad --first-buy-sol ${argValue("--first-buy-sol", "")}`);
  const firstBuyLamports = Math.round(firstBuySol * 1e9);
  const isMainnet =
    !rpcUrl.includes("127.0.0.1") &&
    !rpcUrl.includes("localhost") &&
    !rpcUrl.includes("devnet") &&
    !rpcUrl.includes("testnet");
  if (send && isMainnet && !confirmMainnet)
    fail("mainnet send requires --confirm-mainnet");
  if (localRehearsal && isMainnet)
    fail("--local-rehearsal cannot be used with a mainnet RPC");

  const payer = loadKeypair(walletPath);
  if (!localRehearsal) {
    assertEq(payer.publicKey, PAYER_PUBKEY, "wallet");
    assertEq(
      new PublicKey(LAUNCH_PARAMS.mainnet.admin),
      payer.publicKey,
      "admin"
    );
    assertEq(
      new PublicKey(LAUNCH_PARAMS.mainnet.upgradeAuthority),
      payer.publicKey,
      "upgrade authority"
    );
  } else {
    ok(`local rehearsal payer ${payer.publicKey.toBase58()}`);
  }
  const sendConn = new Connection(rpcUrl, "confirmed");
  const readConn = new Connection(readRpcUrl, "confirmed");
  const balance = await readConn.getBalance(payer.publicKey);
  const state = statePda();
  const vault = vaultPda(state);
  const record = loadRecord(recordFile, payer.publicKey);
  const idl = readJson<any>(
    path.join("target", "production", "fee_short.json")
  );
  const readProvider = new anchor.AnchorProvider(
    readConn,
    new anchor.Wallet(payer),
    { commitment: "confirmed" }
  );
  const sendProvider = new anchor.AnchorProvider(
    sendConn,
    new anchor.Wallet(payer),
    { commitment: "confirmed" }
  );
  const readProgram = new anchor.Program(idl, readProvider) as any;
  const sendProgram = new anchor.Program(idl, sendProvider) as any;
  const dbc = new dbcSdk.DynamicBondingCurveClient(readConn, "confirmed");

  console.log(`stage=${stage} send=${send} mainnet=${isMainnet}`);
  console.log(
    `payer=${payer.publicKey.toBase58()} balance=${Number(balance) / 1e9} SOL`
  );
  console.log(`sendRpc=${rpcUrl}`);
  console.log(`readRpc=${readRpcUrl}`);
  console.log(`state=${state.toBase58()} vault=${vault.toBase58()}`);

  const programExists = await verifyProgram(readConn, payer.publicKey, false);

  if (stage === "plan") {
    const stateData = await readConn.getAccountInfo(state);
    console.log(`programExists=${programExists}`);
    console.log(`stateExists=${Boolean(stateData)}`);
    if (stateData) {
      const st = await readProgram.account.feeShortState.fetch(state);
      console.log(`paused=${st.paused} marginfi=${String(st.marginfiAccount)}`);
    }
    console.log("plan:");
    if (!programExists)
      console.log("  1. deploy target/production/fee_short.so");
    console.log("  2. create DBC config and PUMP-parity pool");
    console.log("  3. transfer DBC pool creator to vault PDA");
    console.log(
      "  4. create vault wSOL/PUMP/base ATAs and init_state (paused)"
    );
    console.log("  5. run post-init preflight");
    console.log("  6. atomically unpause + init marginfi account (go-live)");
    console.log("PLAN_OK no transaction sent");
    return;
  }

  if (stage === "prepare") {
    if (!send) {
      console.log(
        "plan - prepare would execute the steps above; pass --send --confirm-mainnet"
      );
      console.log("PLAN_OK no transaction sent");
      return;
    }
    execFileSync(
      "npx",
      [
        "ts-node",
        "scripts/preflight.ts",
        "--stage",
        "predeploy",
        "--rpc",
        readRpcUrl,
        "--wallet",
        walletPath,
        ...(localRehearsal ? ["--local-rehearsal"] : []),
      ],
      { stdio: "inherit" }
    );

    if (!programExists) {
      record.programDeployOutput = await deployProgram(
        rpcUrl,
        walletPath,
        programKeypairPath,
        productionSo
      );
      writeRecord(recordFile, record);
      for (let i = 0; i < 30; i++) {
        if (await verifyProgram(readConn, payer.publicKey, false)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      await verifyProgram(readConn, payer.publicKey, true);
    } else {
      await verifyProgram(readConn, payer.publicKey, true);
    }

    // Recover addresses from state if it already exists.
    let cfgKey: PublicKey;
    let baseMint: PublicKey;
    let pool: PublicKey;
    const existingState = await readConn.getAccountInfo(state);
    if (existingState) {
      const st = await readProgram.account.feeShortState.fetch(state);
      cfgKey = st.dbcConfig;
      baseMint = st.baseMint;
      pool = st.dbcPool;
      record.config = cfgKey.toBase58();
      record.baseMint = baseMint.toBase58();
      record.pool = pool.toBase58();
      record.state = state.toBase58();
      writeRecord(recordFile, record);
      assertEq(st.pumpPool, DLMM_POOL, "state pump pool");
      console.log("state already initialized; using its DBC addresses");
    } else {
      const configKp = loadOrCreateKeypair(configFile);
      record.configKeypairPath = configFile;
      record.config = configKp.publicKey.toBase58();
      const baseMintKp = loadOrCreateKeypair(baseMintFile);
      record.baseMintKeypairPath = baseMintFile;
      record.baseMint = baseMintKp.publicKey.toBase58();
      record.pool = dbcSdk
        .deriveDbcPoolAddress(
          NATIVE_MINT,
          baseMintKp.publicKey,
          configKp.publicKey
        )
        .toBase58();
      record.tokenMetadata = { name, symbol, uri };
      writeRecord(recordFile, record);

      cfgKey = configKp.publicKey;
      baseMint = baseMintKp.publicKey;
      pool = new PublicKey(record.pool as string);

      const cfgData = await accountWithRetry(readConn, cfgKey, "DBC config");
      if (!cfgData) {
        const curveConfig = await buildCurveConfig();
        const tx: Transaction = await dbc.partner.createConfig2({
          config: cfgKey,
          feeClaimer: vault,
          leftoverReceiver: vault,
          payer: payer.publicKey,
          quoteMint: NATIVE_MINT,
          ...curveConfig,
        });
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (
          await sendConn.getLatestBlockhash("confirmed")
        ).blockhash;
        tx.sign(payer, configKp);
        const sig = await sendConn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        await sendConn.confirmTransaction(sig, "confirmed");
        record.txs.create_config = sig;
        writeRecord(recordFile, record);
        ok(`created DBC config ${cfgKey.toBase58()} sig=${sig}`);
      } else {
        ok(`DBC config already exists ${cfgKey.toBase58()}`);
      }

      const baseData = await accountWithRetry(readConn, baseMint, "base mint");
      const poolData = await accountWithRetry(readConn, pool, "DBC pool");
      if (!baseData || !poolData) {
        if (!localRehearsal && (!uri || uri.includes("example.com")))
          fail("DBC pool creation needs the final --uri metadata URL");
        if (!symbol) fail("DBC pool creation needs --symbol");
        if (!name) fail("DBC pool creation needs --name");
        const createPoolParam = {
          baseMint,
          config: cfgKey,
          name,
          symbol,
          uri,
          payer: payer.publicKey,
          poolCreator: payer.publicKey,
        };
        const tx: Transaction =
          firstBuyLamports > 0
            ? await dbc.creator.createPoolWithFirstBuy({
                createPoolParam,
                firstBuyParam: {
                  buyer: payer.publicKey,
                  buyAmount: new BN(firstBuyLamports),
                  minimumAmountOut: new BN(1),
                  referralTokenAccount: null,
                },
              })
            : await dbc.creator.createPool(createPoolParam);
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (
          await sendConn.getLatestBlockhash("confirmed")
        ).blockhash;
        tx.sign(payer, baseMintKp);
        const sig = await sendConn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        await sendConn.confirmTransaction(sig, "confirmed");
        record.txs.create_pool = sig;
        if (firstBuyLamports > 0) record.txs.first_buy = sig;
        writeRecord(recordFile, record);
        ok(
          `created DBC pool ${pool.toBase58()}${
            firstBuyLamports > 0 ? ` + first buy ${firstBuySol} SOL` : ""
          } sig=${sig}`
        );
      } else {
        ok(`DBC pool already exists ${pool.toBase58()}`);
      }
    }

    // Bind pool config/base and creator to the vault.
    const rawPool = await dbc.state.getPool(pool);
    const p = rawPool.poolState ?? rawPool;
    assertEq(new PublicKey(p.config.toString()), cfgKey, "pool config");
    assertEq(new PublicKey(p.baseMint.toString()), baseMint, "pool base mint");
    const creator = new PublicKey(p.creator.toString());
    if (!creator.equals(vault)) {
      if (!creator.equals(payer.publicKey))
        fail(`pool creator ${creator.toBase58()} is neither payer nor vault`);
      const tx: Transaction = await dbc.creator.transferPoolCreator({
        pool,
        creator: payer.publicKey,
        newCreator: vault,
      });
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = (
        await sendConn.getLatestBlockhash("confirmed")
      ).blockhash;
      tx.sign(payer);
      const sig = await sendConn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });
      await sendConn.confirmTransaction(sig, "confirmed");
      record.txs.transfer_pool_creator = sig;
      writeRecord(recordFile, record);
      ok(`transferred DBC pool creator to vault sig=${sig}`);
    } else {
      ok("DBC pool creator already equals vault");
    }

    const baseMintAi = await readConn.getAccountInfo(baseMint);
    if (!baseMintAi) fail(`base mint missing ${baseMint.toBase58()}`);
    const baseTokenProgram = baseMintAi.owner;
    if (
      !baseTokenProgram.equals(TOKEN_PROGRAM) &&
      !baseTokenProgram.equals(TOKEN_2022_PROGRAM)
    )
      fail(
        `base mint owner ${baseTokenProgram.toBase58()} is not SPL/Token-2022`
      );

    const vaultWsol = await ensureAta(
      sendConn,
      readConn,
      payer,
      vault,
      NATIVE_MINT,
      TOKEN_PROGRAM,
      "vault-wsol",
      send,
      record,
      recordFile
    );
    const vaultPump = await ensureAta(
      sendConn,
      readConn,
      payer,
      vault,
      PUMP_MINT,
      TOKEN_2022_PROGRAM,
      "vault-pump",
      send,
      record,
      recordFile
    );
    const vaultBase = await ensureAta(
      sendConn,
      readConn,
      payer,
      vault,
      baseMint,
      baseTokenProgram,
      "vault-base",
      send,
      record,
      recordFile
    );
    record.vaultWsolAta = vaultWsol.toBase58();
    record.vaultPumpAta = vaultPump.toBase58();
    record.vaultBaseAta = vaultBase.toBase58();
    writeRecord(recordFile, record);

    const stateAi = await readConn.getAccountInfo(state);
    if (!stateAi) {
      const pd = programDataPda();
      const sig = await sendProgram.methods
        .initState(
          payer.publicKey,
          pool,
          cfgKey,
          GROUP,
          SOL_BANK,
          PUMP_BANK,
          vaultWsol,
          vaultPump,
          payer.publicKey,
          DLMM_POOL,
          baseMint,
          vaultBase
        )
        .accounts({
          state,
          vault,
          payer: payer.publicKey,
          admin: payer.publicKey,
          vaultWsolAta: vaultWsol,
          vaultPumpAta: vaultPump,
          programData: pd,
          dbcConfig: cfgKey,
          quoteMint: NATIVE_MINT,
          pumpBank: PUMP_BANK,
          solBank: SOL_BANK,
          group: GROUP,
          dbcPool: pool,
          pumpMint: PUMP_MINT,
          vaultBaseAta: vaultBase,
          baseMint,
        })
        .rpc();
      record.txs.init_state = sig;
      record.state = state.toBase58();
      writeRecord(recordFile, record);
      ok(`init_state sig=${sig} (paused)`);
    } else {
      if (stateAi.data.length !== 491)
        fail(`state length ${stateAi.data.length} != 491`);
      record.state = state.toBase58();
      writeRecord(recordFile, record);
      ok("state already initialized");
    }

    console.log(
      "PREPARE_OK program/config/pool/ATAs/state ready; state remains PAUSED"
    );
    console.log(
      "next: run preflight --stage postinit, then launch --stage go-live --send --confirm-mainnet"
    );
    return;
  }

  // go-live: require a complete prepared state and run post-init preflight.
  if (!programExists)
    fail("program is not deployed; run --stage prepare first");
  const stateAi = await readConn.getAccountInfo(state);
  if (!stateAi) fail("state is missing; run --stage prepare first");
  if (stateAi.data.length !== 491)
    fail(`state length ${stateAi.data.length} != 491`);
  const st = await readProgram.account.feeShortState.fetch(state);
  const mf = marginfiPda(GROUP, vault);
  record.marginfiAccount = mf.toBase58();
  writeRecord(recordFile, record);
  if (!send) {
    console.log(
      `go-live would ${
        st.paused ? "unpause" : "keep unpaused"
      } and init ${mf.toBase58()}`
    );
    console.log("PLAN_OK no transaction sent");
    return;
  }
  execFileSync(
    "npx",
    [
      "ts-node",
      "scripts/preflight.ts",
      "--stage",
      "postinit",
      "--rpc",
      readRpcUrl,
      "--wallet",
      walletPath,
      ...(localRehearsal ? ["--local-rehearsal"] : []),
    ],
    { stdio: "inherit" }
  );

  const mfAi = await readConn.getAccountInfo(mf);
  const ixs: anchor.web3.TransactionInstruction[] = [];
  if (st.paused) {
    ixs.push(
      await sendProgram.methods
        .updateConfig(
          st.dammPool,
          st.dammPosition,
          st.sweepDestination,
          st.pumpPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .instruction()
    );
  }
  if (!mfAi) {
    ixs.push(
      await sendProgram.methods
        .initMarginfiAccount()
        .accounts({
          state,
          vault,
          marginfiAccount: mf,
          group: GROUP,
          payer: payer.publicKey,
          instructionsSysvar: SYSVAR_IX,
          marginfiProgram: MARGINFI_V2,
        })
        .instruction()
    );
  }
  if (ixs.length > 0) {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(...ixs);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (
      await sendConn.getLatestBlockhash("confirmed")
    ).blockhash;
    tx.sign(payer);
    const sig = await sendConn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await sendConn.confirmTransaction(sig, "confirmed");
    record.txs.go_live = sig;
    writeRecord(recordFile, record);
    ok(`go-live transaction sig=${sig}`);
  } else {
    ok("nothing to do; state already unpaused and marginfi account exists");
  }

  const finalState = await readProgram.account.feeShortState.fetch(state);
  if (finalState.paused) fail("state is still paused");
  const finalMf = await readConn.getAccountInfo(mf);
  if (
    !finalMf ||
    !finalMf.owner.equals(MARGINFI_V2) ||
    finalMf.data.length !== 2312
  )
    fail("marginfi account missing or malformed after go-live");
  record.marginfiAccount = mf.toBase58();
  writeRecord(recordFile, record);
  console.log(`GO_LIVE_OK state=${state.toBase58()} marginfi=${mf.toBase58()}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
