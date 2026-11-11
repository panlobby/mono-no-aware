// Clippy allowlist (035): with `-D warnings` the only remaining failures
// are all inside Anchor-generated code, not hand-written logic, so they
// are allowed here with reasons instead of fixed:
// - `unexpected_cfgs` (`anchor-debug`, `custom-heap`, `custom-panic`,
//   `solana`): emitted by `anchor-lang` 0.31.2 derive/`#[program]`
//   expansions; rustc 1.98 checks cfgs the macros predate. Upstream
//   Anchor issue, re-check on the next Anchor bump.
// - `clippy::too_many_arguments`: Anchor instruction handlers take `ctx`
//   plus every account/arg by design (`init_state` 17 params,
//   `update_config` 10 params).
// - `deprecated` (`AccountInfo::realloc` -> `resize`): the call lives in
//   the `#[program]` expansion of `anchor-lang` 0.31.2, not in our code.
#![allow(unexpected_cfgs, clippy::too_many_arguments, deprecated)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    sysvar::instructions as ixs,
};

declare_id!("EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj");

// ---- Programs (see docs/program-cpi-spec.md) ----
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const MARGINFI_V2_PROGRAM_ID: Pubkey = pubkey!("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
// Meteora DLMM (LB-CLMM) v0.12.0, as installed via @meteora-ag/dlmm 1.9.14.
pub const DLMM_PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
pub const MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
// DBC pool authority is a fixed PDA (["pool_authority"] under the DBC program).
// It appears as `pool_authority` with an address constraint in the DBC IDL.
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
// DAMM v2 pool authority is a fixed PDA (["pool_authority"] under cp-amm).
// From @meteora-ag/cp-amm-sdk 1.5.0, IDL cpAmm 0.2.5, program cpamdp....
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");

// ---- Anchor discriminators (sha256("global:<ix>")[0..8]) ----
pub const DISC_CLAIM_TRADING_FEE: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];
pub const DISC_CLAIM_CREATOR_FEE: [u8; 8] = [82, 220, 250, 189, 3, 85, 107, 45];
pub const DISC_CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];
pub const DISC_MARGINFI_INIT: [u8; 8] = [43, 78, 61, 255, 148, 52, 249, 154];
pub const DISC_MARGINFI_INIT_PDA: [u8; 8] = [87, 177, 91, 80, 218, 119, 245, 31];
pub const DISC_LENDING_DEPOSIT: [u8; 8] = [171, 94, 235, 103, 82, 64, 212, 140];
pub const DISC_LENDING_BORROW: [u8; 8] = [4, 126, 116, 53, 48, 5, 212, 31];
pub const DISC_LENDING_REPAY: [u8; 8] = [79, 209, 172, 177, 222, 51, 173, 151];
pub const DISC_LENDING_WITHDRAW: [u8; 8] = [36, 72, 74, 19, 210, 210, 192, 192];
// Meteora DLMM swap2 (v0.12.0, @meteora-ag/dlmm 1.9.14).
pub const DISC_DLMM_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
// marginfi lending_account_pulse_health (IDL 0.1.12): no args.
pub const DISC_PULSE_HEALTH: [u8; 8] = [186, 52, 117, 97, 34, 74, 39, 253];

// Canonical mints and programs for init validation (audit 027).
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const PUMP_MINT: Pubkey = pubkey!("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const BPF_LOADER_UPGRADEABLE_ID: Pubkey =
    pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
// Anchor discriminators for external accounts we parse.
pub const DISC_POOL_CONFIG: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
pub const DISC_BANK: [u8; 8] = [142, 49, 166, 242, 50, 66, 97, 188];
// MarginfiGroup discriminator (MARGINFI_IDL account `MarginfiGroup`).
pub const DISC_GROUP: [u8; 8] = [182, 23, 173, 240, 151, 206, 182, 67];
// DBC VirtualPool discriminator (IDL 0.2.2 account `VirtualPool`).
pub const DISC_VIRTUAL_POOL: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
// marginfi Bank (Borsh, from MARGINFI_IDL `Bank`: mint, mint_decimals,
// group, ...): disc 8 + mint 8..40 + mint_decimals 40 + group 41..73.
pub const OFF_BANK_GROUP: usize = 41;
// DBC VirtualPool (from IDL `PoolState`: volatility_tracker is
// u64 + u8[8] + u128 * 3 = 64 bytes, then config, creator, base_mint):
// disc 8 + tracker 8..72 + config 72..104 + creator 104..136 +
// base_mint 136..168. The pool carries no quote_mint field; the quote
// side is bound by pool.config == dbc_config plus the config
// quote_mint == wSOL check.
pub const OFF_POOL_CONFIG: usize = 72;
pub const OFF_POOL_BASE_MINT: usize = 136;
// marginfi program version pinned exactly (R-03). Fresh accounts use 3;
// older layouts used other slots. Any other version fails closed.
pub const MARGINFI_PROGRAM_VERSION: u8 = 3;

// ---- Health guard (docs/marginfi-health-guard.md) ----
// Fresh marginfi PDA layout. Fail closed on drift.
pub const MARGINFI_ACCOUNT_LEN: usize = 2312;
pub const HEALTH_CACHE_OFF: usize = 1840;
pub const HEALTH_CACHE_LEN: usize = 304;
// HealthCache field offsets relative to HEALTH_CACHE_OFF.
pub const OFF_ASSET: usize = 0;
pub const OFF_LIAB: usize = 16;
pub const OFF_ASSET_MAINT: usize = 32;
pub const OFF_LIAB_MAINT: usize = 48;
pub const OFF_TIMESTAMP: usize = 96;
pub const OFF_FLAGS: usize = 104;
pub const OFF_MRGN_ERR: usize = 108;
pub const OFF_PROGRAM_VERSION: usize = 245;
// User-confirmed thresholds.
pub const MIN_INITIAL_HF_BPS: u64 = 15_000; // 1.50
pub const MIN_MAINT_HF_BPS: u64 = 12_500; // 1.25
                                          // Health freshness vs Clock::get().
pub const MAX_HEALTH_AGE_SECS: i64 = 60;
// Flag bits (u32 LE at flags).
pub const FLAG_ENGINE_OK: u32 = 2;
pub const FLAG_ORACLE_OK: u32 = 4;

#[account]
pub struct FeeShortState {
    pub admin: Pubkey,
    pub dbc_pool: Pubkey,
    pub dbc_config: Pubkey,
    pub damm_pool: Pubkey,
    pub damm_position: Pubkey,
    pub marginfi_account: Pubkey,
    pub group: Pubkey,
    pub sol_bank: Pubkey,
    pub pump_bank: Pubkey,
    pub vault_wsol_ata: Pubkey,
    pub vault_pump_ata: Pubkey,
    pub sweep_destination: Pubkey,
    pub pump_pool: Pubkey,
    pub base_mint: Pubkey,
    pub vault_base_ata: Pubkey,
    pub paused: bool,
    pub bump_state: u8,
    pub bump_vault: u8,
}

impl FeeShortState {
    // 15 Pubkeys (480) + bool (1) + u8 + u8 (2) = 483.
    // Do not guess. A unit test asserts this exact count.
    pub const LEN: usize = 15 * 32 + 1 + 1 + 1;
}

#[event]
pub struct EvtSweep {
    pub destination: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EvtSweepBase {
    pub destination: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EvtSweepDestinationChanged {
    pub old_destination: Pubkey,
    pub new_destination: Pubkey,
}

#[event]
pub struct EvtPoolChanged {
    pub old_pool: Pubkey,
    pub new_pool: Pubkey,
}

// Full config snapshot: emitted on EVERY update_config call, after
// the per-field change events. Indexers must not rely on the conditional
// EvtSweepDestinationChanged / EvtPoolChanged alone; EvtConfig always
// carries the whole new config, including paused and the DAMM pool/position.
#[event]
pub struct EvtConfig {
    pub damm_pool: Pubkey,
    pub damm_position: Pubkey,
    pub sweep_destination: Pubkey,
    pub pump_pool: Pubkey,
    pub paused: bool,
}

#[event]
pub struct EvtBorrowSellDeposit {
    pub pump_amount: u64,
    pub sol_out: u64,
    pub initial_hf_bps: u64,
    pub maint_hf_bps: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("paused")]
    Paused,
    #[msg("bad price")]
    BadPrice,
    #[msg("borrow too small")]
    DustBorrow,
    #[msg("zero amount")]
    ZeroAmount,
    #[msg("bad mint")]
    BadMint,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("bad owner")]
    BadOwner,
    #[msg("already active")]
    AlreadyActive,
}

// update_config guards: every unsafe value is rejected before any
// state is written, so a failed update leaves the old config intact.
// Rules:
// - sweep_destination / pump_pool == default bricks sweep_out / the crank
//   (no real ATA or pool can match the default key).
// - damm_pool and damm_position must be both default (pre-migration, claim
//   skipped) or both set; a half-set pair bricks claim_damm_fees.
pub fn check_update_config(
    damm_pool: &Pubkey,
    damm_position: &Pubkey,
    sweep_destination: &Pubkey,
    pump_pool: &Pubkey,
) -> Result<()> {
    require!(
        *sweep_destination != Pubkey::default(),
        ErrorCode::Unauthorized
    );
    require!(*pump_pool != Pubkey::default(), ErrorCode::Unauthorized);
    let pool_set = *damm_pool != Pubkey::default();
    let position_set = *damm_position != Pubkey::default();
    require!(pool_set == position_set, ErrorCode::Unauthorized);
    Ok(())
}

// Crank guards: permissionless caller, never paused, amount > 0.
// No cap, no cooldown, no epoch. The hardcoded health guard bounds risk.
pub fn check_crank_guards(amount: u64, paused: bool) -> Result<()> {
    require!(!paused, ErrorCode::Paused);
    require!(amount > 0, ErrorCode::ZeroAmount);
    Ok(())
}

// Build raw DLMM swap2 instruction data: discriminator + amount_in le +
// min_out le + RemainingAccountsInfo Borsh. No transfer hooks in our pool,
// so slices are always [{TransferHookX, 0}, {TransferHookY, 0}].
pub fn dlmm_swap2_data(amount_in: u64, min_out_amount: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(32);
    v.extend_from_slice(&DISC_DLMM_SWAP2);
    v.extend_from_slice(&amount_in.to_le_bytes());
    v.extend_from_slice(&min_out_amount.to_le_bytes());
    // RemainingAccountsInfo { slices: Vec<RemainingAccountsSlice> }.
    // Vec len 2 (u32 le), then (accounts_type u8, length u8) per slice.
    // TransferHookX = 0, TransferHookY = 1, both length 0.
    v.extend_from_slice(&2u32.to_le_bytes());
    v.push(0u8);
    v.push(0u8);
    v.push(1u8);
    v.push(0u8);
    v
}

// marginfi pulse_health data: discriminator only, no args.
pub fn marginfi_pulse_health_data() -> Vec<u8> {
    DISC_PULSE_HEALTH.to_vec()
}

// Read signed i128 LE. Fail closed on short data.
pub fn read_i128_le(data: &[u8], offset: usize) -> Result<i128> {
    require!(data.len() >= offset + 16, ErrorCode::BadPrice);
    let mut b = [0u8; 16];
    b.copy_from_slice(&data[offset..offset + 16]);
    Ok(i128::from_le_bytes(b))
}

pub fn read_u32_le(data: &[u8], offset: usize) -> Result<u32> {
    require!(data.len() >= offset + 4, ErrorCode::BadPrice);
    let mut b = [0u8; 4];
    b.copy_from_slice(&data[offset..offset + 4]);
    Ok(u32::from_le_bytes(b))
}

pub fn read_i64_le(data: &[u8], offset: usize) -> Result<i64> {
    require!(data.len() >= offset + 8, ErrorCode::BadPrice);
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[offset..offset + 8]);
    Ok(i64::from_le_bytes(b))
}

// Health guard: fail closed on any drift or weak health.
// Returns (initial_hf_bps, maint_hf_bps). HF is asset/liability * 10_000.
// Uses raw I80F48 i128 values; the 2^48 scale cancels.
pub fn check_health_cache(data: &[u8], now_ts: i64) -> Result<(u64, u64)> {
    require!(data.len() == MARGINFI_ACCOUNT_LEN, ErrorCode::BadPrice);
    let base = HEALTH_CACHE_OFF;
    require!(data.len() >= base + HEALTH_CACHE_LEN, ErrorCode::BadPrice);
    let asset = read_i128_le(data, base + OFF_ASSET)?;
    let liab = read_i128_le(data, base + OFF_LIAB)?;
    let asset_maint = read_i128_le(data, base + OFF_ASSET_MAINT)?;
    let liab_maint = read_i128_le(data, base + OFF_LIAB_MAINT)?;
    require!(liab > 0, ErrorCode::BadPrice);
    require!(liab_maint > 0, ErrorCode::BadPrice);
    require!(asset >= 0, ErrorCode::BadPrice);
    require!(asset_maint >= 0, ErrorCode::BadPrice);
    let left_init = asset
        .checked_mul(10_000)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    let right_init = liab
        .checked_mul(MIN_INITIAL_HF_BPS as i128)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    require!(left_init >= right_init, ErrorCode::BadPrice);
    let left_maint = asset_maint
        .checked_mul(10_000)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    let right_maint = liab_maint
        .checked_mul(MIN_MAINT_HF_BPS as i128)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    require!(left_maint >= right_maint, ErrorCode::BadPrice);
    let ts = read_i64_le(data, base + OFF_TIMESTAMP)?;
    require!(ts <= now_ts, ErrorCode::BadPrice);
    let age = now_ts
        .checked_sub(ts)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    require!(age >= 0, ErrorCode::BadPrice);
    require!(age <= MAX_HEALTH_AGE_SECS, ErrorCode::BadPrice);
    let flags = read_u32_le(data, base + OFF_FLAGS)?;
    require!(flags & FLAG_ENGINE_OK != 0, ErrorCode::BadPrice);
    require!(flags & FLAG_ORACLE_OK != 0, ErrorCode::BadPrice);
    let mrgn_err = read_u32_le(data, base + OFF_MRGN_ERR)?;
    require!(mrgn_err == 0, ErrorCode::BadPrice);
    require!(data.len() > base + OFF_PROGRAM_VERSION, ErrorCode::BadPrice);
    require!(
        data[base + OFF_PROGRAM_VERSION] == MARGINFI_PROGRAM_VERSION,
        ErrorCode::BadPrice
    );
    let init_hf = left_init
        .checked_div(liab)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    let maint_hf = left_maint
        .checked_div(liab_maint)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    let init_out = u64::try_from(init_hf).unwrap_or(u64::MAX);
    let maint_out = u64::try_from(maint_hf).unwrap_or(u64::MAX);
    Ok((init_out, maint_out))
}

