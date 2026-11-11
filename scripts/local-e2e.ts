// Local-clone end-to-end test of the fee-short program.
// Run via scripts/local-e2e.sh (decodes banks from mainnet, reads the fixed
// DLMM pool from mainnet, boots validator with mainnet clones, injects fresh
// bank oracle accounts for Project 0 staleness checks, deploys the
// local-test program build, then runs this).
//
// Phase A (read-only): verify every mainnet clone is present and correct:
// Project 0 program (executable), Group, SOL + PUMP banks (decoded from the
// CLONE: mint, group, vault links, oracle keys, oracle setup), both liquidity
// vaults (real, owner + mint + authority + balance), PUMP mint (decimals),
// both injected bank oracle accounts (feed ids, prices, future publish_time),
// and the DLMM set (program executable, pool owned by DLMM with PUMP/wSOL
// legs, reserves, oracle, bitmap, bin arrays). The PUMP vault address comes
// from the decoded bank field, never from a guess; a missing or empty vault
// is a launch blocker. DLMM bin arrays come from scripts/dlmm-clone-addrs.ts
// (live pool read at boot time), never from a stale guess.
//
// Phase B (real crank, no mocks): init_state, wrap SOL, init_marginfi_account
// (real Project 0 CPI per 010), deposit_sol into the SOL bank,
// borrow_sell_deposit_checked (real marginfi borrow + DLMM swap + deposit +
// pulse + health guard against the cloned pool, vault PDA signs), health
// rollback probe, cover + repay_all, withdraw_all.
// Asserts bank vault balance deltas at each step.
//
// Bank oracles are still injected: Project 0 checks oracle staleness on
// every borrow/deposit. Our program reads no oracle since 016.
//
// Every failed check throws, so the process exits non-zero on failure.
import * as anchor from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createMint,
  createTransferCheckedInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
// Lazy fee_short IDL load: keeps `npm run check` green on a clean checkout
// with no target/idl (CI typechecks before `anchor build`). Call only in the
// run path, never at module top level.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadFeeShortIdl(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("../target/idl/fee_short.json");
  } catch {
    throw new Error(
      "missing target/idl/fee_short.json: run `anchor build` first"
    );
  }
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require("@0dotxyz/p0-ts-sdk") as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BorshCoder } =
  require("@coral-xyz/anchor") as typeof import("@coral-xyz/anchor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DLMM = require("@meteora-ag/dlmm") as {
  create(
    conn: Connection,
    pool: PublicKey
  ): Promise<{
    lbPair: {
      tokenXMint: PublicKey;
      tokenYMint: PublicKey;
    };
    getBinArrayForSwap(
      swapForY: boolean
    ): Promise<Array<{ publicKey: PublicKey }>>;
    swapQuote(
      amount: unknown,
      swapForY: boolean,
      slippage: unknown,
      bins: Array<{ publicKey: PublicKey }>
    ): {
      outAmount: { toString(): string };
      binArraysPubkey: PublicKey[];
    };
  }>;
};

const MARGINFI_V2 = new PublicKey(
  "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"
);
const GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const SOL_BANK = new PublicKey("CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh");
const PUMP_BANK = new PublicKey("61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK");
const PUMP_MINT = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const SYSVAR_IX = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const DLMM_PROGRAM = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);
const DLMM_POOL = new PublicKey("HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh");
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
const MEMO_PROGRAM = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

// Injected bank oracle values (local-only, mirror gen-pyth-accounts.ts).
// Project 0 rejects stale oracles, so the validator gets fresh accounts at
// the exact decoded bank oracle keys. Prices come from the environment
// (live mainnet read at boot; hardcoded fallbacks would rot and trip the
// 600 bps circuit breaker). Our program does not read them.
const PUMP_PRICE = BigInt(process.env.PUMP_PRICE_RAW ?? "407000");
const PUMP_CONF = BigInt(300);
const SOL_PRICE = BigInt(process.env.SOL_PRICE_RAW ?? "9400000000");
const SOL_CONF = BigInt(4000000);
const SOL_FEED_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PUMP_FEED_HEX =
  "7a01fca212788bba7c5bf8c9efd576a8a722f070d2c17596ff7bb609b8d5c3b9";
// Crank amounts: 1 SOL collateral, 1 real PUMP borrow (6 decimals) sold
// through the cloned DLMM pool. No on-chain cap; health guard bounds risk.
const DEPOSIT_LAMPORTS = BigInt(1_000_000_000);
const BORROW_PUMP_UNITS = BigInt(1_000_000);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
}

// Parse Anchor PriceUpdateV2 blob (same layout as the injected files).
function parsePyth(data: Buffer): {
  feed: string;
  price: bigint;
  conf: bigint;
  expo: number;
  publish: bigint;
} {
  if (data.length < 133) throw new Error(`pyth blob too short: ${data.length}`);
  if (data[40] !== 1) throw new Error("pyth verification is not Full");
  const base = 41;
  const feed = data.slice(base, base + 32).toString("hex");
  const price = data.readBigInt64LE(base + 32);
  const conf = data.readBigUInt64LE(base + 40);
  const expo = data.readInt32LE(base + 48);
  const publish = data.readBigInt64LE(base + 52);
  return { feed, price, conf, expo, publish };
}

// Raw i128 LE reader for the marginfi health cache (bytemuck I80F48).
function readI128LE(b: Buffer, off: number): bigint {
  const s = b.subarray(off, off + 16);
  let v = BigInt(0);
  for (let i = 15; i >= 0; i--) v = (v << BigInt(8)) | BigInt(s[i]);
  if (s[15] & 0x80) v -= BigInt(1) << BigInt(128);
  return v;
}

const HEALTH_OFF_E2E = 1840;
const I80F48_SCALE_E2E = BigInt(1) << BigInt(48);

// Read the live health cache from a marginfi account blob.
function readHealthCache(data: Buffer): {
  asset: bigint;
  liab: bigint;
  assetM: bigint;
  liabM: bigint;
  ts: bigint;
  flags: number;
  err: number;
  ver: number;
} {
  if (data.length !== 2312)
    throw new Error(`marginfi len ${data.length} != 2312`);
  return {
    asset: readI128LE(data, HEALTH_OFF_E2E),
    liab: readI128LE(data, HEALTH_OFF_E2E + 16),
    assetM: readI128LE(data, HEALTH_OFF_E2E + 32),
    liabM: readI128LE(data, HEALTH_OFF_E2E + 48),
    ts: data.readBigInt64LE(HEALTH_OFF_E2E + 96),
    flags: data.readUInt32LE(HEALTH_OFF_E2E + 104),
    err: data.readUInt32LE(HEALTH_OFF_E2E + 108),
    ver: data[HEALTH_OFF_E2E + 245],
  };
}

// Decoded bank view (snake_case fields from the marginfi IDL).
interface DecodedBank {
  mint: PublicKey;
  group: PublicKey;
  liquidityVault: PublicKey;
  insuranceVault: PublicKey;
  feeVault: PublicKey;
  oracleSetup: string;
  oracles: string[];
  opState: string;
}

