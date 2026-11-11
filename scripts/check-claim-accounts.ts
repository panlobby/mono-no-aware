// Check ClaimDbc and ClaimDamm CPI metas against the real IDLs.
// No network or funds needed. Exits non-zero on mismatch.
//
//   npx ts-node scripts/check-claim-accounts.ts
//
// DBC: decodes @meteora-ag/dynamic-bonding-curve-sdk 2.0.0 IDL 0.2.2.
// DAMM: reads the vendored cp_amm.json (MeteoraAg/damm-v2-sdk main,
// IDL cpAmm 0.2.5, program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG)
// from scripts/idl/cp_amm.json. The DAMM list comes from that file,
// not from a hardcoded array.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require("fs") as typeof import("fs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk = require("@meteora-ag/dynamic-bonding-curve-sdk") as Record<
  string,
  unknown
>;

type IdlAccount = {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
};

type IdlIx = {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
};

function fail(msg: string): never {
  console.error(`CHECK_FAIL: ${msg}`);
  process.exit(1);
}

function getDbcIdl(): { instructions: IdlIx[] } {
  const idl = (sdk as { DynamicBondingCurveIdl: { instructions: IdlIx[] } })
    .DynamicBondingCurveIdl;
  if (!idl || !Array.isArray(idl.instructions))
    fail("DBC IDL not found in SDK");
  return idl;
}

function findIx(idl: { instructions: IdlIx[] }, name: string): IdlIx {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix) fail(`DBC ix missing: ${name}`);
  return ix as IdlIx;
}

function readRust(): string {
  return fs.readFileSync("programs/fee-short/src/lib.rs", "utf8");
}

function extractMetasBlock(
  rust: string,
  marker: string,
  count: number
): string[] {
  const idx = rust.indexOf(marker);
  if (idx < 0) fail(`marker not found: ${marker}`);
  const slice = rust.slice(idx, idx + 8000);
  const re = /ctx\.accounts\.([a-z_0-9]+)\.key\(\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    out.push(m[1]);
    if (out.length >= count) break;
  }
  if (out.length < count)
    fail(`only ${out.length}/${count} metas for ${marker}`);
  return out.slice(0, count);
}

