// Reads the fixed DLMM pool from mainnet and prints the clone list.
// Nothing is guessed: reserves, oracle, bitmap and bin arrays come from
// the live pool object. Run before booting the local validator.
//
//   npx ts-node scripts/dlmm-clone-addrs.ts --out target/local-e2e/dlmm-clones.json
//
// Writes JSON with pool, reserveX, reserveY, oracle, bitmap, binArrays,
// token programs and mints. Fails when the pool legs are not PUMP/wSOL.
import * as fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DLMM = require("@meteora-ag/dlmm") as {
  create(
    conn: Connection,
    pool: PublicKey
  ): Promise<{
    pubkey: PublicKey;
    lbPair: {
      tokenXMint: PublicKey;
      tokenYMint: PublicKey;
      reserveX: PublicKey;
      reserveY: PublicKey;
      oracle: PublicKey;
    };
    tokenX: { owner: PublicKey };
    tokenY: { owner: PublicKey };
    binArrayBitmapExtension: { publicKey: PublicKey } | null;
    getBinArrayForSwap(
      swapForY: boolean
    ): Promise<Array<{ publicKey: PublicKey }>>;
  }>;
};

const DLMM_POOL = "HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh";
const PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const EXPECTED_BITMAP = "HC5P78TaKkkGaCU14Wk5S8x4G5Pqx2jt1fyvJPbvcQbv";

function arg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function main(): Promise<void> {
  const outFile = arg("--out", "");
  const connection = new Connection(
    "https://api.mainnet-beta.solana.com",
    "confirmed"
  );
  const dlmm = await DLMM.create(connection, new PublicKey(DLMM_POOL));
  if (dlmm.lbPair.tokenXMint.toBase58() !== PUMP_MINT) {
    throw new Error(
      `pool tokenX is not PUMP: ${dlmm.lbPair.tokenXMint.toBase58()}`
    );
  }
  if (dlmm.lbPair.tokenYMint.toBase58() !== WSOL_MINT) {
    throw new Error(
      `pool tokenY is not wSOL: ${dlmm.lbPair.tokenYMint.toBase58()}`
    );
  }
  const bitmap = dlmm.binArrayBitmapExtension?.publicKey;
  if (bitmap === undefined || bitmap === null) {
    throw new Error("pool has no bitmap extension");
  }
  if (bitmap.toBase58() !== EXPECTED_BITMAP) {
    throw new Error(`bitmap moved: ${bitmap.toBase58()}`);
  }
  const bins = await dlmm.getBinArrayForSwap(true);
  if (bins.length < 1) {
    throw new Error("pool returned no bin arrays");
  }
  const out = {
    pool: DLMM_POOL,
    reserveX: dlmm.lbPair.reserveX.toBase58(),
    reserveY: dlmm.lbPair.reserveY.toBase58(),
    oracle: dlmm.lbPair.oracle.toBase58(),
    bitmap: bitmap.toBase58(),
    binArrays: bins.map((b) => b.publicKey.toBase58()),
    tokenXProgram: dlmm.tokenX.owner.toBase58(),
    tokenYProgram: dlmm.tokenY.owner.toBase58(),
    tokenXMint: PUMP_MINT,
    tokenYMint: WSOL_MINT,
  };
  console.log(
    `pool=${out.pool} rx=${out.reserveX.slice(0, 6)} ` +
      `ry=${out.reserveY.slice(0, 6)} oracle=${out.oracle.slice(0, 6)} ` +
      `bitmap=${out.bitmap.slice(0, 6)} bins=${out.binArrays.length}`
  );
  if (outFile) {
    fs.mkdirSync(outFile.slice(0, outFile.lastIndexOf("/")), {
      recursive: true,
    });
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(`wrote ${outFile}`);
  }
  console.log("CHECK_OK dlmm-clone-addrs read the pool");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
