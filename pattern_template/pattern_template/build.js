#!/usr/bin/env node
/**
 * build.js — Pattern Template Fragment Assembler
 *
 * Reads manifest.json, concatenates each variant's fragment list in order,
 * writes the assembled template to build/<variant>.html, and optionally
 * uploads it to Cloudflare KV via wrangler.
 *
 * Usage:
 *   node build.js                     # build all variants
 *   node build.js sis                 # build only sis
 *   node build.js sis sacasis         # build a subset
 *   node build.js --upload            # build all, then upload each to KV
 *   node build.js sacasis --upload    # build sacasis, then upload
 *   node build.js --verify-sis        # build sis and assert it equals the
 *                                     # current /mnt/project/pattern_template
 *                                     # byte-for-byte (round-trip test)
 *
 * KV upload requires `wrangler` on PATH and the SIS_TEMPLATES binding
 * configured in wrangler.toml. The script invokes:
 *   wrangler kv key put --binding=SIS_TEMPLATES <kv_key> --path=<assembled_file>
 *
 * No dependencies beyond Node's stdlib.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const FRAGMENTS_DIR = path.join(ROOT, "fragments");
const BUILD_DIR = path.join(ROOT, "build");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");

// ─── Args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const upload = args.includes("--upload");
const verifySis = args.includes("--verify-sis");
const requestedVariants = args.filter(a => !a.startsWith("--"));

// ─── Load manifest ───────────────────────────────────────────────────
const manifestRaw = fs.readFileSync(MANIFEST_PATH, "utf8");
const manifest = JSON.parse(manifestRaw);
const allVariants = manifest.variants;

const variantsToBuild = requestedVariants.length > 0
  ? requestedVariants
  : Object.keys(allVariants);

for (const v of variantsToBuild) {
  if (!allVariants[v]) {
    console.error(`✗ Unknown variant: "${v}". Known: ${Object.keys(allVariants).join(", ")}`);
    process.exit(1);
  }
}

// ─── Build ───────────────────────────────────────────────────────────
fs.mkdirSync(BUILD_DIR, { recursive: true });

const built = {};
for (const variantName of variantsToBuild) {
  const cfg = allVariants[variantName];
  const parts = [];
  for (const rel of cfg.fragments) {
    const full = path.join(FRAGMENTS_DIR, rel);
    if (!fs.existsSync(full)) {
      console.error(`✗ Missing fragment: ${rel}`);
      process.exit(2);
    }
    parts.push(fs.readFileSync(full, "utf8"));
  }
  const assembled = parts.join("");
  const outPath = path.join(BUILD_DIR, `${variantName}.html`);
  fs.writeFileSync(outPath, assembled);
  built[variantName] = { outPath, assembled, kvKey: cfg.kv_key };
  console.log(`✓ Built ${variantName} → ${path.relative(ROOT, outPath)} (${assembled.length.toLocaleString()} chars, ${cfg.fragments.length} fragments)`);
}

// ─── Round-trip verification ─────────────────────────────────────────
if (verifySis) {
  const sisOriginal = "/mnt/project/pattern_template";
  if (!fs.existsSync(sisOriginal)) {
    console.error(`✗ --verify-sis requires ${sisOriginal} to be readable.`);
    process.exit(3);
  }
  if (!built.sis) {
    console.error(`✗ --verify-sis requires the sis variant to be built (pass it explicitly or use no args).`);
    process.exit(3);
  }
  const original = fs.readFileSync(sisOriginal, "utf8");
  const assembled = built.sis.assembled;
  if (original === assembled) {
    console.log(`✓ Verification passed: assembled sis template is byte-for-byte identical to /mnt/project/pattern_template`);
  } else {
    const origLines = original.split("\n");
    const newLines = assembled.split("\n");
    console.error(`✗ Verification FAILED: assembled sis differs from original.`);
    console.error(`  Original: ${original.length} chars, ${origLines.length} lines`);
    console.error(`  Built:    ${assembled.length} chars, ${newLines.length} lines`);
    const max = Math.min(origLines.length, newLines.length);
    for (let i = 0; i < max; i++) {
      if (origLines[i] !== newLines[i]) {
        console.error(`  First diff at line ${i + 1}:`);
        console.error(`    original: ${JSON.stringify(origLines[i].slice(0, 120))}`);
        console.error(`    built:    ${JSON.stringify(newLines[i].slice(0, 120))}`);
        break;
      }
    }
    process.exit(4);
  }
}

// ─── Upload to KV ────────────────────────────────────────────────────
if (upload) {
  for (const [variantName, info] of Object.entries(built)) {
    console.log(`↑ Uploading ${variantName} to KV key "${info.kvKey}"…`);
    try {
      execFileSync(
        "wrangler",
        [
          "kv", "key", "put",
          "--binding=SIS_TEMPLATES",
          "--remote",
          info.kvKey,
          "--path", info.outPath,
        ],
        { stdio: "inherit" }
      );
      console.log(`✓ Uploaded ${variantName}`);
    } catch (err) {
      console.error(`✗ Failed to upload ${variantName}: ${err.message}`);
      process.exit(5);
    }
  }
}

console.log(`\nDone. Built ${Object.keys(built).length} variant(s).`);