// Mock CPI skip: in local-test, external Marginfi/DBC/DAMM/DLMM accounts may
// be SystemProgram-owned mocks. Skip those CPIs in tests.
#[cfg(feature = "local-test")]
pub fn should_skip_cpi(target: &AccountInfo) -> bool {
    target.owner == &anchor_lang::solana_program::system_program::ID || target.owner == &crate::ID
}

#[cfg(not(feature = "local-test"))]
pub fn should_skip_cpi(_target: &AccountInfo) -> bool {
    false
}

// Build raw marginfi instruction data: discriminator + Borsh args.
pub fn marginfi_borrow_data(amount: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(16);
    v.extend_from_slice(&DISC_LENDING_BORROW);
    v.extend_from_slice(&amount.to_le_bytes());
    v
}

pub fn marginfi_deposit_data(amount: u64) -> Vec<u8> {
    let mut v = Vec::with_capacity(17);
    v.extend_from_slice(&DISC_LENDING_DEPOSIT);
    v.extend_from_slice(&amount.to_le_bytes());
    v.push(0); // deposit_up_to_limit: None
    v
}

pub fn marginfi_repay_data(amount: u64, repay_all: bool) -> Vec<u8> {
    let mut v = Vec::with_capacity(18);
    v.extend_from_slice(&DISC_LENDING_REPAY);
    v.extend_from_slice(&amount.to_le_bytes());
    if repay_all {
        v.push(1);
        v.push(1);
    } else {
        v.push(1);
        v.push(0);
    }
    v
}

pub fn marginfi_withdraw_data(amount: u64, withdraw_all: bool) -> Vec<u8> {
    let mut v = Vec::with_capacity(18);
    v.extend_from_slice(&DISC_LENDING_WITHDRAW);
    v.extend_from_slice(&amount.to_le_bytes());
    if withdraw_all {
        v.push(1);
        v.push(1);
    } else {
        v.push(1);
        v.push(0);
    }
    v
}

pub fn marginfi_init_pda_data(account_index: u16) -> Vec<u8> {
    let mut v = Vec::with_capacity(12);
    v.extend_from_slice(&DISC_MARGINFI_INIT_PDA);
    v.extend_from_slice(&account_index.to_le_bytes());
    v.push(0); // third_party_id: None
    v
}

// DBC event authority is PDA ["__event_authority"] under the DBC program.
pub fn dbc_event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &DBC_PROGRAM_ID).0
}

// DAMM v2 event authority is PDA ["__event_authority"] under cp-amm.
pub fn damm_event_authority() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &DAMM_V2_PROGRAM_ID).0
}

// DBC partner/creator claim data: discriminator + u64::MAX + u64::MAX.
// Matches the SDK `claimTradingFee(maxBase, maxQuote)` args.
pub fn dbc_claim_partner_data() -> Vec<u8> {
    let mut v = Vec::with_capacity(24);
    v.extend_from_slice(&DISC_CLAIM_TRADING_FEE);
    v.extend_from_slice(&u64::MAX.to_le_bytes());
    v.extend_from_slice(&u64::MAX.to_le_bytes());
    v
}

pub fn dbc_claim_creator_data() -> Vec<u8> {
    let mut v = Vec::with_capacity(24);
    v.extend_from_slice(&DISC_CLAIM_CREATOR_FEE);
    v.extend_from_slice(&u64::MAX.to_le_bytes());
    v.extend_from_slice(&u64::MAX.to_le_bytes());
    v
}

// DAMM v2 claim data: discriminator only, no args.
pub fn damm_claim_data() -> Vec<u8> {
    DISC_CLAIM_POSITION_FEE.to_vec()
}

// ProgramData address for our program (BPF loader derived).
pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[crate::ID.as_ref()], &BPF_LOADER_UPGRADEABLE_ID).0
}

// Read a pubkey at byte offset. Fail closed on short data.
pub fn parse_pubkey_at(data: &[u8], offset: usize) -> Result<Pubkey> {
    require!(data.len() >= offset + 32, ErrorCode::BadPrice);
    Ok(Pubkey::new_from_array(
        data[offset..offset + 32].try_into().unwrap(),
    ))
}

// Check a MarginfiGroup account carries the IDL discriminator. Defense in
// depth on top of the owner check and the bank group-field checks: a
// marginfi-owned non-group account (e.g. a Bank passed as group) is
// rejected here.
pub fn check_group_discriminator(data: &[u8]) -> Result<()> {
    require!(data.len() >= 8, ErrorCode::BadPrice);
    require!(data[0..8] == DISC_GROUP, ErrorCode::Unauthorized);
    Ok(())
}

// Parse the group field from a marginfi Bank account. Verified against
// @0dotxyz/p0-ts-sdk 2.11.0 MARGINFI_IDL `Bank` (mint, mint_decimals,
// group, ...). Fail closed on short data or wrong discriminator.
pub fn parse_bank_group(data: &[u8]) -> Result<Pubkey> {
    require!(data.len() >= OFF_BANK_GROUP + 32, ErrorCode::BadPrice);
    require!(data[0..8] == DISC_BANK, ErrorCode::Unauthorized);
    parse_pubkey_at(data, OFF_BANK_GROUP)
}

// Parse the config field from a DBC VirtualPool account. Verified against
// @meteora-ag/dynamic-bonding-curve-sdk 2.0.0 IDL `PoolState`.
pub fn parse_virtual_pool_config(data: &[u8]) -> Result<Pubkey> {
    require!(data.len() >= OFF_POOL_CONFIG + 32, ErrorCode::BadPrice);
    require!(data[0..8] == DISC_VIRTUAL_POOL, ErrorCode::Unauthorized);
    parse_pubkey_at(data, OFF_POOL_CONFIG)
}

// Parse the base_mint field from a DBC VirtualPool account (same IDL).
pub fn parse_virtual_pool_base_mint(data: &[u8]) -> Result<Pubkey> {
    require!(data.len() >= OFF_POOL_BASE_MINT + 32, ErrorCode::BadPrice);
    require!(data[0..8] == DISC_VIRTUAL_POOL, ErrorCode::Unauthorized);
    parse_pubkey_at(data, OFF_POOL_BASE_MINT)
}

// Pure binding check for a marginfi bank at init: the bank mint must equal
// the expected mint and the bank group must equal the expected group.
pub fn check_bank_binding(
    bank_mint: &Pubkey,
    bank_group: &Pubkey,
    expected_mint: &Pubkey,
    expected_group: &Pubkey,
) -> Result<()> {
    require_keys_eq!(*bank_mint, *expected_mint, ErrorCode::Unauthorized);
    require_keys_eq!(*bank_group, *expected_group, ErrorCode::Unauthorized);
    Ok(())
}

// Pure binding check for a DBC pool at init: pool.config must equal the
// expected config and pool.base_mint must equal the expected base mint.
pub fn check_pool_binding(
    pool_config: &Pubkey,
    pool_base: &Pubkey,
    expected_config: &Pubkey,
    expected_base: &Pubkey,
) -> Result<()> {
    require_keys_eq!(*pool_config, *expected_config, ErrorCode::Unauthorized);
    require_keys_eq!(*pool_base, *expected_base, ErrorCode::Unauthorized);
    Ok(())
}

// Parse the upgrade authority from a BPF loader ProgramData account.
// Layout: u32 tag (3 = ProgramData) + u64 slot + Option<Pubkey>.
pub fn parse_program_data_upgrade_authority(data: &[u8]) -> Result<Pubkey> {
    require!(data.len() >= 45, ErrorCode::BadPrice);
    let mut tag = [0u8; 4];
    tag.copy_from_slice(&data[0..4]);
    require!(u32::from_le_bytes(tag) == 3, ErrorCode::Unauthorized);
    require!(data[12] == 1, ErrorCode::Unauthorized);
    parse_pubkey_at(data, 13)
}

// Canonical ATA for (owner, mint, token program).
pub fn canonical_ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

// Check an ATA key is canonical. Reject non-canonical accounts.
pub fn check_ata_canonical(
    ata_key: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *ata_key,
        canonical_ata(owner, mint, token_program),
        ErrorCode::Unauthorized
    );
    Ok(())
}

fn vault_seeds<'a>(state_key: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [b"vault", state_key.as_ref(), bump]
}

#[program]
pub mod fee_short {
    use super::*;

