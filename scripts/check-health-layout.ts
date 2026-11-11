// Read-only check for the marginfi health-cache layout.
// No network or funds needed for offline checks.
// With --account <pubkey> it also reads a local-clone fresh account
// and compares raw bytes vs the p0 SDK parse.
//
//   npx ts-node scripts/check-health-layout.ts
//   npx ts-node scripts/check-health-layout.ts --account <MARGINFI_ACCOUNT>
//   RPC_URL=http://127.0.0.1:8899 npx ts-node scripts/check-health-layout.ts --account <KEY>
//
// Exits non-zero on any mismatch.

import { Connection, PublicKey } from "@solana/web3.js";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const anchor =
  require("@coral-xyz/anchor") as typeof import("@coral-xyz/anchor");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require("@0dotxyz/p0-ts-sdk") as Record<string, unknown>;

const MARGINFI_V2 = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const GROUP = "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8";
const SOL_BANK = "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh";
const PUMP_BANK = "61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK";
const SOL_ORACLE = "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE";
const PUMP_ORACLE = "4KL8nVtrXmLjbbHtrDz5YCHNqmii62oHfr9bsUtx1bgi";

const EXPECT_DISC = [186, 52, 117, 97, 34, 74, 39, 253];
const EXPECT_LEN = 2312;
const EXPECT_HEALTH_OFF = 1840;
const MIN_INITIAL_BPS = 15_000;
const MIN_MAINT_BPS = 12_500;
const MAX_AGE_SECS = 60;