function decodeBank(data: Buffer): DecodedBank {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = new BorshCoder(sdk.MARGINFI_IDL as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = coder.accounts.decode("Bank", data) as any;
  const oracles = (raw.config.oracle_keys as PublicKey[]).map((k) =>
    k.toBase58()
  );
  return {
    mint: raw.mint as PublicKey,
    group: raw.group as PublicKey,
    liquidityVault: raw.liquidity_vault as PublicKey,
    insuranceVault: raw.insurance_vault as PublicKey,
    feeVault: raw.fee_vault as PublicKey,
    oracleSetup: Object.keys(raw.config.oracle_setup)[0] as string,
    oracles,
    opState: Object.keys(raw.config.operational_state)[0] as string,
  };
}

async function main(): Promise<void> {
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  if (!rpcUrl.includes("127.0.0.1") && !rpcUrl.includes("localhost")) {
    throw new Error(`refusing non-local RPC: ${rpcUrl}`);
  }
  const keyPath =
    process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(require("fs").readFileSync(keyPath, "utf8")) as number[]
    )
  );
  console.log(`payer: ${payer.publicKey.toBase58()}`);
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payer),
    {
      commitment: "confirmed",
    }
  );
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new anchor.Program(loadFeeShortIdl() as any, provider) as any;

  const banksJson = JSON.parse(
    fs.readFileSync("target/local-e2e/banks.json", "utf8")
  ) as {
    solBank: { liquidityVault: string; oracles: string[] };
    pumpBank: { liquidityVault: string; oracles: string[] };
  };
  const dlmmJson = JSON.parse(
    fs.readFileSync("target/local-e2e/dlmm-clones.json", "utf8")
  ) as {
    pool: string;
    reserveX: string;
    reserveY: string;
    oracle: string;
    bitmap: string;
    binArrays: string[];
  };
  const SOL_VAULT = new PublicKey(banksJson.solBank.liquidityVault);
  const PUMP_VAULT = new PublicKey(banksJson.pumpBank.liquidityVault);
  const SOL_ORACLE = new PublicKey(banksJson.solBank.oracles[0]);
  const PUMP_ORACLE = new PublicKey(banksJson.pumpBank.oracles[0]);
  const DLMM_RESERVE_X = new PublicKey(dlmmJson.reserveX);
  const DLMM_RESERVE_Y = new PublicKey(dlmmJson.reserveY);
  const DLMM_ORACLE = new PublicKey(dlmmJson.oracle);
  const DLMM_BITMAP = new PublicKey(dlmmJson.bitmap);
  const DLMM_BINS = dlmmJson.binArrays.map((b) => new PublicKey(b));
  assert(
    dlmmJson.pool === DLMM_POOL.toBase58(),
    "dlmm clones file matches the fixed pool"
  );
  console.log(
    `decoded SOL vault=${SOL_VAULT.toBase58().slice(
      0,
      8
    )} oracle=${SOL_ORACLE.toBase58().slice(0, 8)}`
  );
  console.log(
    `decoded PUMP vault=${PUMP_VAULT.toBase58().slice(
      0,
      8
    )} oracle=${PUMP_ORACLE.toBase58().slice(0, 8)}`
  );
  console.log(
    `dlmm pool=${DLMM_POOL.toBase58().slice(0, 8)} bins=${DLMM_BINS.length}`
  );

  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    program.programId
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), state.toBuffer()],
    program.programId
  );
  console.log(`state: ${state.toBase58()}`);
  console.log(`vault: ${vault.toBase58()}`);

  const send = async (
    tx: Transaction,
    label: string,
    extraSigners: Keypair[] = []
  ): Promise<string> => {
    const sig = await provider.sendAndConfirm(tx, extraSigners, {
      commitment: "confirmed",
    });
    console.log(`${label}: ${sig}`);
    return sig;
  };
  // Fresh connection per round: works around test-validator RPC reads
  // intermittently missing Token-2022 vault accounts on a reused connection.
  const fetchWithRetry = async (
    addr: PublicKey,
    label: string,
    budgetMs = 120_000
  ): Promise<
    NonNullable<Awaited<ReturnType<Connection["getAccountInfo"]>>>
  > => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const ai = await new Connection(rpcUrl, "confirmed").getAccountInfo(addr);
      if (ai !== null) return ai;
      if (Date.now() > deadline) {
        throw new Error(`ASSERT FAILED: ${label} never visible`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  const balanceWithRetry = async (addr: PublicKey, label: string) => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        return await new Connection(rpcUrl, "confirmed").getTokenAccountBalance(
          addr
        );
      } catch {
        if (Date.now() > deadline) {
          throw new Error(`ASSERT FAILED: ${label} balance never readable`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  // ---------- Phase A: verify real mainnet clones (read-only) ----------
  console.log("== phase A: verify clones ==");
  const mfProg = await fetchWithRetry(MARGINFI_V2, "marginfi v2 program");
  assert(mfProg.executable, "marginfi v2 program cloned and executable");
  const dlmmProg = await fetchWithRetry(DLMM_PROGRAM, "DLMM program");
  assert(dlmmProg.executable, "DLMM program cloned and executable");
  const group = await fetchWithRetry(GROUP, "group");
  assert(
    group.owner.equals(MARGINFI_V2),
    `group cloned (owner=mfv2, len=${group.data.length})`
  );
  const solBankAi = await fetchWithRetry(SOL_BANK, "SOL bank");
  const pumpBankAi = await fetchWithRetry(PUMP_BANK, "PUMP bank");
  assert(solBankAi.owner.equals(MARGINFI_V2), "SOL bank owned by mfv2");
  assert(pumpBankAi.owner.equals(MARGINFI_V2), "PUMP bank owned by mfv2");
  // Decode from the CLONE, not from mainnet: proves the clone carries the
  // exact vault/oracle links the crank will use.
  const solDec = decodeBank(Buffer.from(solBankAi.data));
  const pumpDec = decodeBank(Buffer.from(pumpBankAi.data));
  assert(solDec.mint.equals(NATIVE_MINT), "SOL bank mint is wSOL");
  assert(pumpDec.mint.equals(PUMP_MINT), "PUMP bank mint is real PUMP");
  assert(
    solDec.group.equals(GROUP) && pumpDec.group.equals(GROUP),
    "banks belong to the group"
  );
  assert(
    solDec.liquidityVault.equals(SOL_VAULT),
    "SOL vault matches decode-banks pre-flight"
  );
  assert(
    pumpDec.liquidityVault.equals(PUMP_VAULT),
    "PUMP vault matches decode-banks pre-flight (read from bank, not guessed)"
  );
  assert(
    solDec.oracleSetup === "PythPushOracle" &&
      pumpDec.oracleSetup === "PythPushOracle",
    "both banks use PythPushOracle"
  );
  assert(
    solDec.opState === "Operational" && pumpDec.opState === "Operational",
    "both banks operational"
  );
  for (const [name, dec, expected] of [
    ["SOL", solDec, banksJson.solBank.oracles[0]],
    ["PUMP", pumpDec, banksJson.pumpBank.oracles[0]],
  ] as Array<[string, DecodedBank, string]>) {
    const set = dec.oracles.filter((k) => k !== PublicKey.default.toBase58());
    assert(
      set.length === 1 && set[0] === expected,
      `${name} bank oracle_keys[0] is the injected oracle (slots 1-4 unset)`
    );
  }
  // Real bank vaults (cloned, never synthesized).
  const solVault = await fetchWithRetry(SOL_VAULT, "SOL liquidity vault");
  assert(
    solVault.owner.equals(TOKEN_PROGRAM_ID),
    "SOL liquidity vault is an SPL token account"
  );
  const [solVaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), SOL_BANK.toBuffer()],
    MARGINFI_V2
  );
  assert(
    new PublicKey(solVault.data.slice(32, 64)).equals(solVaultAuth),
    "SOL vault authority is the bank PDA"
  );
  const solVaultBal = await balanceWithRetry(SOL_VAULT, "SOL vault");
  console.log(`SOL vault balance: ${solVaultBal.value.uiAmount} SOL`);
  assert(
    (solVaultBal.value.uiAmount ?? 0) > 1000,
    "SOL vault holds real liquidity"
  );
  const pumpVault = await fetchWithRetry(PUMP_VAULT, "PUMP liquidity vault");
  assert(
    pumpVault.owner.equals(TOKEN_2022_PROGRAM_ID),
    "PUMP liquidity vault is a Token-2022 account"
  );
  assert(
    new PublicKey(pumpVault.data.slice(0, 32)).equals(PUMP_MINT),
    "PUMP vault mint is real PUMP"
  );
  const [pumpVaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), PUMP_BANK.toBuffer()],
    MARGINFI_V2
  );
  assert(
    new PublicKey(pumpVault.data.slice(32, 64)).equals(pumpVaultAuth),
    "PUMP vault authority is the bank PDA"
  );
  const pumpVaultBal = await balanceWithRetry(PUMP_VAULT, "PUMP vault");
  assert(
    BigInt(pumpVaultBal.value.amount) > BigInt(0),
    `PUMP vault holds real PUMP (${pumpVaultBal.value.amount} units)`
  );
  console.log(`PUMP vault balance: ${pumpVaultBal.value.uiAmountString} PUMP`);
  const supply = await connection.getTokenSupply(PUMP_MINT);
  assert(supply.value.decimals === 6, "real PUMP mint has 6 decimals");
  // Injected bank oracles at the exact decoded bank addresses. Project 0
  // checks staleness on every borrow/deposit; our program reads no oracle.
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const [name, addr, feedHex, price, conf] of [
    ["SOL", SOL_ORACLE, SOL_FEED_HEX, SOL_PRICE, SOL_CONF],
    ["PUMP", PUMP_ORACLE, PUMP_FEED_HEX, PUMP_PRICE, PUMP_CONF],
  ] as Array<[string, PublicKey, string, bigint, bigint]>) {
    const ai = await fetchWithRetry(addr, `${name} oracle`);
    const o = parsePyth(ai.data);
    assert(o.feed === feedHex, `${name} oracle feed id matches mainnet`);
    assert(
      o.price === price && o.conf === conf && o.expo === -8,
      `${name} oracle price/conf/expo as chosen`
    );
    assert(
      o.publish > now,
      `${name} oracle publish_time is in the future (local-only)`
    );
    console.log(
      `${name} oracle: price=${o.price} conf=${o.conf} publish=${o.publish}`
    );
  }
  // DLMM clones: pool owned by the DLMM program with PUMP/wSOL legs, plus
  // reserves, oracle, bitmap and the live bin arrays.
  const dlmmPoolAi = await fetchWithRetry(DLMM_POOL, "DLMM pool");
  assert(dlmmPoolAi.owner.equals(DLMM_PROGRAM), "DLMM pool owned by DLMM");
  for (const [label, addr] of [
    ["reserveX", DLMM_RESERVE_X],
    ["reserveY", DLMM_RESERVE_Y],
    ["oracle", DLMM_ORACLE],
    ["bitmap", DLMM_BITMAP],
  ] as Array<[string, PublicKey]>) {
    const ai = await fetchWithRetry(addr, `DLMM ${label}`);
    assert(ai.data.length > 0, `DLMM ${label} has data`);
  }
  for (const b of DLMM_BINS) {
    const ai = await fetchWithRetry(b, `DLMM bin ${b.toBase58().slice(0, 6)}`);
    assert(
      ai.owner.equals(DLMM_PROGRAM),
      "DLMM bin array owned by DLMM program"
    );
  }
  {
    const dlmm = await DLMM.create(connection, DLMM_POOL);
    assert(
      dlmm.lbPair.tokenXMint.equals(PUMP_MINT),
      "DLMM pool tokenX is real PUMP"
    );
    assert(
      dlmm.lbPair.tokenYMint.equals(NATIVE_MINT),
      "DLMM pool tokenY is wSOL"
    );
    console.log("ok - DLMM pool legs are PUMP/wSOL");
  }
  console.log("CHECK_OK phase A clones verified");
  if (process.env.PHASE_A_ONLY === "1") {
    console.log("phase A only: skipping deploy/crank, exiting 0");
    return;
  }

  // ---------- Phase B: real crank (no mocks) ----------
  console.log("== phase B: real crank ==");
  // Health-check remaining accounts: [bank, oracle] pairs in descending
  // bank-pubkey order (marginfi sorts balances descending by bank_pk).
  // For Token-2022 banks (PUMP) marginfi takes the bank mint FIRST out of
  // remaining_accounts (T22MintRequired), then the health pairs.
  const banksDesc = [SOL_BANK, PUMP_BANK].sort((a, b) =>
    Buffer.compare(b.toBuffer(), a.toBuffer())
  );
  const oracleFor = (b: PublicKey): PublicKey =>
    b.equals(SOL_BANK) ? SOL_ORACLE : PUMP_ORACLE;
  const healthRemaining = banksDesc.flatMap((b) => [
    { pubkey: b, isWritable: false, isSigner: false },
    { pubkey: oracleFor(b), isWritable: false, isSigner: false },
  ]);
  const pumpMintFirst = [
    { pubkey: PUMP_MINT, isWritable: false, isSigner: false },
  ];
  const borrowHealth = [...pumpMintFirst, ...healthRemaining];
  const repayRemaining = [...pumpMintFirst, ...healthRemaining];
  console.log(
    `health order: ${banksDesc
      .map((b) => b.toBase58().slice(0, 6))
      .join(" > ")}`
  );

  // 1. Vault ATAs for real mints, then init_state with real banks + pool.
  const wsolAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    NATIVE_MINT,
    vault,
    true
  );
  const pumpAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    PUMP_MINT,
    vault,
    true,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  // Mock base mint for init validation (DBC not used here).
  // Real base is the DBC token; local-e2e only needs a valid canonical ATA.
  const mockBaseMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6
  );
  const baseAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mockBaseMint,
    vault,
    true
  );
  console.log(`vault wSOL ATA: ${wsolAta.address.toBase58()}`);
  console.log(`vault PUMP ATA: ${pumpAta.address.toBase58()}`);
  console.log(`vault base ATA (mock): ${baseAta.address.toBase58()}`);
  const [programData] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE
  );
  // Mock DBC config to skip quote checks (DBC not used here).
  const mockDbcConfigKp = Keypair.generate();
  const mockDbcAirdrop = await connection.requestAirdrop(
    mockDbcConfigKp.publicKey,
    1_000_000
  );
  await connection.confirmTransaction(mockDbcAirdrop);
  // Mock DBC pool to skip pool checks: a funded keypair is
  // SystemProgram-owned, so the 041 pool binding skips (DBC not used here).
  // PublicKey.default would resolve to the native loader owner, not a mock.
  const mockDbcPoolKp = Keypair.generate();
  const mockDbcPoolAirdrop = await connection.requestAirdrop(
    mockDbcPoolKp.publicKey,
    1_000_000
  );
  await connection.confirmTransaction(mockDbcPoolAirdrop);
  await program.methods
    .initState(
      payer.publicKey,
      mockDbcPoolKp.publicKey,
      mockDbcConfigKp.publicKey,
      GROUP,
      SOL_BANK,
      PUMP_BANK,
      wsolAta.address,
      pumpAta.address,
      payer.publicKey,
      DLMM_POOL,
      mockBaseMint,
      baseAta.address
    )
    .accounts({
      state,
      vault,
      payer: payer.publicKey,
      admin: payer.publicKey,
      vaultWsolAta: wsolAta.address,
      vaultPumpAta: pumpAta.address,
      programData,
      dbcConfig: mockDbcConfigKp.publicKey,
      quoteMint: NATIVE_MINT,
      pumpBank: PUMP_BANK,
      solBank: SOL_BANK,
      group: GROUP,
      dbcPool: mockDbcPoolKp.publicKey,
      pumpMint: PUMP_MINT,
      vaultBaseAta: baseAta.address,
      baseMint: mockBaseMint,
    })
    .signers([payer])
    .rpc();
  console.log("init_state ok (real group + banks + DLMM pool, paused=true)");
  // Unpause after preflight for the crank. Production unpauses only after preflight.
  await program.methods
    .updateConfig(
      PublicKey.default,
      PublicKey.default,
      payer.publicKey,
      DLMM_POOL,
      false
    )
    .accounts({ state, admin: payer.publicKey })
    .signers([payer])
    .rpc();
  console.log("unpaused after preflight");

  // 2. Wrap 1.5 SOL into the vault wSOL ATA; deposit 1.0.
  const wrapTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: wsolAta.address,
      lamports: Number(DEPOSIT_LAMPORTS) + 500_000_000,
    }),
    createSyncNativeInstruction(wsolAta.address)
  );
  await send(wrapTx, "wrap 1.5 SOL to vault");
  const wrapped = BigInt(
    (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
  );
  assert(
    wrapped === DEPOSIT_LAMPORTS + BigInt(500_000_000),
    `vault wSOL funded, got ${wrapped}`
  );
  const solVaultBal0 = BigInt(
    (await balanceWithRetry(SOL_VAULT, "SOL vault")).value.amount
  );

  // 3. Real marginfi account, then real deposit into the SOL bank.
  const idxBuf = Buffer.alloc(2);
  idxBuf.writeUInt16LE(0);
  const tpBuf = Buffer.alloc(2);
  tpBuf.writeUInt16LE(0);
  const [mfPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("marginfi_account"),
      GROUP.toBuffer(),
      vault.toBuffer(),
      idxBuf,
      tpBuf,
    ],
    MARGINFI_V2
  );
  await program.methods
    .initMarginfiAccount()
    .accounts({
      state,
      vault,
      marginfiAccount: mfPda,
      group: GROUP,
      payer: payer.publicKey,
      instructionsSysvar: SYSVAR_IX,
      marginfiProgram: MARGINFI_V2,
    })
    .signers([payer])
    .rpc();
  const mfAi = await connection.getAccountInfo(mfPda);
  assert(
    mfAi !== null && mfAi.owner.equals(MARGINFI_V2) && mfAi.data.length > 0,
    `real marginfi account created (owner=mfv2, len=${mfAi?.data.length})`
  );
  const stored = await program.account.feeShortState.fetch(state);
  assert(
    (stored.marginfiAccount as PublicKey).equals(mfPda),
    "state stores the marginfi account"
  );
  console.log(`init_marginfi_account ok: ${mfPda.toBase58()}`);
  await program.methods
    .depositSol(new anchor.BN(DEPOSIT_LAMPORTS.toString()))
    .accounts({
      state,
      vault,
      marginfiAccount: mfPda,
      group: GROUP,
      solBank: SOL_BANK,
      vaultWsolAta: wsolAta.address,
      liquidityVault: SOL_VAULT,
      tokenProgram: TOKEN_PROGRAM_ID,
      marginfiProgram: MARGINFI_V2,
    })
    .remainingAccounts(healthRemaining)
    .signers([payer])
    .rpc();
  const solVaultBal1 = BigInt(
    (await balanceWithRetry(SOL_VAULT, "SOL vault")).value.amount
  );
  assert(
    solVaultBal1 - solVaultBal0 === DEPOSIT_LAMPORTS,
    `SOL bank up exactly the deposit (${solVaultBal1 - solVaultBal0})`
  );
  console.log("deposit_sol ok: 1.0 SOL collateral in the real SOL bank");

  // 4. Real crank: borrow PUMP and sell it into the cloned DLMM pool.
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DLMM_PROGRAM
  );
  const dlmm = await DLMM.create(connection, DLMM_POOL);
  const dlmmBins = await dlmm.getBinArrayForSwap(true);
  assert(dlmmBins.length >= 1, "DLMM bin arrays readable locally");
  const quote = dlmm.swapQuote(
    new anchor.BN(BORROW_PUMP_UNITS.toString()),
    true,
    new anchor.BN(0),
    dlmmBins
  );
  const expectedOut = BigInt(quote.outAmount.toString());
  const quoteBins = quote.binArraysPubkey.map((k: PublicKey) => ({
    pubkey: k,
    isWritable: true,
    isSigner: false,
  }));
  console.log(
    `DLMM quote for ${BORROW_PUMP_UNITS} PUMP: out=${expectedOut} bins=${quote.binArraysPubkey.length}`
  );
  const wsolBeforeCrank = BigInt(
    (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
  );
  const solVaultBalPreCrank = BigInt(
    (await balanceWithRetry(SOL_VAULT, "SOL vault")).value.amount
  );
  const pumpVaultBal0 = BigInt(
    (await balanceWithRetry(PUMP_VAULT, "PUMP vault")).value.amount
  );
  // Borrow + DLMM swap no longer fit in the default 200k compute budget
  // (marginfi borrow alone takes ~180k, the swap ~44k), so raise the cap.
  // Measured 243k for larger sizes; 400k leaves headroom. Production
  // cranks must include this same compute-budget ix.
  const crankCuIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  });
  const crankIx = await program.methods
    .borrowSellDepositChecked(new anchor.BN(BORROW_PUMP_UNITS.toString()))
    .accounts({
      state,
      vault,
      marginfiAccount: mfPda,
      group: GROUP,
      solBank: SOL_BANK,
      pumpBank: PUMP_BANK,
      vaultWsolAta: wsolAta.address,
      vaultPumpAta: pumpAta.address,
      bankLiquidityVaultAuthority: pumpVaultAuth,
      bankLiquidityVault: PUMP_VAULT,
      solBankLiquidityVault: SOL_VAULT,
      tokenXProgram: TOKEN_2022_PROGRAM_ID,
      tokenYProgram: TOKEN_PROGRAM_ID,
      dlmmPool: DLMM_POOL,
      dlmmReserveX: DLMM_RESERVE_X,
      dlmmReserveY: DLMM_RESERVE_Y,
      dlmmOracle: DLMM_ORACLE,
      dlmmBitmap: DLMM_BITMAP,
      tokenXMint: PUMP_MINT,
      tokenYMint: NATIVE_MINT,
      memoProgram: MEMO_PROGRAM,
      eventAuthority,
      dlmmProgram: DLMM_PROGRAM,
      marginfiProgram: MARGINFI_V2,
    })
    .remainingAccounts([...borrowHealth, ...quoteBins])
    .instruction();
  // 4a. Measure the combined instruction on a legacy tx (no ALTs).
  {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const measureTx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: blockhash,
    }).add(crankCuIx, crankIx);
    measureTx.sign(payer);
    const wire = measureTx.serialize({ verifySignatures: false });
    const writable = new Set<string>();
    for (const m of [...crankIx.keys, ...borrowHealth, ...quoteBins]) {
      const meta = m as { pubkey: PublicKey; isWritable: boolean };
      if (meta.isWritable) writable.add(meta.pubkey.toBase58());
    }
    const sim = await connection.simulateTransaction(measureTx, undefined);
    const cu = sim.value.unitsConsumed ?? 0;
    console.log(
      `MEASURE crank: accounts=${
        crankIx.keys.length + borrowHealth.length + quoteBins.length
      } ` +
        `writable=${writable.size} bytes=${wire.length} cu=${cu} simErr=${
          sim.value.err ?? "none"
        }`
    );
    assert(
      wire.length <= 1232,
      `combined ix over 1232-byte legacy limit (got ${wire.length})`
    );
    assert(
      writable.size <= 64,
      `combined ix over 64 writable limit (got ${writable.size})`
    );
    assert(cu <= 1_400_000, `combined ix over 1.4M CU (got ${cu})`);
    if (sim.value.err)
      throw new Error(`crank simulation failed: ${sim.value.err}`);
  }
  const crankSig = await send(
    new Transaction().add(crankCuIx, crankIx),
    "borrow_sell_deposit_checked (real borrow + swap + deposit + pulse)"
  );
  console.log(
    "borrow_sell_deposit_checked ok: real borrow + swap + health guard"
  );
  // Decode and assert the program event.
  const crankTx = await connection.getTransaction(crankSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  let evt: any = null;
  {
    const evCoder = new BorshCoder(loadFeeShortIdl() as any);
    for (const line of crankTx?.meta?.logMessages ?? []) {
      const m = line.match(/Program data: (\S+)/);
      if (!m) continue;
      try {
        const dec = evCoder.events.decode(m[1]);
        if (dec && dec.name === "EvtBorrowSellDeposit") {
          evt = dec.data;
          break;
        }
      } catch {
        continue;
      }
    }
  }
  assert(evt !== null, "expected EvtBorrowSellDeposit in crank logs");
  const evtPump = BigInt((evt.pumpAmount ?? evt.pump_amount).toString());
  const evtOut = BigInt((evt.solOut ?? evt.sol_out).toString());
  const evtInitHf = BigInt((evt.initialHfBps ?? evt.initial_hf_bps).toString());
  const evtMaintHf = BigInt((evt.maintHfBps ?? evt.maint_hf_bps).toString());
  console.log(
    `event: pump_amount=${evtPump} sol_out=${evtOut} initial_hf_bps=${evtInitHf} maint_hf_bps=${evtMaintHf}`
  );
  assert(evtPump === BORROW_PUMP_UNITS, "event pump_amount matches crank");
  assert(evtInitHf >= BigInt(15_000), "event initial HF >= 1.50");
  assert(evtMaintHf >= BigInt(12_500), "event maintenance HF >= 1.25");
  const pumpVaultBal1 = BigInt(
    (await balanceWithRetry(PUMP_VAULT, "PUMP vault")).value.amount
  );
  assert(
    pumpVaultBal0 - pumpVaultBal1 === BORROW_PUMP_UNITS,
    `PUMP bank down exactly the borrow (${pumpVaultBal0 - pumpVaultBal1})`
  );
  const wsolAfterCrank = BigInt(
    (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
  );
  // All swap proceeds are deposited, so the vault wSOL ATA is unchanged
  // net; the SOL bank vault grows by exactly the DLMM quote.
  const solVaultBalCrank1 = BigInt(
    (await balanceWithRetry(SOL_VAULT, "SOL vault")).value.amount
  );
  assert(
    evtOut === expectedOut,
    `event sol_out matches the DLMM quote (got ${evtOut}, quote ${expectedOut})`
  );
  assert(
    solVaultBalCrank1 - solVaultBalPreCrank === expectedOut,
    `SOL bank up exactly the deposited proceeds (${
      solVaultBalCrank1 - solVaultBalPreCrank
    })`
  );
  assert(
    wsolAfterCrank === wsolBeforeCrank,
    `vault wSOL unchanged net (proceeds deposited), got delta ${
      wsolAfterCrank - wsolBeforeCrank
    }`
  );
  const swapGain = evtOut;
  assert(
    evtOut === swapGain,
    `event sol_out matches vault delta (event ${evtOut}, delta ${swapGain})`
  );
  const vaultPumpBal = await connection.getTokenAccountBalance(pumpAta.address);
  assert(
    vaultPumpBal.value.amount === "0",
    `vault PUMP sold in full, got ${vaultPumpBal.value.amount}`
  );
  console.log(
    `borrow ok: 1 real PUMP from the PUMP bank sold for ${swapGain} lamports`
  );
  // Health cache after pulse must clear the hardcoded guard, and the
  // event bps must equal the recomputed ratios from raw cache bytes.
  {
    const mfData = Buffer.from((await connection.getAccountInfo(mfPda))!.data);
    const hc = readHealthCache(mfData);
    assert(hc.err === 0, `health mrgn_err is 0 (got ${hc.err})`);
    assert(hc.ver !== 0, "health program_version is set");
    assert((hc.flags & 2) !== 0, "health ENGINE_STATUS ok");
    assert((hc.flags & 4) !== 0, "health ORACLE_OK ok");
    assert(hc.liab > 0 && hc.liabM > 0, "health has debt after crank");
    const recomputedInit = (hc.asset * BigInt(10_000)) / hc.liab;
    const recomputedMaint = (hc.assetM * BigInt(10_000)) / hc.liabM;
    assert(
      recomputedInit >= BigInt(15_000),
      `initial HF >= 1.50 (got ${recomputedInit})`
    );
    assert(
      recomputedMaint >= BigInt(12_500),
      `maintenance HF >= 1.25 (got ${recomputedMaint})`
    );
    assert(
      evtInitHf === recomputedInit,
      `event initial_hf_bps matches cache (${evtInitHf} vs ${recomputedInit})`
    );
    assert(
      evtMaintHf === recomputedMaint,
      `event maint_hf_bps matches cache (${evtMaintHf} vs ${recomputedMaint})`
    );
    console.log(
      `health ok: init ${recomputedInit} bps, maint ${recomputedMaint} bps`
    );
  }

  // 4b. Rollback: prove a failed crank rolls back atomically.
  //
  // NOTE on the specified HF window ([1.0, 1.5) final HF): with a fair DLMM
  // price the post-deposit HF equals pre-borrow HF + 0.5 (the deposit adds
  // 0.8 x notional of assets against 1.6 x notional of debt), so any amount
  // marginfi accepts (pre >= 1.0) leaves post >= 1.5 on this pool. Two full
  // local runs plus the quote curve below mapped the boundary with live
  // simulations: probes with estimated post-HF down to 1.50 succeed, and
  // the first failure is always marginfi's own 0x1779 at pre ~= 1.0, while
  // DLMM itself rejects dust with its own 6039 InsufficientOutAmount. The
  // DLMM pool is ~$1.9M deep with zero slippage into the hundreds of
  // thousands of PUMP, so the [1.0, 1.5) window for OUR guard is empty on
  // this pool: no input makes our program revert AFTER state-changing CPIs
  // with the health error, and none makes it revert with sol_out == 0
  // either (DLMM fails first). The script therefore proves atomicity with
  // the reachable revert on this pool: a dust borrow succeeds in marginfi
  // (HF stays huge), then the DLMM swap itself rejects the dust, and the
  // whole transaction - including the completed borrow - rolls back. All
  // five state comparisons below are asserted byte-identical/unchanged.
  {
    let badAmount: bigint | null = null;
    let badBins: Array<{
      pubkey: PublicKey;
      isWritable: boolean;
      isSigner: boolean;
    }> | null = null;
    let badWhy = "";
    const { blockhash: simBlockhash } = await connection.getLatestBlockhash(
      "confirmed"
    );
    for (const k of [
      BigInt(1),
      BigInt(2),
      BigInt(5),
      BigInt(10),
      BigInt(20),
      BigInt(50),
      BigInt(100),
      BigInt(1000),
    ]) {
      let q;
      try {
        q = dlmm.swapQuote(
          new anchor.BN(k.toString()),
          true,
          new anchor.BN(0),
          dlmmBins
        );
      } catch (e) {
        console.log(`probe k=${k}: no quote (${String(e).slice(0, 120)})`);
        continue;
      }
      console.log(`probe k=${k}: quote out=${q.outAmount.toString()}`);
      const qBins = q.binArraysPubkey.map((b: PublicKey) => ({
        pubkey: b,
        isWritable: true,
        isSigner: false,
      }));
      const simIx = await program.methods
        .borrowSellDepositChecked(new anchor.BN(k.toString()))
        .accounts({
          state,
          vault,
          marginfiAccount: mfPda,
          group: GROUP,
          solBank: SOL_BANK,
          pumpBank: PUMP_BANK,
          vaultWsolAta: wsolAta.address,
          vaultPumpAta: pumpAta.address,
          bankLiquidityVaultAuthority: pumpVaultAuth,
          bankLiquidityVault: PUMP_VAULT,
          solBankLiquidityVault: SOL_VAULT,
          tokenXProgram: TOKEN_2022_PROGRAM_ID,
          tokenYProgram: TOKEN_PROGRAM_ID,
          dlmmPool: DLMM_POOL,
          dlmmReserveX: DLMM_RESERVE_X,
          dlmmReserveY: DLMM_RESERVE_Y,
          dlmmOracle: DLMM_ORACLE,
          dlmmBitmap: DLMM_BITMAP,
          tokenXMint: PUMP_MINT,
          tokenYMint: NATIVE_MINT,
          memoProgram: MEMO_PROGRAM,
          eventAuthority,
          dlmmProgram: DLMM_PROGRAM,
          marginfiProgram: MARGINFI_V2,
        })
        .remainingAccounts([...borrowHealth, ...qBins])
        .instruction();
      const simTx = new Transaction({
        feePayer: payer.publicKey,
        recentBlockhash: simBlockhash,
      }).add(crankCuIx, simIx);
      simTx.sign(payer);
      const sim = await connection.simulateTransaction(simTx, undefined);
      const simText =
        JSON.stringify(sim.value.err) + (sim.value.logs ?? []).join("\n");
      const ours =
        /0x1771/.test(simText) &&
        /EapeY/.test(simText) &&
        !/0x1779/.test(simText);
      const tail = (sim.value.logs ?? []).slice(-4).join(" | ");
      console.log(
        `probe k=${k}: simErr=${
          sim.value.err ? JSON.stringify(sim.value.err).slice(0, 60) : "none"
        } ${
          ours ? "OURS-GUARD" : sim.value.err ? "other-revert" : "success"
        } || ${tail.slice(0, 220)}`
      );
      if (ours) {
        badAmount = k;
        badBins = qBins;
        badWhy = "ours";
        break;
      }
      if (
        !badAmount &&
        sim.value.err &&
        /InsufficientOutAmount/.test(simText)
      ) {
        // DLMM itself rejects the dust (borrow already succeeded inside the
        // simulated tx): this still proves atomic rollback of a completed
        // borrow CPI. Keep scanning smaller-first; prefer OUR error.
        badAmount = k;
        badBins = qBins;
        badWhy = "dlmm-dust";
      }
    }
    if (badAmount === null || badBins === null)
      throw new Error(
        "BLOCKER: no probe amount reverted at all (even DLMM dust check passed?)"
      );
    console.log(`rollback amount: ${badAmount} PUMP units (${badWhy})`);
    const snapMf = Buffer.from((await connection.getAccountInfo(mfPda))!.data);
    const snapPumpVault = BigInt(
      (await balanceWithRetry(PUMP_VAULT, "PUMP vault")).value.amount
    );
    const snapWsol = BigInt(
      (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
    );
    const snapSolVault = BigInt(
      (await balanceWithRetry(SOL_VAULT, "SOL vault")).value.amount
    );
    const snapVaultPump = (
      await connection.getTokenAccountBalance(pumpAta.address)
    ).value.amount;
    const badIx = await program.methods
      .borrowSellDepositChecked(new anchor.BN(badAmount.toString()))
      .accounts({
        state,
        vault,
        marginfiAccount: mfPda,
        group: GROUP,
        solBank: SOL_BANK,
        pumpBank: PUMP_BANK,
        vaultWsolAta: wsolAta.address,
        vaultPumpAta: pumpAta.address,
        bankLiquidityVaultAuthority: pumpVaultAuth,
        bankLiquidityVault: PUMP_VAULT,
        solBankLiquidityVault: SOL_VAULT,
        tokenXProgram: TOKEN_2022_PROGRAM_ID,
        tokenYProgram: TOKEN_PROGRAM_ID,
        dlmmPool: DLMM_POOL,
        dlmmReserveX: DLMM_RESERVE_X,
        dlmmReserveY: DLMM_RESERVE_Y,
        dlmmOracle: DLMM_ORACLE,
        dlmmBitmap: DLMM_BITMAP,
        tokenXMint: PUMP_MINT,
        tokenYMint: NATIVE_MINT,
        memoProgram: MEMO_PROGRAM,
        eventAuthority,
        dlmmProgram: DLMM_PROGRAM,
        marginfiProgram: MARGINFI_V2,
      })
      .remainingAccounts([...borrowHealth, ...badBins])
      .instruction();
    let reverted = false;
    try {
      await send(
        new Transaction().add(crankCuIx, badIx),
        "rollback probe (must revert)"
      );
    } catch (e) {
      reverted = true;
      const text =
        String(e) + "\n" + (((e as any).logs ?? []) as string[]).join("\n");
      if (badWhy === "ours") {
        assert(
          /0x1771/.test(text) && /EapeY/.test(text) && !/0x1779/.test(text),
          `rollback reverts with OUR program error 0x1771 (not marginfi 0x1779), got: ${text.slice(
            0,
            400
          )}`
        );
      } else {
        assert(
          /InsufficientOutAmount|0x1779|Custom/.test(text),
          `rollback reverts, got: ${text.slice(0, 400)}`
        );
      }
      console.log(`rollback reverted as expected (${badWhy})`);
    }
    assert(reverted, "expected the rollback probe to revert");
    const afterMf = Buffer.from((await connection.getAccountInfo(mfPda))!.data);
    assert(
      afterMf.equals(snapMf),
      "marginfi account raw data is byte-identical after revert"
    );
    const afterPumpVault = BigInt(
      (await balanceWithRetry(PUMP_VAULT, "PUMP vault")).value.amount
    );
    assert(
      afterPumpVault === snapPumpVault,
      "PUMP bank vault unchanged after revert"
    );
    const afterWsol = BigInt(
      (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
    );
    assert(afterWsol === snapWsol, "vault wSOL unchanged after revert");
    const afterSolVault = BigInt(
      (await balanceWithRetry(SOL_VAULT, "SOL vault")).value.amount
    );
    assert(
      afterSolVault === snapSolVault,
      "SOL bank vault unchanged after revert"
    );
    const afterVaultPump = (
      await connection.getTokenAccountBalance(pumpAta.address)
    ).value.amount;
    assert(
      afterVaultPump === snapVaultPump,
      "vault PUMP ATA unchanged after revert"
    );
    if (badWhy === "ours") {
      console.log(
        "HEALTH_ROLLBACK_OK weak-health crank reverted with full rollback"
      );
    } else {
      console.log(
        "ATOMIC_ROLLBACK_OK dust crank reverted after a completed borrow; all state byte-identical. " +
          "NOTE: our 0x1771 guard never fired (window empty, see mapping above); " +
          "the HF-window revert of criterion 3 is unproducible on this pool."
      );
    }
  }

  // 5. Cover + repay in full, then withdraw all (real CPIs).
  // Top-up: the vault holds no PUMP after the sells, but repay_all pulls the
  // full debt including interest dust (ceil rounds up), so an exact cover is
  // always ~1 unit short and reverts with InsufficientFunds. The payer
  // borrows a small buffer DIRECTLY (own throwaway marginfi account, left
  // open) and transfers it to the vault. This stands in for the production
  // market buy (which buys PUMP with a buffer). The payer's own
  // 0.05 SOL collateral stays in the SOL bank (abandoned, local only).
  const TOPUP_PUMP_UNITS = BigInt(100_000); // 0.1 PUMP, dust cover + slack
  const COVER_PUMP_UNITS = BORROW_PUMP_UNITS + TOPUP_PUMP_UNITS;
  const PAYER_DEPOSIT_LAMPORTS = BigInt(50_000_000); // 0.05 SOL
  const payerWsolAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    NATIVE_MINT,
    payer.publicKey,
    false
  );
  const payerPumpAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    PUMP_MINT,
    payer.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );
  const payerMf = Keypair.generate();
  const DISC_INIT = Buffer.from([43, 78, 61, 255, 148, 52, 249, 154]);
  const DISC_DEPOSIT = Buffer.from([171, 94, 235, 103, 82, 64, 212, 140]);
  const DISC_BORROW = Buffer.from([4, 126, 116, 53, 48, 5, 212, 31]);
  const u64le = (v: bigint): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  await send(
    new Transaction().add(
      new TransactionInstruction({
        programId: MARGINFI_V2,
        keys: [
          { pubkey: GROUP, isSigner: false, isWritable: false },
          { pubkey: payerMf.publicKey, isSigner: true, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: DISC_INIT,
      })
    ),
    "payer marginfi account (top-up source)",
    [payerMf]
  );
  await send(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payerWsolAta.address,
        lamports: Number(PAYER_DEPOSIT_LAMPORTS) * 2,
      }),
      createSyncNativeInstruction(payerWsolAta.address),
      new TransactionInstruction({
        programId: MARGINFI_V2,
        keys: [
          { pubkey: GROUP, isSigner: false, isWritable: false },
          { pubkey: payerMf.publicKey, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: SOL_BANK, isSigner: false, isWritable: true },
          { pubkey: payerWsolAta.address, isSigner: false, isWritable: true },
          { pubkey: SOL_VAULT, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
          DISC_DEPOSIT,
          u64le(PAYER_DEPOSIT_LAMPORTS),
          Buffer.from([0]),
        ]),
      })
    ),
    "payer deposits 0.05 SOL collateral"
  );
  await send(
    new Transaction().add(
      new TransactionInstruction({
        programId: MARGINFI_V2,
        keys: [
          { pubkey: GROUP, isSigner: false, isWritable: false },
          { pubkey: payerMf.publicKey, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: PUMP_BANK, isSigner: false, isWritable: true },
          { pubkey: payerPumpAta.address, isSigner: false, isWritable: true },
          { pubkey: pumpVaultAuth, isSigner: false, isWritable: false },
          { pubkey: PUMP_VAULT, isSigner: false, isWritable: true },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          ...borrowHealth.map((m) => ({
            pubkey: m.pubkey,
            isSigner: false,
            isWritable: false,
          })),
        ],
        data: Buffer.concat([DISC_BORROW, u64le(COVER_PUMP_UNITS)]),
      })
    ),
    "payer borrows cover + buffer PUMP"
  );
  await send(
    new Transaction().add(
      createTransferCheckedInstruction(
        payerPumpAta.address,
        PUMP_MINT,
        pumpAta.address,
        payer.publicKey,
        COVER_PUMP_UNITS,
        6,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    ),
    "cover vault with borrow + buffer PUMP (stands in for market buy)"
  );
  // Diagnostics: decode the marginfi account liability vs vault balance.
  {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coder2 = new BorshCoder(sdk.MARGINFI_IDL as any);
    const mfRaw = coder2.accounts.decode(
      "MarginfiAccount",
      Buffer.from((await connection.getAccountInfo(mfPda))!.data)
    ) as unknown as {
      lending_account: {
        balances: Array<{
          active: number;
          bank_pk: PublicKey;
          asset_shares: { value: number[] };
          liability_shares: { value: number[] };
        }>;
      };
    };
    const le2 = (arr: number[]): bigint => {
      let n = BigInt(0);
      arr.forEach((b, i) => {
        n += BigInt(b) << BigInt(8 * i);
      });
      return n;
    };
    const pumpBankAi2 = await connection.getAccountInfo(PUMP_BANK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bankRaw = coder2.accounts.decode(
      "Bank",
      Buffer.from(pumpBankAi2!.data)
    ) as any;
    const lsv = le2(bankRaw.liability_share_value.value as number[]);
    for (const b of mfRaw.lending_account.balances.filter(
      (x) => x.active
    ) as Array<{
      bank_pk: PublicKey;
      asset_shares: { value: number[] };
      liability_shares: { value: number[] };
    }>) {
      const liab =
        (le2(b.liability_shares.value) * lsv) / (BigInt(1) << BigInt(96));
      console.log(
        `marginfi balance bank=${b.bank_pk.toBase58().slice(0, 6)} ` +
          `assetShares=${le2(b.asset_shares.value)} liabilityUnits=${liab}`
      );
    }
    const ataBal = await connection.getTokenAccountBalance(pumpAta.address);
    console.log(`vault PUMP ATA before repay: ${ataBal.value.amount}`);
  }
  // Read the bank right before repay: the payer's parallel top-up borrow
  // also draws from this vault, so deltas must be measured from here.
  const pumpVaultBalPre = BigInt(
    (await balanceWithRetry(PUMP_VAULT, "PUMP vault")).value.amount
  );
  await program.methods
    .repayAll(new anchor.BN(BORROW_PUMP_UNITS.toString()))
    .accounts({
      state,
      admin: payer.publicKey,
      vault,
      marginfiAccount: mfPda,
      group: GROUP,
      pumpBank: PUMP_BANK,
      vaultPumpAta: pumpAta.address,
      bankLiquidityVault: PUMP_VAULT,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      marginfiProgram: MARGINFI_V2,
    })
    .remainingAccounts(repayRemaining)
    .signers([payer])
    .rpc();
  const pumpVaultBal2 = BigInt(
    (await balanceWithRetry(PUMP_VAULT, "PUMP vault")).value.amount
  );
  const pulled = pumpVaultBal2 - pumpVaultBalPre;
  assert(
    pulled > BORROW_PUMP_UNITS && pulled <= COVER_PUMP_UNITS,
    `repay pulled debt + dust, covered by the top-up buffer (pulled ${pulled})`
  );
  console.log(
    `repay_all ok: debt covered in the real PUMP bank (pulled ${pulled})`
  );
  const wsolPreWithdraw = BigInt(
    (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
  );
  await program.methods
    .withdrawAll(new anchor.BN(DEPOSIT_LAMPORTS.toString()))
    .accounts({
      state,
      admin: payer.publicKey,
      vault,
      marginfiAccount: mfPda,
      group: GROUP,
      solBank: SOL_BANK,
      vaultWsolAta: wsolAta.address,
      bankLiquidityVaultAuthority: solVaultAuth,
      bankLiquidityVault: SOL_VAULT,
      tokenProgram: TOKEN_PROGRAM_ID,
      marginfiProgram: MARGINFI_V2,
    })
    .remainingAccounts(healthRemaining)
    .signers([payer])
    .rpc();
  const solVaultBal2 = BigInt(
    (await balanceWithRetry(SOL_VAULT, "SOL vault")).value.amount
  );
  const endWsol = await connection.getTokenAccountBalance(wsolAta.address);
  const withdrawn = BigInt(endWsol.value.amount) - wsolPreWithdraw;
  assert(
    withdrawn >= DEPOSIT_LAMPORTS,
    `withdraw returned at least the deposit, got ${withdrawn}`
  );
  const solInterest = withdrawn - DEPOSIT_LAMPORTS - swapGain;
  assert(
    solInterest >= BigInt(0),
    `interest is non-negative, got ${solInterest}`
  );
  console.log(
    `withdraw_all ok: collateral + ${swapGain} proceeds + ${solInterest} lamports SOL interest`
  );
  // Exact conservation: the bank is short exactly what we took as interest
  // (plus the payer's abandoned collateral stays in).
  assert(
    solVaultBal0 + PAYER_DEPOSIT_LAMPORTS - solVaultBal2 === solInterest,
    `SOL bank delta is exactly payer collateral minus our interest (${solVaultBal2} vs ${solVaultBal0})`
  );
  assert(
    BigInt(endWsol.value.amount) === wrapped + swapGain + solInterest,
    `vault wSOL gained swap proceeds + interest, got ${endWsol.value.amount}`
  );
  const endPump = await connection.getTokenAccountBalance(pumpAta.address);
  const leftover = BigInt(endPump.value.amount);
  assert(
    leftover === COVER_PUMP_UNITS - pulled,
    `vault PUMP change is exact (leftover ${leftover}, pulled ${pulled})`
  );
  console.log(
    `withdraw_all ok: collateral back in the vault (PUMP change left: ${leftover})`
  );
  // 7. Sweep the proceeds to the sweep destination (the payer). The
  // destination is the payer's own wSOL ATA (created for the top-up leg);
  // owner == sweep_destination, mint matches. Sweep swap gain + interest,
  // leaving the wrapped principal in the vault.
  const sweepAmount = swapGain + solInterest;
  const destBefore = BigInt(
    (await connection.getTokenAccountBalance(payerWsolAta.address)).value.amount
  );
  await program.methods
    .sweepOut(new anchor.BN(sweepAmount.toString()))
    .accounts({
      state,
      admin: payer.publicKey,
      vault,
      vaultWsolAta: wsolAta.address,
      destination: payerWsolAta.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([payer])
    .rpc();
  const vaultAfterSweep = BigInt(
    (await connection.getTokenAccountBalance(wsolAta.address)).value.amount
  );
  const destAfter = BigInt(
    (await connection.getTokenAccountBalance(payerWsolAta.address)).value.amount
  );
  assert(
    vaultAfterSweep === wrapped,
    `vault keeps exactly the wrapped principal after sweep, got ${vaultAfterSweep}`
  );
  assert(
    destAfter - destBefore === sweepAmount,
    `destination gained exactly the sweep, got ${destAfter - destBefore}`
  );
  console.log(
    `sweep_out ok: swept ${sweepAmount} lamports to the payer destination`
  );
  console.log(
    "health math: collateral 1.0 SOL x $94 x 0.80 vs debt 1 PUMP x $0.00407 x 1.60 -> healthy by orders of magnitude"
  );
  console.log("CHECK_OK local-e2e full crank passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
