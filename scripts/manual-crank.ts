// One-shot manual crank for the keeperless fee-short program.
// No daemon, no cron. Reads live state, optionally claims fees and deposits
// collateral, then calls borrow_sell_deposit_checked once and prints the
// event plus health before and after. Unwind mode runs the admin close
// (repay_all, withdraw_all, sweep_out) with explicit preconditions.
//
//   npx ts-node scripts/manual-crank.ts                                   # dry run
//   npx ts-node scripts/manual-crank.ts --send --amount 1000000           # crank 1 PUMP
//   npx ts-node scripts/manual-crank.ts --send --claim --warn-claim-below 1000   # claim first
//   npx ts-node scripts/manual-crank.ts --send --deposit-lamports 500000000
//   npx ts-node scripts/manual-crank.ts --send --claim --deposit-vault-wsol --amount 1000000
//   npx ts-node scripts/manual-crank.ts --send --mode pause
//   npx ts-node scripts/manual-crank.ts --send --mode unwind
//
// Flags:
//   --rpc URL             RPC endpoint (default http://127.0.0.1:8899).
//   --wallet PATH         Payer keypair (default ANCHOR_WALLET or ~/.config/solana/id.json).
//   --amount N            PUMP base units to borrow+sell (default 1000000 = 1 PUMP).
//   --claim               Run claim_dbc_fees and claim_damm_fees first (skips
//                         whichever pool/position is still default).
//   --warn-claim-below N  Post-claim warning when a claim wSOL delta is
//                         below N (default 0). Never skips: the claim is
//                         already broadcast by then.
//   --deposit-lamports N  Wrap N lamports to the vault and deposit_sol first (default 0 = skip).
//   --deposit-vault-wsol  Deposit the vault's existing wSOL token balance (for example
//                         after --claim) before the crank. Never wraps payer SOL.
//   --mode crank|pause|unwind  crank (default), admin pause or admin unwind.
//   --send                Broadcast. Without it the script prints the plan and exits 0.
//
// The payer is gas only for crank mode. Unwind mode requires the payer to be
// the state admin and the vault PUMP ATA to already hold cover (debt +
// buffer); the script never market-buys PUMP. It never holds vault or admin
// authority beyond the payer keypair it signs with.
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
  createSyncNativeInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
// NOTE: no static import of ../target/idl/fee_short.json here. That file
// only exists after `anchor build`, and CI runs `npm run check` before any
// build. The IDL is required lazily in the --send path below, so dry-run
// and tsc never need a built program.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BorshCoder } =
  require("@coral-xyz/anchor") as typeof import("@coral-xyz/anchor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DLMM = require("@meteora-ag/dlmm") as {
  create(
    conn: Connection,
    pool: PublicKey
  ): Promise<{
    lbPair: { reserveX: PublicKey; reserveY: PublicKey; oracle: PublicKey };
    binArrayBitmapExtension: { publicKey: PublicKey } | null;
    getBinArrayForSwap(
      swapForY: boolean
    ): Promise<Array<{ publicKey: PublicKey }>>;
  }>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require("@0dotxyz/p0-ts-sdk") as Record<string, unknown>;

const MARGINFI_V2 = new PublicKey(
  "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"
);
const DLMM_PROGRAM = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);
const DBC_PROGRAM = new PublicKey(
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
);
const DBC_POOL_AUTHORITY = new PublicKey(
  "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
);
const DAMM_V2_PROGRAM = new PublicKey(
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
);
const DAMM_POOL_AUTHORITY = new PublicKey(
  "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
);
const MEMO_PROGRAM = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);
const DEFAULT_KEY = "11111111111111111111111111111111";
const HEALTH_OFF = 1840;
const SCALE = BigInt(1) << BigInt(48);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function fail(msg: string): never {
  console.error(`MANUAL_CRANK_FAIL: ${msg}`);
  process.exit(1);
}

function readI128LE(b: Buffer, off: number): bigint {
  const s = b.subarray(off, off + 16);
  let v = BigInt(0);
  for (let i = 15; i >= 0; i--) v = (v << BigInt(8)) | BigInt(s[i]);
  if (s[15] & 0x80) v -= BigInt(1) << BigInt(128);
  return v;
}