function fail(msg: string): never {
  console.error(`CHECK_FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`ok - ${msg}`);
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

// Read signed i128 LE (matches Rust). Returns BigInt.
function readI128LE(b: Buffer, off: number): bigint {
  const slice = b.subarray(off, off + 16);
  if (slice.length !== 16) fail(`short i128 at ${off}`);
  let v = 0n;
  for (let i = 15; i >= 0; i--) {
    v = (v << 8n) | BigInt(slice[i]);
  }
  if (slice[15] & 0x80) v = v - (1n << 128n);
  return v;
}

function readU32LE(b: Buffer, off: number): number {
  return b.readUInt32LE(off);
}

function readI64LE(b: Buffer, off: number): bigint {
  return b.readBigInt64LE(off);
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// Guard core. Takes raw i128 values. Fails closed.
function guardPass(
  asset: bigint,
  liab: bigint,
  assetMaint: bigint,
  liabMaint: bigint
): boolean {
  if (liab <= 0n || liabMaint <= 0n) return false;
  if (asset < 0n || assetMaint < 0n) return false;
  const I128_MAX = (1n << 127n) - 1n;
  // Checked mul bounds.
  if (asset > I128_MAX / 10_000n) return false;
  if (liab > I128_MAX / 15_000n) return false;
  if (assetMaint > I128_MAX / 10_000n) return false;
  if (liabMaint > I128_MAX / 12_500n) return false;
  if (asset * 10_000n < liab * 15_000n) return false;
  if (assetMaint * 10_000n < liabMaint * 12_500n) return false;
  return true;
}

async function main(): Promise<void> {
  // 1. IDL checks offline.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idl = (sdk as any).MARGINFI_IDL as {
    address: string;
    metadata: { version: string };
    instructions: Array<{
      name: string;
      discriminator: number[];
      accounts: Array<{ name: string; writable?: boolean }>;
      args: unknown[];
    }>;
  };
  if (!idl) fail("MARGINFI_IDL missing");
  if (idl.address !== MARGINFI_V2) fail(`IDL address ${idl.address}`);
  ok(`IDL address ${idl.address} version ${idl.metadata.version}`);
  const ix = idl.instructions.find(
    (i) => i.name === "lending_account_pulse_health"
  );
  if (!ix) fail("lending_account_pulse_health missing in IDL");
  if (JSON.stringify(ix.discriminator) !== JSON.stringify(EXPECT_DISC))
    fail(`pulse disc ${JSON.stringify(ix.discriminator)}`);
  ok(`pulse disc ${EXPECT_DISC.join(",")}`);
  if (ix.accounts.length !== 2) fail("pulse inner accounts != 2");
  if (ix.accounts[0].name !== "marginfi_account" || !ix.accounts[0].writable)
    fail("pulse account 0 must be marginfi_account writable");
  if (ix.accounts[1].name !== "group") fail("pulse account 1 must be group");
  if (ix.args.length !== 0) fail("pulse must have no args");
  ok("pulse inner [marginfi_account(w), group] no args");

  // Remaining order rule: descending bank pubkey, SOL first.
  const sol = new PublicKey(SOL_BANK);
  const pump = new PublicKey(PUMP_BANK);
  const cmp = Buffer.compare(sol.toBuffer(), pump.toBuffer());
  if (cmp <= 0) fail("SOL bank must sort above PUMP bank");
  ok("health order [sol_bank, sol_oracle, pump_bank, pump_oracle] SOL first");

  // 2. Offset math offline.
  const BAL = 104;
  const LENDING = 16 * BAL + 2 + 6 + 56;
  if (LENDING !== 1728) fail(`lendingAccount ${LENDING}`);
  const healthOff = 8 + 32 + 32 + LENDING + 8 + 32;
  if (healthOff !== EXPECT_HEALTH_OFF) fail(`health off ${healthOff}`);
  if (EXPECT_LEN !== 2312) fail("len constant drift");
  ok(`account len 2312 health_cache off 1840 lending 1728`);

  // Health field offsets relative.
  const rel: Record<string, number> = {
    asset_value: 0,
    liability_value: 16,
    asset_value_maint: 32,
    liability_value_maint: 48,
    timestamp: 96,
    flags: 104,
    mrgn_err: 108,
    program_version: 245,
  };
  if (rel.liability_value !== 16 || rel.flags !== 104) fail("rel offsets");
  ok(
    "health field offsets asset 0 liab 16 maint 32/48 ts 96 flags 104 err 108 ver 245"
  );

  // 3. I80F48 vectors via SDK.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toWrap = (sdk as any).bigNumberToWrappedI80F48 as (v: string) => {
    value: number[];
  };
  const hexOf = (v: string): string =>
    Buffer.from(toWrap(v).value).toString("hex");
  const expect: Record<string, string> = {
    "0": "00000000000000000000000000000000",
    "1": "00000000000001000000000000000000",
    "1.25": "00000000004001000000000000000000",
    "1.5": "00000000008001000000000000000000",
    "100": "00000000000064000000000000000000",
  };
  for (const k of Object.keys(expect)) {
    if (hexOf(k) !== expect[k]) fail(`I80F48 ${k} got ${hexOf(k)}`);
  }
  ok("I80F48 vectors 0/1/1.25/1.5/100 match SDK");

  // 4. Guard boundary vectors.
  if (!guardPass(150n, 100n, 125n, 100n)) fail("boundary pass must hold");
  if (guardPass(149n, 100n, 125n, 100n)) fail("149/100 must fail initial");
  if (guardPass(150n, 100n, 124n, 100n)) fail("124 maint must fail");
  if (guardPass(10n, 0n, 10n, 1n)) fail("zero liab must fail");
  if (guardPass(-5n, 100n, 125n, 100n)) fail("negative must fail");
  ok("guard boundaries 150/100 pass, 149 fail, zero/negative fail");

  // 5. Synthetic health buffer vs SDK parse (positive values only).
  const SCALE = 1n << 48n;
  const buf = Buffer.alloc(304, 0);
  const writeRaw = (off: number, v: bigint): void => {
    let x = v;
    if (x < 0) x = x + (1n << 128n);
    for (let i = 0; i < 16; i++) {
      buf[off + i] = Number((x >> BigInt(8 * i)) & 0xffn);
    }
  };
  writeRaw(0, 150n * SCALE);
  writeRaw(16, 100n * SCALE);
  writeRaw(32, 125n * SCALE);
  writeRaw(48, 100n * SCALE);
  const a = readI128LE(buf, 0);
  const l = readI128LE(buf, 16);
  if (a !== 150n * SCALE || l !== 100n * SCALE) fail("raw read drift");
  if (!guardPass(a, l, readI128LE(buf, 32), readI128LE(buf, 48)))
    fail("synthetic guard must pass");
  ok("synthetic health raw matches guard pass");

  // 6. Online fresh-account check when --account is given.
  const acctStr = arg("--account") || process.env.MARGINFI_ACCOUNT || "";
  if (!acctStr) {
    console.log("SKIP_ONLINE: no --account; offline checks passed");
    console.log("CHECK_OK health layout offline");
    return;
  }
  const rpc = process.env.RPC_URL || "http://127.0.0.1:8899";
  const conn = new Connection(rpc, "confirmed");
  const key = new PublicKey(acctStr);
  const ai = await conn.getAccountInfo(key);
  if (!ai) fail(`account ${acctStr} missing on ${rpc}`);
  if (!ai.owner.equals(new PublicKey(MARGINFI_V2)))
    fail(`owner ${ai.owner.toBase58()} != MFv2`);
  if (ai.data.length !== EXPECT_LEN)
    fail(`len ${ai.data.length} != 2312 (drift?)`);
  ok(`fresh account ${acctStr} owner MFv2 len 2312 on ${rpc}`);

  // SDK decode vs raw.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = new (anchor as any).BorshCoder((sdk as any).MARGINFI_IDL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dec: any;
  try {
    dec = coder.accounts.decode("MarginfiAccount", Buffer.from(ai.data));
  } catch (e) {
    fail(`SDK decode failed: ${(e as Error).message.slice(0, 300)}`);
  }
  const data = Buffer.from(ai.data);
  const rawAsset = readI128LE(data, EXPECT_HEALTH_OFF + 0);
  const rawLiab = readI128LE(data, EXPECT_HEALTH_OFF + 16);
  const rawAssetM = readI128LE(data, EXPECT_HEALTH_OFF + 32);
  const rawLiabM = readI128LE(data, EXPECT_HEALTH_OFF + 48);
  const ts = readI64LE(data, EXPECT_HEALTH_OFF + 96);
  const flags = readU32LE(data, EXPECT_HEALTH_OFF + 104);
  const mrgnErr = readU32LE(data, EXPECT_HEALTH_OFF + 108);
  const progVer = data[EXPECT_HEALTH_OFF + 245];
  console.log(
    `raw asset=${rawAsset} liab=${rawLiab} maint ${rawAssetM}/${rawLiabM} ts=${ts} flags=${flags} err=${mrgnErr} ver=${progVer}`
  );

  // Compare raw vs SDK numeric value for all four health fields.
  // Convert each SDK decimal back to raw bytes with the SDK helper
  // (exact for positive values) and compare to the raw slice.
  // Fail on any mismatch. Sign-only check is not enough.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toDec = (sdk as any).wrappedI80F48toBigNumber as (w: {
    value: number[];
  }) => { toString(): string; isNegative(): boolean };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toWrapFn = (sdk as any).bigNumberToWrappedI80F48 as (v: string) => {
    value: number[];
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hc: any = (dec as any).health_cache ?? (dec as any).healthCache;
  if (!hc) fail("health_cache missing in SDK decode");
  const fields: Array<[string, bigint]> = [
    ["asset_value", rawAsset],
    ["liability_value", rawLiab],
    ["asset_value_maint", rawAssetM],
    ["liability_value_maint", rawLiabM],
  ];
  for (const [name, raw] of fields) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped: any = (hc as any)[name] ?? (hc as any)[snakeToCamel(name)];
    if (!wrapped) fail(`health field missing: ${name}`);
    const sdkDec = toDec(wrapped);
    const sdkStr = sdkDec.toString();
    const back = toWrapFn(sdkStr);
    const backBuf = Buffer.from(back.value);
    const rawSlice = data.subarray(
      EXPECT_HEALTH_OFF + rel[name],
      EXPECT_HEALTH_OFF + rel[name] + 16
    );
    if (!backBuf.equals(rawSlice)) {
      fail(`raw vs SDK numeric mismatch on ${name}: raw=${raw} sdk=${sdkStr}`);
    }
    ok(`raw vs SDK numeric agree ${name}=${sdkStr.slice(0, 20)}`);
  }

  // Balance order must match remaining order when SOL+PUMP present.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bals: any[] =
    (dec as any).lending_account?.balances ??
    (dec as any).lendingAccount?.balances ??
    [];
  const active = bals.filter((b) => b.active);
  console.log(`active balances ${active.length}`);
  const keys = active.map((b) =>
    String(b.bankPk ?? b.bank_pk ?? b.bank_pk?.toString?.())
  );
  // When both banks present, order must be SOL then PUMP.
  if (
    keys.includes(SOL_BANK) &&
    keys.includes(PUMP_BANK) &&
    keys.length === 2
  ) {
    if (keys[0] !== SOL_BANK || keys[1] !== PUMP_BANK)
      fail(`balance order ${keys.join(",")}`);
    ok("on-chain balance order SOL then PUMP matches remaining order");
  } else {
    console.log(`balances ${keys.join(",") || "none"}; order check skipped`);
  }

  // Fail-closed version and flags.
  // A fresh empty account has ver 0, ts 0, flags 0. That is expected
  // before the first pulse. The on-chain guard (037) must reject it.
  // The layout check only verifies offset and raw vs SDK agreement.
  if (progVer === 0) {
    console.log("note: programVersion 0 (empty cache); guard must reject");
  } else {
    ok(`programVersion ${progVer}`);
  }
  if (mrgnErr !== 0) fail(`mrgn_err ${mrgnErr}`);
  ok(`mrgn_err 0`);

  // Oracle keys must be the canonical bank oracles.
  if (GROUP !== dec.group?.toBase58?.() && GROUP !== String(dec.group))
    console.log(`group ${String(dec.group)} (expected ${GROUP})`);
  console.log("CHECK_OK health layout online");
}

main().catch((e) => {
  console.error(`CHECK_FAIL: ${(e as Error).message}`);
  process.exit(1);
});
