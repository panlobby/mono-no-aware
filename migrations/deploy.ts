// Launch params — single source of truth for mainnet launch.
// pump.fun parity on Meteora DBC + fee-short to Project 0 PUMP Bank.
// Supply 1B / 6 decimals. 1-segment curve: 30 virtual SOL + 1,073M virtual
// tokens -> 85 SOL real inflow sells 793,086,956.5, migrates 206,913,043.5.
// Fee 1.25% max-short (creator 0). DAMM v2 25bps. 100% locked LP.
// Project 0 Group 4qp6... / SOL Bank CCKt... / PUMP Bank 61Qx... (Token-2022).
//
// MAINNET RUNBOOK: docs/mainnet-launch.md
// The executable flow is scripts/launch.ts:
//   1. read-only preflight;
//   2. prepare: deploy production artifact, create DBC config/pool, vault ATAs
//      and fee-short state (paused);
//   3. post-init preflight;
//   4. go-live: atomic unpause + marginfi account init.
// No Squads, keeper, server or soft-launch phase. The launch wallet is
// payer, admin and upgrade authority. See docs/mainnet-launch.md and
// docs/fee-short-architecture.md.

import * as anchor from "@anchor-lang/core";

export const LAUNCH_PARAMS = {
  // Mainnet launch decisions (user-confirmed 2026-11-09):
  // - use the same hot wallet as the previous token;
  // - no Squads/multisig: this key is payer, admin and upgrade authority;
  // - prepare for an explicit --send go-live, not a soft-launch phase.
  mainnet: {
    rpcUrl: "https://solana-rpc.publicnode.com",
    // PublicNode rejects some batched/indexed reads; use the official
    // endpoint for read-only preflight/DLMM/bank inspection. The send path
    // may use either endpoint via --rpc.
    readRpcUrl: "https://api.mainnet-beta.solana.com",
    deployer: "DtNMDWy9dxrTSQxAruwbzSrY2NE3KFd4aDxMD79X9fLH",
    admin: "DtNMDWy9dxrTSQxAruwbzSrY2NE3KFd4aDxMD79X9fLH",
    upgradeAuthority: "DtNMDWy9dxrTSQxAruwbzSrY2NE3KFd4aDxMD79X9fLH",
    programId: "EapeYFLdbqdw4YCVfKwW9VPF1prdU14351vf3sMCRvDj",
    tokenMetadata: {
      // Finalized 2026-11-11. Immutable on-chain at DBC pool creation.
      name: "Mono no Aware",
      symbol: "mono",
      uri: "https://ar-io.dev/qG41oNKpHzh66gG7v55GwZJLAqhtv5xJ1ppLnclyc1M",
    },
  },
  token: {
    totalSupplyTokens: 1_000_000_000,
    baseDecimals: 6,
    quoteDecimals: 9,
    tokenType: "SPLToken",
    quoteMint: "So11111111111111111111111111111111111111112",
    pumpMint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
    pumpDecimals: 6,
  },
  curve: {
    // Virtual reserves from pump.fun.
    virtualSol: 30,
    virtualTokens: 1_073_000_000,
    // Derived targets. See docs/dbc-pump-parity-spec.md section 3.
    startPriceSolPerToken: 30 / 1_073_000_000,
    endPriceSolPerToken: 115 / 279_913_043.5,
    expectedBuyableTokens: 793_086_956.5,
    expectedMigrationBaseTokens: 206_913_043.5,
    expectedMigrationThresholdSOL: 85,
    expectedMigrationThresholdLamports: 85_000_000_000,
    startMcapSOL: 27.959,
    endMcapSOL: 410.842,
    // Q64.64 human-price scale check values. SDK is source of truth.
    expectedSqrtStartQ64: "3084469561662146",
    expectedSqrtEndQ64: "11823799986371562",
    // Raw scale (lamports per microtoken) for reference only.
    expectedSqrtStartRawQ64: "97539491883135584",
    expectedSqrtEndRawQ64: "373901385552019776",
    expectedLiquidityRaw: "5673623181001",
    sqrtPrices: [30 / 1_073_000_000, 115 / 279_913_043.5],
    liquidityWeights: [1],
    activationType: "Timestamp",
  },
  fee: {
    totalFeeBps: 125,
    totalFeeNumerator: 12_500_000,
    feeDenominator: 1_000_000_000,
    startingFeeBps: 125,
    endingFeeBps: 125,
    baseFeeMode: "FeeSchedulerExponential",
    dynamicFeeEnabled: false,
    collectFeeMode: "QuoteToken",
    creatorTradingFeePercentage: 0,
    poolCreationFee: 0,
    enableFirstSwapWithMinFee: false,
  },
  migration: {
    option: "MET_DAMM_V2",
    feeOption: "FixedBps25",
    feePercentage: 0,
    creatorFeePercentage: 0,
    dammV2FeeBps: 25,
  },
  liquidityDistribution: {
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 50,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 50,
  },
  project0: {
    program: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    group: "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8",
    solBank: "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh",
    pumpBank: "61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK",
    solOracle: "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE",
    pumpOracle: "4KL8nVtrXmLjbbHtrDz5YCHNqmii62oHfr9bsUtx1bgi",
    oracleMaxAgeSec: 70,
  },
  programs: {
    dbc: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
    dammV2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    marginfiV2: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    dlmm: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  },
  feeShort: {
    // Fixed DLMM sell venue (PUMP/wSOL). Admin can rotate it via update_config.
    pumpPool: "HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh",
  },
};

module.exports = async function (provider: anchor.AnchorProvider) {
  // Configure client to use the provider.
  anchor.setProvider(provider);

  // Mainnet launch is driven by scripts/launch.ts, not `anchor migrate`.
  // Params live in LAUNCH_PARAMS.
  console.log("Launch params loaded:", JSON.stringify(LAUNCH_PARAMS.curve));
};

// Keep LAUNCH_PARAMS on module.exports for require("./deploy") users
// (plain `export const` is wiped by the assignment above under CommonJS).
(
  module.exports as unknown as { LAUNCH_PARAMS: typeof LAUNCH_PARAMS }
).LAUNCH_PARAMS = LAUNCH_PARAMS;