    pub fn init_state(
        ctx: Context<InitState>,
        admin: Pubkey,
        dbc_pool: Pubkey,
        dbc_config: Pubkey,
        group: Pubkey,
        sol_bank: Pubkey,
        pump_bank: Pubkey,
        vault_wsol_ata: Pubkey,
        vault_pump_ata: Pubkey,
        sweep_destination: Pubkey,
        pump_pool: Pubkey,
        base_mint: Pubkey,
        vault_base_ata: Pubkey,
    ) -> Result<()> {
        // Launch authority: only the current upgrade authority can init.
        // The program proves it from the ProgramData account.
        // Mock ProgramData (SystemProgram-owned) skips the check in tests.
        if !should_skip_cpi(&ctx.accounts.program_data.to_account_info()) {
            require_keys_eq!(
                ctx.accounts.program_data.key(),
                program_data_address(),
                ErrorCode::Unauthorized
            );
            require_keys_eq!(
                *ctx.accounts.program_data.to_account_info().owner,
                BPF_LOADER_UPGRADEABLE_ID,
                ErrorCode::Unauthorized
            );
            let data = ctx.accounts.program_data.try_borrow_data()?;
            let authority = parse_program_data_upgrade_authority(&data)?;
            drop(data);
            require_keys_eq!(ctx.accounts.payer.key(), authority, ErrorCode::Unauthorized);
        }
        // Bind params to accounts. Reject mismatched keys.
        require_keys_eq!(ctx.accounts.admin.key(), admin, ErrorCode::Unauthorized);
        require_keys_eq!(ctx.accounts.group.key(), group, ErrorCode::Unauthorized);
        require_keys_eq!(
            ctx.accounts.sol_bank.key(),
            sol_bank,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.dbc_pool.key(),
            dbc_pool,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.dbc_config.key(),
            dbc_config,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.pump_bank.key(),
            pump_bank,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.vault_wsol_ata.key(),
            vault_wsol_ata,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.vault_pump_ata.key(),
            vault_pump_ata,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.vault_base_ata.key(),
            vault_base_ata,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.base_mint.key(),
            base_mint,
            ErrorCode::Unauthorized
        );
        // Vault ATAs must be real token accounts owned by the vault.
        require_keys_eq!(
            *ctx.accounts.vault_wsol_ata.to_account_info().owner,
            anchor_spl::token::ID,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            *ctx.accounts.vault_pump_ata.to_account_info().owner,
            anchor_spl::token_2022::ID,
            ErrorCode::Unauthorized
        );
        let wsol_data = ctx.accounts.vault_wsol_ata.try_borrow_data()?;
        let wsol_mint = token_mint(&wsol_data)?;
        let wsol_owner = token_owner(&wsol_data)?;
        drop(wsol_data);
        require_keys_eq!(
            wsol_owner,
            ctx.accounts.vault.key(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            wsol_mint,
            ctx.accounts.quote_mint.key(),
            ErrorCode::Unauthorized
        );
        check_ata_canonical(
            &ctx.accounts.vault_wsol_ata.key(),
            &ctx.accounts.vault.key(),
            &ctx.accounts.quote_mint.key(),
            &anchor_spl::token::ID,
        )?;
        let pump_data = ctx.accounts.vault_pump_ata.try_borrow_data()?;
        let pump_mint_val = token_mint(&pump_data)?;
        let pump_owner = token_owner(&pump_data)?;
        drop(pump_data);
        require_keys_eq!(
            pump_owner,
            ctx.accounts.vault.key(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            pump_mint_val,
            ctx.accounts.pump_mint.key(),
            ErrorCode::Unauthorized
        );
        check_ata_canonical(
            &ctx.accounts.vault_pump_ata.key(),
            &ctx.accounts.vault.key(),
            &ctx.accounts.pump_mint.key(),
            &anchor_spl::token_2022::ID,
        )?;
        // Base fee ATA: vault-owned canonical ATA for the base mint.
        // Base is our token (SPL in production). The token program is the
        // program that owns the base mint, so the same code works for
        // SPL and Token-2022 base mints.
        require_keys_eq!(
            *ctx.accounts.vault_base_ata.to_account_info().owner,
            *ctx.accounts.base_mint.to_account_info().owner,
            ErrorCode::Unauthorized
        );
        let base_token_program = *ctx.accounts.base_mint.to_account_info().owner;
        require!(
            base_token_program == anchor_spl::token::ID
                || base_token_program == anchor_spl::token_2022::ID,
            ErrorCode::Unauthorized
        );
        let base_data = ctx.accounts.vault_base_ata.try_borrow_data()?;
        let base_mint_val = token_mint(&base_data)?;
        let base_owner = token_owner(&base_data)?;
        drop(base_data);
        require_keys_eq!(
            base_owner,
            ctx.accounts.vault.key(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            base_mint_val,
            ctx.accounts.base_mint.key(),
            ErrorCode::Unauthorized
        );
        check_ata_canonical(
            &ctx.accounts.vault_base_ata.key(),
            &ctx.accounts.vault.key(),
            &ctx.accounts.base_mint.key(),
            &base_token_program,
        )?;
        // Base must be a real third mint, not wSOL and not PUMP.
        // Otherwise both fee legs could point at the same ATA.
        require!(
            ctx.accounts.base_mint.key() != NATIVE_MINT,
            ErrorCode::BadMint
        );
        require!(
            ctx.accounts.base_mint.key() != ctx.accounts.pump_mint.key(),
            ErrorCode::BadMint
        );
        require!(
            ctx.accounts.vault_base_ata.key() != ctx.accounts.vault_wsol_ata.key(),
            ErrorCode::Unauthorized
        );
        require!(
            ctx.accounts.vault_base_ata.key() != ctx.accounts.vault_pump_ata.key(),
            ErrorCode::Unauthorized
        );
        // DBC config quote must be wSOL when the config is real.
        // Mock config (SystemProgram-owned) skips this in tests.
        if !should_skip_cpi(&ctx.accounts.dbc_config.to_account_info()) {
            require_keys_eq!(
                *ctx.accounts.dbc_config.to_account_info().owner,
                DBC_PROGRAM_ID,
                ErrorCode::Unauthorized
            );
            let cfg_data = ctx.accounts.dbc_config.try_borrow_data()?;
            require!(cfg_data.len() >= 40, ErrorCode::BadPrice);
            require!(cfg_data[0..8] == DISC_POOL_CONFIG, ErrorCode::Unauthorized);
            let cfg_quote = parse_pubkey_at(&cfg_data, 8)?;
            drop(cfg_data);
            require_keys_eq!(
                ctx.accounts.quote_mint.key(),
                cfg_quote,
                ErrorCode::Unauthorized
            );
            require_keys_eq!(
                ctx.accounts.quote_mint.key(),
                NATIVE_MINT,
                ErrorCode::Unauthorized
            );
        }
        // Group must be a real marginfi group when it is real.
        // Mock group (SystemProgram-owned) skips this in tests.
        if !should_skip_cpi(&ctx.accounts.group.to_account_info()) {
            require_keys_eq!(
                *ctx.accounts.group.to_account_info().owner,
                MARGINFI_V2_PROGRAM_ID,
                ErrorCode::Unauthorized
            );
            let group_data = ctx.accounts.group.try_borrow_data()?;
            check_group_discriminator(&group_data)?;
            drop(group_data);
        }
        // SOL bank: real marginfi bank for wSOL in our group.
        // Mock bank (SystemProgram-owned) skips this in tests.
        if !should_skip_cpi(&ctx.accounts.sol_bank.to_account_info()) {
            require_keys_eq!(
                *ctx.accounts.sol_bank.to_account_info().owner,
                MARGINFI_V2_PROGRAM_ID,
                ErrorCode::Unauthorized
            );
            let sol_data = ctx.accounts.sol_bank.try_borrow_data()?;
            require!(sol_data.len() >= 40, ErrorCode::BadPrice);
            require!(sol_data[0..8] == DISC_BANK, ErrorCode::Unauthorized);
            let sol_mint = parse_pubkey_at(&sol_data, 8)?;
            let sol_group = parse_bank_group(&sol_data)?;
            drop(sol_data);
            check_bank_binding(&sol_mint, &sol_group, &NATIVE_MINT, &group)?;
        }
        // DBC pool must be a real VirtualPool for our config and base mint
        // when it is real. Mock pool (SystemProgram-owned, e.g. default)
        // skips this in tests and in local-e2e/health-rollback (DBC unused).
        if !should_skip_cpi(&ctx.accounts.dbc_pool.to_account_info()) {
            require_keys_eq!(
                *ctx.accounts.dbc_pool.to_account_info().owner,
                DBC_PROGRAM_ID,
                ErrorCode::Unauthorized
            );
            let pool_data = ctx.accounts.dbc_pool.try_borrow_data()?;
            let pool_config = parse_virtual_pool_config(&pool_data)?;
            let pool_base = parse_virtual_pool_base_mint(&pool_data)?;
            drop(pool_data);
            check_pool_binding(&pool_config, &pool_base, &dbc_config, &base_mint)?;
            // The pool carries no quote_mint field; the quote side is the
            // config link above plus quote == wSOL.
            require_keys_eq!(
                ctx.accounts.quote_mint.key(),
                NATIVE_MINT,
                ErrorCode::Unauthorized
            );
        }
        // PUMP bank mint must match the pump mint when the bank is real.
        // Mock bank (SystemProgram-owned) skips this in tests.
        if !should_skip_cpi(&ctx.accounts.pump_bank.to_account_info()) {
            require_keys_eq!(
                *ctx.accounts.pump_bank.to_account_info().owner,
                MARGINFI_V2_PROGRAM_ID,
                ErrorCode::Unauthorized
            );
            let bank_data = ctx.accounts.pump_bank.try_borrow_data()?;
            require!(bank_data.len() >= 40, ErrorCode::BadPrice);
            require!(bank_data[0..8] == DISC_BANK, ErrorCode::Unauthorized);
            let bank_mint = parse_pubkey_at(&bank_data, 8)?;
            let bank_group = parse_bank_group(&bank_data)?;
            drop(bank_data);
            require_keys_eq!(
                ctx.accounts.pump_mint.key(),
                bank_mint,
                ErrorCode::Unauthorized
            );
            check_bank_binding(&bank_mint, &bank_group, &PUMP_MINT, &group)?;
        }
        let s = &mut ctx.accounts.state;
        s.admin = admin;
        s.dbc_pool = dbc_pool;
        s.dbc_config = dbc_config;
        s.damm_pool = Pubkey::default();
        s.damm_position = Pubkey::default();
        s.marginfi_account = Pubkey::default();
        s.group = group;
        s.sol_bank = sol_bank;
        s.pump_bank = pump_bank;
        s.vault_wsol_ata = vault_wsol_ata;
        s.vault_pump_ata = vault_pump_ata;
        s.sweep_destination = sweep_destination;
        s.pump_pool = pump_pool;
        s.base_mint = base_mint;
        s.vault_base_ata = vault_base_ata;
        s.paused = true;
        s.bump_state = ctx.bumps.state;
        s.bump_vault = ctx.bumps.vault;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        damm_pool: Pubkey,
        damm_position: Pubkey,
        sweep_destination: Pubkey,
        pump_pool: Pubkey,
        paused: bool,
    ) -> Result<()> {
        // All guards run before any write: a failed update leaves the old
        // config intact.
        check_update_config(&damm_pool, &damm_position, &sweep_destination, &pump_pool)?;
        let s = &mut ctx.accounts.state;
        s.damm_pool = damm_pool;
        s.damm_position = damm_position;
        if s.sweep_destination != sweep_destination {
            let old = s.sweep_destination;
            s.sweep_destination = sweep_destination;
            emit!(EvtSweepDestinationChanged {
                old_destination: old,
                new_destination: sweep_destination,
            });
        }
        if s.pump_pool != pump_pool {
            let old = s.pump_pool;
            s.pump_pool = pump_pool;
            emit!(EvtPoolChanged {
                old_pool: old,
                new_pool: pump_pool,
            });
        }
        s.paused = paused;
        emit!(EvtConfig {
            damm_pool,
            damm_position,
            sweep_destination,
            pump_pool,
            paused,
        });
        Ok(())
    }

    // Admin only: move wSOL proceeds out of the vault to the configured
    // sweep destination. Plain SPL transfer (never close_account) so the
    // vault ATA survives and future fee claims keep working. The
    // destination ATA must already exist and be owned by
    // state.sweep_destination (wallet or program PDA alike); this
    // instruction never creates accounts.
    // Admin-only sweep works while paused, so the close can finish as
    // pause -> repay -> withdraw -> sweep with no unpause race.
    pub fn sweep_out(ctx: Context<SweepOut>, amount: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.state.admin,
            ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        check_sweep_amount(amount)?;
        require_keys_eq!(
            ctx.accounts.vault_wsol_ata.key(),
            ctx.accounts.state.vault_wsol_ata,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token::ID,
            ErrorCode::Unauthorized
        );
        let vault_data = ctx.accounts.vault_wsol_ata.try_borrow_data()?;
        let vault_mint = token_mint(&vault_data)?;
        // The destination mint must match the vault wSOL ATA mint (which is
        // canonical wSOL in production; the equality check is what the
        // program enforces so mock-mint tests exercise the same code).
        let dest_data = ctx.accounts.destination.try_borrow_data()?;
        // Read mint first: a missing account has empty data and fails here
        // with BadMint before any owner comparison runs.
        let dest_mint = token_mint(&dest_data)?;
        let dest_owner = token_owner(&dest_data)?;
        check_sweep_destination(
            &dest_owner,
            &dest_mint,
            &ctx.accounts.state.sweep_destination,
            &vault_mint,
        )?;
        drop(vault_data);
        drop(dest_data);
        let state_key = ctx.accounts.state.key();
        let bump = [ctx.accounts.state.bump_vault];
        let seeds = vault_seeds(&state_key, &bump);
        // SPL Token Transfer = 3u8 + amount le.
        let mut data = vec![3u8];
        data.extend_from_slice(&amount.to_le_bytes());
        let ix = Instruction {
            program_id: anchor_spl::token::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.vault_wsol_ata.key(), false),
                AccountMeta::new(ctx.accounts.destination.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.vault_wsol_ata.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.vault.to_account_info(),
            ],
            &[&seeds],
        )?;
        emit!(EvtSweep {
            destination: ctx.accounts.destination.key(),
            amount,
        });
        Ok(())
    }

    // Admin only: recover non-wSOL base fee dust from the vault.
    // DBC collects in QuoteToken mode and DAMM base fees are dust, but the
    // canonical base ATA can still accrue base tokens. This moves them to
    // the sweep_destination's base ATA (must pre-exist, owner ==
    // sweep_destination, mint == state.base_mint). Plain transfer, never
    // close, works while paused. No sale: the admin sells manually if needed.
    pub fn sweep_base(ctx: Context<SweepBase>, amount: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.state.admin,
            ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        check_sweep_amount(amount)?;
        require_keys_eq!(
            ctx.accounts.vault_base_ata.key(),
            ctx.accounts.state.vault_base_ata,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.base_mint.key(),
            ctx.accounts.state.base_mint,
            ErrorCode::Unauthorized
        );
        // Token program must own the base mint (SPL or Token-2022).
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            *ctx.accounts.base_mint.to_account_info().owner,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            *ctx.accounts.vault_base_ata.to_account_info().owner,
            ctx.accounts.token_program.key(),
            ErrorCode::Unauthorized
        );
        let vault_data = ctx.accounts.vault_base_ata.try_borrow_data()?;
        let vault_mint = token_mint(&vault_data)?;
        let vault_owner = token_owner(&vault_data)?;
        require_keys_eq!(
            vault_owner,
            ctx.accounts.vault.key(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            vault_mint,
            ctx.accounts.base_mint.key(),
            ErrorCode::Unauthorized
        );
        drop(vault_data);
        let dest_data = ctx.accounts.destination.try_borrow_data()?;
        let dest_mint = token_mint(&dest_data)?;
        let dest_owner = token_owner(&dest_data)?;
        check_sweep_destination(
            &dest_owner,
            &dest_mint,
            &ctx.accounts.state.sweep_destination,
            &vault_mint,
        )?;
        drop(dest_data);
        let state_key = ctx.accounts.state.key();
        let bump = [ctx.accounts.state.bump_vault];
        let seeds = vault_seeds(&state_key, &bump);
        // SPL/Token-2022 Transfer = 3u8 + amount le (same encoding).
        let mut data = vec![3u8];
        data.extend_from_slice(&amount.to_le_bytes());
        let ix = Instruction {
            program_id: ctx.accounts.token_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.vault_base_ata.key(), false),
                AccountMeta::new(ctx.accounts.destination.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.vault_base_ata.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.vault.to_account_info(),
            ],
            &[&seeds],
        )?;
        emit!(EvtSweepBase {
            destination: ctx.accounts.destination.key(),
            amount,
        });
        Ok(())
    }

    // Permissionless crank: anyone can call, program pays via vault PDA CPI.
    // Always runs the real marginfi_account_initialize_pda CPI. There is no
    // mock bypass here: a fresh PDA is SystemProgram-owned, which is exactly
    // what the marginfi program expects for an uncreated account. Mock tests
    // use init_mock_marginfi_account instead (local-test only).
    pub fn init_marginfi_account(ctx: Context<InitMarginfi>) -> Result<()> {
        require!(!ctx.accounts.state.paused, ErrorCode::Paused);
        require_keys_eq!(
            ctx.accounts.state.marginfi_account,
            Pubkey::default(),
            ErrorCode::AlreadyActive
        );
        require_keys_eq!(
            ctx.accounts.group.key(),
            ctx.accounts.state.group,
            ErrorCode::Unauthorized
        );
        let state_key = ctx.accounts.state.key();
        let bump = [ctx.accounts.state.bump_vault];
        let seeds = vault_seeds(&state_key, &bump);
        let ix = Instruction {
            program_id: MARGINFI_V2_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.group.key(), false),
                AccountMeta::new(ctx.accounts.marginfi_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new_readonly(ctx.accounts.instructions_sysvar.key(), false),
                AccountMeta::new_readonly(anchor_lang::solana_program::system_program::ID, false),
            ],
            data: marginfi_init_pda_data(0),
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.group.to_account_info(),
                ctx.accounts.marginfi_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.instructions_sysvar.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&seeds],
        )?;
        ctx.accounts.state.marginfi_account = ctx.accounts.marginfi_account.key();
        Ok(())
    }

    /// Test-only (local-test): bind a SystemProgram-owned mock marginfi
    /// account key without running the real CPI. Mainnet builds must NEVER
    /// enable local-test.
    #[cfg(feature = "local-test")]
    pub fn init_mock_marginfi_account(ctx: Context<InitMockMarginfi>) -> Result<()> {
        require!(!ctx.accounts.state.paused, ErrorCode::Paused);
        require_keys_eq!(
            ctx.accounts.state.marginfi_account,
            Pubkey::default(),
            ErrorCode::AlreadyActive
        );
        require_keys_eq!(
            ctx.accounts.group.key(),
            ctx.accounts.state.group,
            ErrorCode::Unauthorized
        );
        // Mock path only: the passed account must be SystemProgram-owned.
        require_keys_eq!(
            *ctx.accounts.marginfi_account.owner,
            anchor_lang::solana_program::system_program::ID,
            ErrorCode::BadOwner
        );
        ctx.accounts.state.marginfi_account = ctx.accounts.marginfi_account.key();
        Ok(())
    }

    // Permissionless: claim partner + creator trading fees to vault ATAs.
    // Exact DBC IDL account lists (SDK 2.0.0, IDL 0.2.2):
    // partner `claim_trading_fee` (14): pool_authority, config, pool(w),
    // token_a(w), token_b(w), base_vault(w), quote_vault(w), base_mint,
    // quote_mint, fee_claimer(signer), token_base/token_quote, event_authority, program.
    // creator `claim_creator_trading_fee` (13): same minus config.
    // token_b is the vault wSOL ATA (state.vault_wsol_ata).
    // token_a is the vault base ATA for the DBC base mint; it must exist
    // even when base fees are zero because the DBC program writes to it.
    // In local-test with a SystemProgram-owned mock pool, skip the DBC CPIs.
    pub fn claim_dbc_fees(ctx: Context<ClaimDbc>) -> Result<()> {
        require!(!ctx.accounts.state.paused, ErrorCode::Paused);
        require_keys_eq!(
            ctx.accounts.dbc_pool.key(),
            ctx.accounts.state.dbc_pool,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.dbc_config.key(),
            ctx.accounts.state.dbc_config,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.vault_wsol_ata.key(),
            ctx.accounts.state.vault_wsol_ata,
            ErrorCode::Unauthorized
        );
        // Both fee legs are canonical: quote leg is state.vault_wsol_ata
        // (above), base leg must be state.vault_base_ata for state.base_mint.
        // A second vault-owned ATA would strand fees outside sweep reach.
        require_keys_eq!(
            ctx.accounts.base_mint.key(),
            ctx.accounts.state.base_mint,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.token_a_account.key(),
            ctx.accounts.state.vault_base_ata,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.pool_authority.key(),
            DBC_POOL_AUTHORITY,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.event_authority.key(),
            dbc_event_authority(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.dbc_program.key(),
            DBC_PROGRAM_ID,
            ErrorCode::Unauthorized
        );
        // Quote leg (token_b) must be vault-owned for the quote mint.
        // Key equality alone is not enough if init is ever bypassed.
        // Keep the base-leg checks too.
        let quote_data = ctx.accounts.vault_wsol_ata.try_borrow_data()?;
        let quote_mint_val = token_mint(&quote_data)?;
        let quote_owner = token_owner(&quote_data)?;
        check_fee_destination(
            &quote_owner,
            &quote_mint_val,
            &ctx.accounts.vault.key(),
            &ctx.accounts.quote_mint.key(),
        )?;
        drop(quote_data);
        // Bind the base leg too: DBC pays base fees to any token_a account,
        // so require a vault-owned ATA for the pool base mint. Base fees are
        // zero by fee design (quote-mode), but the check closes the hole
        // generally instead of relying on that.
        let token_a_data = ctx.accounts.token_a_account.try_borrow_data()?;
        let token_a_mint = token_mint(&token_a_data)?;
        let token_a_owner = token_owner(&token_a_data)?;
        check_fee_destination(
            &token_a_owner,
            &token_a_mint,
            &ctx.accounts.vault.key(),
            &ctx.accounts.base_mint.key(),
        )?;
        drop(token_a_data);
        // Token programs must be the programs that own the pool mints;
        // otherwise a fake program could silently swallow the fee transfer
        // after DBC zeroes the fee counters.
        require_keys_eq!(
            ctx.accounts.token_base_program.key(),
            *ctx.accounts.base_mint.to_account_info().owner,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.token_quote_program.key(),
            *ctx.accounts.quote_mint.to_account_info().owner,
            ErrorCode::Unauthorized
        );
        let state_key = ctx.accounts.state.key();
        let bump = [ctx.accounts.state.bump_vault];
        let seeds = vault_seeds(&state_key, &bump);
        // Partner leg (14 accounts, IDL order).
        let ix_a = Instruction {
            program_id: DBC_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.pool_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.dbc_config.key(), false),
                AccountMeta::new(ctx.accounts.dbc_pool.key(), false),
                AccountMeta::new(ctx.accounts.token_a_account.key(), false),
                AccountMeta::new(ctx.accounts.vault_wsol_ata.key(), false),
                AccountMeta::new(ctx.accounts.base_vault.key(), false),
                AccountMeta::new(ctx.accounts.quote_vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.base_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_base_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_quote_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.dbc_program.key(), false),
            ],
            data: dbc_claim_partner_data(),
        };
        // Mock support: skip DBC CPIs for SystemProgram-owned test pools.
        let skip_dbc = should_skip_cpi(&ctx.accounts.dbc_pool.to_account_info());
        if !skip_dbc {
            invoke_signed(
                &ix_a,
                &[
                    ctx.accounts.pool_authority.to_account_info(),
                    ctx.accounts.dbc_config.to_account_info(),
                    ctx.accounts.dbc_pool.to_account_info(),
                    ctx.accounts.token_a_account.to_account_info(),
                    ctx.accounts.vault_wsol_ata.to_account_info(),
                    ctx.accounts.base_vault.to_account_info(),
                    ctx.accounts.quote_vault.to_account_info(),
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.quote_mint.to_account_info(),
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.token_base_program.to_account_info(),
                    ctx.accounts.token_quote_program.to_account_info(),
                    ctx.accounts.event_authority.to_account_info(),
                    ctx.accounts.dbc_program.to_account_info(),
                ],
                &[&seeds],
            )?;
        };
        // Creator leg (13 accounts, IDL order, no config).
        let ix_b = Instruction {
            program_id: DBC_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.pool_authority.key(), false),
                AccountMeta::new(ctx.accounts.dbc_pool.key(), false),
                AccountMeta::new(ctx.accounts.token_a_account.key(), false),
                AccountMeta::new(ctx.accounts.vault_wsol_ata.key(), false),
                AccountMeta::new(ctx.accounts.base_vault.key(), false),
                AccountMeta::new(ctx.accounts.quote_vault.key(), false),
                AccountMeta::new_readonly(ctx.accounts.base_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.quote_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_base_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_quote_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.dbc_program.key(), false),
            ],
            data: dbc_claim_creator_data(),
        };
        if !skip_dbc {
            invoke_signed(
                &ix_b,
                &[
                    ctx.accounts.pool_authority.to_account_info(),
                    ctx.accounts.dbc_pool.to_account_info(),
                    ctx.accounts.token_a_account.to_account_info(),
                    ctx.accounts.vault_wsol_ata.to_account_info(),
                    ctx.accounts.base_vault.to_account_info(),
                    ctx.accounts.quote_vault.to_account_info(),
                    ctx.accounts.base_mint.to_account_info(),
                    ctx.accounts.quote_mint.to_account_info(),
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.token_base_program.to_account_info(),
                    ctx.accounts.token_quote_program.to_account_info(),
                    ctx.accounts.event_authority.to_account_info(),
                    ctx.accounts.dbc_program.to_account_info(),
                ],
                &[&seeds],
            )?;
        }
        Ok(())
    }

    // Permissionless: claim locked DAMM v2 position fees to vault ATAs.
    // Exact cp-amm IDL (sdk 1.5.0, IDL 0.2.5, program cpamdp...):
    // `claim_position_fee` (15): pool_authority (fixed HLnp...), pool,
    // position(w), token_a(w), token_b(w), token_a_vault(w), token_b_vault(w),
    // token_a_mint, token_b_mint, position_nft_account, signer, token_a/b
    // programs, event_authority, program. No args.
    // In local-test with a SystemProgram-owned mock pool, skip the DAMM CPI.
    pub fn claim_damm_fees(ctx: Context<ClaimDamm>) -> Result<()> {
        require!(!ctx.accounts.state.paused, ErrorCode::Paused);
        require!(
            ctx.accounts.state.damm_pool != Pubkey::default(),
            ErrorCode::BadPrice
        );
        require_keys_eq!(
            ctx.accounts.damm_pool.key(),
            ctx.accounts.state.damm_pool,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.position.key(),
            ctx.accounts.state.damm_position,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.pool_authority.key(),
            DAMM_POOL_AUTHORITY,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.event_authority.key(),
            damm_event_authority(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.damm_program.key(),
            DAMM_V2_PROGRAM_ID,
            ErrorCode::Unauthorized
        );
        // Fee destinations must be vault-owned ATAs for the pool mints.
        // DAMM v2 pays position fees to any token_a/b account when the NFT
        // owner (our vault PDA) signs, so without this check any caller
        // could direct the vault's fee revenue to their own accounts.
        let fee_a_data = ctx.accounts.fee_token_a_account.try_borrow_data()?;
        let fee_a_mint = token_mint(&fee_a_data)?;
        let fee_a_owner = token_owner(&fee_a_data)?;
        check_fee_destination(
            &fee_a_owner,
            &fee_a_mint,
            &ctx.accounts.vault.key(),
            &ctx.accounts.token_a_mint.key(),
        )?;
        drop(fee_a_data);
        let fee_b_data = ctx.accounts.fee_token_b_account.try_borrow_data()?;
        let fee_b_mint = token_mint(&fee_b_data)?;
        let fee_b_owner = token_owner(&fee_b_data)?;
        check_fee_destination(
            &fee_b_owner,
            &fee_b_mint,
            &ctx.accounts.vault.key(),
            &ctx.accounts.token_b_mint.key(),
        )?;
        drop(fee_b_data);
        // Token programs must be the programs that own the pool mints,
        // otherwise a fake program could silently swallow the fee transfer.
        require_keys_eq!(
            ctx.accounts.token_a_program.key(),
            *ctx.accounts.token_a_mint.to_account_info().owner,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.token_b_program.key(),
            *ctx.accounts.token_b_mint.to_account_info().owner,
            ErrorCode::Unauthorized
        );
        // Both legs must be canonical: pool mints are exactly {base, wSOL}
        // and fee destinations are exactly {vault_base_ata, vault_wsol_ata}.
        // Owner + mint checks alone still allow a second vault-owned ATA,
        // which DAMM would happily pay into while sweep only reads the
        // canonical ATAs, stranding fee revenue. The pair check enforces
        // the quote-only assumption; base dust is recoverable via sweep_base.
        check_base_quote_pair(
            &ctx.accounts.token_a_mint.key(),
            &ctx.accounts.token_b_mint.key(),
            &ctx.accounts.state.base_mint,
        )?;
        check_canonical_fee_set(
            &ctx.accounts.fee_token_a_account.key(),
            &ctx.accounts.fee_token_b_account.key(),
            &ctx.accounts.state.vault_base_ata,
            &ctx.accounts.state.vault_wsol_ata,
        )?;
        let state_key = ctx.accounts.state.key();
        let bump = [ctx.accounts.state.bump_vault];
        let seeds = vault_seeds(&state_key, &bump);
        let ix = Instruction {
            program_id: DAMM_V2_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.pool_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.damm_pool.key(), false),
                AccountMeta::new(ctx.accounts.position.key(), false),
                AccountMeta::new(ctx.accounts.fee_token_a_account.key(), false),
                AccountMeta::new(ctx.accounts.fee_token_b_account.key(), false),
                AccountMeta::new(ctx.accounts.vault_a.key(), false),
                AccountMeta::new(ctx.accounts.vault_b.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_a_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_b_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.position_nft_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_a_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_b_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(ctx.accounts.damm_program.key(), false),
            ],
            data: damm_claim_data(),
        };
        // Mock support: skip DAMM CPI for SystemProgram-owned test pools.
        if !should_skip_cpi(&ctx.accounts.damm_pool.to_account_info()) {
            invoke_signed(
                &ix,
                &[
                    ctx.accounts.pool_authority.to_account_info(),
                    ctx.accounts.damm_pool.to_account_info(),
                    ctx.accounts.position.to_account_info(),
                    ctx.accounts.fee_token_a_account.to_account_info(),
                    ctx.accounts.fee_token_b_account.to_account_info(),
                    ctx.accounts.vault_a.to_account_info(),
                    ctx.accounts.vault_b.to_account_info(),
                    ctx.accounts.token_a_mint.to_account_info(),
                    ctx.accounts.token_b_mint.to_account_info(),
                    ctx.accounts.position_nft_account.to_account_info(),
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.token_a_program.to_account_info(),
                    ctx.accounts.token_b_program.to_account_info(),
                    ctx.accounts.event_authority.to_account_info(),
                    ctx.accounts.damm_program.to_account_info(),
                ],
                &[&seeds],
            )?;
        }
        Ok(())
    }

    // Permissionless: deposit wSOL to SOL Bank.
    // In local-test with a SystemProgram-owned mock bank, skip the CPI.
    pub fn deposit_sol<'info>(
        ctx: Context<'_, '_, '_, 'info, DepositSol<'info>>,
        amount: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.state.paused, ErrorCode::Paused);
        require!(amount > 0, ErrorCode::DustBorrow);
        require_keys_eq!(
            ctx.accounts.group.key(),
            ctx.accounts.state.group,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.marginfi_account.key(),
            ctx.accounts.state.marginfi_account,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.sol_bank.key(),
            ctx.accounts.state.sol_bank,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.vault_wsol_ata.key(),
            ctx.accounts.state.vault_wsol_ata,
            ErrorCode::Unauthorized
        );
        // The SOL bank holds SPL wSOL. The CPI metas below already hardcode
        // the SPL Token program, so a mismatched account fails closed there;
        // this names the invariant and errors early with Unauthorized.
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token::ID,
            ErrorCode::Unauthorized
        );
        let state_key = ctx.accounts.state.key();
        let bump = [ctx.accounts.state.bump_vault];
        let seeds = vault_seeds(&state_key, &bump);
        let mut metas = vec![
            AccountMeta::new_readonly(ctx.accounts.group.key(), false),
            AccountMeta::new(ctx.accounts.marginfi_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
            AccountMeta::new(ctx.accounts.sol_bank.key(), false),
            AccountMeta::new(ctx.accounts.vault_wsol_ata.key(), false),
            AccountMeta::new(ctx.accounts.liquidity_vault.key(), false),
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
        ];
        for acc in ctx.remaining_accounts.iter() {
            metas.push(AccountMeta {
                pubkey: *acc.key,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            });
        }
        let ix = Instruction {
            program_id: MARGINFI_V2_PROGRAM_ID,
            accounts: metas,
            data: marginfi_deposit_data(amount),
        };
        let mut infos = vec![
            ctx.accounts.group.to_account_info(),
            ctx.accounts.marginfi_account.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.sol_bank.to_account_info(),
            ctx.accounts.vault_wsol_ata.to_account_info(),
            ctx.accounts.liquidity_vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ];
        infos.extend_from_slice(ctx.remaining_accounts);
        // Mock support: skip marginfi CPI for SystemProgram-owned test banks.
        if !should_skip_cpi(&ctx.accounts.sol_bank.to_account_info()) {
            invoke_signed(&ix, &infos, &[&seeds])?;
        }
        Ok(())
    }

    // Permissionless crank: borrow PUMP, sell it into the fixed DLMM pool,
    // deposit the exact SOL proceeds, pulse health and enforce the hard
    // floor. Anyone can call; the vault PDA signs all CPIs.
    // Sequence: (a) marginfi borrow into vault_pump_ata; (b) DLMM swap
    // vault_pump_ata -> vault_wsol_ata signed by the vault PDA with
    // min_out 0 (no oracle, pool is fixed and admin-chosen);
    // (c) read delta, require sol_out > 0, deposit exactly sol_out;
    // (d) marginfi pulse_health; (e) read health cache and enforce
    // initial >= 1.50 and maintenance >= 1.25. Any failure reverts.
    // Only the swap delta is deposited; pre-existing wSOL never moves.
    pub fn borrow_sell_deposit_checked<'info>(
        ctx: Context<'_, '_, '_, 'info, BorrowSellDepositChecked<'info>>,
        amount: u64,
    ) -> Result<()> {
        check_crank_guards(amount, ctx.accounts.state.paused)?;
        let s = &ctx.accounts.state;
        require_keys_eq!(ctx.accounts.group.key(), s.group, ErrorCode::Unauthorized);
        require_keys_eq!(
            ctx.accounts.marginfi_account.key(),
            s.marginfi_account,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.sol_bank.key(),
            s.sol_bank,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.pump_bank.key(),
            s.pump_bank,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.vault_pump_ata.key(),
            s.vault_pump_ata,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.vault_wsol_ata.key(),
            s.vault_wsol_ata,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.dlmm_pool.key(),
            s.pump_pool,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.dlmm_program.key(),
            DLMM_PROGRAM_ID,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.token_x_program.key(),
            anchor_spl::token_2022::ID,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.token_y_program.key(),
            anchor_spl::token::ID,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.memo_program.key(),
            MEMO_PROGRAM_ID,
            ErrorCode::Unauthorized
        );
        // Event authority must be the DLMM PDA ["__event_authority"].
        let (expected_auth, _) =
            Pubkey::find_program_address(&[b"__event_authority"], &DLMM_PROGRAM_ID);
        require_keys_eq!(
            ctx.accounts.event_authority.key(),
            expected_auth,
            ErrorCode::Unauthorized
        );
        // Remaining layout: [pump_mint, health pairs (banks+oracles), bins...].
        // Health is 5 accounts (mint-first for Token-2022 + 2 banks + 2 oracles);
        // the rest are DLMM bin arrays (at least 1).
        require!(ctx.remaining_accounts.len() >= 6, ErrorCode::BadPrice);
        let (health, bins) = ctx.remaining_accounts.split_at(5);
        // Pulse uses the 4 health pairs without the mint-first entry.
        let pulse_pairs = &health[1..];
        require!(pulse_pairs.len() == 4, ErrorCode::BadPrice);
        let wsol_before = {
            let d = ctx.accounts.vault_wsol_ata.try_borrow_data()?;
            token_amount(&d)?
        };
        let state_key = ctx.accounts.state.key();
        let bump = [ctx.accounts.state.bump_vault];
        let seeds = vault_seeds(&state_key, &bump);
        // Mock flags (local-test only): production should_skip_cpi is always
        // false, so every CPI below runs for real on mainnet.
        let borrow_skipped = should_skip_cpi(&ctx.accounts.pump_bank.to_account_info());
        let swap_skipped = should_skip_cpi(&ctx.accounts.dlmm_pool.to_account_info());
        let deposit_skipped = should_skip_cpi(&ctx.accounts.sol_bank.to_account_info());
        let pulse_skipped = should_skip_cpi(&ctx.accounts.marginfi_account.to_account_info());
        // (a) marginfi borrow into the vault PUMP ATA.
        let mut borrow_metas = vec![
            AccountMeta::new_readonly(ctx.accounts.group.key(), false),
            AccountMeta::new(ctx.accounts.marginfi_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
            AccountMeta::new(ctx.accounts.pump_bank.key(), false),
            AccountMeta::new(ctx.accounts.vault_pump_ata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.bank_liquidity_vault_authority.key(), false),
            AccountMeta::new(ctx.accounts.bank_liquidity_vault.key(), false),
            AccountMeta::new_readonly(anchor_spl::token_2022::ID, false),
        ];
        for acc in health.iter() {
            borrow_metas.push(AccountMeta {
                pubkey: *acc.key,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            });
        }
        let borrow_ix = Instruction {
            program_id: MARGINFI_V2_PROGRAM_ID,
            accounts: borrow_metas,
            data: marginfi_borrow_data(amount),
        };
        {
            let mut infos = vec![
                ctx.accounts.group.to_account_info(),
                ctx.accounts.marginfi_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.pump_bank.to_account_info(),
                ctx.accounts.vault_pump_ata.to_account_info(),
                ctx.accounts
                    .bank_liquidity_vault_authority
                    .to_account_info(),
                ctx.accounts.bank_liquidity_vault.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
            ];
            infos.extend_from_slice(health);
            if !borrow_skipped {
                invoke_signed(&borrow_ix, &infos, &[&seeds])?;
            }
        }
        // (b) DLMM swap vault_pump_ata -> vault_wsol_ata, user = vault PDA.
        // min_out_amount = 0, no oracle. The hardcoded health floor below is
        // the only bound; the pool is fixed and admin-chosen.
        let swap_data = dlmm_swap2_data(amount, 0);
        let mut swap_metas = vec![
            AccountMeta::new(ctx.accounts.dlmm_pool.key(), false),
            AccountMeta::new(ctx.accounts.dlmm_bitmap.key(), false),
            AccountMeta::new(ctx.accounts.dlmm_reserve_x.key(), false),
            AccountMeta::new(ctx.accounts.dlmm_reserve_y.key(), false),
            AccountMeta::new(ctx.accounts.vault_pump_ata.key(), false),
            AccountMeta::new(ctx.accounts.vault_wsol_ata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_x_mint.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_y_mint.key(), false),
            AccountMeta::new(ctx.accounts.dlmm_oracle.key(), false),
            AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
            AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
            AccountMeta::new_readonly(ctx.accounts.token_x_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.token_y_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.memo_program.key(), false),
            AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
            AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
        ];
        for acc in bins.iter() {
            swap_metas.push(AccountMeta {
                pubkey: *acc.key,
                is_signer: false,
                is_writable: true,
            });
        }
        let swap_ix = Instruction {
            program_id: DLMM_PROGRAM_ID,
            accounts: swap_metas,
            data: swap_data,
        };
        {
            let mut infos = vec![
                ctx.accounts.dlmm_pool.to_account_info(),
                ctx.accounts.dlmm_bitmap.to_account_info(),
                ctx.accounts.dlmm_reserve_x.to_account_info(),
                ctx.accounts.dlmm_reserve_y.to_account_info(),
                ctx.accounts.vault_pump_ata.to_account_info(),
                ctx.accounts.vault_wsol_ata.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.dlmm_oracle.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                ctx.accounts.memo_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ];
            infos.extend_from_slice(bins);
            if !swap_skipped {
                invoke_signed(&swap_ix, &infos, &[&seeds])?;
            }
        }
        let wsol_after = {
            let d = ctx.accounts.vault_wsol_ata.try_borrow_data()?;
            token_amount(&d)?
        };
        let sol_out = wsol_after
            .checked_sub(wsol_before)
            .ok_or(error!(ErrorCode::MathOverflow))?;
        // Production always requires a positive fill. Local-test mocks skip
        // the swap CPI, so the delta is 0 there; allow 0 only when the swap
        // was skipped, otherwise fail closed.
        if sol_out == 0 {
            require!(swap_skipped, ErrorCode::BadPrice);
        }
        // (c) Deposit exactly the swap proceeds into the SOL bank.
        // Pre-existing wSOL never moves: only sol_out is deposited.
        // The SOL bank liquidity vault is bound by marginfi's bank relation;
        // a wrong vault fails inside the marginfi CPI.
        if sol_out > 0 && !deposit_skipped {
            let mut deposit_metas = vec![
                AccountMeta::new_readonly(ctx.accounts.group.key(), false),
                AccountMeta::new(ctx.accounts.marginfi_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
                AccountMeta::new(ctx.accounts.sol_bank.key(), false),
                AccountMeta::new(ctx.accounts.vault_wsol_ata.key(), false),
                AccountMeta::new(ctx.accounts.sol_bank_liquidity_vault.key(), false),
                AccountMeta::new_readonly(anchor_spl::token::ID, false),
            ];
            for acc in pulse_pairs.iter() {
                deposit_metas.push(AccountMeta {
                    pubkey: *acc.key,
                    is_signer: acc.is_signer,
                    is_writable: acc.is_writable,
                });
            }
            let deposit_ix = Instruction {
                program_id: MARGINFI_V2_PROGRAM_ID,
                accounts: deposit_metas,
                data: marginfi_deposit_data(sol_out),
            };
            let mut infos = vec![
                ctx.accounts.group.to_account_info(),
                ctx.accounts.marginfi_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.sol_bank.to_account_info(),
                ctx.accounts.vault_wsol_ata.to_account_info(),
                ctx.accounts.sol_bank_liquidity_vault.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
            ];
            infos.extend_from_slice(pulse_pairs);
            invoke_signed(&deposit_ix, &infos, &[&seeds])?;
        }
        // (d) Pulse health, then (e) enforce the hard floor.
        // Local-test mocks skip both only when the marginfi account itself
        // is SystemProgram-owned. Production never skips.
        let (initial_hf_bps, maint_hf_bps) = if pulse_skipped {
            (MIN_INITIAL_HF_BPS, MIN_MAINT_HF_BPS)
        } else {
            let mut pulse_metas = vec![
                AccountMeta::new(ctx.accounts.marginfi_account.key(), false),
                AccountMeta::new_readonly(ctx.accounts.group.key(), false),
            ];
            for acc in pulse_pairs.iter() {
                pulse_metas.push(AccountMeta {
                    pubkey: *acc.key,
                    is_signer: acc.is_signer,
                    is_writable: acc.is_writable,
                });
            }
            let pulse_ix = Instruction {
                program_id: MARGINFI_V2_PROGRAM_ID,
                accounts: pulse_metas,
                data: marginfi_pulse_health_data(),
            };
            {
                let mut infos = vec![
                    ctx.accounts.marginfi_account.to_account_info(),
                    ctx.accounts.group.to_account_info(),
                ];
                infos.extend_from_slice(pulse_pairs);
                invoke_signed(&pulse_ix, &infos, &[&seeds])?;
            }
            let mf_data = ctx.accounts.marginfi_account.try_borrow_data()?;
            let now_ts = Clock::get()?.unix_timestamp;
            check_health_cache(&mf_data, now_ts)?
        };
        emit!(EvtBorrowSellDeposit {
            pump_amount: amount,
            sol_out,
            initial_hf_bps,
            maint_hf_bps,
        });
        Ok(())
    }

    pub fn repay_all<'info>(
        ctx: Context<'_, '_, '_, 'info, RepayAll<'info>>,
        amount: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.state.admin,
            ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.group.key(),
            ctx.accounts.state.group,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.marginfi_account.key(),
            ctx.accounts.state.marginfi_account,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.pump_bank.key(),
            ctx.accounts.state.pump_bank,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.vault_pump_ata.key(),
            ctx.accounts.state.vault_pump_ata,
            ErrorCode::Unauthorized
        );
        // The PUMP bank is Token-2022. The CPI metas below already hardcode
        // the Token-2022 program, so a mismatched account fails closed
        // there; this names the invariant and errors early with Unauthorized.
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token_2022::ID,
            ErrorCode::Unauthorized
        );
        let state_key = ctx.accounts.state.key();
        let bump = [ctx.accounts.state.bump_vault];
        let seeds = vault_seeds(&state_key, &bump);
        let mut metas = vec![
            AccountMeta::new_readonly(ctx.accounts.group.key(), false),
            AccountMeta::new(ctx.accounts.marginfi_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
            AccountMeta::new(ctx.accounts.pump_bank.key(), false),
            AccountMeta::new(ctx.accounts.vault_pump_ata.key(), false),
            AccountMeta::new(ctx.accounts.bank_liquidity_vault.key(), false),
            AccountMeta::new_readonly(anchor_spl::token_2022::ID, false),
        ];
        for acc in ctx.remaining_accounts.iter() {
            metas.push(AccountMeta {
                pubkey: *acc.key,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            });
        }
        let ix = Instruction {
            program_id: MARGINFI_V2_PROGRAM_ID,
            accounts: metas,
            data: marginfi_repay_data(amount, true),
        };
        let mut infos = vec![
            ctx.accounts.group.to_account_info(),
            ctx.accounts.marginfi_account.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.pump_bank.to_account_info(),
            ctx.accounts.vault_pump_ata.to_account_info(),
            ctx.accounts.bank_liquidity_vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ];
        infos.extend_from_slice(ctx.remaining_accounts);
        // Mock support: skip marginfi repay for SystemProgram-owned test banks.
        if !should_skip_cpi(&ctx.accounts.pump_bank.to_account_info()) {
            invoke_signed(&ix, &infos, &[&seeds])?;
        }
        Ok(())
    }

    pub fn withdraw_all<'info>(
        ctx: Context<'_, '_, '_, 'info, WithdrawAll<'info>>,
        amount: u64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.state.admin,
            ctx.accounts.admin.key(),
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.group.key(),
            ctx.accounts.state.group,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.marginfi_account.key(),
            ctx.accounts.state.marginfi_account,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.sol_bank.key(),
            ctx.accounts.state.sol_bank,
            ErrorCode::Unauthorized
        );
        require_keys_eq!(
            ctx.accounts.vault_wsol_ata.key(),
            ctx.accounts.state.vault_wsol_ata,
            ErrorCode::Unauthorized
        );
        // The SOL bank holds SPL wSOL. The CPI metas below already hardcode
        // the SPL Token program, so a mismatched account fails closed
        // there; this names the invariant and errors early with Unauthorized.
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token::ID,
            ErrorCode::Unauthorized
        );
        let state_key = ctx.accounts.state.key();
        let bump = [ctx.accounts.state.bump_vault];
        let seeds = vault_seeds(&state_key, &bump);
        let mut metas = vec![
            AccountMeta::new_readonly(ctx.accounts.group.key(), false),
            AccountMeta::new(ctx.accounts.marginfi_account.key(), false),
            AccountMeta::new_readonly(ctx.accounts.vault.key(), true),
            AccountMeta::new(ctx.accounts.sol_bank.key(), false),
            AccountMeta::new(ctx.accounts.vault_wsol_ata.key(), false),
            AccountMeta::new_readonly(ctx.accounts.bank_liquidity_vault_authority.key(), false),
            AccountMeta::new(ctx.accounts.bank_liquidity_vault.key(), false),
            AccountMeta::new_readonly(anchor_spl::token::ID, false),
        ];
        for acc in ctx.remaining_accounts.iter() {
            metas.push(AccountMeta {
                pubkey: *acc.key,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            });
        }
        let ix = Instruction {
            program_id: MARGINFI_V2_PROGRAM_ID,
            accounts: metas,
            data: marginfi_withdraw_data(amount, true),
        };
        let mut infos = vec![
            ctx.accounts.group.to_account_info(),
            ctx.accounts.marginfi_account.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.sol_bank.to_account_info(),
            ctx.accounts.vault_wsol_ata.to_account_info(),
            ctx.accounts
                .bank_liquidity_vault_authority
                .to_account_info(),
            ctx.accounts.bank_liquidity_vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ];
        infos.extend_from_slice(ctx.remaining_accounts);
        // Mock support: skip marginfi withdraw for SystemProgram-owned test banks.
        if !should_skip_cpi(&ctx.accounts.sol_bank.to_account_info()) {
            invoke_signed(&ix, &infos, &[&seeds])?;
        }
        Ok(())
    }
}