async function readHealth(
  conn: Connection,
  marginfiAccount: PublicKey,
  label: string
): Promise<void> {
  const ai = await conn.getAccountInfo(marginfiAccount);
  if (!ai || ai.data.length !== 2312) {
    console.log(
      `${label}: no readable marginfi account (len=${
        ai?.data.length ?? "null"
      })`
    );
    return;
  }
  const d = Buffer.from(ai.data);
  const asset = readI128LE(d, HEALTH_OFF);
  const liab = readI128LE(d, HEALTH_OFF + 16);
  const assetM = readI128LE(d, HEALTH_OFF + 32);
  const liabM = readI128LE(d, HEALTH_OFF + 48);
  const init =
    liab <= 0
      ? NaN
      : Number(asset) / Number(SCALE) / (Number(liab) / Number(SCALE));
  const maint =
    liabM <= 0
      ? NaN
      : Number(assetM) / Number(SCALE) / (Number(liabM) / Number(SCALE));
  console.log(
    `${label}: initHF=${init.toFixed(2)} maintHF=${maint.toFixed(2)} ` +
      `ts=${d.readBigInt64LE(HEALTH_OFF + 96)} flags=${d.readUInt32LE(
        HEALTH_OFF + 104
      )} ` +
      `err=${d.readUInt32LE(HEALTH_OFF + 108)} ver=${d[HEALTH_OFF + 245]}`
  );
}

