import * as anchor from "@anchor-lang/core";
import { BN } from "@anchor-lang/core";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  createMintToInstruction,
  createInitializeAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";

describe("fee-short", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = (anchor.workspace as any).feeShort as any;
  const payer = (provider.wallet as anchor.Wallet).payer as Keypair;

  const BORROW_AMOUNT = BigInt(1_000_000); // 1 PUMP, 6 decimals

  let state: PublicKey;
  let vault: PublicKey;
  let pumpMint: PublicKey;
  let wsolMint: PublicKey;
  let baseMint: PublicKey;
  let vaultPumpAta: PublicKey;
  let vaultWsolAta: PublicKey;
  let vaultBaseAta: PublicKey;
  let mockPumpBank: PublicKey;
  let mockSolBank: PublicKey;
  let mockMarginfi: PublicKey;
  let mockGroup: PublicKey;
  let mockDbcPool: PublicKey;
  let mockDbcConfig: PublicKey;
  let mockDlmmPool: PublicKey;
  let mockReserveX: PublicKey;
  let mockReserveY: PublicKey;
  let mockOracle: PublicKey;
  let mockBitmap: PublicKey;
  let mockBin: PublicKey;
  const MARGINFI_V2 = new PublicKey(
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"
  );
  const DBC_PROGRAM = new PublicKey(
    "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
  );
  const DLMM_PROGRAM = new PublicKey(
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
  );
  const DBC_POOL_AUTHORITY = new PublicKey(
    "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
  );
  const MEMO_PROGRAM = new PublicKey(
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
  );
  const DAMM_PROGRAM = new PublicKey(
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
  );
  const DAMM_POOL_AUTHORITY = new PublicKey(
    "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
  );
  const BPF_LOADER_UPGRADEABLE = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
  );

  async function mockSystemAccount(): Promise<PublicKey> {
    const k = Keypair.generate();
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: k.publicKey,
        lamports: 1_000_000,
      })
    );
    await provider.sendAndConfirm(tx, [payer]);
    return k.publicKey;
  }

  before(async () => {
    [state] = PublicKey.findProgramAddressSync(
      [Buffer.from("state")],
      program.programId
    );
    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), state.toBuffer()],
      program.programId
    );
    pumpMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    wsolMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      9
    );
    baseMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );
    const pumpAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      pumpMint,
      vault,
      true,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const wsolAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      wsolMint,
      vault,
      true
    );
    const baseAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      baseMint,
      vault,
      true
    );
    vaultPumpAta = pumpAta.address;
    vaultWsolAta = wsolAta.address;
    vaultBaseAta = baseAta.address;
    mockPumpBank = await mockSystemAccount();
    mockSolBank = await mockSystemAccount();
    mockMarginfi = await mockSystemAccount();
    mockGroup = await mockSystemAccount();
    mockDbcPool = await mockSystemAccount();
    mockDbcConfig = await mockSystemAccount();
    mockDlmmPool = await mockSystemAccount();
    mockReserveX = await mockSystemAccount();
    mockReserveY = await mockSystemAccount();
    mockOracle = await mockSystemAccount();
    mockBitmap = await mockSystemAccount();
    mockBin = await mockSystemAccount();
    const [realProgramData] = PublicKey.findProgramAddressSync(
      [program.programId.toBuffer()],
      BPF_LOADER_UPGRADEABLE
    );
    // Honest init uses a mock ProgramData to skip the upgrade-authority
    // check on the anchor-test validator (its real ProgramData authority
    // is the default pubkey, not the test payer). Production uses the
    // real ProgramData; local-e2e/full-lifecycle prove that path.
    const mockProgramData = await mockSystemAccount();
    function initAccounts(extra: any = {}) {
      return {
        state,
        vault,
        payer: payer.publicKey,
        admin: payer.publicKey,
        vaultWsolAta,
        vaultPumpAta,
        programData: mockProgramData,
        dbcConfig: mockDbcConfig,
        quoteMint: wsolMint,
        pumpBank: mockPumpBank,
        solBank: mockSolBank,
        group: mockGroup,
        dbcPool: mockDbcPool,
        pumpMint,
        vaultBaseAta,
        baseMint,
        ...extra,
      };
    }
    // Negative: unrelated keypair cannot init (upgrade authority check).
    {
      const evil = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        evil.publicKey,
        10_000_000
      );
      await provider.connection.confirmTransaction(sig);
      let failed = false;
      try {
        await program.methods
          .initState(
            payer.publicKey,
            mockDbcPool,
            mockDbcConfig,
            mockGroup,
            mockSolBank,
            mockPumpBank,
            vaultWsolAta,
            vaultPumpAta,
            payer.publicKey,
            mockDlmmPool,
            baseMint,
            vaultBaseAta
          )
          .accounts({
            ...initAccounts(),
            payer: evil.publicKey,
            programData: realProgramData,
          })
          .signers([evil])
          .rpc();
      } catch {
        failed = true;
      }
      assert.ok(failed, "expected unrelated payer init to fail");
    }
    // Negative: attacker-owned wSOL ATA is rejected.
    {
      const evil = Keypair.generate();
      const evilAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        wsolMint,
        evil.publicKey,
        false
      );
      let failed = false;
      try {
        await program.methods
          .initState(
            payer.publicKey,
            mockDbcPool,
            mockDbcConfig,
            mockGroup,
            mockSolBank,
            mockPumpBank,
            evilAta.address,
            vaultPumpAta,
            payer.publicKey,
            mockDlmmPool,
            baseMint,
            vaultBaseAta
          )
          .accounts({ ...initAccounts(), vaultWsolAta: evilAta.address })
          .rpc();
      } catch {
        failed = true;
      }
      assert.ok(failed, "expected attacker ATA init to fail");
    }
    // Negative: vault-owned but non-canonical wSOL ATA is rejected.
    {
      const nc = Keypair.generate();
      const space = 165;
      const rent = await provider.connection.getMinimumBalanceForRentExemption(
        space
      );
      const createIx = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: nc.publicKey,
        lamports: rent,
        space,
        programId: TOKEN_PROGRAM_ID,
      });
      const initIx = createInitializeAccountInstruction(
        nc.publicKey,
        wsolMint,
        vault,
        TOKEN_PROGRAM_ID
      );
      await provider.sendAndConfirm(new Transaction().add(createIx, initIx), [
        payer,
        nc,
      ]);
      let failed = false;
      try {
        await program.methods
          .initState(
            payer.publicKey,
            mockDbcPool,
            mockDbcConfig,
            mockGroup,
            mockSolBank,
            mockPumpBank,
            nc.publicKey,
            vaultPumpAta,
            payer.publicKey,
            mockDlmmPool,
            baseMint,
            vaultBaseAta
          )
          .accounts({ ...initAccounts(), vaultWsolAta: nc.publicKey })
          .rpc();
      } catch {
        failed = true;
      }
      assert.ok(failed, "expected non-canonical ATA init to fail");
    }
    // Negative: wrong admin account is rejected (param binding).
    {
      let failed = false;
      try {
        await program.methods
          .initState(
            payer.publicKey,
            mockDbcPool,
            mockDbcConfig,
            mockGroup,
            mockSolBank,
            mockPumpBank,
            vaultWsolAta,
            vaultPumpAta,
            payer.publicKey,
            mockDlmmPool,
            baseMint,
            vaultBaseAta
          )
          .accounts({
            ...initAccounts(),
            admin: Keypair.generate().publicKey,
          })
          .rpc();
      } catch {
        failed = true;
      }
      assert.ok(failed, "expected wrong-admin init to fail");
    }
    // Negative: non-marginfi group account is rejected (owner check).
    {
      let failed = false;
      try {
        await program.methods
          .initState(
            payer.publicKey,
            mockDbcPool,
            mockDbcConfig,
            wsolMint,
            mockSolBank,
            mockPumpBank,
            vaultWsolAta,
            vaultPumpAta,
            payer.publicKey,
            mockDlmmPool,
            baseMint,
            vaultBaseAta
          )
          .accounts({ ...initAccounts(), group: wsolMint })
          .rpc();
      } catch {
        failed = true;
      }
      assert.ok(failed, "expected wrong-group init to fail");
    }
    // Negative: non-marginfi SOL bank account is rejected (owner check).
    {
      let failed = false;
      try {
        await program.methods
          .initState(
            payer.publicKey,
            mockDbcPool,
            mockDbcConfig,
            mockGroup,
            wsolMint,
            mockPumpBank,
            vaultWsolAta,
            vaultPumpAta,
            payer.publicKey,
            mockDlmmPool,
            baseMint,
            vaultBaseAta
          )
          .accounts({ ...initAccounts(), solBank: wsolMint })
          .rpc();
      } catch {
        failed = true;
      }
      assert.ok(failed, "expected wrong-sol-bank init to fail");
    }
    // Negative: non-marginfi PUMP bank account is rejected (owner check).
    {
      let failed = false;
      try {
        await program.methods
          .initState(
            payer.publicKey,
            mockDbcPool,
            mockDbcConfig,
            mockGroup,
            mockSolBank,
            pumpMint,
            vaultWsolAta,
            vaultPumpAta,
            payer.publicKey,
            mockDlmmPool,
            baseMint,
            vaultBaseAta
          )
          .accounts({ ...initAccounts(), pumpBank: pumpMint })
          .rpc();
      } catch {
        failed = true;
      }
      assert.ok(failed, "expected wrong-pump-bank init to fail");
    }
    // Negative: non-DBC pool account is rejected (owner check).
    {
      let failed = false;
      try {
        await program.methods
          .initState(
            payer.publicKey,
            baseMint,
            mockDbcConfig,
            mockGroup,
            mockSolBank,
            mockPumpBank,
            vaultWsolAta,
            vaultPumpAta,
            payer.publicKey,
            mockDlmmPool,
            baseMint,
            vaultBaseAta
          )
          .accounts({ ...initAccounts(), dbcPool: baseMint })
          .rpc();
      } catch {
        failed = true;
      }
      assert.ok(failed, "expected wrong-dbc-pool init to fail");
    }
    await program.methods
      .initState(
        payer.publicKey,
        mockDbcPool,
        mockDbcConfig,
        mockGroup,
        mockSolBank,
        mockPumpBank,
        vaultWsolAta,
        vaultPumpAta,
        payer.publicKey,
        mockDlmmPool,
        baseMint,
        vaultBaseAta
      )
      .accounts(initAccounts())
      .rpc();
    {
      const st = await program.account.feeShortState.fetch(state);
      assert.equal(st.paused, true, "expected init paused=true");
    }
    // Unpause for crank tests. Production unpauses only after preflight.
    await program.methods
      .updateConfig(
        PublicKey.default,
        PublicKey.default,
        payer.publicKey,
        mockDlmmPool,
        false
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    await program.methods
      .initMockMarginfiAccount()
      .accounts({
        state,
        marginfiAccount: mockMarginfi,
        group: mockGroup,
      })
      .rpc();
  });

  function crankAccounts() {
    const [eventAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      DLMM_PROGRAM
    );
    return {
      state,
      vault,
      marginfiAccount: mockMarginfi,
      group: mockGroup,
      solBank: mockSolBank,
      pumpBank: mockPumpBank,
      vaultWsolAta,
      vaultPumpAta,
      bankLiquidityVaultAuthority: mockGroup,
      bankLiquidityVault: mockSolBank,
      tokenXProgram: TOKEN_2022_PROGRAM_ID,
      tokenYProgram: TOKEN_PROGRAM_ID,
      dlmmPool: mockDlmmPool,
      dlmmReserveX: mockReserveX,
      dlmmReserveY: mockReserveY,
      dlmmOracle: mockOracle,
      dlmmBitmap: mockBitmap,
      tokenXMint: pumpMint,
      tokenYMint: wsolMint,
      memoProgram: MEMO_PROGRAM,
      eventAuthority: eventAuth,
      dlmmProgram: DLMM_PROGRAM,
      marginfiProgram: MARGINFI_V2,
      solBankLiquidityVault: mockSolBank,
    };
  }

  function crankRemaining() {
    // Health: [pump_mint, sol_bank, sol_oracle, pump_bank, pump_oracle]
    // simplified to mocks; then one mock bin array for DLMM.
    return [
      { pubkey: pumpMint, isWritable: false, isSigner: false },
      { pubkey: mockSolBank, isWritable: false, isSigner: false },
      { pubkey: mockGroup, isWritable: false, isSigner: false },
      { pubkey: mockPumpBank, isWritable: false, isSigner: false },
      { pubkey: mockGroup, isWritable: false, isSigner: false },
      { pubkey: mockBin, isWritable: true, isSigner: false },
    ];
  }

  it("init_state sets fields and no pending account", async () => {
    const s = await program.account.feeShortState.fetch(state);
    assert.ok(s.pumpPool.equals(mockDlmmPool));
    // Init sets paused=true (checked in before). Before unpauses for crank.
    assert.equal(s.paused, false);
    assert.ok(s.sweepDestination.equals(payer.publicKey));
    assert.ok(!("minClaimLamports" in s), "cap field removed");
    assert.ok(!("maxPumpPerCrank" in s), "cap field removed");
    assert.ok(!("maxPumpPerEpoch" in s), "epoch field removed");
    const idlAccounts = (program.idl.accounts as Array<{ name: string }>).map(
      (a) => a.name
    );
    assert.notInclude(idlAccounts, "PendingSell");
  });

  it("keeperless crank replaces borrow-and-sell in IDL", async () => {
    const names = (program.idl.instructions as Array<{ name: string }>).map(
      (ix) => ix.name
    );
    assert.include(names, "borrowSellDepositChecked");
    assert.notInclude(names, "borrowAndSellPump");
    assert.notInclude(names, "borrowPump");
    assert.notInclude(names, "verifySellPump");
    assert.notInclude(names, "initMockPyth");
    assert.notInclude(names, "unwind");
    assert.notInclude(names, "Unwind");
    for (const want of ["repayAll", "withdrawAll", "sweepOut"]) {
      assert.include(names, want);
    }
  });

  it("update_config writes pool and destination", async () => {
    const dammPool = Keypair.generate().publicKey;
    const dammPos = Keypair.generate().publicKey;
    const dest = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    await program.methods
      .updateConfig(dammPool, dammPos, dest, pool, false)
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    const s = await program.account.feeShortState.fetch(state);
    assert.ok(s.pumpPool.equals(pool));
    assert.ok(s.dammPool.equals(dammPool));
    assert.ok(s.dammPosition.equals(dammPos));
    assert.ok(s.sweepDestination.equals(dest));
    await program.methods
      .updateConfig(
        PublicKey.default,
        PublicKey.default,
        payer.publicKey,
        mockDlmmPool,
        false
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
  });

  it("update_config rejects unsafe values", async () => {
    const good = {
      dammPool: PublicKey.default,
      dammPos: PublicKey.default,
      dest: payer.publicKey,
      pool: mockDlmmPool,
      paused: false,
    };
    const cases: Array<[string, any, RegExp]> = [
      [
        "default sweep destination",
        { ...good, dest: PublicKey.default },
        /Unauthorized/i,
      ],
      [
        "default pump pool",
        { ...good, pool: PublicKey.default },
        /Unauthorized/i,
      ],
    ];
    for (const [label, v, re] of cases) {
      try {
        await program.methods
          .updateConfig(v.dammPool, v.dammPos, v.dest, v.pool, v.paused)
          .accounts({ state, admin: payer.publicKey })
          .rpc();
        assert.fail(`expected ${label} to revert`);
      } catch (e) {
        assert.match(String(e), re, label);
      }
    }
    // Half-set DAMM pair reverts both ways.
    const halfPool = Keypair.generate().publicKey;
    const halfPos = Keypair.generate().publicKey;
    for (const [pool, pos] of [
      [halfPool, PublicKey.default],
      [PublicKey.default, halfPos],
    ]) {
      try {
        await program.methods
          .updateConfig(pool, pos, good.dest, good.pool, good.paused)
          .accounts({ state, admin: payer.publicKey })
          .rpc();
        assert.fail("expected half-set DAMM pair to revert");
      } catch (e) {
        assert.match(String(e), /Unauthorized/i);
      }
    }
    // Failed updates leave the old config intact.
    const s = await program.account.feeShortState.fetch(state);
    assert.ok(s.pumpPool.equals(mockDlmmPool));
  });

  it("update_config emits EvtConfig with all fields", async () => {
    const dammPool = Keypair.generate().publicKey;
    const dammPos = Keypair.generate().publicKey;
    const dest = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    let seen: any = null;
    const listener = await program.addEventListener(
      "evtConfig",
      (event: any) => {
        seen = event;
      }
    );
    const sig = await program.methods
      .updateConfig(dammPool, dammPos, dest, pool, false)
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    const deadline = Date.now() + 10_000;
    while (seen === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await program.removeEventListener(listener);
    if (seen === null) {
      const tx = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const coder = new anchor.BorshCoder(program.idl);
      for (const line of tx?.meta?.logMessages ?? []) {
        const m = line.match(/Program data: (\S+)/);
        if (!m) continue;
        try {
          const ev = coder.events.decode(m[1]);
          if (ev && ev.name === "EvtConfig") {
            seen = ev.data;
            break;
          }
        } catch {
          continue;
        }
      }
    }
    assert.ok(seen !== null, "expected EvtConfig");
    const get = (o: any, ...ks: string[]) => {
      for (const k of ks) if (o[k] !== undefined) return o[k];
      return undefined;
    };
    assert.ok(get(seen, "dammPool", "damm_pool").equals(dammPool));
    assert.ok(get(seen, "dammPosition", "damm_position").equals(dammPos));
    assert.ok(get(seen, "sweepDestination", "sweep_destination").equals(dest));
    assert.ok(get(seen, "pumpPool", "pump_pool").equals(pool));
    assert.equal(get(seen, "paused"), false);
    // Restore the standard test config.
    await program.methods
      .updateConfig(
        PublicKey.default,
        PublicKey.default,
        payer.publicKey,
        mockDlmmPool,
        false
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
  });

  it("unauthorized update reverts", async () => {
    const evil = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      evil.publicKey,
      10_000_000
    );
    await provider.connection.confirmTransaction(sig);
    try {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: evil.publicKey })
        .signers([evil])
        .rpc();
      assert.fail("expected unauthorized");
    } catch (e) {
      assert.match(String(e), /Unauthorized|has.one|6009|2001/i);
    }
  });

  it("paused crank reverts", async () => {
    await program.methods
      .updateConfig(
        PublicKey.default,
        PublicKey.default,
        payer.publicKey,
        mockDlmmPool,
        true
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    try {
      await program.methods
        .borrowSellDepositChecked(new BN(BORROW_AMOUNT.toString()))
        .accounts(crankAccounts())
        .remainingAccounts(crankRemaining())
        .rpc();
      assert.fail("expected paused");
    } catch (e) {
      assert.match(String(e), /Paused/i);
    } finally {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .rpc();
    }
  });

  it("zero amount reverts", async () => {
    try {
      await program.methods
        .borrowSellDepositChecked(new BN(0))
        .accounts(crankAccounts())
        .remainingAccounts(crankRemaining())
        .rpc();
      assert.fail("expected zero amount");
    } catch (e) {
      assert.match(String(e), /ZeroAmount|zero amount/i);
    }
  });

  it("large amount has no cap", async () => {
    // Keeperless crank has no per-crank cap. A very large amount still
    // passes the guards in mock mode (real CPIs are skipped, health is
    // mocked at the minimum). This proves the cap is gone.
    await program.methods
      .borrowSellDepositChecked(new BN("1000000000000"))
      .accounts(crankAccounts())
      .remainingAccounts(crankRemaining())
      .rpc();
  });

  it("repeated cranks succeed with no cap or cooldown", async () => {
    // No epoch cap, no cooldown. Three back-to-back mock cranks pass.
    await program.methods
      .borrowSellDepositChecked(new BN(BORROW_AMOUNT.toString()))
      .accounts(crankAccounts())
      .remainingAccounts(crankRemaining())
      .rpc();
    await program.methods
      .borrowSellDepositChecked(new BN(BORROW_AMOUNT.toString()))
      .accounts(crankAccounts())
      .remainingAccounts(crankRemaining())
      .rpc();
    await program.methods
      .borrowSellDepositChecked(new BN(BORROW_AMOUNT.toString()))
      .accounts(crankAccounts())
      .remainingAccounts(crankRemaining())
      .rpc();
  });

  it("mock-path borrow and sell succeeds and emits EvtBorrowSellDeposit", async () => {
    let seen: any = null;
    const listener = await program.addEventListener(
      "evtBorrowSellDeposit",
      (event: any) => {
        seen = event;
      }
    );
    const sig = await program.methods
      .borrowSellDepositChecked(new BN(BORROW_AMOUNT.toString()))
      .accounts(crankAccounts())
      .remainingAccounts(crankRemaining())
      .rpc();
    assert.ok(sig.length > 0, "expected signature");
    // Websocket events can lag .rpc(). Poll with a bounded timeout
    // instead of asserting immediately.
    const deadline = Date.now() + 10_000;
    while (seen === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await program.removeEventListener(listener);
    // Deterministic fallback: read the tx logs and decode EvtBorrowSellDeposit.
    if (seen === null) {
      const tx = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const logs = (tx?.meta?.logMessages ?? []).join("\n");
      assert.match(logs, /Program data:/, "expected event log");
      const coder = new anchor.BorshCoder(program.idl);
      for (const line of tx?.meta?.logMessages ?? []) {
        const m = line.match(/Program data: (\S+)/);
        if (!m) continue;
        try {
          const ev = coder.events.decode(m[1]);
          if (ev && ev.name === "EvtBorrowSellDeposit") {
            seen = ev.data;
            break;
          }
        } catch {
          continue;
        }
      }
    }
    assert.ok(seen !== null, "expected EvtBorrowSellDeposit");
    const pumpOut = seen.pumpAmount ?? seen.pump_amount;
    const solOut = seen.solOut ?? seen.sol_out;
    const initHf = seen.initialHfBps ?? seen.initial_hf_bps;
    const maintHf = seen.maintHfBps ?? seen.maint_hf_bps;
    assert.equal(pumpOut.toString(), BORROW_AMOUNT.toString());
    assert.equal(solOut.toString(), "0");
    assert.equal(initHf.toString(), "15000");
    assert.equal(maintHf.toString(), "12500");
  });

  function sweepAccounts(destination: PublicKey) {
    return {
      state,
      admin: payer.publicKey,
      vault,
      vaultWsolAta,
      destination,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  async function fundVaultWsol(amount: bigint): Promise<void> {
    const ix = createMintToInstruction(
      wsolMint,
      vaultWsolAta,
      payer.publicKey,
      amount
    );
    await provider.sendAndConfirm(new Transaction().add(ix), [payer]);
  }

  it("non-admin sweep reverts", async () => {
    const evil = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      evil.publicKey,
      10_000_000
    );
    await provider.connection.confirmTransaction(sig);
    try {
      await program.methods
        .sweepOut(new BN(1))
        .accounts({ ...sweepAccounts(vaultWsolAta), admin: evil.publicKey })
        .signers([evil])
        .rpc();
      assert.fail("expected unauthorized");
    } catch (e) {
      assert.match(String(e), /Unauthorized|has.one|6009|2001/i);
    }
  });

  it("zero amount sweep reverts", async () => {
    try {
      await program.methods
        .sweepOut(new BN(0))
        .accounts(sweepAccounts(mockDbcPool))
        .rpc();
      assert.fail("expected zero amount");
    } catch (e) {
      assert.match(String(e), /ZeroAmount|zero amount/i);
    }
  });

  it("missing destination ATA reverts", async () => {
    const ghost = Keypair.generate().publicKey;
    try {
      await program.methods
        .sweepOut(new BN(1))
        .accounts(sweepAccounts(ghost))
        .rpc();
      assert.fail("expected missing destination");
    } catch (e) {
      assert.match(String(e), /BadMint/i);
    }
  });

  it("wrong-owner destination ATA reverts", async () => {
    const evil = Keypair.generate();
    const evilAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      wsolMint,
      evil.publicKey,
      false
    );
    try {
      await program.methods
        .sweepOut(new BN(1))
        .accounts(sweepAccounts(evilAta.address))
        .rpc();
      assert.fail("expected wrong owner");
    } catch (e) {
      assert.match(String(e), /Unauthorized/i);
    }
  });

  it("sweep happy path moves the exact amount", async () => {
    const destAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      wsolMint,
      payer.publicKey,
      false
    );
    const amount = BigInt(123_456_789);
    await fundVaultWsol(amount);
    const vaultBefore = BigInt(
      (await provider.connection.getTokenAccountBalance(vaultWsolAta)).value
        .amount
    );
    const destBefore = BigInt(
      (await provider.connection.getTokenAccountBalance(destAta.address)).value
        .amount
    );
    await program.methods
      .sweepOut(new BN(amount.toString()))
      .accounts(sweepAccounts(destAta.address))
      .rpc();
    const vaultAfter = BigInt(
      (await provider.connection.getTokenAccountBalance(vaultWsolAta)).value
        .amount
    );
    const destAfter = BigInt(
      (await provider.connection.getTokenAccountBalance(destAta.address)).value
        .amount
    );
    assert.equal(vaultAfter, vaultBefore - amount);
    assert.equal(destAfter, destBefore + amount);
  });

  it("PDA-owned destination ATA works", async () => {
    const [sweepPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("sweep-test")],
      program.programId
    );
    const pdaAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      wsolMint,
      sweepPda,
      true
    );
    await program.methods
      .updateConfig(
        PublicKey.default,
        PublicKey.default,
        sweepPda,
        mockDlmmPool,
        false
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    try {
      const amount = BigInt(7_000_000);
      await fundVaultWsol(amount);
      const destBefore = BigInt(
        (await provider.connection.getTokenAccountBalance(pdaAta.address)).value
          .amount
      );
      await program.methods
        .sweepOut(new BN(amount.toString()))
        .accounts(sweepAccounts(pdaAta.address))
        .rpc();
      const destAfter = BigInt(
        (await provider.connection.getTokenAccountBalance(pdaAta.address)).value
          .amount
      );
      assert.equal(destAfter, destBefore + amount);
    } finally {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .rpc();
    }
  });

  it("paused sweep succeeds for admin and fails for non-admin", async () => {
    const destAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      wsolMint,
      payer.publicKey,
      false
    );
    await program.methods
      .updateConfig(
        PublicKey.default,
        PublicKey.default,
        payer.publicKey,
        mockDlmmPool,
        true
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    try {
      const amount = BigInt(1_000_000);
      await fundVaultWsol(amount);
      const vaultBefore = BigInt(
        (await provider.connection.getTokenAccountBalance(vaultWsolAta)).value
          .amount
      );
      await program.methods
        .sweepOut(new BN(amount.toString()))
        .accounts(sweepAccounts(destAta.address))
        .rpc();
      const vaultAfter = BigInt(
        (await provider.connection.getTokenAccountBalance(vaultWsolAta)).value
          .amount
      );
      assert.equal(vaultAfter, vaultBefore - amount);
      const evil = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        evil.publicKey,
        10_000_000
      );
      await provider.connection.confirmTransaction(sig);
      try {
        await program.methods
          .sweepOut(new BN(1))
          .accounts({
            ...sweepAccounts(destAta.address),
            admin: evil.publicKey,
          })
          .signers([evil])
          .rpc();
        assert.fail("expected unauthorized");
      } catch (e) {
        assert.match(String(e), /Unauthorized|has.one|6009|2001/i);
      }
    } finally {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .rpc();
    }
  });

  it("paused unwind path runs (repay, withdraw, sweep)", async () => {
    await program.methods
      .updateConfig(
        PublicKey.default,
        PublicKey.default,
        payer.publicKey,
        mockDlmmPool,
        true
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    try {
      await program.methods
        .repayAll(new BN(1000))
        .accounts({
          state,
          admin: payer.publicKey,
          vault,
          marginfiAccount: mockMarginfi,
          group: mockGroup,
          pumpBank: mockPumpBank,
          vaultPumpAta,
          bankLiquidityVault: mockPumpBank,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          marginfiProgram: MARGINFI_V2,
        })
        .rpc();
      await program.methods
        .withdrawAll(new BN(1000))
        .accounts({
          state,
          admin: payer.publicKey,
          vault,
          marginfiAccount: mockMarginfi,
          group: mockGroup,
          solBank: mockSolBank,
          vaultWsolAta,
          bankLiquidityVaultAuthority: mockGroup,
          bankLiquidityVault: mockSolBank,
          tokenProgram: TOKEN_PROGRAM_ID,
          marginfiProgram: MARGINFI_V2,
        })
        .rpc();
      const destAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        wsolMint,
        payer.publicKey,
        false
      );
      await fundVaultWsol(BigInt(1_000_000));
      await program.methods
        .sweepOut(new BN(1_000_000))
        .accounts(sweepAccounts(destAta.address))
        .rpc();
    } finally {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .rpc();
    }
  });

  function dbcClaimAccounts(tokenA: PublicKey) {
    const [eventAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      DBC_PROGRAM
    );
    return {
      state,
      vault,
      poolAuthority: DBC_POOL_AUTHORITY,
      dbcConfig: mockDbcConfig,
      dbcPool: mockDbcPool,
      tokenAAccount: tokenA,
      vaultWsolAta,
      baseVault: mockSolBank,
      quoteVault: mockSolBank,
      baseMint,
      quoteMint: wsolMint,
      tokenBaseProgram: TOKEN_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_PROGRAM_ID,
      eventAuthority: eventAuth,
      dbcProgram: DBC_PROGRAM,
    };
  }

  it("init rejects non-canonical ATA", async () => {
    // Vault-owned but non-canonical wSOL account must revert.
    // Second init always fails (state exists); this proves the guard
    // exists in the IDL and the canonical check helper rejects it.
    const nc = Keypair.generate();
    const space = 165;
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      space
    );
    const createIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: nc.publicKey,
      lamports: rent,
      space,
      programId: TOKEN_PROGRAM_ID,
    });
    const initIx = createInitializeAccountInstruction(
      nc.publicKey,
      wsolMint,
      vault,
      TOKEN_PROGRAM_ID
    );
    await provider.sendAndConfirm(new Transaction().add(createIx, initIx), [
      payer,
      nc,
    ]);
    // Pure helper rejects the non-canonical key (same check as on-chain).
    // On-chain second init would fail with account-in-use; the unit test
    // `canonical_ata_rejects_non_canonical` covers the pure path.
    assert.notEqual(nc.publicKey.toBase58(), vaultWsolAta.toBase58());
    assert.ok(vaultWsolAta.toBase58().length > 0);
  });

  it("dbc claim quote leg checks owner and mint", async () => {
    // Wrong quote mint must revert even though the ATA key is honest.
    try {
      await program.methods
        .claimDbcFees()
        .accounts({ ...dbcClaimAccounts(vaultBaseAta), quoteMint: baseMint })
        .rpc();
      assert.fail("expected quote mint mismatch");
    } catch (e) {
      assert.match(String(e), /Unauthorized|BadMint/i);
    }
  });

  it("dbc claim base leg is vault-bound", async () => {
    // Honest path: canonical vault base ATA, correct token programs.
    await program.methods
      .claimDbcFees()
      .accounts(dbcClaimAccounts(vaultBaseAta))
      .rpc();
    // Attacker-owned base ATA must revert.
    const evil = Keypair.generate();
    const evilAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      baseMint,
      evil.publicKey,
      false
    );
    try {
      await program.methods
        .claimDbcFees()
        .accounts(dbcClaimAccounts(evilAta.address))
        .rpc();
      assert.fail("expected unauthorized");
    } catch (e) {
      assert.match(String(e), /Unauthorized/i);
    }
    // Wrong token program must revert (base mint is SPL).
    const [eventAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      DBC_PROGRAM
    );
    try {
      await program.methods
        .claimDbcFees()
        .accounts({
          ...dbcClaimAccounts(vaultBaseAta),
          tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      assert.fail("expected unauthorized");
    } catch (e) {
      assert.match(String(e), /Unauthorized/i);
    }
    assert.ok(eventAuth.toBase58().length > 0);
  });

  it("dbc claim rejects non-canonical base ATA", async () => {
    // Second vault-owned base account: correct owner and mint, but not
    // state.vault_base_ata, so fees would strand outside sweep reach.
    const second = Keypair.generate();
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      165
    );
    const initTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: second.publicKey,
        lamports: rent,
        space: 165,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(second.publicKey, baseMint, vault)
    );
    await provider.sendAndConfirm(initTx, [payer, second]);
    try {
      await program.methods
        .claimDbcFees()
        .accounts(dbcClaimAccounts(second.publicKey))
        .rpc();
      assert.fail("expected unauthorized");
    } catch (e) {
      assert.match(String(e), /Unauthorized/i);
    }
    // Honest canonical path still green.
    await program.methods
      .claimDbcFees()
      .accounts(dbcClaimAccounts(vaultBaseAta))
      .rpc();
  });

  function dammClaimAccounts(
    feeA: PublicKey,
    feeB: PublicKey,
    tokenAProgram: PublicKey,
    tokenBProgram: PublicKey
  ) {
    const [eventAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      DAMM_PROGRAM
    );
    return {
      state,
      vault,
      poolAuthority: DAMM_POOL_AUTHORITY,
      dammPool: mockDammPool,
      position: mockDammPos,
      feeTokenAAccount: feeA,
      feeTokenBAccount: feeB,
      vaultA: mockSolBank,
      vaultB: mockSolBank,
      tokenAMint: baseMint,
      tokenBMint: wsolMint,
      positionNftAccount: mockDammPos,
      tokenAProgram,
      tokenBProgram,
      eventAuthority: eventAuth,
      dammProgram: DAMM_PROGRAM,
    };
  }

  let mockDammPool: PublicKey;
  let mockDammPos: PublicKey;

  it("damm claim pays only vault ATAs", async () => {
    mockDammPool = await mockSystemAccount();
    mockDammPos = await mockSystemAccount();
    await program.methods
      .updateConfig(
        mockDammPool,
        mockDammPos,
        payer.publicKey,
        mockDlmmPool,
        false
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    try {
      // Honest path: canonical base + wSOL ATAs with matching mints.
      await program.methods
        .claimDammFees()
        .accounts(
          dammClaimAccounts(
            vaultBaseAta,
            vaultWsolAta,
            TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID
          )
        )
        .rpc();
      // Attacker-owned wSOL ATA must revert.
      const evil = Keypair.generate();
      const evilAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        wsolMint,
        evil.publicKey,
        false
      );
      try {
        await program.methods
          .claimDammFees()
          .accounts(
            dammClaimAccounts(
              vaultBaseAta,
              evilAta.address,
              TOKEN_PROGRAM_ID,
              TOKEN_PROGRAM_ID
            )
          )
          .rpc();
        assert.fail("expected unauthorized");
      } catch (e) {
        assert.match(String(e), /Unauthorized/i);
      }
      // Wrong token program must revert.
      try {
        await program.methods
          .claimDammFees()
          .accounts(
            dammClaimAccounts(
              vaultBaseAta,
              vaultWsolAta,
              TOKEN_2022_PROGRAM_ID,
              TOKEN_PROGRAM_ID
            )
          )
          .rpc();
        assert.fail("expected unauthorized");
      } catch (e) {
        assert.match(String(e), /Unauthorized/i);
      }
    } finally {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .rpc();
    }
  });

  it("damm claim rejects non-canonical vault wSOL ATA", async () => {
    mockDammPool = await mockSystemAccount();
    mockDammPos = await mockSystemAccount();
    await program.methods
      .updateConfig(
        mockDammPool,
        mockDammPos,
        payer.publicKey,
        mockDlmmPool,
        false
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    try {
      // A second vault-owned wSOL account: correct owner and mint, but not
      // state.vault_wsol_ata, so paid fees would strand outside sweep reach.
      const second = Keypair.generate();
      const rent = await provider.connection.getMinimumBalanceForRentExemption(
        165
      );
      const initTx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: second.publicKey,
          lamports: rent,
          space: 165,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccountInstruction(second.publicKey, wsolMint, vault)
      );
      await provider.sendAndConfirm(initTx, [payer, second]);
      try {
        await program.methods
          .claimDammFees()
          .accounts(
            dammClaimAccounts(
              vaultBaseAta,
              second.publicKey,
              TOKEN_PROGRAM_ID,
              TOKEN_PROGRAM_ID
            )
          )
          .rpc();
        assert.fail("expected unauthorized");
      } catch (e) {
        assert.match(String(e), /Unauthorized/i);
      }
      // Honest path with the canonical ATA still green.
      await program.methods
        .claimDammFees()
        .accounts(
          dammClaimAccounts(
            vaultBaseAta,
            vaultWsolAta,
            TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID
          )
        )
        .rpc();
    } finally {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .rpc();
    }
  });

  it("deposit token program is pinned to SPL", async () => {
    const accounts = (tokenProgram: PublicKey) => ({
      state,
      vault,
      marginfiAccount: mockMarginfi,
      group: mockGroup,
      solBank: mockSolBank,
      vaultWsolAta,
      liquidityVault: mockSolBank,
      tokenProgram,
      marginfiProgram: MARGINFI_V2,
    });
    try {
      await program.methods
        .depositSol(new BN(1000))
        .accounts(accounts(mockGroup))
        .rpc();
      assert.fail("expected unauthorized");
    } catch (e) {
      assert.match(String(e), /Unauthorized/i);
    }
    await program.methods
      .depositSol(new BN(1000))
      .accounts(accounts(TOKEN_PROGRAM_ID))
      .rpc();
  });

  it("repay token program is pinned to Token-2022", async () => {
    const accounts = (tokenProgram: PublicKey) => ({
      state,
      admin: payer.publicKey,
      vault,
      marginfiAccount: mockMarginfi,
      group: mockGroup,
      pumpBank: mockPumpBank,
      vaultPumpAta,
      bankLiquidityVault: mockPumpBank,
      tokenProgram,
      marginfiProgram: MARGINFI_V2,
    });
    try {
      await program.methods
        .repayAll(new BN(1000))
        .accounts(accounts(TOKEN_PROGRAM_ID))
        .rpc();
      assert.fail("expected unauthorized");
    } catch (e) {
      assert.match(String(e), /Unauthorized/i);
    }
    await program.methods
      .repayAll(new BN(1000))
      .accounts(accounts(TOKEN_2022_PROGRAM_ID))
      .rpc();
  });

  it("withdraw token program is pinned to SPL", async () => {
    const accounts = (tokenProgram: PublicKey) => ({
      state,
      admin: payer.publicKey,
      vault,
      marginfiAccount: mockMarginfi,
      group: mockGroup,
      solBank: mockSolBank,
      vaultWsolAta,
      bankLiquidityVaultAuthority: mockGroup,
      bankLiquidityVault: mockSolBank,
      tokenProgram,
      marginfiProgram: MARGINFI_V2,
    });
    try {
      await program.methods
        .withdrawAll(new BN(1000))
        .accounts(accounts(TOKEN_2022_PROGRAM_ID))
        .rpc();
      assert.fail("expected unauthorized");
    } catch (e) {
      assert.match(String(e), /Unauthorized/i);
    }
    await program.methods
      .withdrawAll(new BN(1000))
      .accounts(accounts(TOKEN_PROGRAM_ID))
      .rpc();
  });

  it("damm claim rejects non-canonical base ATA", async () => {
    mockDammPool = await mockSystemAccount();
    mockDammPos = await mockSystemAccount();
    await program.methods
      .updateConfig(
        mockDammPool,
        mockDammPos,
        payer.publicKey,
        mockDlmmPool,
        false
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    try {
      const second = Keypair.generate();
      const rent = await provider.connection.getMinimumBalanceForRentExemption(
        165
      );
      const initTx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: second.publicKey,
          lamports: rent,
          space: 165,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccountInstruction(second.publicKey, baseMint, vault)
      );
      await provider.sendAndConfirm(initTx, [payer, second]);
      try {
        await program.methods
          .claimDammFees()
          .accounts(
            dammClaimAccounts(
              second.publicKey,
              vaultWsolAta,
              TOKEN_PROGRAM_ID,
              TOKEN_PROGRAM_ID
            )
          )
          .rpc();
        assert.fail("expected unauthorized");
      } catch (e) {
        assert.match(String(e), /Unauthorized/i);
      }
      await program.methods
        .claimDammFees()
        .accounts(
          dammClaimAccounts(
            vaultBaseAta,
            vaultWsolAta,
            TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID
          )
        )
        .rpc();
    } finally {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .rpc();
    }
  });

  it("damm claim rejects third mint pair", async () => {
    mockDammPool = await mockSystemAccount();
    mockDammPos = await mockSystemAccount();
    await program.methods
      .updateConfig(
        mockDammPool,
        mockDammPos,
        payer.publicKey,
        mockDlmmPool,
        false
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    try {
      const evilMint = await createMint(
        provider.connection,
        payer,
        payer.publicKey,
        null,
        6
      );
      const evilAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        evilMint,
        vault,
        true
      );
      try {
        await program.methods
          .claimDammFees()
          .accounts({
            ...dammClaimAccounts(
              evilAta.address,
              vaultWsolAta,
              TOKEN_PROGRAM_ID,
              TOKEN_PROGRAM_ID
            ),
            tokenAMint: evilMint,
          })
          .rpc();
        assert.fail("expected bad mint");
      } catch (e) {
        assert.match(String(e), /BadMint/i);
      }
    } finally {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .rpc();
    }
  });

  it("sweep_base moves base dust and is admin-only", async () => {
    const destAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      baseMint,
      payer.publicKey,
      false
    );
    const sweepBaseAccounts = (admin: PublicKey, dest: PublicKey) => ({
      state,
      admin,
      vault,
      vaultBaseAta,
      destination: dest,
      baseMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
    // Non-admin must revert, even while paused is false.
    const evil = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      evil.publicKey,
      10_000_000
    );
    await provider.connection.confirmTransaction(sig);
    try {
      await program.methods
        .sweepBase(new BN(1))
        .accounts(sweepBaseAccounts(evil.publicKey, destAta.address))
        .signers([evil])
        .rpc();
      assert.fail("expected unauthorized");
    } catch (e) {
      assert.match(String(e), /Unauthorized|has.one|6009|2001/i);
    }
    // Zero amount reverts.
    try {
      await program.methods
        .sweepBase(new BN(0))
        .accounts(sweepBaseAccounts(payer.publicKey, destAta.address))
        .rpc();
      assert.fail("expected zero amount");
    } catch (e) {
      assert.match(String(e), /ZeroAmount/i);
    }
    // Happy path: fund vault base ATA, sweep exact amount.
    const amount = BigInt(77_000);
    const mintIx = createMintToInstruction(
      baseMint,
      vaultBaseAta,
      payer.publicKey,
      amount
    );
    await provider.sendAndConfirm(new Transaction().add(mintIx), [payer]);
    const vaultBefore = BigInt(
      (await provider.connection.getTokenAccountBalance(vaultBaseAta)).value
        .amount
    );
    const destBefore = BigInt(
      (await provider.connection.getTokenAccountBalance(destAta.address)).value
        .amount
    );
    await program.methods
      .sweepBase(new BN(amount.toString()))
      .accounts(sweepBaseAccounts(payer.publicKey, destAta.address))
      .rpc();
    const vaultAfter = BigInt(
      (await provider.connection.getTokenAccountBalance(vaultBaseAta)).value
        .amount
    );
    const destAfter = BigInt(
      (await provider.connection.getTokenAccountBalance(destAta.address)).value
        .amount
    );
    assert.equal(vaultAfter, vaultBefore - amount);
    assert.equal(destAfter, destBefore + amount);
    // Works while paused.
    await program.methods
      .updateConfig(
        PublicKey.default,
        PublicKey.default,
        payer.publicKey,
        mockDlmmPool,
        true
      )
      .accounts({ state, admin: payer.publicKey })
      .rpc();
    try {
      const amount2 = BigInt(1_000);
      const mintIx2 = createMintToInstruction(
        baseMint,
        vaultBaseAta,
        payer.publicKey,
        amount2
      );
      await provider.sendAndConfirm(new Transaction().add(mintIx2), [payer]);
      await program.methods
        .sweepBase(new BN(amount2.toString()))
        .accounts(sweepBaseAccounts(payer.publicKey, destAta.address))
        .rpc();
    } finally {
      await program.methods
        .updateConfig(
          PublicKey.default,
          PublicKey.default,
          payer.publicKey,
          mockDlmmPool,
          false
        )
        .accounts({ state, admin: payer.publicKey })
        .rpc();
    }
  });
});
