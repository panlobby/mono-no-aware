// Strict production artifact verifier (D-02 / task 047 hardening).
//
// It verifies BOTH sides of the deploy artifact:
// - the IDL program address and exact instruction allowlist;
// - sha256 of fee_short.so and fee_short.json against the tracked manifest;
// - source file hashes recorded in the manifest.
//
// This rejects the prior footgun where a local-test .so with a production
// IDL passed only because the .so existed.
//
//   npm run verify:artifact
//   npx ts-node scripts/check-production-artifact.ts --dir target/production
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const MANIFEST_PATH = path.join("scripts", "production-artifact.json");

interface Manifest {
  schema: number;
  programId: string;
  solanaVersion: string;
  anchorVersion: string;
  rustVersion: string;
  sourceHashes: Record<string, string>;
  artifacts: Record<string, string>;
  instructions: string[];
}

function argValue(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function fail(msg: string): never {
  console.error(`PRODUCTION_ARTIFACT_FAIL: ${msg}`);
  process.exit(1);
}

function sha256(file: string): string {
  if (!fs.existsSync(file)) fail(`missing file ${file}`);
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function main(): void {
  const dir = argValue("--dir", path.join("target", "production"));
  const soPath = path.join(dir, "fee_short.so");
  const idlPath = path.join(dir, "fee_short.json");
  if (!fs.existsSync(MANIFEST_PATH)) fail(`missing manifest ${MANIFEST_PATH}`);
  if (!fs.existsSync(idlPath)) fail(`missing production IDL ${idlPath}`);
  if (!fs.existsSync(soPath)) fail(`missing production .so ${soPath}`);

  const manifest = JSON.parse(
    fs.readFileSync(MANIFEST_PATH, "utf8")
  ) as Manifest;
  if (manifest.schema !== 1)
    fail(`unsupported manifest schema ${manifest.schema}`);

  // Source hashes tie the expected artifact to the reviewed code.
  for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
    const actual = sha256(file);
    if (actual !== expected)
      fail(`source hash mismatch ${file}: ${actual} != ${expected}`);
  }

  // Artifact hashes. A local-test .so cannot pass just because the IDL is
  // production: both files must match the pinned manifest.
  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    const actual = sha256(path.join(dir, name));
    if (actual !== expected)
      fail(`${name} sha256 mismatch: ${actual} != ${expected}`);
  }

  const idlRaw = fs.readFileSync(idlPath, "utf8");
  const idl = JSON.parse(idlRaw) as {
    address?: string;
    instructions?: Array<{ name?: string }>;
  };
  if (idl.address !== manifest.programId)
    fail(`IDL address ${idl.address ?? "missing"} != ${manifest.programId}`);

  const actualNames = (idl.instructions ?? []).map((ix) => ix.name ?? "");
  const actualSorted = [...actualNames].sort();
  const expectedSorted = [...manifest.instructions].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(
      `instruction allowlist mismatch: actual=${actualSorted.join(
        ","
      )} expected=${expectedSorted.join(",")}`
    );
  }

  console.log(
    `toolchain pinned: solana=${manifest.solanaVersion} anchor=${manifest.anchorVersion} rust=${manifest.rustVersion}`
  );
  console.log(`program id: ${manifest.programId}`);
  console.log(`instructions: ${actualSorted.length} exact allowlist entries`);
  console.log(`fee_short.so sha256: ${manifest.artifacts["fee_short.so"]}`);
  console.log(`fee_short.json sha256: ${manifest.artifacts["fee_short.json"]}`);
  console.log("PRODUCTION_ARTIFACT_OK");
}

main();