// ---- Account contexts ----

#[derive(Accounts)]
pub struct InitState<'info> {
    // FeeShortState: 15 Pubkeys (480) + bool (1) + u8 + u8 (2) = 483
    // bytes + 8 discriminator.
    #[account(init, payer = payer, space = 8 + FeeShortState::LEN, seeds = [b"state"], bump)]
    pub state: Account<'info, FeeShortState>,
    /// CHECK: vault PDA, signer for CPIs via seeds.
    #[account(seeds = [b"vault", state.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: admin pubkey stored in state.
    pub admin: UncheckedAccount<'info>,
    /// CHECK: vault wSOL ATA owned by vault PDA.
    pub vault_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: vault PUMP ATA owned by vault PDA.
    pub vault_pump_ata: UncheckedAccount<'info>,
    /// CHECK: program data for upgrade authority check.
    pub program_data: UncheckedAccount<'info>,
    /// CHECK: DBC config for quote mint check.
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: quote mint (wSOL in production).
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: PUMP bank for mint check.
    pub pump_bank: UncheckedAccount<'info>,
    /// CHECK: SOL bank for mint + group check.
    pub sol_bank: UncheckedAccount<'info>,
    /// CHECK: Project 0 group for owner + bank group check.
    pub group: UncheckedAccount<'info>,
    /// CHECK: DBC pool for config + base mint check.
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: PUMP mint.
    pub pump_mint: UncheckedAccount<'info>,
    /// CHECK: vault base ATA owned by vault PDA (canonical for base mint).
    pub vault_base_ata: UncheckedAccount<'info>,
    /// CHECK: base mint (our token, not wSOL and not PUMP).
    pub base_mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(mut, has_one = admin)]
    pub state: Account<'info, FeeShortState>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitMarginfi<'info> {
    #[account(mut)]
    pub state: Account<'info, FeeShortState>,
    /// CHECK: vault PDA signer via seeds.
    #[account(seeds = [b"vault", state.key().as_ref()], bump = state.bump_vault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: marginfi account PDA to init.
    #[account(mut)]
    pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: Project 0 group.
    pub group: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: sysvar for marginfi PDA init CPI validation.
    #[account(address = ixs::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    /// CHECK: marginfi v2 program. Must be in the outer ix so the runtime
    /// can resolve the CPI target (Unknown program + MissingAccount otherwise).
    #[account(address = MARGINFI_V2_PROGRAM_ID)]
    pub marginfi_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Test-only (local-test): bind a mock marginfi account key, no CPI.
#[cfg(feature = "local-test")]
#[derive(Accounts)]
pub struct InitMockMarginfi<'info> {
    #[account(mut)]
    pub state: Account<'info, FeeShortState>,
    /// CHECK: mock marginfi account, must be SystemProgram-owned.
    pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: Project 0 group.
    pub group: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimDbc<'info> {
    pub state: Account<'info, FeeShortState>,
    /// CHECK: vault PDA signer via seeds (fee_claimer / creator).
    #[account(seeds = [b"vault", state.key().as_ref()], bump = state.bump_vault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: DBC pool authority (fixed FhVo...).
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC config (partner leg only; creator leg ignores it).
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: DBC pool.
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: vault base ATA (token_a). Must exist even when base fees are zero.
    #[account(mut)]
    pub token_a_account: UncheckedAccount<'info>,
    /// CHECK: vault wSOL ATA receiver (token_b). Must equal state.vault_wsol_ata.
    #[account(mut)]
    pub vault_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: DBC base vault.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC quote vault.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: base mint.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: quote mint (wSOL).
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: base token program.
    pub token_base_program: UncheckedAccount<'info>,
    /// CHECK: quote token program.
    pub token_quote_program: UncheckedAccount<'info>,
    /// CHECK: DBC event authority PDA ["__event_authority"].
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DBC program. Must be in the outer ix so the runtime can
    /// resolve the CPI target (Unknown program + MissingAccount otherwise).
    /// Also serves as the inner `program` account in the CPI.
    #[account(address = DBC_PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimDamm<'info> {
    pub state: Account<'info, FeeShortState>,
    /// CHECK: vault PDA signer via seeds.
    #[account(seeds = [b"vault", state.key().as_ref()], bump = state.bump_vault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 pool authority (fixed HLnp...).
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 pool.
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: locked position, must equal state.damm_position.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: fee destination A owned by vault.
    #[account(mut)]
    pub fee_token_a_account: UncheckedAccount<'info>,
    /// CHECK: fee destination B owned by vault.
    #[account(mut)]
    pub fee_token_b_account: UncheckedAccount<'info>,
    /// CHECK: pool vault A.
    #[account(mut)]
    pub vault_a: UncheckedAccount<'info>,
    /// CHECK: pool vault B.
    #[account(mut)]
    pub vault_b: UncheckedAccount<'info>,
    /// CHECK: token A mint.
    pub token_a_mint: UncheckedAccount<'info>,
    /// CHECK: token B mint.
    pub token_b_mint: UncheckedAccount<'info>,
    /// CHECK: position NFT account holding 1 NFT.
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: token A program.
    pub token_a_program: UncheckedAccount<'info>,
    /// CHECK: token B program.
    pub token_b_program: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 event authority PDA ["__event_authority"].
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 program. Must be in the outer ix so the runtime can
    /// resolve the CPI target (Unknown program + MissingAccount otherwise).
    /// Also serves as the inner `program` account in the CPI.
    #[account(address = DAMM_V2_PROGRAM_ID)]
    pub damm_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    pub state: Account<'info, FeeShortState>,
    /// CHECK: vault PDA signer via seeds.
    #[account(seeds = [b"vault", state.key().as_ref()], bump = state.bump_vault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: marginfi account.
    #[account(mut)]
    pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: Project 0 group.
    pub group: UncheckedAccount<'info>,
    /// CHECK: SOL bank.
    #[account(mut)]
    pub sol_bank: UncheckedAccount<'info>,
    /// CHECK: vault wSOL ATA source.
    #[account(mut)]
    pub vault_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: SOL bank liquidity vault.
    #[account(mut)]
    pub liquidity_vault: UncheckedAccount<'info>,
    /// CHECK: SPL token program.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: marginfi v2 program. Must be in the outer ix so the runtime
    /// can resolve the CPI target (Unknown program + MissingAccount otherwise).
    #[account(address = MARGINFI_V2_PROGRAM_ID)]
    pub marginfi_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BorrowSellDepositChecked<'info> {
    #[account(mut)]
    pub state: Account<'info, FeeShortState>,
    /// CHECK: vault PDA signer via seeds (marginfi authority + DLMM user).
    #[account(seeds = [b"vault", state.key().as_ref()], bump = state.bump_vault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: marginfi account.
    #[account(mut)]
    pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: Project 0 group.
    pub group: UncheckedAccount<'info>,
    /// CHECK: SOL bank (collateral, health check; writable for deposit and pulse).
    #[account(mut)]
    pub sol_bank: UncheckedAccount<'info>,
    /// CHECK: PUMP bank (debt).
    #[account(mut)]
    pub pump_bank: UncheckedAccount<'info>,
    /// CHECK: vault wSOL ATA (swap output + deposit source).
    #[account(mut)]
    pub vault_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: vault PUMP ATA (borrow dest + swap input).
    #[account(mut)]
    pub vault_pump_ata: UncheckedAccount<'info>,
    /// CHECK: PUMP bank liquidity vault authority PDA.
    pub bank_liquidity_vault_authority: UncheckedAccount<'info>,
    /// CHECK: PUMP bank liquidity vault.
    #[account(mut)]
    pub bank_liquidity_vault: UncheckedAccount<'info>,
    /// CHECK: SOL bank liquidity vault (deposit dest, bound by marginfi).
    #[account(mut)]
    pub sol_bank_liquidity_vault: UncheckedAccount<'info>,
    /// CHECK: Token-2022 program (marginfi borrow + DLMM token X).
    pub token_x_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token program (deposit + DLMM token Y, wSOL leg).
    pub token_y_program: UncheckedAccount<'info>,
    /// CHECK: DLMM pool, must equal state.pump_pool.
    #[account(mut)]
    pub dlmm_pool: UncheckedAccount<'info>,
    /// CHECK: DLMM reserve X (PUMP).
    #[account(mut)]
    pub dlmm_reserve_x: UncheckedAccount<'info>,
    /// CHECK: DLMM reserve Y (wSOL).
    #[account(mut)]
    pub dlmm_reserve_y: UncheckedAccount<'info>,
    /// CHECK: DLMM oracle.
    #[account(mut)]
    pub dlmm_oracle: UncheckedAccount<'info>,
    /// CHECK: DLMM bin-array bitmap extension.
    #[account(mut)]
    pub dlmm_bitmap: UncheckedAccount<'info>,
    /// CHECK: PUMP mint (DLMM token X mint).
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: wSOL mint (DLMM token Y mint).
    pub token_y_mint: UncheckedAccount<'info>,
    /// CHECK: Memo program (DLMM swap).
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: DLMM event authority PDA ["__event_authority"].
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: DLMM program. Must be in the outer ix so the runtime
    /// can resolve the CPI target (Unknown program + MissingAccount otherwise).
    #[account(address = DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    /// CHECK: marginfi v2 program. Must be in the outer ix so the runtime
    /// can resolve the CPI target (Unknown program + MissingAccount otherwise).
    #[account(address = MARGINFI_V2_PROGRAM_ID)]
    pub marginfi_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RepayAll<'info> {
    #[account(mut, has_one = admin)]
    pub state: Account<'info, FeeShortState>,
    pub admin: Signer<'info>,
    /// CHECK: vault PDA signer via seeds.
    #[account(seeds = [b"vault", state.key().as_ref()], bump = state.bump_vault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: marginfi account.
    #[account(mut)]
    pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: Project 0 group.
    pub group: UncheckedAccount<'info>,
    /// CHECK: PUMP bank.
    #[account(mut)]
    pub pump_bank: UncheckedAccount<'info>,
    /// CHECK: vault PUMP ATA source with cover amount.
    #[account(mut)]
    pub vault_pump_ata: UncheckedAccount<'info>,
    /// CHECK: PUMP bank liquidity vault.
    #[account(mut)]
    pub bank_liquidity_vault: UncheckedAccount<'info>,
    /// CHECK: Token-2022 program.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: marginfi v2 program. Must be in the outer ix so the runtime
    /// can resolve the CPI target (Unknown program + MissingAccount otherwise).
    #[account(address = MARGINFI_V2_PROGRAM_ID)]
    pub marginfi_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct WithdrawAll<'info> {
    #[account(mut, has_one = admin)]
    pub state: Account<'info, FeeShortState>,
    pub admin: Signer<'info>,
    /// CHECK: vault PDA signer via seeds.
    #[account(seeds = [b"vault", state.key().as_ref()], bump = state.bump_vault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: marginfi account.
    #[account(mut)]
    pub marginfi_account: UncheckedAccount<'info>,
    /// CHECK: Project 0 group.
    pub group: UncheckedAccount<'info>,
    /// CHECK: SOL bank.
    #[account(mut)]
    pub sol_bank: UncheckedAccount<'info>,
    /// CHECK: vault wSOL ATA destination.
    #[account(mut)]
    pub vault_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: SOL bank liquidity vault authority PDA.
    pub bank_liquidity_vault_authority: UncheckedAccount<'info>,
    /// CHECK: SOL bank liquidity vault.
    #[account(mut)]
    pub bank_liquidity_vault: UncheckedAccount<'info>,
    /// CHECK: SPL token program.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: marginfi v2 program. Must be in the outer ix so the runtime
    /// can resolve the CPI target (Unknown program + MissingAccount otherwise).
    #[account(address = MARGINFI_V2_PROGRAM_ID)]
    pub marginfi_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SweepOut<'info> {
    #[account(mut, has_one = admin)]
    pub state: Account<'info, FeeShortState>,
    pub admin: Signer<'info>,
    /// CHECK: vault PDA signer via seeds.
    #[account(seeds = [b"vault", state.key().as_ref()], bump = state.bump_vault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: vault wSOL ATA source, must hold at least `amount`.
    #[account(mut)]
    pub vault_wsol_ata: UncheckedAccount<'info>,
    /// CHECK: destination token account. Must already exist; owner must
    /// equal state.sweep_destination and mint must equal the vault wSOL
    /// ATA mint. Never created or closed by this instruction.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token program (wSOL is SPL, never Token-2022).
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SweepBase<'info> {
    #[account(mut, has_one = admin)]
    pub state: Account<'info, FeeShortState>,
    pub admin: Signer<'info>,
    /// CHECK: vault PDA signer via seeds.
    #[account(seeds = [b"vault", state.key().as_ref()], bump = state.bump_vault)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: vault base ATA source, must equal state.vault_base_ata.
    #[account(mut)]
    pub vault_base_ata: UncheckedAccount<'info>,
    /// CHECK: destination base token account. Must already exist; owner must
    /// equal state.sweep_destination and mint must equal state.base_mint.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: base mint, must equal state.base_mint.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: token program that owns the base mint (SPL or Token-2022).
    pub token_program: UncheckedAccount<'info>,
}

