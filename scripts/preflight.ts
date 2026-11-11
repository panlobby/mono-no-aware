// Read-only mainnet preflight for the fee-short launch.
//
//   npx ts-node scripts/preflight.ts
//   npx ts-node scripts/preflight.ts --stage postdeploy
//   npx ts-node scripts/preflight.ts --stage postinit
//   npx ts-node scripts/preflight.ts --stage live
//
// The script never signs or sends a transaction. It re-reads every address
// used by the launch, checks owner/discriminator/layout relationships,
// validates the production artifact, and prints the exact funding shortfall.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LAUNCH_PARAMS } =
  require("../migrations/deploy") as typeof import("../migrations/deploy");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const web3 = require("@solana/web3.js") as typeof import("@solana/web3.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const anchor =
  require("@anchor-lang/core") as typeof import("@anchor-lang/core");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require("@0dotxyz/p0-ts-sdk") as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbcSdk = require("@meteora-ag/dynamic-bonding-curve-sdk") as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DLMM = require("@meteora-ag/dlmm") as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BN = require("bn.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BorshCoder } =
  require("@coral-xyz/anchor") as typeof import("@coral-xyz/anchor");

type WConnection = import("@solana/web3.js").Connection;
type WPublicKey = import("@solana/web3.js").PublicKey;
type WAccountInfo<T> = import("@solana/web3.js").AccountInfo<T>;

const MARGINFI_V2 = new web3.PublicKey(LAUNCH_PARAMS.project0.program);
const DBC_PROGRAM = new web3.PublicKey(LAUNCH_PARAMS.programs.dbc);
const DAMM_PROGRAM = new web3.PublicKey(LAUNCH_PARAMS.programs.dammV2);
const DLMM_PROGRAM = new web3.PublicKey(LAUNCH_PARAMS.programs.dlmm);
const BPF_LOADER = new web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const SYSVAR_IX = new web3.PublicKey(
  "Sysvar1nstructions1111111111111111111111111"
);
const NATIVE_MINT = new web3.PublicKey(LAUNCH_PARAMS.token.quoteMint);
const PUMP_MINT = new web3.PublicKey(LAUNCH_PARAMS.token.pumpMint);
const GROUP = new web3.PublicKey(LAUNCH_PARAMS.project0.group);
const SOL_BANK = new web3.PublicKey(LAUNCH_PARAMS.project0.solBank);
const PUMP_BANK = new web3.PublicKey(LAUNCH_PARAMS.project0.pumpBank);
const DLMM_POOL = new web3.PublicKey(LAUNCH_PARAMS.feeShort.pumpPool);
const PROGRAM_ID = new web3.PublicKey(LAUNCH_PARAMS.mainnet.programId);
const EXPECTED_PAYER = new web3.PublicKey(LAUNCH_PARAMS.mainnet.deployer);
const DISC_GROUP = [182, 23, 173, 240, 151, 206, 182, 67];

const STAGES = ["predeploy", "postdeploy", "postinit", "live"] as const;
type Stage = (typeof STAGES)[number];

function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function fail(msg: string): never {
  console.error(`PREFLIGHT_FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`ok - ${msg}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function accountWithRetry(
  connection: WConnection,
  key: WPublicKey,
  label: string
): Promise<WAccountInfo<Buffer> | null> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const ai = await connection.getAccountInfo(key);
    if (ai) return ai as WAccountInfo<Buffer>;
    if (attempt < 5) await sleep(1000 * attempt);
  }
  console.log(`warn - ${label} ${key.toBase58()} not found`);
  return null;
}

function requireAccount(
  ai: WAccountInfo<Buffer> | null,
  key: WPublicKey,
  label: string
): WAccountInfo<Buffer> {
  if (!ai) fail(`${label} missing: ${key.toBase58()}`);
  return ai;
}

function assertKey(
  actual: WPublicKey,
  expected: WPublicKey,
  label: string
): void {
  if (!actual.equals(expected))
    fail(`${label} mismatch: ${actual.toBase58()} != ${expected.toBase58()}`);
}

function readPk(data: Buffer, offset: number): WPublicKey {
  if (data.length < offset + 32) fail(`short pubkey at offset ${offset}`);
  return new web3.PublicKey(data.subarray(offset, offset + 32));
}

function parsePyth(data: Buffer): {
  feed: string;
  price: bigint;
  conf: bigint;
  expo: number;
  publish: bigint;
} {
  if (data.length < 133) fail(`Pyth account too short: ${data.length}`);
  if (data[40] !== 1) fail("Pyth verification level is not Full");
  const base = 41;
  return {
    feed: data.subarray(base, base + 32).toString("hex"),
    price: data.readBigInt64LE(base + 32),
    conf: data.readBigUInt64LE(base + 40),
    expo: data.readInt32LE(base + 48),
    publish: data.readBigInt64LE(base + 52),
  };
}

function parseProgramDataAuthority(data: Buffer): WPublicKey {
  if (data.length < 45) fail("ProgramData too short");
  if (data.readUInt32LE(0) !== 3) fail("not a ProgramData account");
  if (data[12] !== 1) fail("program has no upgrade authority");
  return readPk(data, 13);
}

function ata(
  mint: WPublicKey,
  owner: WPublicKey,
  tokenProgram: WPublicKey
): WPublicKey {
  return web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    new web3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  )[0];
}

async function main(): Promise<void> {
  const rpcUrl = argValue("--rpc", LAUNCH_PARAMS.mainnet.readRpcUrl);
  const walletPath =
    argValue("--wallet", "") ||
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config/solana/id.json");
  const stage = argValue("--stage", "predeploy") as Stage;
  if (!STAGES.includes(stage)) fail(`bad --stage ${stage}`);
  const localRehearsal = has("--local-rehearsal");
  const isLocalRpc =
    rpcUrl.includes("127.0.0.1") ||
    rpcUrl.includes("localhost") ||
    rpcUrl.includes("devnet") ||
    rpcUrl.includes("testnet");
  if (localRehearsal && !isLocalRpc)
    fail("--local-rehearsal requires a local/devnet/testnet RPC");
  const connection = new web3.Connection(rpcUrl, "confirmed");
  const payer = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")))
  );
  if (!localRehearsal) {
    assertKey(payer.publicKey, EXPECTED_PAYER, "wallet");
    assertKey(
      new web3.PublicKey(LAUNCH_PARAMS.mainnet.admin),
      EXPECTED_PAYER,
      "admin"
    );
    assertKey(
      new web3.PublicKey(LAUNCH_PARAMS.mainnet.upgradeAuthority),
      EXPECTED_PAYER,
      "upgrade authority"
    );
  } else {
    ok(`local rehearsal payer ${payer.publicKey.toBase58()}`);
  }
  ok(`rpc ${rpcUrl}`);
  ok(`wallet ${payer.publicKey.toBase58()}`);
  ok(`stage ${stage}`);

  // Artifact and source hashes are checked before any deploy action.
  execFileSync("npm", ["run", "verify:artifact", "--silent"], {
    stdio: "inherit",
  });

  const slot = await connection.getSlot("confirmed");
  ok(`rpc slot ${slot}`);

  // External programs must exist and be executable.
  for (const [label, key] of [
    ["DBC", DBC_PROGRAM],
    ["DAMM v2", DAMM_PROGRAM],
    ["DLMM", DLMM_PROGRAM],
    ["marginfi v2", MARGINFI_V2],
  ] as Array<[string, WPublicKey]>) {
    const ai = requireAccount(
      await accountWithRetry(connection, key, label),
      key,
      label
    );
    if (!ai.executable) fail(`${label} is not executable: ${key.toBase58()}`);
    ok(`${label} program executable`);
  }

  // Mint owners and decimals.
  const wsolAi = requireAccount(
    await accountWithRetry(connection, NATIVE_MINT, "wSOL mint"),
    NATIVE_MINT,
    "wSOL mint"
  );
  if (
    !wsolAi.owner.equals(web3.SystemProgram.programId) &&
    !wsolAi.owner.equals(
      new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    )
  )
    fail(`wSOL mint unexpected owner ${wsolAi.owner.toBase58()}`);
  if (wsolAi.data[44] !== 9) fail(`wSOL decimals ${wsolAi.data[44]} != 9`);
  ok("wSOL mint owner/decimals");

  const pumpAi = requireAccount(
    await accountWithRetry(connection, PUMP_MINT, "PUMP mint"),
    PUMP_MINT,
    "PUMP mint"
  );
  if (
    !pumpAi.owner.equals(
      new web3.PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
    )
  )
    fail(`PUMP mint unexpected owner ${pumpAi.owner.toBase58()}`);
  if (pumpAi.data[44] !== 6) fail(`PUMP decimals ${pumpAi.data[44]} != 6`);
  ok("PUMP mint owner/decimals");

  // Marginfi group + bank relationships.
  const coder = new BorshCoder(sdk.MARGINFI_IDL as any);
  const groupAi = requireAccount(
    await accountWithRetry(connection, GROUP, "marginfi group"),
    GROUP,
    "marginfi group"
  );
  assertKey(groupAi.owner, MARGINFI_V2, "group owner");
  if (
    JSON.stringify([...groupAi.data.subarray(0, 8)]) !==
    JSON.stringify(DISC_GROUP)
  )
    fail("group discriminator mismatch");
  ok("marginfi group owner/discriminator");

  const banks: Array<[string, WPublicKey, WPublicKey]> = [
    ["SOL bank", SOL_BANK, NATIVE_MINT],
    ["PUMP bank", PUMP_BANK, PUMP_MINT],
  ];
  for (const [label, bankKey, expectedMint] of banks) {
    const ai = requireAccount(
      await accountWithRetry(connection, bankKey, label),
      bankKey,
      label
    );
    assertKey(ai.owner, MARGINFI_V2, `${label} owner`);
    const bank = coder.accounts.decode("Bank", Buffer.from(ai.data)) as any;
    assertKey(bank.mint as WPublicKey, expectedMint, `${label} mint`);
    assertKey(bank.group as WPublicKey, GROUP, `${label} group`);
    const oracleKeys = (bank.config.oracle_keys as WPublicKey[]).filter(
      (k) => !k.equals(web3.PublicKey.default)
    );
    if (oracleKeys.length === 0) fail(`${label} has no oracle`);
    const oracleAi = requireAccount(
      await accountWithRetry(connection, oracleKeys[0], `${label} oracle`),
      oracleKeys[0],
      `${label} oracle`
    );
    const px = parsePyth(Buffer.from(oracleAi.data));
    const maxAge = Number(bank.config.oracle_max_age.toString());
    const now = Math.floor(Date.now() / 1000);
    const age = now - Number(px.publish);
    if (age > maxAge) fail(`${label} oracle stale: age=${age}s max=${maxAge}s`);
    if (px.price <= 0n) fail(`${label} oracle price <= 0`);
    ok(
      `${label}: mint/group/oracle age=${age}s/${maxAge}s price=${px.price} expo=${px.expo}`
    );
  }

  // Fixed DLMM sell venue.
  const dlmm = await DLMM.create(connection, DLMM_POOL);
  const lb = dlmm.lbPair as any;
  assertKey(lb.tokenXMint as WPublicKey, PUMP_MINT, "DLMM tokenX");
  assertKey(lb.tokenYMint as WPublicKey, NATIVE_MINT, "DLMM tokenY");
  const rxAi = requireAccount(
    await accountWithRetry(
      connection,
      lb.reserveX as WPublicKey,
      "DLMM reserveX"
    ),
    lb.reserveX as WPublicKey,
    "DLMM reserveX"
  );
  const ryAi = requireAccount(
    await accountWithRetry(
      connection,
      lb.reserveY as WPublicKey,
      "DLMM reserveY"
    ),
    lb.reserveY as WPublicKey,
    "DLMM reserveY"
  );
  const rxAmount = Buffer.from(rxAi.data).readBigUInt64LE(64);
  const ryAmount = Buffer.from(ryAi.data).readBigUInt64LE(64);
  if (rxAmount === 0n || ryAmount === 0n) fail("DLMM reserve is empty");
  ok(`DLMM pool legs/reserves: X=${rxAmount} Y=${ryAmount}`);

  // Program account + ProgramData authority (may be absent before deploy).
  const programAi = await accountWithRetry(
    connection,
    PROGRAM_ID,
    "fee-short program"
  );
  const programDataKey = web3.PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBuffer()],
    BPF_LOADER
  )[0];
  let programDataRent = 0n;
  if (!programAi) {
    if (stage !== "predeploy")
      fail(`fee-short program missing at ${PROGRAM_ID.toBase58()}`);
    console.log(
      "warn - fee-short program not deployed yet (expected at predeploy)"
    );
  } else {
    assertKey(programAi.owner, BPF_LOADER, "fee-short program owner");
    if (!programAi.executable) fail("fee-short program is not executable");
    const pdAi = requireAccount(
      await accountWithRetry(
        connection,
        programDataKey,
        "fee-short ProgramData"
      ),
      programDataKey,
      "fee-short ProgramData"
    );
    assertKey(
      parseProgramDataAuthority(Buffer.from(pdAi.data)),
      payer.publicKey,
      "ProgramData upgrade authority"
    );
    ok(
      `fee-short program deployed; upgrade authority ${payer.publicKey.toBase58()}`
    );
  }

  // Vault PDA and canonical vault ATAs.
  const [state] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    PROGRAM_ID
  );
  const [vault] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), state.toBuffer()],
    PROGRAM_ID
  );
  const baseMintKey = argValue("--base-mint", "");
  let baseMint = baseMintKey ? new web3.PublicKey(baseMintKey) : null;
  const vaultWsol = ata(
    NATIVE_MINT,
    vault,
    new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
  );
  const vaultPump = ata(
    PUMP_MINT,
    vault,
    new web3.PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
  );
  ok(`state PDA ${state.toBase58()}`);
  ok(`vault PDA ${vault.toBase58()}`);
  ok(`vault wSOL ATA ${vaultWsol.toBase58()}`);
  ok(`vault PUMP ATA ${vaultPump.toBase58()}`);
  if (baseMint) ok(`vault base mint (supplied) ${baseMint.toBase58()}`);

  // State account checks, when it exists.
  const stateAi = await accountWithRetry(connection, state, "fee-short state");
  if (stateAi) {
    if (stateAi.data.length !== 8 + 483)
      fail(`state length ${stateAi.data.length} != 491`);
    const idl = JSON.parse(
      fs.readFileSync(
        path.join("target", "production", "fee_short.json"),
        "utf8"
      )
    ) as any;
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(payer),
      { commitment: "confirmed" }
    );
    const program = new anchor.Program(idl, provider);
    const st = await (program.account as any).feeShortState.fetch(state);
    assertKey(st.admin as WPublicKey, payer.publicKey, "state admin");
    assertKey(st.group as WPublicKey, GROUP, "state group");
    assertKey(st.solBank as WPublicKey, SOL_BANK, "state SOL bank");
    assertKey(st.pumpBank as WPublicKey, PUMP_BANK, "state PUMP bank");
    assertKey(st.vaultWsolAta as WPublicKey, vaultWsol, "state vault wSOL ATA");
    assertKey(st.vaultPumpAta as WPublicKey, vaultPump, "state vault PUMP ATA");
    assertKey(st.pumpPool as WPublicKey, DLMM_POOL, "state DLMM pool");
    if (!baseMint) baseMint = st.baseMint as WPublicKey;
    assertKey(st.baseMint as WPublicKey, baseMint, "state base mint");
    const vaultBase = ata(
      baseMint,
      vault,
      new web3.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    );
    assertKey(st.vaultBaseAta as WPublicKey, vaultBase, "state vault base ATA");
    ok(`state base mint ${baseMint.toBase58()}`);
    if (stage === "live" && st.paused) fail("state is paused");
    if (stage === "postinit" && st.paused) ok("state intentionally paused");
    ok(
      `state exists: paused=${st.paused} marginfi=${String(st.marginfiAccount)}`
    );
  } else {
    if (stage === "postinit" || stage === "live") fail("state account missing");
    console.log("warn - fee-short state not initialized yet");
  }

  // Wallet funding estimate for first deploy.
  const bal = BigInt(await connection.getBalance(payer.publicKey));
  const soPath = path.join("target", "production", "fee_short.so");
  if (!fs.existsSync(soPath)) fail(`missing ${soPath}`);
  const soSize = fs.statSync(soPath).size;
  const dataRent = BigInt(
    await connection.getMinimumBalanceForRentExemption(soSize + 45)
  );
  const bufferRent = dataRent;
  const otherCosts = programAi ? 100_000_000n : 500_000_000n;
  const requiredUpfront = programAi
    ? otherCosts
    : dataRent + bufferRent + otherCosts;
  console.log(
    `wallet balance=${bal} lamports (${Number(bal) / 1e9} SOL), ` +
      `programdata rent=${dataRent}, buffer rent=${bufferRent}, ` +
      `required upfront≈${requiredUpfront} lamports (${
        Number(requiredUpfront) / 1e9
      } SOL)`
  );
  if (bal < requiredUpfront) {
    fail(
      `wallet underfunded: have ${(Number(bal) / 1e9).toFixed(6)} SOL, ` +
        `need at least ${(Number(requiredUpfront) / 1e9).toFixed(6)} SOL; ` +
        `shortfall ${(Number(requiredUpfront - bal) / 1e9).toFixed(6)} SOL. ` +
        "Program buffer rent is temporary but must exist during deploy."
    );
  }
  ok("wallet has enough upfront lamports");

  // If state exists, also validate DBC config/pool and marginfi account.
  if (stateAi) {
    const idl = JSON.parse(
      fs.readFileSync(
        path.join("target", "production", "fee_short.json"),
        "utf8"
      )
    ) as any;
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(payer),
      {
        commitment: "confirmed",
      }
    );
    const program = new anchor.Program(idl, provider);
    const st = await (program.account as any).feeShortState.fetch(state);
    const dbcClient = new dbcSdk.DynamicBondingCurveClient(
      connection,
      "confirmed"
    );
    const rawPool = await dbcClient.state.getPool(st.dbcPool);
    const pool = rawPool.poolState ?? rawPool;
    assertKey(
      new web3.PublicKey(pool.config.toString()),
      st.dbcConfig,
      "DBC pool config"
    );
    assertKey(
      new web3.PublicKey(pool.baseMint.toString()),
      st.baseMint,
      "DBC pool base mint"
    );
    assertKey(
      new web3.PublicKey(pool.creator.toString()),
      vault,
      "DBC pool creator"
    );
    const rawCfg = await dbcClient.state.getPoolConfig(st.dbcConfig);
    const cfg = rawCfg.poolState ?? rawCfg;
    assertKey(
      new web3.PublicKey(cfg.quoteMint.toString()),
      NATIVE_MINT,
      "DBC config quote mint"
    );
    assertKey(
      new web3.PublicKey(cfg.feeClaimer.toString()),
      vault,
      "DBC config fee claimer"
    );
    assertKey(
      new web3.PublicKey(cfg.leftoverReceiver.toString()),
      vault,
      "DBC config leftover receiver"
    );
    ok("DBC config/pool bound to vault");

    const mf = st.marginfiAccount as WPublicKey;
    if (!mf.equals(web3.PublicKey.default)) {
      const mfAi = requireAccount(
        await accountWithRetry(connection, mf, "marginfi account"),
        mf,
        "marginfi account"
      );
      assertKey(mfAi.owner, MARGINFI_V2, "marginfi account owner");
      if (mfAi.data.length !== 2312)
        fail(`marginfi account length ${mfAi.data.length} != 2312`);
      ok(`marginfi account initialized ${mf.toBase58()}`);
    } else if (stage === "live") {
      fail("legacy state has no marginfi account");
    } else {
      console.log("warn - marginfi account not initialized yet");
    }

    if (stage === "live") {
      if (st.paused) fail("state is paused");
      if (!mf.equals(web3.PublicKey.default))
        ok("live state is unpaused with marginfi account");
    }
  }

  console.log("PREFLIGHT_OK");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
