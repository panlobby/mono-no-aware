// Health-guard rollback proof: negative local-clone case.
// Boots with a local-only HIGH PUMP oracle (default +5% over the pool's
// ~$0.00407), so the DLMM sale fill is worse than the bank oracle. Then
// calls the real combined instruction with an amount marginfi accepts
// (~99% of the max the live cache + bank config allow) whose final initial
// HF lands below 1.5. The tx must revert with OUR program health error
// (0x1771) and NOT with marginfi's 0x1779, and every account must roll
// back: marginfi account raw data byte-identical, PUMP bank vault unchanged,
// vault wSOL ATA unchanged, SOL bank liquidity vault unchanged,
// vault PUMP ATA unchanged. Prints HEALTH_ROLLBACK_OK only on a full pass.
//
// Run via scripts/health-rollback-local.sh (boots the validator with the
// high PUMP oracle, deploys the local-test build, then runs this).
// Every failed check throws, so the process exits non-zero on failure.
import * as anchor from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createMint,
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

// Local-only oracle values for the negative run: the PUMP bank oracle is
// injected HIGH (default live +5%) while the cloned DLMM pool still prices
// PUMP at the live fill, so the crank's sale fill is worse than the bank
// oracle. SOL is the live mainnet price (a hardcoded fixture would rot and
// trip the 600 bps circuit breaker). Feed ids stay the real mainnet
// ones so any feed-id check passes; only price/conf are local-only.
// Values come from the environment (exported by health-rollback-local.sh)
// so the script asserts the oracle it was actually booted with.
const PUMP_PRICE = BigInt(process.env.PUMP_PRICE_RAW ?? "427350");
const PUMP_CONF = BigInt(process.env.PUMP_CONF_RAW ?? "315");
const SOL_PRICE = BigInt(process.env.SOL_PRICE_RAW ?? "9400000000");
const SOL_CONF = BigInt(4_000_000);
const SOL_FEED_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const PUMP_FEED_HEX =
  "7a01fca212788bba7c5bf8c9efd576a8a722f070d2c17596ff7bb609b8d5c3b9";
// 1 SOL collateral, then one failing crank. No caps on-chain; the health
// guard is the only bound.
const DEPOSIT_LAMPORTS = BigInt(1_000_000_000);

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