// Token account mint reader (SPL layout: mint[0..32], owner[32..64], ...).
pub fn token_mint(data: &[u8]) -> Result<Pubkey> {
    require!(data.len() >= 32, ErrorCode::BadMint);
    Ok(Pubkey::new_from_array(data[0..32].try_into().unwrap()))
}

// Token account owner reader (SPL layout: mint[0..32], owner[32..64], ...).
pub fn token_owner(data: &[u8]) -> Result<Pubkey> {
    require!(data.len() >= 64, ErrorCode::BadOwner);
    Ok(Pubkey::new_from_array(data[32..64].try_into().unwrap()))
}

// Sweep guard: never zero (no silent no-op). Pause does not block
// admin sweep, so the close finishes without an unpause race.
pub fn check_sweep_amount(amount: u64) -> Result<()> {
    require!(amount > 0, ErrorCode::ZeroAmount);
    Ok(())
}

// Sweep destination guards: owner must be the configured sweep_destination,
// mint must match the vault wSOL ATA mint.
pub fn check_sweep_destination(
    owner: &Pubkey,
    mint: &Pubkey,
    expected_owner: &Pubkey,
    expected_mint: &Pubkey,
) -> Result<()> {
    require_keys_eq!(*owner, *expected_owner, ErrorCode::Unauthorized);
    require_keys_eq!(*mint, *expected_mint, ErrorCode::BadMint);
    Ok(())
}