async function main(): Promise<void> {
  const idl = getDbcIdl();
  const partner = findIx(idl, "claim_trading_fee");
  const creator = findIx(idl, "claim_creator_trading_fee");

  // Discriminators must match our program constants.
  const discPartner = [8, 236, 89, 49, 152, 125, 177, 81];
  const discCreator = [82, 220, 250, 189, 3, 85, 107, 45];
  const discDamm = [180, 38, 154, 17, 133, 33, 162, 211];
  if (partner.discriminator.join(",") !== discPartner.join(",")) {
    fail(`partner disc mismatch ${partner.discriminator}`);
  }
  if (creator.discriminator.join(",") !== discCreator.join(",")) {
    fail(`creator disc mismatch ${creator.discriminator}`);
  }
  console.log("disc partner/creator match program constants");

  // IDL account names and order (SDK 2.0.0, IDL 0.2.2).
  const partnerNames = partner.accounts.map((a) => a.name);
  const creatorNames = creator.accounts.map((a) => a.name);
  const expectPartner = [
    "pool_authority",
    "config",
    "pool",
    "token_a_account",
    "token_b_account",
    "base_vault",
    "quote_vault",
    "base_mint",
    "quote_mint",
    "fee_claimer",
    "token_base_program",
    "token_quote_program",
    "event_authority",
    "program",
  ];
  const expectCreator = [
    "pool_authority",
    "pool",
    "token_a_account",
    "token_b_account",
    "base_vault",
    "quote_vault",
    "base_mint",
    "quote_mint",
    "creator",
    "token_base_program",
    "token_quote_program",
    "event_authority",
    "program",
  ];
  if (partnerNames.join(",") !== expectPartner.join(",")) {
    fail(`partner IDL order changed: ${partnerNames.join(",")}`);
  }
  if (creatorNames.join(",") !== expectCreator.join(",")) {
    fail(`creator IDL order changed: ${creatorNames.join(",")}`);
  }
  console.log("DBC IDL lists: partner 14, creator 13, order OK");

  // Our Rust field order must map to the IDL order.
  const rust = readRust();
  // Partner ix_a metas in Rust (14, IDL order).
  const partnerFields = extractMetasBlock(rust, "Partner leg (14 accounts", 14);
  const expectPartnerFields = [
    "pool_authority",
    "dbc_config",
    "dbc_pool",
    "token_a_account",
    "vault_wsol_ata",
    "base_vault",
    "quote_vault",
    "base_mint",
    "quote_mint",
    "vault",
    "token_base_program",
    "token_quote_program",
    "event_authority",
    "dbc_program",
  ];
  if (partnerFields.join(",") !== expectPartnerFields.join(",")) {
    fail(`partner Rust metas mismatch: ${partnerFields.join(",")}`);
  }
  console.log("partner Rust metas match IDL order");

  // Creator ix_b metas in Rust (13, IDL order, no config).
  const creatorFields = extractMetasBlock(rust, "Creator leg (13 accounts", 13);
  const expectCreatorFields = [
    "pool_authority",
    "dbc_pool",
    "token_a_account",
    "vault_wsol_ata",
    "base_vault",
    "quote_vault",
    "base_mint",
    "quote_mint",
    "vault",
    "token_base_program",
    "token_quote_program",
    "event_authority",
    "dbc_program",
  ];
  if (creatorFields.join(",") !== expectCreatorFields.join(",")) {
    fail(`creator Rust metas mismatch: ${creatorFields.join(",")}`);
  }
  console.log("creator Rust metas match IDL order (no config)");

  // DAMM v2 from the vendored cp_amm.json (damm-v2-sdk main, IDL 0.2.5).
  const dammRaw = fs.readFileSync("scripts/idl/cp_amm.json", "utf8");
  const dammIdl = JSON.parse(dammRaw) as {
    address: string;
    metadata: { version: string };
    instructions: IdlIx[];
  };
  if (dammIdl.address !== "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG") {
    fail(`damm program id mismatch: ${dammIdl.address}`);
  }
  if (dammIdl.metadata.version !== "0.2.5") {
    fail(`damm IDL version mismatch: ${dammIdl.metadata.version}`);
  }
  console.log(
    `DAMM IDL: program ${dammIdl.address}, version ${dammIdl.metadata.version}`
  );
  const dammIx = dammIdl.instructions.find(
    (i) => i.name === "claim_position_fee"
  );
  if (!dammIx) fail("damm ix missing: claim_position_fee");
  if (dammIx.discriminator.join(",") !== discDamm.join(",")) {
    fail(`damm disc mismatch ${dammIx.discriminator}`);
  }
  console.log("damm disc matches program constant");
  const dammNames = dammIx.accounts.map((a) => a.name);
  const expectDammNames = [
    "pool_authority",
    "pool",
    "position",
    "token_a_account",
    "token_b_account",
    "token_a_vault",
    "token_b_vault",
    "token_a_mint",
    "token_b_mint",
    "position_nft_account",
    "signer",
    "token_a_program",
    "token_b_program",
    "event_authority",
    "program",
  ];
  if (dammNames.join(",") !== expectDammNames.join(",")) {
    fail(`damm IDL order changed: ${dammNames.join(",")}`);
  }
  if (dammIx.accounts.length !== 15) fail("damm must be 15 accounts");
  const byName: Record<string, IdlAccount> = Object.fromEntries(
    dammIx.accounts.map((a) => [a.name, a])
  );
  if (
    byName["pool_authority"].address !==
    "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
  ) {
    fail("damm pool_authority address changed");
  }
  const writableTrue = [
    "position",
    "token_a_account",
    "token_b_account",
    "token_a_vault",
    "token_b_vault",
  ];
  for (const n of writableTrue) {
    if (!byName[n].writable) fail(`damm ${n} must be writable`);
  }
  if (!byName["signer"].signer) fail("damm signer must be signer");
  console.log("DAMM IDL list: 15 accounts, order/flags OK");
  // Direct check: our DAMM ix must list these fields in IDL order.
  // Marker is the handler definition (a plain "claim_damm_fees" search
  // would hit doc comments first).
  const rustDammIdx = rust.indexOf("pub fn claim_damm_fees");
  if (rustDammIdx < 0) fail("claim_damm_fees not found");
  const rustDammSlice = rust.slice(rustDammIdx, rustDammIdx + 12000);
  const re = /ctx\.accounts\.([a-z_0-9]+)\.key\(\)/g;
  const all: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(rustDammSlice)) !== null) all.push(m[1]);
  // The DAMM ix vec is the 15 metas in IDL order; find the run that
  // starts with pool_authority, damm_pool, position.
  let found: string[] | null = null;
  for (let i = 0; i + 15 <= all.length; i++) {
    const win = all.slice(i, i + 15);
    if (
      win[0] === "pool_authority" &&
      win[1] === "damm_pool" &&
      win[2] === "position"
    ) {
      found = win;
      break;
    }
  }
  if (!found)
    fail(
      `DAMM Rust metas not found in IDL order: ${all.slice(0, 30).join(",")}`
    );
  const expectDammFields = [
    "pool_authority",
    "damm_pool",
    "position",
    "fee_token_a_account",
    "fee_token_b_account",
    "vault_a",
    "vault_b",
    "token_a_mint",
    "token_b_mint",
    "position_nft_account",
    "vault",
    "token_a_program",
    "token_b_program",
    "event_authority",
    "damm_program",
  ];
  if (found.join(",") !== expectDammFields.join(",")) {
    fail(`damm Rust metas mismatch: ${found.join(",")}`);
  }
  console.log("damm Rust metas match IDL order (15)");

  console.log("CHECK_OK claim accounts match DBC + DAMM IDLs");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