// Read a WrappedI80F48 bank weight via the SDK and return it as a float.
function bankWeight(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coder: any,
  bankAi: { data: Uint8Array },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  field: string
): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = coder.accounts.decode("Bank", Buffer.from(bankAi.data)) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toDec = (sdk as any).wrappedI80F48toBigNumber as (w: {
    value: number[];
  }) => { toString(): string };
  return Number(toDec(raw.config[field]).toString());
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
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new anchor.Program(loadFeeShortIdl() as any, provider) as any;

  const banksJson = JSON.parse(
    fs.readFileSync("target/health-rollback-e2e/banks.json", "utf8")
  ) as {
    solBank: { liquidityVault: string; oracles: string[] };
    pumpBank: { liquidityVault: string; oracles: string[] };
  };
  const dlmmJson = JSON.parse(
    fs.readFileSync("target/health-rollback-e2e/dlmm-clones.json", "utf8")
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
      if (Date.now() > budgetMs + deadline) {
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

  // ---------- Phase A: verify clones + the HIGH local PUMP oracle ----------
  console.log("== phase A: verify clones ==");
  const mfProg = await fetchWithRetry(MARGINFI_V2, "marginfi v2 program");
  assert(mfProg.executable, "marginfi v2 program cloned and executable");
  const dlmmProg = await fetchWithRetry(DLMM_PROGRAM, "DLMM program");
  assert(dlmmProg.executable, "DLMM program cloned and executable");
  const group = await fetchWithRetry(GROUP, "group");
  assert(group.owner.equals(MARGINFI_V2), "group cloned (owner=mfv2)");
  const solBankAi = await fetchWithRetry(SOL_BANK, "SOL bank");
  const pumpBankAi = await fetchWithRetry(PUMP_BANK, "PUMP bank");
  assert(solBankAi.owner.equals(MARGINFI_V2), "SOL bank owned by mfv2");
  assert(pumpBankAi.owner.equals(MARGINFI_V2), "PUMP bank owned by mfv2");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = new BorshCoder(sdk.MARGINFI_IDL as any);
  const pumpBankRaw = coder.accounts.decode(
    "Bank",
    Buffer.from(pumpBankAi.data)
  );
  const pumpOracle = new PublicKey(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pumpBankRaw as any).config.oracle_keys[0].toBase58()
  );
  assert(
    pumpOracle.equals(PUMP_ORACLE),
    "PUMP bank points at the injected oracle key"
  );
  const pumpOracleAi = await fetchWithRetry(PUMP_ORACLE, "PUMP oracle");
  const pumpPx = parsePyth(Buffer.from(pumpOracleAi.data));
  assert(
    pumpPx.feed === PUMP_FEED_HEX,
    "PUMP oracle keeps the real mainnet feed id"
  );
  assert(
    pumpPx.price === PUMP_PRICE && pumpPx.conf === PUMP_CONF,
    `PUMP oracle is the local-only HIGH price (got ${pumpPx.price}, want ${PUMP_PRICE})`
  );
  console.log(
    `PUMP oracle HIGH: price=${pumpPx.price} conf=${pumpPx.conf} (real feed id, local-only)`
  );
  const solOracleAi = await fetchWithRetry(SOL_ORACLE, "SOL oracle");
  const solPx = parsePyth(Buffer.from(solOracleAi.data));
  assert(
    solPx.price === SOL_PRICE && solPx.conf === SOL_CONF,
    "SOL oracle is the live mainnet price"
  );
  const dlmm = await DLMM.create(connection, DLMM_POOL);
  assert(
    dlmm.lbPair.tokenXMint.equals(PUMP_MINT),
    "DLMM pool tokenX is real PUMP"
  );
  assert(
    dlmm.lbPair.tokenYMint.equals(NATIVE_MINT),
    "DLMM pool tokenY is wSOL"
  );
  console.log("ok - DLMM pool legs are PUMP/wSOL (fair price, unmoved)");
  // Read the bank weights we borrow against (live, never hardcoded).
  const solAssetW = bankWeight(coder, solBankAi, "asset_weight_init");
  const pumpLiabW = bankWeight(coder, pumpBankAi, "liability_weight_init");
  console.log(
    `bank weights live: SOL asset ${solAssetW}, PUMP liab ${pumpLiabW}`
  );
  const [pumpVaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), PUMP_BANK.toBuffer()],
    MARGINFI_V2
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DLMM_PROGRAM
  );
  console.log("CHECK_OK phase A clones verified (HIGH pump oracle)");

  // ---------- Phase B: init, wrap, marginfi account, deposit ----------
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
  console.log("deposit_sol ok: 1.0 SOL collateral in the real SOL bank");

  // 4. Pick the revert amount: ~99% of the live max borrow at the HIGH
  // oracle, so marginfi's pre-check passes while the post-deposit guard
  // must fail. maxBorrow = collateral_usd / (liabWeight * oraclePrice).
  // The DLMM fill happens at the fair pool price, so the deposit covers
  // only a fraction of what the oracle valuation charged.
  const solPriceUsd = Number(solPx.price) / 1e8;
  const pumpPriceUsd = Number(pumpPx.price) / 1e8;
  assert(
    BigInt(Math.round(solPriceUsd * 1e8)) === SOL_PRICE,
    `SOL oracle matches the injected live price (got ${solPriceUsd})`
  );
  assert(
    BigInt(Math.round(pumpPriceUsd * 1e8)) === PUMP_PRICE,
    `PUMP oracle matches the injected HIGH price (got ${pumpPriceUsd})`
  );
  const collateralUsd =
    (Number(DEPOSIT_LAMPORTS) / 1e9) * solPriceUsd * solAssetW;
  const maxBorrowTokens = Math.floor(
    collateralUsd / (pumpLiabW * pumpPriceUsd)
  );
  console.log(
    `live max borrow at HIGH oracle: ~${maxBorrowTokens} PUMP (collateral $${collateralUsd.toFixed(
      2
    )}, liabW ${pumpLiabW}, oracle $${pumpPriceUsd})`
  );
  assert(maxBorrowTokens > 100, "max borrow is a sane multi-PUMP amount");
  const dlmmBins = await dlmm.getBinArrayForSwap(true);
  assert(dlmmBins.length >= 1, "DLMM bin arrays readable locally");
  const crankCuIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  });
  let badAmount: bigint | null = null;
  let badBins: Array<{
    pubkey: PublicKey;
    isWritable: boolean;
    isSigner: boolean;
  }> | null = null;
  const { blockhash: simBlockhash } = await connection.getLatestBlockhash(
    "confirmed"
  );
  for (const frac of [0.9, 0.95, 0.97, 0.99, 1.0]) {
    const k = BigInt(Math.floor(maxBorrowTokens * frac)) * BigInt(1_000_000);
    if (k <= 0) continue;
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
    const theirs = /0x1779/.test(simText);
    const tail = (sim.value.logs ?? []).slice(-4).join(" | ");
    console.log(
      `probe k=${k}: simErr=${
        sim.value.err ? JSON.stringify(sim.value.err).slice(0, 60) : "none"
      } ${
        ours
          ? "OURS-GUARD"
          : theirs
          ? "marginfi"
          : sim.value.err
          ? "other-revert"
          : "success"
      } || ${tail.slice(0, 220)}`
    );
    if (ours) {
      badAmount = k;
      badBins = qBins;
      break;
    }
    if (theirs) {
      console.log("marginfi rejected first: window closed below this k");
      break;
    }
  }
  if (badAmount === null || badBins === null)
    throw new Error(
      "BLOCKER: no probe amount failed with our 0x1771 guard (window closed or estimator off)"
    );
  console.log(`rollback amount: ${badAmount} PUMP units (ours-guard)`);
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
  // Broadcast the revert probe with skipPreflight so the failed tx lands
  // on-chain and yields a signature. A preflight sim would throw before
  // broadcast and leave no sig to record.
  const probeTx = new Transaction().add(crankCuIx, badIx);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  probeTx.recentBlockhash = blockhash;
  probeTx.feePayer = payer.publicKey;
  probeTx.sign(payer);
  const revertSig = await connection.sendRawTransaction(probeTx.serialize(), {
    skipPreflight: true,
  });
  console.log(`rollback probe broadcast (must revert): ${revertSig}`);
  await connection.confirmTransaction(revertSig, "confirmed");
  const probeInfo = await connection.getTransaction(revertSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const probeText =
    JSON.stringify(probeInfo?.meta?.err) +
    "\n" +
    (probeInfo?.meta?.logMessages ?? []).join("\n");
  assert(
    probeInfo?.meta?.err,
    "expected the weak-health crank to revert on-chain"
  );
  assert(
    /0x1771/.test(probeText) &&
      /EapeY/.test(probeText) &&
      !/0x1779/.test(probeText),
    `rollback reverts with OUR program error 0x1771 (not marginfi 0x1779), got: ${probeText.slice(
      0,
      400
    )}`
  );
  console.log("rollback reverted with our guard as expected");
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
  console.log(
    "HEALTH_ROLLBACK_OK weak-health crank reverted with full rollback"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