// Fee destination guards: the payout account must be owned by the vault
// PDA and its mint must match the pool mint, so a permissionless crank can
// only ever pay fee revenue into the vault. The downstream programs (DBC,
// DAMM v2) do not constrain payout destinations when the position owner
// signs, so this check is the only thing stopping fee diversion.
pub fn check_fee_destination(
    owner: &Pubkey,
    mint: &Pubkey,
    vault: &Pubkey,
    expected_mint: &Pubkey,
) -> Result<()> {
    require_keys_eq!(*owner, *vault, ErrorCode::Unauthorized);
    require_keys_eq!(*mint, *expected_mint, ErrorCode::BadMint);
    Ok(())
}

// Base/quote mint pair: DAMM pool mints must include the canonical base
// mint exactly once. The other leg is wSOL in production (mock wSOL in
// tests). Per-leg mint checks plus the canonical fee set below force the
// other leg to match the vault wSOL ATA mint, so no third mint can pay
// fees into the vault. We do NOT hardcode NATIVE_MINT here so mock
// tests with a fake wSOL mint exercise the same code path.
pub fn check_base_quote_pair(token_a: &Pubkey, token_b: &Pubkey, base_mint: &Pubkey) -> Result<()> {
    require!(*token_a != *token_b, ErrorCode::BadMint);
    let a_is_base = *token_a == *base_mint;
    let b_is_base = *token_b == *base_mint;
    require!(a_is_base != b_is_base, ErrorCode::BadMint);
    Ok(())
}