async function main(): Promise<void> {
  const rpcUrl =
    arg("--rpc", "") ||
    process.env.ANCHOR_PROVIDER_URL ||
    "http://127.0.0.1:8899";
  const keyPath =
    arg("--wallet", "") ||
    process.env.ANCHOR_WALLET ||
    `${process.env.HOME}/.config/solana/id.json`;
  const amount = BigInt(arg("--amount", "1000000"));
  const mode = arg("--mode", "crank");
  const warnClaimBelow = BigInt(arg("--warn-claim-below", "0"));
  const depositLamports = BigInt(arg("--deposit-lamports", "0"));
  const depositVaultWsol = has("--deposit-vault-wsol");
  const wantClaim = has("--claim");
  const send = has("--send");
  if (mode !== "crank" && mode !== "unwind" && mode !== "pause")
    fail(`bad --mode ${mode}`);
  if (amount <= 0 && mode === "crank") fail("amount must be > 0");

  const plan: string[] = [];
  if (wantClaim)
    plan.push(`claim DBC+DAMM fees (warn below ${warnClaimBelow})`);
  if (depositLamports > 0)
    plan.push(`wrap ${depositLamports} lamports + deposit_sol`);
  if (depositVaultWsol) plan.push("deposit existing vault wSOL balance");
  if (mode === "crank")
    plan.push(`borrow_sell_deposit_checked amount=${amount}`);
  else if (mode === "pause")
    plan.push("update_config paused=true (admin only)");
  else plan.push("unwind: repay_all + withdraw_all + sweep_out (admin only)");
  console.log(`plan: ${plan.join(" | ")}`);
  if (!send) {
    console.log("DRY_RUN_OK (pass --send to broadcast)");
    return;
  }

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")) as number[])
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payer),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  // Lazy IDL require: keeps dry-run and tsc working without anchor build.
  const idlPath = fs.existsSync("target/production/fee_short.json")
    ? "../target/production/fee_short.json"
    : "../target/idl/fee_short.json";
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const idlJson = require(idlPath) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new anchor.Program(idlJson as any, provider) as any;
  const readTokenBal = async (ata: PublicKey): Promise<bigint> => {
    const ai = await connection.getAccountInfo(ata);
    if (!ai || ai.data.length < 72) return 0n;
    return Buffer.from(ai.data).readBigUInt64LE(64);
  };
  const [state] = PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    program.programId
  );
  const st = await program.account.feeShortState.fetch(state);
  const vault = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), state.toBuffer()],
    program.programId
  )[0];
  const s = {
    admin: st.admin as PublicKey,
    group: st.group as PublicKey,
    solBank: st.solBank as PublicKey,
    pumpBank: st.pumpBank as PublicKey,
    vaultWsolAta: st.vaultWsolAta as PublicKey,
    vaultPumpAta: st.vaultPumpAta as PublicKey,
    sweepDestination: st.sweepDestination as PublicKey,
    pumpPool: st.pumpPool as PublicKey,
    baseMint: st.baseMint as PublicKey,
    vaultBaseAta: st.vaultBaseAta as PublicKey,
    marginfiAccount: st.marginfiAccount as PublicKey,
    dbcPool: st.dbcPool as PublicKey,
    dbcConfig: st.dbcConfig as PublicKey,
    dammPool: st.dammPool as PublicKey,
    dammPosition: st.dammPosition as PublicKey,
    paused: st.paused as boolean,
  };
  console.log(`state: ${state.toBase58()} paused=${s.paused}`);
  console.log(`vault: ${vault.toBase58()}`);
  console.log(`marginfi: ${s.marginfiAccount.toBase58()}`);
  console.log(`pumpPool: ${s.pumpPool.toBase58()}`);
  if (s.paused && mode === "crank") fail("state is paused; crank would revert");

  // Health pairs in descending bank-pubkey order, with live oracle_keys[0].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = new BorshCoder((sdk as any).MARGINFI_IDL as any);
  const oracleFor = async (bank: PublicKey): Promise<PublicKey> => {
    const ai = await connection.getAccountInfo(bank);
    if (!ai) fail(`bank missing ${bank.toBase58()}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = coder.accounts.decode("Bank", Buffer.from(ai!.data)) as any;
    const keys = (raw.config.oracle_keys ??
      raw.config.oracleKeys) as PublicKey[];
    return keys[0];
  };
  const solOracle = await oracleFor(s.solBank);
  const pumpOracle = await oracleFor(s.pumpBank);
  const banksDesc = [s.solBank, s.pumpBank].sort((a, b) =>
    Buffer.compare(b.toBuffer(), a.toBuffer())
  );
  const of = (b: PublicKey): PublicKey =>
    b.equals(s.solBank) ? solOracle : pumpOracle;
  const healthPairs = banksDesc.flatMap((b) => [b, of(b)]);
  console.log(
    `health order: ${banksDesc
      .map((k) => k.toBase58().slice(0, 6))
      .join(" > ")}`
  );

  // Live DLMM set for the fixed pool (reserves, oracle, bitmap, bins).
  const dlmm = await DLMM.create(connection, s.pumpPool);
  const bins = await dlmm.getBinArrayForSwap(true);
  if (bins.length === 0) fail("DLMM returned no bin arrays");
  const bitmap = dlmm.binArrayBitmapExtension?.publicKey as PublicKey;
  if (!bitmap) fail("DLMM pool has no bitmap extension");
  const quoteBins = bins.map((k: { publicKey: PublicKey }) => ({
    pubkey: k.publicKey,
    isWritable: true,
    isSigner: false,
  }));
  console.log(`bins: ${bins.length}`);

  await readHealth(connection, s.marginfiAccount, "health before");

  if (wantClaim) {
    const wBefore = await readTokenBal(s.vaultWsolAta);
    // DBC leg: skip when the pool is still default.
    if (s.dbcPool.toBase58() !== DEFAULT_KEY) {
      const [eventAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        DBC_PROGRAM
      );
      // Read the live DBC pool for vaults and mints.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk") as any;
      const client = new dbc.DynamicBondingCurveClient(connection, "confirmed");
      const rawPool = await client.state.getPool(s.dbcPool);
      const pst = (rawPool as any).poolState ?? rawPool;
      const sig = await program.methods
        .claimDbcFees()
        .accounts({
          state,
          vault,
          poolAuthority: DBC_POOL_AUTHORITY,
          dbcConfig: s.dbcConfig,
          dbcPool: s.dbcPool,
          tokenAAccount: s.vaultBaseAta,
          vaultWsolAta: s.vaultWsolAta,
          baseVault: new PublicKey(pst.baseVault.toString()),
          quoteVault: new PublicKey(pst.quoteVault.toString()),
          baseMint: s.baseMint,
          quoteMint: NATIVE_MINT,
          tokenBaseProgram: (await connection.getAccountInfo(s.baseMint))!
            .owner,
          tokenQuoteProgram: TOKEN_PROGRAM_ID,
          eventAuthority: eventAuth,
          dbcProgram: DBC_PROGRAM,
        })
        .rpc();
      console.log(`claim_dbc_fees: ${sig}`);
    } else {
      console.log("DBC pool is default; skipping DBC claim");
    }
    // DAMM leg: skip when pool/position are still default.
    if (
      s.dammPool.toBase58() !== DEFAULT_KEY &&
      s.dammPosition.toBase58() !== DEFAULT_KEY
    ) {
      const [eventAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        DAMM_V2_PROGRAM
      );
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cpAmmIdl = require("./idl/cp_amm.json");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dammProgram = new anchor.Program(cpAmmIdl as any, provider) as any;
      const poolState = await dammProgram.account.pool.fetch(s.dammPool);
      const tokenAMint = poolState.tokenAMint as PublicKey;
      const tokenBMint = poolState.tokenBMint as PublicKey;
      const vaultA = poolState.vaultA as PublicKey;
      const vaultB = poolState.vaultB as PublicKey;
      const posState = await dammProgram.account.position.fetch(s.dammPosition);
      const nftMint = posState.nftMint as PublicKey;
      const nftAccs = await connection.getParsedTokenAccountsByOwner(vault, {
        mint: nftMint,
      });
      // Require exactly one vault-owned account holding 1 NFT. Zero means
      // the position NFT lives elsewhere; multiple means ambiguity. Never
      // take value[0] blindly.
      const nftMatches = nftAccs.value.filter(
        (a) => a.account.data.parsed.info.tokenAmount.amount === "1"
      );
      if (nftMatches.length !== 1)
        fail(
          `expected exactly one vault NFT account with amount 1, found ${nftMatches.length}`
        );
      const positionNftAccount = nftMatches[0].pubkey;
      const feeA = tokenAMint.equals(s.baseMint)
        ? s.vaultBaseAta
        : s.vaultWsolAta;
      const feeB = tokenBMint.equals(s.baseMint)
        ? s.vaultBaseAta
        : s.vaultWsolAta;
      const sig = await program.methods
        .claimDammFees()
        .accounts({
          state,
          vault,
          poolAuthority: DAMM_POOL_AUTHORITY,
          dammPool: s.dammPool,
          position: s.dammPosition,
          feeTokenAAccount: feeA,
          feeTokenBAccount: feeB,
          vaultA,
          vaultB,
          tokenAMint,
          tokenBMint,
          positionNftAccount,
          tokenAProgram: (await connection.getAccountInfo(tokenAMint))!.owner,
          tokenBProgram: (await connection.getAccountInfo(tokenBMint))!.owner,
          eventAuthority: eventAuth,
          dammProgram: DAMM_V2_PROGRAM,
        })
        .rpc();
      console.log(`claim_damm_fees: ${sig}`);
    } else {
      console.log("DAMM pool/position default; skipping DAMM claim");
    }
    const wAfter = await readTokenBal(s.vaultWsolAta);
    const delta = wAfter - wBefore;
    console.log(`claim wSOL delta=${delta} threshold=${warnClaimBelow}`);
    if (delta < warnClaimBelow)
      console.log(
        `WARN_CLAIM_BELOW threshold: delta=${delta} below ${warnClaimBelow}`
      );
  }

  const depositVaultSol = async (
    depositAmount: bigint,
    label: string
  ): Promise<void> => {
    if (depositAmount <= 0) fail(`${label}: deposit amount must be > 0`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const depBankRaw = coder.accounts.decode(
      "Bank",
      Buffer.from((await connection.getAccountInfo(s.solBank))!.data)
    ) as any;
    const depSig = await program.methods
      .depositSol(new anchor.BN(depositAmount.toString()))
      .accounts({
        state,
        vault,
        marginfiAccount: s.marginfiAccount,
        group: s.group,
        solBank: s.solBank,
        vaultWsolAta: s.vaultWsolAta,
        liquidityVault: (depBankRaw.liquidity_vault ??
          depBankRaw.liquidityVault) as PublicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        marginfiProgram: MARGINFI_V2,
      })
      .remainingAccounts(
        healthPairs.map((k) => ({
          pubkey: k,
          isWritable: false,
          isSigner: false,
        }))
      )
      .rpc();
    console.log(`deposit_sol ${label} ${depositAmount}: ${depSig}`);
  };

  if (depositLamports > 0) {
    const wrapTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: s.vaultWsolAta,
        lamports: Number(depositLamports),
      }),
      createSyncNativeInstruction(s.vaultWsolAta)
    );
    await provider.sendAndConfirm(wrapTx, [payer]);
    await depositVaultSol(depositLamports, "wrapped");
  }

  if (depositVaultWsol) {
    const vaultWsol = await readTokenBal(s.vaultWsolAta);
    if (vaultWsol === BigInt(0))
      fail(`vault wSOL is empty; claim fees or use --deposit-lamports first`);
    await depositVaultSol(vaultWsol, "existing-vault-wsol");
  }

  if (mode === "pause") {
    if (s.admin.toBase58() !== payer.publicKey.toBase58())
      fail("pause needs the admin keypair as payer");
    const sig = await program.methods
      .updateConfig(
        s.dammPool,
        s.dammPosition,
        s.sweepDestination,
        s.pumpPool,
        true
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    console.log(`update_config paused=true: ${sig}`);
    console.log("MANUAL_PAUSE_OK");
    return;
  }

  if (mode === "unwind") {
    if (s.admin.toBase58() !== payer.publicKey.toBase58())
      fail("unwind needs the admin keypair as payer");
    const pumpBal = await readTokenBal(s.vaultPumpAta);
    console.log(`vault PUMP before unwind: ${pumpBal} (fund cover first)`);
    if (pumpBal === BigInt(0))
      fail("vault PUMP is empty; fund debt+buffer before unwind");
    // SOL bank liquidity vault: read the live SOL bank account.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const solRaw = coder.accounts.decode(
      "Bank",
      Buffer.from((await connection.getAccountInfo(s.solBank))!.data)
    ) as any;
    const solLiqVault = (solRaw.liquidity_vault ??
      solRaw.liquidityVault) as PublicKey;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pumpRaw = coder.accounts.decode(
      "Bank",
      Buffer.from((await connection.getAccountInfo(s.pumpBank))!.data)
    ) as any;
    const pumpLiqVault = (pumpRaw.liquidity_vault ??
      pumpRaw.liquidityVault) as PublicKey;
    const pumpMintLive = pumpRaw.mint as PublicKey;
    const repaySig = await program.methods
      .repayAll(new anchor.BN(pumpBal.toString()))
      .accounts({
        state,
        admin: payer.publicKey,
        vault,
        marginfiAccount: s.marginfiAccount,
        group: s.group,
        pumpBank: s.pumpBank,
        vaultPumpAta: s.vaultPumpAta,
        bankLiquidityVault: pumpLiqVault,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        marginfiProgram: MARGINFI_V2,
      })
      .remainingAccounts(
        [pumpMintLive, ...healthPairs].map((k) => ({
          pubkey: k,
          isWritable: false,
          isSigner: false,
        }))
      )
      .rpc();
    console.log(`repay_all: ${repaySig}`);
    const withdrawSig = await program.methods
      .withdrawAll(new anchor.BN("18446744073709551615"))
      .accounts({
        state,
        admin: payer.publicKey,
        vault,
        marginfiAccount: s.marginfiAccount,
        group: s.group,
        solBank: s.solBank,
        vaultWsolAta: s.vaultWsolAta,
        bankLiquidityVaultAuthority: PublicKey.findProgramAddressSync(
          [Buffer.from("liquidity_vault_auth"), s.solBank.toBuffer()],
          MARGINFI_V2
        )[0],
        bankLiquidityVault: solLiqVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        marginfiProgram: MARGINFI_V2,
      })
      .remainingAccounts(
        healthPairs.map((k) => ({
          pubkey: k,
          isWritable: false,
          isSigner: false,
        }))
      )
      .rpc();
    console.log(`withdraw_all: ${withdrawSig}`);
    const wBal = await readTokenBal(s.vaultWsolAta);
    const destAta = (
      await import("@solana/spl-token")
    ).getAssociatedTokenAddressSync(NATIVE_MINT, s.sweepDestination, true);
    const sweepSig = await program.methods
      .sweepOut(new anchor.BN(wBal.toString()))
      .accounts({
        state,
        admin: payer.publicKey,
        vault,
        vaultWsolAta: s.vaultWsolAta,
        destination: destAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log(`sweep_out ${wBal}: ${sweepSig}`);
    await readHealth(connection, s.marginfiAccount, "health after unwind");
    console.log("MANUAL_UNWIND_OK");
    return;
  }

  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    DLMM_PROGRAM
  );
  const [pumpVaultAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth"), s.pumpBank.toBuffer()],
    MARGINFI_V2
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const solRaw2 = coder.accounts.decode(
    "Bank",
    Buffer.from((await connection.getAccountInfo(s.solBank))!.data)
  ) as any;
  const solLiqVault = (solRaw2.liquidity_vault ??
    solRaw2.liquidityVault) as PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pumpRaw2 = coder.accounts.decode(
    "Bank",
    Buffer.from((await connection.getAccountInfo(s.pumpBank))!.data)
  ) as any;
  const pumpLiqVault = (pumpRaw2.liquidity_vault ??
    pumpRaw2.liquidityVault) as PublicKey;
  const pumpMintLive = pumpRaw2.mint as PublicKey;
  const crankCuIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 400_000,
  });
  const crankIx = await program.methods
    .borrowSellDepositChecked(new anchor.BN(amount.toString()))
    .accounts({
      state,
      vault,
      marginfiAccount: s.marginfiAccount,
      group: s.group,
      solBank: s.solBank,
      pumpBank: s.pumpBank,
      vaultWsolAta: s.vaultWsolAta,
      vaultPumpAta: s.vaultPumpAta,
      bankLiquidityVaultAuthority: pumpVaultAuth,
      bankLiquidityVault: pumpLiqVault,
      solBankLiquidityVault: solLiqVault,
      tokenXProgram: TOKEN_2022_PROGRAM_ID,
      tokenYProgram: TOKEN_PROGRAM_ID,
      dlmmPool: s.pumpPool,
      dlmmReserveX: dlmm.lbPair.reserveX,
      dlmmReserveY: dlmm.lbPair.reserveY,
      dlmmOracle: dlmm.lbPair.oracle,
      dlmmBitmap: bitmap,
      tokenXMint: pumpMintLive,
      tokenYMint: NATIVE_MINT,
      memoProgram: MEMO_PROGRAM,
      eventAuthority,
      dlmmProgram: DLMM_PROGRAM,
      marginfiProgram: MARGINFI_V2,
    })
    .remainingAccounts([
      { pubkey: pumpMintLive, isWritable: false, isSigner: false },
      ...healthPairs.map((k) => ({
        pubkey: k,
        isWritable: false,
        isSigner: false,
      })),
      ...quoteBins,
    ])
    .instruction();
  const sig = await provider.sendAndConfirm(
    new Transaction().add(crankCuIx, crankIx),
    [payer]
  );
  console.log(`borrow_sell_deposit_checked: ${sig}`);
  // Decode and print the event.
  const tx = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const evCoder = new BorshCoder(program.idl);
  for (const line of tx?.meta?.logMessages ?? []) {
    const m = line.match(/Program data: (\S+)/);
    if (!m) continue;
    try {
      const ev = evCoder.events.decode(m[1]);
      if (ev && ev.name === "EvtBorrowSellDeposit") {
        const d = ev.data as any;
        const pump = d.pumpAmount ?? d.pump_amount;
        const out = d.solOut ?? d.sol_out;
        const ihf = d.initialHfBps ?? d.initial_hf_bps;
        const mhf = d.maintHfBps ?? d.maint_hf_bps;
        console.log(
          `event: pump_amount=${pump} sol_out=${out} initial_hf_bps=${ihf} maint_hf_bps=${mhf}`
        );
        break;
      }
    } catch {
      continue;
    }
  }
  await readHealth(connection, s.marginfiAccount, "health after");
  console.log("MANUAL_CRANK_OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