// Canonical fee set: both DAMM fee destinations must be exactly the two
// canonical vault ATAs (base + wSOL) in any order. Per-leg owner/mint
// checks already bind each leg to its pool mint; this closes the second
// vault-owned ATA hole for the base leg too.
pub fn check_canonical_fee_set(
    fee_a: &Pubkey,
    fee_b: &Pubkey,
    vault_base: &Pubkey,
    vault_wsol: &Pubkey,
) -> Result<()> {
    require!(*fee_a != *fee_b, ErrorCode::Unauthorized);
    let ok = (*fee_a == *vault_base && *fee_b == *vault_wsol)
        || (*fee_a == *vault_wsol && *fee_b == *vault_base);
    require!(ok, ErrorCode::Unauthorized);
    Ok(())
}

// Token account amount reader (SPL layout: mint[0..32], owner[32..64], amount[64..72]).
pub fn token_amount(data: &[u8]) -> Result<u64> {
    require!(data.len() >= 72, ErrorCode::BadPrice);
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[64..72]);
    Ok(u64::from_le_bytes(b))
}

#[cfg(test)]
#[cfg(feature = "local-test")]
mod tests {
    use super::*;

    #[test]
    fn state_space_is_exact() {
        // 15 Pubkeys (480) + bool (1) + u8 + u8 (2) = 483.
        assert_eq!(FeeShortState::LEN, 15 * 32 + 1 + 1 + 1);
        assert_eq!(FeeShortState::LEN, 483);
    }

    #[test]
    fn update_config_guards_ok() {
        let base = Pubkey::new_unique();
        let pos = Pubkey::new_unique();
        let dest = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        // Both DAMM default (pre-migration) passes.
        assert!(check_update_config(&Pubkey::default(), &Pubkey::default(), &dest, &pool).is_ok());
        // Both DAMM set passes.
        assert!(check_update_config(&base, &pos, &dest, &pool).is_ok());
    }

    #[test]
    fn update_config_default_addresses_err() {
        let dest = Pubkey::new_unique();
        let pool = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        // Default sweep destination bricks sweep_out.
        assert!(check_update_config(
            &Pubkey::default(),
            &Pubkey::default(),
            &Pubkey::default(),
            &pool
        )
        .is_err());
        // Default pump pool bricks the crank.
        assert!(check_update_config(
            &Pubkey::default(),
            &Pubkey::default(),
            &dest,
            &Pubkey::default()
        )
        .is_err());
        // Half-set DAMM pair bricks claim_damm_fees.
        assert!(check_update_config(&other, &Pubkey::default(), &dest, &pool).is_err());
        assert!(check_update_config(&Pubkey::default(), &other, &dest, &pool).is_err());
    }

    fn test_health_buffer(
        asset: i128,
        liab: i128,
        asset_maint: i128,
        liab_maint: i128,
        ts: i64,
        flags: u32,
        mrgn_err: u32,
        ver: u8,
    ) -> Vec<u8> {
        let mut data = vec![0u8; MARGINFI_ACCOUNT_LEN];
        data[HEALTH_CACHE_OFF..HEALTH_CACHE_OFF + 16].copy_from_slice(&asset.to_le_bytes());
        data[HEALTH_CACHE_OFF + 16..HEALTH_CACHE_OFF + 32].copy_from_slice(&liab.to_le_bytes());
        data[HEALTH_CACHE_OFF + 32..HEALTH_CACHE_OFF + 48]
            .copy_from_slice(&asset_maint.to_le_bytes());
        data[HEALTH_CACHE_OFF + 48..HEALTH_CACHE_OFF + 64]
            .copy_from_slice(&liab_maint.to_le_bytes());
        data[HEALTH_CACHE_OFF + 96..HEALTH_CACHE_OFF + 104].copy_from_slice(&ts.to_le_bytes());
        data[HEALTH_CACHE_OFF + 104..HEALTH_CACHE_OFF + 108].copy_from_slice(&flags.to_le_bytes());
        data[HEALTH_CACHE_OFF + 108..HEALTH_CACHE_OFF + 112]
            .copy_from_slice(&mrgn_err.to_le_bytes());
        data[HEALTH_CACHE_OFF + 245] = ver;
        data
    }

    #[test]
    fn health_guard_boundary_pass_fail() {
        const SCALE: i128 = 1 << 48;
        // Exact boundary passes: 150/100 initial, 125/100 maint.
        let ok = test_health_buffer(
            150 * SCALE,
            100 * SCALE,
            125 * SCALE,
            100 * SCALE,
            1000,
            7,
            0,
            3,
        );
        assert_eq!(check_health_cache(&ok, 1000).unwrap(), (15_000, 12_500));
        // Initial fail: 149/100.
        let bad_init = test_health_buffer(
            149 * SCALE,
            100 * SCALE,
            125 * SCALE,
            100 * SCALE,
            1000,
            7,
            0,
            3,
        );
        assert!(check_health_cache(&bad_init, 1000).is_err());
        // Maint fail: 124/100.
        let bad_maint = test_health_buffer(
            150 * SCALE,
            100 * SCALE,
            124 * SCALE,
            100 * SCALE,
            1000,
            7,
            0,
            3,
        );
        assert!(check_health_cache(&bad_maint, 1000).is_err());
    }

    #[test]
    fn health_guard_zero_negative_reject() {
        const SCALE: i128 = 1 << 48;
        // Liability zero rejects (both legs).
        let zero_liab = test_health_buffer(150 * SCALE, 0, 125 * SCALE, 100 * SCALE, 1000, 7, 0, 3);
        assert!(check_health_cache(&zero_liab, 1000).is_err());
        let zero_maint =
            test_health_buffer(150 * SCALE, 100 * SCALE, 125 * SCALE, 0, 1000, 7, 0, 3);
        assert!(check_health_cache(&zero_maint, 1000).is_err());
        // Negative asset rejects. On-chain -1 is raw -2^48.
        let neg = test_health_buffer(-SCALE, 100 * SCALE, 125 * SCALE, 100 * SCALE, 1000, 7, 0, 3);
        assert!(check_health_cache(&neg, 1000).is_err());
    }

    #[test]
    fn health_guard_known_raw_vectors() {
        const SCALE: i128 = 1 << 48;
        // 1.0 encodes as 00..00 01 00..00 LE.
        let mut one = [0u8; 16];
        one[6] = 1;
        assert_eq!(SCALE.to_le_bytes(), one);
        // On-chain -1 is raw -2^48, not the SDK helper encoding.
        let mut neg = [0u8; 16];
        neg[6] = 255;
        neg[7] = 255;
        neg[8] = 255;
        neg[9] = 255;
        neg[10] = 255;
        neg[11] = 255;
        neg[12] = 255;
        neg[13] = 255;
        neg[14] = 255;
        neg[15] = 255;
        assert_eq!((-SCALE).to_le_bytes(), neg);
        // Positive 1.5 / 1.25 round-trip through the helper math.
        let buf = test_health_buffer(
            150 * SCALE / 100,
            SCALE,
            125 * SCALE / 100,
            SCALE,
            1000,
            7,
            0,
            3,
        );
        assert!(check_health_cache(&buf, 1000).is_ok());
    }

    #[test]
    fn health_guard_short_overflow_reject() {
        const SCALE: i128 = 1 << 48;
        assert!(check_health_cache(&[], 1000).is_err());
        assert!(check_health_cache(&vec![0u8; 100], 1000).is_err());
        assert!(check_health_cache(&vec![0u8; 2311], 1000).is_err());
        assert!(check_health_cache(&vec![0u8; 2313], 1000).is_err());
        // Checked-mul overflow rejects.
        let over = test_health_buffer(i128::MAX, 1, 125 * SCALE, 100 * SCALE, 1000, 7, 0, 3);
        assert!(check_health_cache(&over, 1000).is_err());
    }

    #[test]
    fn health_guard_stale_future_flags_err_reject() {
        const SCALE: i128 = 1 << 48;
        let base = |ts: i64, flags: u32, err: u32, ver: u8| {
            test_health_buffer(
                150 * SCALE,
                100 * SCALE,
                125 * SCALE,
                100 * SCALE,
                ts,
                flags,
                err,
                ver,
            )
        };
        // Stale: older than 60s rejects; exactly 60s passes.
        assert!(check_health_cache(&base(939, 7, 0, 3), 1000).is_err());
        assert!(check_health_cache(&base(940, 7, 0, 3), 1000).is_ok());
        // Future timestamp rejects.
        assert!(check_health_cache(&base(1001, 7, 0, 3), 1000).is_err());
        // Engine bit (2) clear rejects; oracle bit (4) clear rejects.
        assert!(check_health_cache(&base(1000, 5, 0, 3), 1000).is_err());
        assert!(check_health_cache(&base(1000, 3, 0, 3), 1000).is_err());
        // mrgn_err non-zero rejects; version zero rejects.
        assert!(check_health_cache(&base(1000, 7, 1, 3), 1000).is_err());
        assert!(check_health_cache(&base(1000, 7, 0, 0), 1000).is_err());
    }

    #[test]
    fn pulse_health_data_exact() {
        let d = marginfi_pulse_health_data();
        assert_eq!(&d, &[186, 52, 117, 97, 34, 74, 39, 253]);
        assert_eq!(d.len(), 8);
    }

    #[test]
    fn crank_guards_ok() {
        assert!(check_crank_guards(1, false).is_ok());
        assert!(check_crank_guards(u64::MAX, false).is_ok());
    }

    #[test]
    fn crank_zero_amount_err() {
        assert!(check_crank_guards(0, false).is_err());
    }

    #[test]
    fn crank_paused_err() {
        assert!(check_crank_guards(1, true).is_err());
    }

    #[test]
    fn dlmm_swap2_data_exact() {
        let d = dlmm_swap2_data(0x0102030405060708, 0);
        assert_eq!(&d[0..8], &DISC_DLMM_SWAP2);
        assert_eq!(&d[8..16], &0x0102030405060708u64.to_le_bytes());
        assert_eq!(&d[16..24], &0u64.to_le_bytes());
        // RemainingAccountsInfo: vec len 2 + [{0,0},{1,0}].
        assert_eq!(&d[24..32], &[2u8, 0, 0, 0, 0, 0, 1, 0]);
        assert_eq!(d.len(), 32);
    }

    #[test]
    fn dlmm_swap2_min_out_encoded() {
        let d = dlmm_swap2_data(77, 99);
        assert_eq!(&d[8..16], &77u64.to_le_bytes());
        assert_eq!(&d[16..24], &99u64.to_le_bytes());
    }

    #[test]
    fn dlmm_program_id_matches_sdk() {
        // Pinned to @meteora-ag/dlmm 1.9.14 LB-CLMM v0.12.0.
        assert_eq!(
            DLMM_PROGRAM_ID.to_string(),
            "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
        );
        assert_eq!(&DISC_DLMM_SWAP2, &[65, 75, 63, 76, 235, 91, 91, 136]);
    }

    #[test]
    fn token_amount_reads_spl_layout() {
        let mut data = vec![0u8; 72];
        data[64..72].copy_from_slice(&419_000_000u64.to_le_bytes());
        assert_eq!(token_amount(&data).unwrap(), 419_000_000);
        assert!(token_amount(&[0u8; 10]).is_err());
    }

    #[test]
    fn marginfi_borrow_data_exact() {
        let d = marginfi_borrow_data(0x0102030405060708);
        assert_eq!(&d[0..8], &DISC_LENDING_BORROW);
        assert_eq!(&d[8..16], &0x0102030405060708u64.to_le_bytes());
        assert_eq!(d.len(), 16);
    }

    #[test]
    fn marginfi_deposit_data_exact() {
        let d = marginfi_deposit_data(77);
        assert_eq!(&d[0..8], &DISC_LENDING_DEPOSIT);
        assert_eq!(&d[8..16], &77u64.to_le_bytes());
        assert_eq!(d[16], 0);
        assert_eq!(d.len(), 17);
    }

    #[test]
    fn marginfi_repay_data_borsh() {
        let t = marginfi_repay_data(9, true);
        assert_eq!(&t[0..8], &DISC_LENDING_REPAY);
        assert_eq!(&t[8..16], &9u64.to_le_bytes());
        assert_eq!(&t[16..18], &[1u8, 1u8]);
        let f = marginfi_repay_data(9, false);
        assert_eq!(&f[16..18], &[1u8, 0u8]);
    }

    #[test]
    fn marginfi_withdraw_data_borsh() {
        let t = marginfi_withdraw_data(11, true);
        assert_eq!(&t[0..8], &DISC_LENDING_WITHDRAW);
        assert_eq!(&t[8..16], &11u64.to_le_bytes());
        assert_eq!(&t[16..18], &[1u8, 1u8]);
        let f = marginfi_withdraw_data(11, false);
        assert_eq!(&f[16..18], &[1u8, 0u8]);
    }

    #[test]
    fn marginfi_init_pda_data_exact() {
        let d = marginfi_init_pda_data(0);
        assert_eq!(&d[0..8], &DISC_MARGINFI_INIT_PDA);
        assert_eq!(&d[8..10], &0u16.to_le_bytes());
        assert_eq!(d[10], 0);
        let e = marginfi_init_pda_data(7);
        assert_eq!(&e[8..10], &7u16.to_le_bytes());
    }

    #[test]
    fn sweep_amount_zero_err() {
        assert!(check_sweep_amount(0).is_err());
    }

    #[test]
    fn sweep_amount_paused_ok() {
        // Pause does not block admin sweep (029).
        assert!(check_sweep_amount(1).is_ok());
    }

    #[test]
    fn sweep_amount_ok() {
        assert!(check_sweep_amount(1).is_ok());
        assert!(check_sweep_amount(u64::MAX).is_ok());
    }

    #[test]
    fn sweep_owner_mismatch_err() {
        let got = Pubkey::new_unique();
        let want = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert!(check_sweep_destination(&got, &mint, &want, &mint).is_err());
    }

    #[test]
    fn sweep_mint_mismatch_err() {
        let owner = Pubkey::new_unique();
        let got = Pubkey::new_unique();
        let want = Pubkey::new_unique();
        assert!(check_sweep_destination(&owner, &got, &owner, &want).is_err());
    }

    #[test]
    fn sweep_destination_ok() {
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert!(check_sweep_destination(&owner, &mint, &owner, &mint).is_ok());
    }

    #[test]
    fn fee_destination_ok() {
        let vault = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert!(check_fee_destination(&vault, &mint, &vault, &mint).is_ok());
    }

    #[test]
    fn fee_destination_wrong_owner_err() {
        let vault = Pubkey::new_unique();
        let evil = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        assert!(check_fee_destination(&evil, &mint, &vault, &mint).is_err());
    }

    #[test]
    fn fee_destination_wrong_mint_err() {
        let vault = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        assert!(check_fee_destination(&vault, &other, &vault, &mint).is_err());
    }

    fn sweep_test_data(mint: &Pubkey, owner: &Pubkey) -> Vec<u8> {
        let mut data = vec![0u8; 165];
        data[0..32].copy_from_slice(mint.as_ref());
        data[32..64].copy_from_slice(owner.as_ref());
        data
    }

    #[test]
    fn sweep_readers_parse_layout() {
        let mint = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let data = sweep_test_data(&mint, &owner);
        assert_eq!(token_mint(&data).unwrap(), mint);
        assert_eq!(token_owner(&data).unwrap(), owner);
    }

    #[test]
    fn sweep_readers_short_data_err() {
        assert!(token_mint(&[0u8; 10]).is_err());
        assert!(token_owner(&[0u8; 40]).is_err());
    }

    #[test]
    fn dbc_pool_authority_matches_idl() {
        // Fixed in the DBC IDL as pool_authority address.
        assert_eq!(
            DBC_POOL_AUTHORITY.to_string(),
            "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM"
        );
    }

    #[test]
    fn damm_pool_authority_matches_idl() {
        // From @meteora-ag/cp-amm-sdk 1.5.0, IDL cpAmm 0.2.5.
        assert_eq!(
            DAMM_POOL_AUTHORITY.to_string(),
            "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
        );
    }

    #[test]
    fn claim_event_authorities_derive() {
        let dbc_auth = dbc_event_authority();
        let (expect_dbc, _) =
            Pubkey::find_program_address(&[b"__event_authority"], &DBC_PROGRAM_ID);
        assert_eq!(dbc_auth, expect_dbc);
        let damm_auth = damm_event_authority();
        let (expect_damm, _) =
            Pubkey::find_program_address(&[b"__event_authority"], &DAMM_V2_PROGRAM_ID);
        assert_eq!(damm_auth, expect_damm);
        assert_ne!(dbc_auth, damm_auth);
    }

    #[test]
    fn dbc_claim_partner_data_exact() {
        let d = dbc_claim_partner_data();
        assert_eq!(&d[0..8], &DISC_CLAIM_TRADING_FEE);
        assert_eq!(&d[8..16], &u64::MAX.to_le_bytes());
        assert_eq!(&d[16..24], &u64::MAX.to_le_bytes());
        assert_eq!(d.len(), 24);
    }

    #[test]
    fn dbc_claim_creator_data_exact() {
        let d = dbc_claim_creator_data();
        assert_eq!(&d[0..8], &DISC_CLAIM_CREATOR_FEE);
        assert_eq!(&d[8..16], &u64::MAX.to_le_bytes());
        assert_eq!(&d[16..24], &u64::MAX.to_le_bytes());
        assert_eq!(d.len(), 24);
    }

    #[test]
    fn damm_claim_data_exact() {
        let d = damm_claim_data();
        assert_eq!(&d, &DISC_CLAIM_POSITION_FEE);
        assert_eq!(d.len(), 8);
    }

    #[test]
    fn program_data_address_uses_loader() {
        let expect =
            Pubkey::find_program_address(&[crate::ID.as_ref()], &BPF_LOADER_UPGRADEABLE_ID).0;
        assert_eq!(program_data_address(), expect);
    }

    #[test]
    fn parse_pubkey_at_ok() {
        let k = Pubkey::new_unique();
        let mut data = vec![0u8; 50];
        data[8..40].copy_from_slice(k.as_ref());
        assert_eq!(parse_pubkey_at(&data, 8).unwrap(), k);
        assert!(parse_pubkey_at(&data, 30).is_err());
    }

    #[test]
    fn parse_program_data_authority_ok() {
        let auth = Pubkey::new_unique();
        let mut data = vec![0u8; 45];
        data[0..4].copy_from_slice(&3u32.to_le_bytes());
        data[4..12].copy_from_slice(&42u64.to_le_bytes());
        data[12] = 1;
        data[13..45].copy_from_slice(auth.as_ref());
        assert_eq!(parse_program_data_upgrade_authority(&data).unwrap(), auth);
    }

    #[test]
    fn parse_program_data_authority_rejects() {
        let mut bad_tag = vec![0u8; 45];
        bad_tag[0..4].copy_from_slice(&2u32.to_le_bytes());
        bad_tag[12] = 1;
        assert!(parse_program_data_upgrade_authority(&bad_tag).is_err());
        let mut no_auth = vec![0u8; 45];
        no_auth[0..4].copy_from_slice(&3u32.to_le_bytes());
        no_auth[12] = 0;
        assert!(parse_program_data_upgrade_authority(&no_auth).is_err());
        assert!(parse_program_data_upgrade_authority(&[0u8; 10]).is_err());
    }

    #[test]
    fn canonical_ata_rejects_non_canonical() {
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let good = canonical_ata(&owner, &mint, &anchor_spl::token::ID);
        assert!(check_ata_canonical(&good, &owner, &mint, &anchor_spl::token::ID).is_ok());
        let evil = Pubkey::new_unique();
        assert!(check_ata_canonical(&evil, &owner, &mint, &anchor_spl::token::ID).is_err());
    }

    #[test]
    fn init_constants_match_production() {
        assert_eq!(
            NATIVE_MINT.to_string(),
            "So11111111111111111111111111111111111111112"
        );
        assert_eq!(
            PUMP_MINT.to_string(),
            "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
        );
        assert_eq!(&DISC_POOL_CONFIG, &[26, 108, 14, 123, 116, 230, 129, 43]);
        assert_eq!(&DISC_BANK, &[142, 49, 166, 242, 50, 66, 97, 188]);
    }

    #[test]
    fn group_discriminator_rejects_non_group() {
        // Correct MarginfiGroup discriminator passes.
        let mut data = vec![0u8; 32];
        data[0..8].copy_from_slice(&DISC_GROUP);
        assert!(check_group_discriminator(&data).is_ok());
        // A marginfi-owned Bank discriminator is rejected as group.
        let mut bank = vec![0u8; 32];
        bank[0..8].copy_from_slice(&DISC_BANK);
        assert!(check_group_discriminator(&bank).is_err());
        // Wrong discriminator rejects.
        let mut bad = vec![0u8; 32];
        bad[0] = 0xFF;
        assert!(check_group_discriminator(&bad).is_err());
        // Short data rejects.
        assert!(check_group_discriminator(&data[..7]).is_err());
    }

    #[test]
    fn bank_group_parses_layout() {
        // Synthetic marginfi Bank: disc + mint + decimals + group.
        let mint = Pubkey::new_unique();
        let group = Pubkey::new_unique();
        let mut data = vec![0u8; 73];
        data[0..8].copy_from_slice(&DISC_BANK);
        data[8..40].copy_from_slice(mint.as_ref());
        data[40] = 6;
        data[41..73].copy_from_slice(group.as_ref());
        assert_eq!(parse_bank_group(&data).unwrap(), group);
        // Wrong discriminator rejects.
        let mut bad = data.clone();
        bad[0] = 0xFF;
        assert!(parse_bank_group(&bad).is_err());
        // Short data rejects.
        assert!(parse_bank_group(&data[..50]).is_err());
    }

    #[test]
    fn virtual_pool_parses_layout() {
        // Synthetic DBC VirtualPool: disc + 64-byte tracker + config +
        // creator + base_mint. Verified against the installed DBC IDL
        // `PoolState` field order.
        assert_eq!(&DISC_VIRTUAL_POOL, &[213, 224, 5, 209, 98, 69, 119, 92]);
        let config = Pubkey::new_unique();
        let base = Pubkey::new_unique();
        let mut data = vec![0u8; 168];
        data[0..8].copy_from_slice(&DISC_VIRTUAL_POOL);
        data[OFF_POOL_CONFIG..OFF_POOL_CONFIG + 32].copy_from_slice(config.as_ref());
        data[OFF_POOL_BASE_MINT..OFF_POOL_BASE_MINT + 32].copy_from_slice(base.as_ref());
        assert_eq!(parse_virtual_pool_config(&data).unwrap(), config);
        assert_eq!(parse_virtual_pool_base_mint(&data).unwrap(), base);
        // Wrong discriminator rejects.
        let mut bad = data.clone();
        bad[0] = 0xFF;
        assert!(parse_virtual_pool_config(&bad).is_err());
        assert!(parse_virtual_pool_base_mint(&bad).is_err());
        // Short data rejects.
        assert!(parse_virtual_pool_config(&data[..100]).is_err());
        assert!(parse_virtual_pool_base_mint(&data[..100]).is_err());
    }

    #[test]
    fn bank_binding_rejects_wrong_mint_group() {
        let mint = Pubkey::new_unique();
        let group = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        // Exact match passes.
        assert!(check_bank_binding(&mint, &group, &mint, &group).is_ok());
        // Wrong mint rejects.
        assert!(check_bank_binding(&other, &group, &mint, &group).is_err());
        // Wrong group rejects.
        assert!(check_bank_binding(&mint, &other, &mint, &group).is_err());
        // Both wrong rejects.
        assert!(check_bank_binding(&other, &other, &mint, &group).is_err());
    }

    #[test]
    fn pool_binding_rejects_wrong_config_base() {
        let config = Pubkey::new_unique();
        let base = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        // Exact match passes.
        assert!(check_pool_binding(&config, &base, &config, &base).is_ok());
        // Wrong config rejects.
        assert!(check_pool_binding(&other, &base, &config, &base).is_err());
        // Wrong base mint rejects.
        assert!(check_pool_binding(&config, &other, &config, &base).is_err());
        // Both wrong rejects.
        assert!(check_pool_binding(&other, &other, &config, &base).is_err());
    }

    #[test]
    fn health_guard_pins_version_3() {
        const SCALE: i128 = 1 << 48;
        assert_eq!(MARGINFI_PROGRAM_VERSION, 3);
        // Exact version passes at the boundary.
        let ok = test_health_buffer(
            150 * SCALE,
            100 * SCALE,
            125 * SCALE,
            100 * SCALE,
            1000,
            7,
            0,
            3,
        );
        assert!(check_health_cache(&ok, 1000).is_ok());
        // Versions 0, 2 and 4 reject.
        for v in [0u8, 2, 4] {
            let bad = test_health_buffer(
                150 * SCALE,
                100 * SCALE,
                125 * SCALE,
                100 * SCALE,
                1000,
                7,
                0,
                v,
            );
            assert!(
                check_health_cache(&bad, 1000).is_err(),
                "version {} must fail",
                v
            );
        }
    }

    #[test]
    fn base_quote_pair_ok_both_orders() {
        let base = Pubkey::new_unique();
        let quote = Pubkey::new_unique();
        assert!(check_base_quote_pair(&base, &quote, &base).is_ok());
        assert!(check_base_quote_pair(&quote, &base, &base).is_ok());
    }

    #[test]
    fn base_quote_pair_rejects_third_mint() {
        let base = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let third = Pubkey::new_unique();
        assert!(check_base_quote_pair(&other, &third, &base).is_err());
        assert!(check_base_quote_pair(&base, &base, &base).is_err());
    }

    #[test]
    fn canonical_fee_set_ok_both_orders() {
        let vb = Pubkey::new_unique();
        let vw = Pubkey::new_unique();
        assert!(check_canonical_fee_set(&vb, &vw, &vb, &vw).is_ok());
        assert!(check_canonical_fee_set(&vw, &vb, &vb, &vw).is_ok());
    }

    #[test]
    fn canonical_fee_set_rejects_second_ata() {
        let vb = Pubkey::new_unique();
        let vw = Pubkey::new_unique();
        let evil = Pubkey::new_unique();
        assert!(check_canonical_fee_set(&evil, &vw, &vb, &vw).is_err());
        assert!(check_canonical_fee_set(&vb, &evil, &vb, &vw).is_err());
        assert!(check_canonical_fee_set(&vb, &vb, &vb, &vw).is_err());
    }
}
