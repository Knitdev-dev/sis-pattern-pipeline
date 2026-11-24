// TDCR SWEATER CALCULATOR - Cloudflare Worker
// v15 — PATCH 2026-11-10: small sizes — sleeve gets the body's raglan round count when it needs 1-2 more (was: sleeve_grows_too_fast).
// v14 — PATCH: body_sts_needed mod-4 parity fix (Step 10).
//   Rag4 and UA_base*2 are always multiples of 4, so body_sts_needed's
//   divisibility by 4 depended entirely on (Y5_body_st_raw − Y2_body) mod 4.
//   Y5_body_st_raw was only rounded to nearest even (not nearest multiple of
//   4), so some bust/gauge/ease combinations (e.g. bust 80, gauge 20×24,
//   close ease) produced a non-integer body_pairs_needed → schedule_error
//   "raglan_pairs_non_integer" + cascading Y3_closure/Y4_closure failures.
//   Fix: when the parity gap is non-zero, bump the chest-stitch target up by
//   2 sts (≤1cm finished chest, never undersizes) before computing
//   body_sts_needed. Y5_body_st_raw was unused anywhere else in the file, so
//   this is fully isolated; finished_chest_cm (derived from the realized
//   schedule output) reflects the adjustment automatically. See
//   Y5_parity_gap / Y5_body_st_target in Step 10 below.
//
// ── EVEN-STITCH PARITY LOGIC (for k1tbl/p1 ribs) ───────────────────────────
//   The collar, cuff, and hem ribs are k1tbl/p1, which need EVEN stitch
//   counts on: each sleeve, the front, and the full back (rb+lb). rb/lb
//   halves may individually be odd. This is enforced in three places:
//     1. Y1_slv (sleeve split) is rounded to even at the start (Step 5).
//     2. Phase 1 short rows use an EVEN number of RS/WS pairs — Phase1 is
//        rounded to the nearest multiple of 4 rows (Step 6). Each Phase-1
//        pair adds 1 st per sleeve, so an even pair count keeps the sleeve
//        gain even. (Phase 2 adds 2 st/sleeve per pair — always even — so
//        any Phase-2 pair count is fine.) Net: sleeve stays even out of
//        short rows, and SL_parity_bump ends up 0 in normal cases.
//     3. Front and full-back are forced even at the Y4 divide (Step 12) by
//        redistributing within the fixed non_rag total (non_rag is even, so
//        both can be even). A leftover SL_parity_bump at pick-up (Step 13)
//        remains as a defensive fallback only.
// v13 — Ease values aligned with industry standards (matches SIS v3).
//
//   Ease changes (lookupEaseCm):
//     - close:      +10 → 0 cm   (body-skimming; CYC "close fitting")
//     - relaxed:    +20 → +7.5   (CYC "classic" / "relaxed/standard" midpoint)
//     - oversized:  +30 → +20    (CYC "oversized" floor +15, working +20)
//
//   Downstream lookups updated to remain coherent at the new ease values
//   (all derived from industry-standards report Charts 1-3):
//     - upperArmIntercept: 17.5 / 18.5 / 19   (was 17.5 / 20.5 / 22.0)
//       Re-derived against set-in chart M values + 4 cm raglan offset.
//     - lookupNeckCm sis_neck_offset: 0 / 0.5 / 1.5  (was 0 / 1 / 2)
//       Tracks SIS lookupNeckWidth offsets (+0.5 / +1.5).
//     - targetArmholeCm: base = SIS-v3 close + 4 cm; offset +0/+1/+3
//       (was base = SIS-v2 close + 4; offset +0/+1.5/+3.5)
//     - lookupCuffCm: base = SIS-v3 close-fit cuff values; bust-bracketed offset
//     - body length (Step 17): base = SIS-v3 close-fit length; bust-bracketed offset
//
//   No change required:
//     - REFERENCES const (chart values still correct; tier midpoints still apply).
//     - pickTierByEase: still useful as defence-in-depth, though under v13
//       the user-facing label now matches the chart tier directly for relaxed
//       and oversized; close (0) is still 2.5 cm off the close-fit chart's
//       midpoint (-2.5), which the bust_offset_cm field surfaces.
//     - Validator (tdcr-validator) — reads lookups from calc output as ground truth.
//
// v12 — Lookup tables aligned with SIS calculator + industry-standards report.
//   Same finished-garment goal across both calculators at any given fit;
//   construction-driven differences (raglan vs set-in armhole offset of +4 cm)
//   are encoded in the lookup table itself.
//
//   Lookup changes from v11:
//     - Bust ease: relaxed 22→20, oversized 35→30 (matches SIS)
//     - Armhole: rebuilt as base table + per-fit offset, base = SIS + 4 cm
//                (4 cm raglan-vs-set-in offset per Patty Lyons)
//     - Cuff: rebuilt to match SIS lookupLowerSleeveCirc verbatim
//     - Neck cast-on: derived from SIS neck_width × 2.3 (scoop curve factor),
//                     now ease-aware
//     - Body length: base table aligned with SIS, fit offsets +0/+3/+5
//                    (was +0 for relaxed/oversized, -3 for close);
//                    cropped/long step ±10 cm (was ±6), aligned with SIS
//                    and Amy Herzog / CYC industry convention
//
//   The reference patterns block is unchanged — those are informational
//   deltas, not targets, and will simply show larger differences from the
//   new aligned outputs.
//
// v11 — Scenario C rewrite: promotion-then-doubling algorithm.
//   A: body_pairs_needed < half_ar  → sleeve-only "modified raglan" rounds absorb slack
//   B: body_pairs_needed = half_ar  → exact fit, default I-P cadence
//   C: body_pairs_needed > half_ar  → promote plain rows to body-only inc rounds
//                                      starting from the bottom of the body-only
//                                      section, then continuing into the raglan
//                                      section. If still insufficient, double up
//                                      inc rounds at the very bottom of the
//                                      body-only section. Error if still doesn't fit.
//   Sleeve cadence locked at every-2nd-row in all scenarios. UA stays at
//   UA_base — no overflow inflation. trailing_plain_rows is always 0 (asserted in A/B).
//
// Field model for the schedule (all scenarios populate these):
//   raglan_paired_inc       — raglan rounds followed by a plain (Round 1, Round 2)
//   raglan_with_body_inc    — raglan rounds followed by Round 2A body-only inc (C only)
//   body_only_paired_inc    — body-only inc rounds followed by a plain (top of section)
//   body_only_consecutive_inc — body-only inc rounds with no plain after (middle/bottom of section)
//   body_only_doubled_inc   — doubled (+8 body) inc rounds at the very bottom (C only)
//
// Y3 stitch counts are corrected after the scenario branch (Step 9 computes
// preliminary, Step 11b finalises using raglan_with_body_inc).

// ═══════════════════════════════════════════════════════════
// INDUSTRY-STANDARD REFERENCE — for the embedded reference_check feature.
// CYC-based finished-garment chart (set-in sleeve construction), 9 sizes
// XS through 5XL, at three ease tiers. Source: Craft Yarn Council 2018
// body chart + Ysolda Teague 2017 (for cuff/neck values CYC omits) +
// Amy Herzog set-in conventions. See project docs.
//
// TIER MAPPING (v13):
//   Under v13 the calculator's user labels match the report's chart tiers
//   directly for relaxed (+7.5) and oversized (+20). Close (0) sits 2.5 cm
//   above the close_fit chart's midpoint (-2.5) — the chart values are still
//   the right family for comparison, and bust_offset_cm in the output
//   surfaces the small discrepancy. pickTierByEase still does the right thing
//   in all three cases by picking the nearest midpoint.
//
// CONSTRUCTION NOTE:
//   The chart is set-in. Raglan armholes conventionally run 4–5 cm
//   deeper than set-in (Patty Lyons), so positive armhole deltas of
//   that magnitude are expected and not a calc error. Upper-arm
//   circumference also tends to run wider on raglans because the
//   sleeve carries the increased yoke depth down toward the bicep.
//
// LENGTH NOTE:
//   The chart length corresponds to "standard" length_preference.
//   Cropped will show ~-10 cm and long ~+10 cm by design.
// ═══════════════════════════════════════════════════════════

// CYC body busts (zero-ease), 9 sizes XS through 5XL:
const REFERENCE_BUSTS = [76, 86, 96.5, 106.5, 117, 127, 137, 147, 158];
const SIZE_LABELS    = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

// Finished-garment measurements (cm), keyed by CYC body bust, at each ease tier.
const REFERENCES = {
  close_fit: {
    tier_label: "close-fit (-2.5 cm bust ease)",
    midpoint_ease_cm: -2.5,
    by_bust: {
      76:  { chest_cm:  73.5, upper_arm_cm: 27.5, armhole_cm: 18.0, cuff_cm: 17.0, length_cm: 57.0 },
      86:  { chest_cm:  83.5, upper_arm_cm: 28.5, armhole_cm: 19.0, cuff_cm: 17.0, length_cm: 58.0 },
      96.5:{ chest_cm:  94.0, upper_arm_cm: 30.5, armhole_cm: 20.5, cuff_cm: 18.0, length_cm: 58.5 },
      106.5:{chest_cm: 104.0, upper_arm_cm: 33.0, armhole_cm: 22.0, cuff_cm: 19.0, length_cm: 59.5 },
      117: { chest_cm: 114.5, upper_arm_cm: 37.0, armhole_cm: 23.0, cuff_cm: 20.0, length_cm: 60.0 },
      127: { chest_cm: 124.5, upper_arm_cm: 42.0, armhole_cm: 24.5, cuff_cm: 20.5, length_cm: 60.5 },
      137: { chest_cm: 134.5, upper_arm_cm: 45.5, armhole_cm: 25.5, cuff_cm: 21.5, length_cm: 60.5 },
      147: { chest_cm: 144.5, upper_arm_cm: 49.5, armhole_cm: 27.0, cuff_cm: 22.5, length_cm: 62.0 },
      158: { chest_cm: 155.5, upper_arm_cm: 52.0, armhole_cm: 28.0, cuff_cm: 23.0, length_cm: 62.0 },
    },
  },
  relaxed: {
    tier_label: "relaxed (+7.5 cm bust ease)",
    midpoint_ease_cm: 7.5,
    by_bust: {
      76:  { chest_cm:  83.5, upper_arm_cm: 29.0, armhole_cm: 19.0, cuff_cm: 18.0, length_cm: 59.0 },
      86:  { chest_cm:  93.5, upper_arm_cm: 30.0, armhole_cm: 20.0, cuff_cm: 18.0, length_cm: 60.0 },
      96.5:{ chest_cm: 104.0, upper_arm_cm: 32.0, armhole_cm: 21.5, cuff_cm: 19.0, length_cm: 60.5 },
      106.5:{chest_cm: 114.0, upper_arm_cm: 34.5, armhole_cm: 23.0, cuff_cm: 19.5, length_cm: 61.5 },
      117: { chest_cm: 124.5, upper_arm_cm: 38.5, armhole_cm: 24.0, cuff_cm: 20.5, length_cm: 62.0 },
      127: { chest_cm: 134.5, upper_arm_cm: 43.5, armhole_cm: 25.5, cuff_cm: 21.0, length_cm: 63.0 },
      137: { chest_cm: 144.5, upper_arm_cm: 47.0, armhole_cm: 26.5, cuff_cm: 22.0, length_cm: 63.0 },
      147: { chest_cm: 154.5, upper_arm_cm: 51.0, armhole_cm: 28.0, cuff_cm: 23.0, length_cm: 64.5 },
      158: { chest_cm: 165.5, upper_arm_cm: 53.5, armhole_cm: 29.0, cuff_cm: 23.5, length_cm: 64.5 },
    },
  },
  oversized: {
    tier_label: "oversized (+20 cm bust ease)",
    midpoint_ease_cm: 20.0,
    by_bust: {
      76:  { chest_cm:  96.0, upper_arm_cm: 32.0, armhole_cm: 21.0, cuff_cm: 19.0, length_cm: 62.0 },
      86:  { chest_cm: 106.0, upper_arm_cm: 33.0, armhole_cm: 22.0, cuff_cm: 19.0, length_cm: 63.0 },
      96.5:{ chest_cm: 116.5, upper_arm_cm: 35.0, armhole_cm: 23.5, cuff_cm: 20.0, length_cm: 64.0 },
      106.5:{chest_cm: 126.5, upper_arm_cm: 37.5, armhole_cm: 25.0, cuff_cm: 20.5, length_cm: 65.0 },
      117: { chest_cm: 137.0, upper_arm_cm: 41.5, armhole_cm: 26.0, cuff_cm: 21.5, length_cm: 66.0 },
      127: { chest_cm: 147.0, upper_arm_cm: 46.5, armhole_cm: 27.5, cuff_cm: 22.0, length_cm: 67.0 },
      137: { chest_cm: 157.0, upper_arm_cm: 50.0, armhole_cm: 28.5, cuff_cm: 23.0, length_cm: 67.0 },
      147: { chest_cm: 167.0, upper_arm_cm: 54.0, armhole_cm: 30.0, cuff_cm: 24.0, length_cm: 68.0 },
      158: { chest_cm: 178.0, upper_arm_cm: 56.5, armhole_cm: 31.0, cuff_cm: 24.5, length_cm: 68.0 },
    },
  },
};

// Find the reference (CYC body) bust closest to the actual body bust by
// absolute distance. Ties go to the lower (smaller) value because the loop
// uses strict `<`.
function findNearestReferenceBust(bust_cm) {
  let nearest = REFERENCE_BUSTS[0];
  let minDist = Math.abs(bust_cm - nearest);
  for (const r of REFERENCE_BUSTS) {
    const d = Math.abs(bust_cm - r);
    if (d < minDist) { minDist = d; nearest = r; }
  }
  return nearest;
}

function sizeLabelForBust(ref_bust_cm) {
  const i = REFERENCE_BUSTS.indexOf(ref_bust_cm);
  return i >= 0 ? SIZE_LABELS[i] : null;
}

// Pick the chart tier whose midpoint ease is closest to the actual ease_cm
// produced by the calculator. This decouples the chart lookup from the
// user-facing label, which is necessary because this calculator's "relaxed"
// (+20 cm) corresponds to CYC's "oversized" tier (also +20 cm).
function pickTierByEase(ease_cm) {
  let bestKey = "relaxed";
  let bestDist = Infinity;
  for (const [key, tier] of Object.entries(REFERENCES)) {
    const d = Math.abs(ease_cm - tier.midpoint_ease_cm);
    if (d < bestDist) { bestDist = d; bestKey = key; }
  }
  return bestKey;
}

// Build the reference_check object from the calc result + actual ease cm + bust.
// Always returns an object; bust_offset_cm shows how far the actual bust is from
// the nearest reference so callers can interpret deltas correctly (a +3 cm chest
// delta is small if bust_offset is also +3).
function buildReferenceCheck(result, ease_cm, bust_cm, ease_preference) {
  const tier_key = pickTierByEase(ease_cm);
  const refSet = REFERENCES[tier_key];
  const ref_bust_cm = findNearestReferenceBust(bust_cm);
  const ref = refSet.by_bust[ref_bust_cm];
  const ref_size = sizeLabelForBust(ref_bust_cm);
  const deltas_cm = {
    chest:   +(result.finished_chest_cm     - ref.chest_cm).toFixed(1),
    sleeve:  +(result.finished_upper_arm_cm - ref.upper_arm_cm).toFixed(1),
    armhole: +(result.armhole_depth_cm      - ref.armhole_cm).toFixed(1),
    cuff:    +(result.cuff_cm               - ref.cuff_cm).toFixed(1),
    length:  +(result.body_length_cm        - ref.length_cm).toFixed(1),
  };
  let max_field = "chest";
  let max_abs = Math.abs(deltas_cm.chest);
  for (const [k, v] of Object.entries(deltas_cm)) {
    if (Math.abs(v) > max_abs) { max_abs = Math.abs(v); max_field = k; }
  }
  const severity = max_abs < 1.0 ? "within_rounding"
                 : max_abs < 3.0 ? "small"
                 : max_abs < 6.0 ? "moderate"
                 :                 "significant";
  return {
    ref_source: "CYC industry standard (set-in sleeve chart)",
    ref_size,
    ref_bust_cm,
    ref_tier: refSet.tier_label,
    ease_preference,                      // user-facing label
    ease_cm,                              // actual ease used by the calc
    bust_offset_cm: +(bust_cm - ref_bust_cm).toFixed(1),
    deltas_cm,
    max_abs_delta_cm: +max_abs.toFixed(1),
    max_delta_field: max_field,
    severity,
    notes: "Chart is set-in; raglan armholes typically run +4 to +5 cm and upper arms run wider. Length deltas of ±10 cm are by design when length_preference is cropped/long.",
  };
}


// ── Compound raglan block solver ───────────────────────────────────────
// Replaces the Bresenham plain-pair spread. Bresenham scattered isolated plain
// pairs through the raglan section, so the cadence alternated between every-2nd
// and every-4th round — a visible break in the raglan line, confirmed in test
// knitting. Instead the section is split into three CONTIGUOUS blocks at two
// cadences:
//
//   block 1 (fast, top)    n1 increases every 2nd round   — neck to shoulder
//   block 2 (slow, middle) n2 increases every r2-th round — across upper chest
//   block 3 (fast, bottom) n3 increases every 2nd round   — upper bust to underarm
//
// This is the "S-curve" compound raglan (Winter, Sher): the body widens quickly
// from neck to shoulder, barely widens across the upper chest, then widens again
// toward the bust, so one constant rate cannot follow it. See also Budd,
// The Knitter's Handy Book of Top-Down Sweaters (linear fast->slow, the two-block
// special case of this when n3 = 0).
//
// Closure:  2*n1 + r2*n2 + 2*n3 = 2*R + S   and   n1 + n2 + n3 = R.
// Substituting n1 + n3 = R - n2 collapses both to  n2 * (r2 - 2) = S, so the
// solver has exactly one degree of freedom: which (r2, n2) pair to pick. The
// split of the remaining fast increases between top and bottom does NOT appear
// in the closure and is therefore a free fit choice.
//
//   R = raglan increase rounds required by the sleeve (raglan_pairs)
//   S = surplus rows to absorb  (= 2 * raglan_plain_pairs)
//
// Picks the SMALLEST slow rate r2 >= 3 that divides S exactly and yields a
// slow-block count n2 <= R. Smallest r2 = smallest change of angle at the block
// boundary, i.e. the least visible break in the raglan line.
//
// PARITY INVARIANT: available_rows is rounded even in Step 10, so S is even.
// For any odd r2 the divisor (r2 - 2) is odd, so every factor of 2 in S survives
// into n2 = S/(r2-2); n2 is therefore even whenever r2 is odd, and r2*n2 is even
// in all cases. The section row count 2*n1 + r2*n2 + 2*n3 stays even, so the
// even-row assumptions downstream still hold even though the repeating unit is
// no longer a 2-round pair.
function compoundRaglanBlocks(R, S, resuming) {
  if (!Number.isInteger(R) || !Number.isInteger(S) || R < 0 || S < 0) return null;
  // No surplus: single fast block, constant every-2nd-round (scenario B).
  if (S === 0) return { n1: R, n2: 0, r2: 2, n3: 0 };
  if (R === 0) return null;             // surplus rows but no increases to spread
  let r2 = 0, n2 = 0;
  for (let r = 3; r <= S + 2; r++) {
    const d = r - 2;
    if (S % d !== 0) continue;
    const c = S / d;
    if (c <= R) { r2 = r; n2 = c; break; }
  }
  if (r2 === 0) return null;            // no feasible slow block
  const F  = R - n2;
  // Remaining fast increases split half above the slow block, half below.
  // Nothing in the closure constrains this — it is a pure fit choice. Half and
  // half is the neutral default; the odd one goes to the TOP block, where
  // shoulder coverage needs it more. If this is ever made adjustable, this is
  // the only line to change.
  //
  // RESUMING: the checkpoint sits at the midpoint of the slow block by
  // construction, so a knitter resuming from it is always mid-slow-block. A
  // leading fast block would speed the raglan up for a round or two and then
  // drop it back to the slow rate — a visible kink in the raglan line exactly
  // where it should be smooth. So the remainder is shaped as slow-then-fast:
  // finish the slow block, then the closing fast block.
  const n1 = resuming ? 0 : Math.ceil(F / 2);
  const n3 = F - n1;
  return { n1, n2, r2, n3 };
}

// ordinal: 2 -> "2nd", 3 -> "3rd", 4 -> "4th". Used for the slow-rate wording,
// which is 3 in most sizes but can be 4, 5, ... when the surplus is large.
function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + "th";
  switch (n % 10) {
    case 1:  return n + "st";
    case 2:  return n + "nd";
    case 3:  return n + "rd";
    default: return n + "th";
  }
}

// ── Raglan block wording (2026-11-16) ──
// "once" instead of "1 times"; the slow block names Round 2 instead of "knit 2
// rounds plain", so every instruction uses the two rounds defined at the top.
function timesWord(n) {
  if (n === 1) return "once";
  if (n === 2) return "twice";
  if (n === 3) return "three times";
  return n + " times";
}
// Repeat notation (Yulia, 17 Nov 2026), aligned with the brioche pattern:
//   * to *   = stitches repeated within one round
//   ** to ** = a block of rounds; always "a total of N times" (N includes the
//              first time), never "N more times".
function repBlock(inner, n) {
  if (n === 1) return inner + '.';
  return '**' + inner + '.** Repeat ** to ** a total of <strong>' + n + '</strong> times.';
}
function blockInstr(rate, n) {
  const inner = rate === 2 ? 'Work Round 1, then Round 2'
                           : 'Work Round 1, then Round 2 ' + timesWord(rate - 1);
  return repBlock(inner, n);
}
function roundsNote(r) { return ' <em>(' + r + ' rounds)</em>'; }

// renderCompoundRaglanHTML: turn the solved compound-raglan blocks into finished
// HTML for the template to substitute verbatim (same ownership principle as the
// rest of the pipeline — the calculator decides wording, the formatter only
// substitutes).
//   blocks:      { n1, n2, r2, n3 } from compoundRaglanBlocks()
//   raglan_sts:  the per-line raglan stitch count (for the Round-1 text)
//   body_only_pairs: number of body-only increase pairs appended after the
//     raglan section (0 for none). Rendered as Round 2A (body-only) + Round 2B.
//   y3:          section stitch counts for the after-raglan box (optional)
// startSection: number of sections already printed above this one. On a fresh
// pattern it is 0 and sections number from 1. On a resumed pattern the worked
// prefix has already used up some numbers, so the remainder continues the
// count rather than restarting at 1 — a knitter holding both PDFs must never
// see two different things both called "Section 2".
// omitIntro: suppress the "worked in N sections" preamble when the worked
// prefix has already introduced the section structure.
// chkHtml / chkInc (2026-11-16): when given, the measurement checkpoint box is
// placed INSIDE the section, right after the increase round it belongs to,
// and that section is split into "repeat k times" / box / "repeat the rest
// MORE times". Before this the box sat after the whole yoke, so knitters only
// met it after they had already knitted past the point it describes.
function renderCompoundRaglanHTML(blocks, raglan_sts, body_only_pairs, y3,
                                  startSection, omitIntro, chkHtml, chkInc) {
  if (!blocks) return "";
  const _start = startSection || 0;
  const n1 = blocks.n1, n2 = blocks.n2, r2 = blocks.r2, n3 = blocks.n3;

  // Knitters were reading these two lines as the first instruction to work
  // rather than as definitions the sections below refer back to.
  const roundsIntro =
    '<p><em>Round 1 and Round 2 are defined here and referred to throughout ' +
    'the sections below.</em></p>';
  const round1 =
    '<div class="instr"><strong>Round 1 (raglan inc):</strong> ' +
    '*Knit to marker, M1R, SM, k' + raglan_sts + ', SM, M1L* — repeat * to * 3 more ' +
    'times, knit to end of round. <em>(8 sts increased)</em></div>';
  const round2 =
    '<div class="instr"><strong>Round 2 (plain):</strong> Knit to end.</div>';

  // Stitch-count box after the raglan increases (before body-only), when the
  // caller supplies the Y3 section counts.
  // Only when body-only rounds follow: otherwise it repeats, number for number,
  // the "yoke complete" box that comes straight after it (Yulia, 16 Nov 2026).
  let afterRaglan = "";
  if (y3 && body_only_pairs && body_only_pairs > 0) {
    const total = y3.rb + raglan_sts + y3.slv + raglan_sts + y3.f +
                  raglan_sts + y3.slv + raglan_sts + y3.lb;
    afterRaglan =
      "\n" + '<div class="stitch-box">' +
      "\n" + '<div class="label">AFTER RAGLAN INCREASES</div>' +
      "\n" + '<strong>' + y3.rb + '</strong> sts (right back) · ' + raglan_sts +
      ' raglan sts · <strong>' + y3.slv + '</strong> sts (right sleeve) · ' + raglan_sts +
      ' raglan sts · <strong>' + y3.f + '</strong> sts (front) · ' + raglan_sts +
      ' raglan sts · <strong>' + y3.slv + '</strong> sts (left sleeve) · ' + raglan_sts +
      ' raglan sts · <strong>' + y3.lb + '</strong> sts (left back)' +
      "\n" + '<br/><strong>Total: ' + total + ' sts</strong>' +
      "\n" + '</div>';
  }

  // Optional body-only section. Round 2A grows the body only; Round 2B is plain.
  let bodyOnly = "";
  if (body_only_pairs && body_only_pairs > 0) {
    bodyOnly =
      "\n" + '<hr class="divider"/>' +
      "\n" + '<h2 class="subsection">Body-Only Increases</h2>' +
      "\n" + '<p>These rounds shape the body only; the sleeves wait.</p>' +
      "\n" + '<div class="instr"><strong>Round 3 (body-only inc):</strong> ' +
      '*Knit to marker, M1R, SM, k' + raglan_sts + ', SM, knit to marker, SM, k' +
      raglan_sts + ', SM, M1L* — repeat * to * once more, knit to end of round. ' +
      '<em>(4 body sts increased)</em></div>' +
      "\n" + '<p style="margin-top:3mm">' +
      repBlock('Work Round 3, then Round 2', body_only_pairs) +
      roundsNote(2 * body_only_pairs) + '</p>';
  }
  bodyOnly = afterRaglan + bodyOnly;

  // ── Compound blocks ──
  // Collect only the non-empty blocks, then number them in knitting order so a
  // suppressed block never leaves a gap in the numbering (small sizes routinely
  // have n2 = 0, and n3 = 0 whenever the fast count is 1).
  const present = [];
  if (n1 > 0) present.push({ n: n1, rate: 2,  where: "neck to shoulder" });
  if (n2 > 0) present.push({ n: n2, rate: r2, where: "across the upper chest" });
  if (n3 > 0) present.push({ n: n3, rate: 2,  where: "to the underarm" });

  let out = "";
  if (present.length > 1 && !omitIntro) {
    out += '<p style="margin-top:3mm">The raglan increases are worked in ' +
           '<strong>' + present.length + '</strong> sections at different rates.</p>';
  }
  let cum = 0;
  present.forEach(function (b, i) {
    const sec = 'Section ' + (_start + i + 1);
    const label = (present.length > 1 || _start > 0)
      ? sec + ' (' + b.where + (_start > 0 && i === 0 ? ', from where you are now' : '') + '):'
      : 'Raglan increases:';
    const contLabel = (present.length > 1 || _start > 0)
      ? sec + ', continued:'
      : 'Raglan increases, continued:';
    // On a resumed pattern (_start > 0) the knitter has already worked part of
    // this section, so a bare "10 times" reads as the total rather than what is
    // left to do. "10 MORE times" removes the ambiguity.
    // Checkpoint inside this block? k = repeats to work before stopping.
    const k = (chkHtml && chkInc > cum && chkInc <= cum + b.n) ? chkInc - cum : 0;
    cum += b.n;
    if (k === 0) {
      out += '<p style="margin-top:3mm"><strong>' + label + '</strong> ' +
             blockInstr(b.rate, b.n) + roundsNote(b.rate * b.n) + '</p>';
      return;
    }
    out += '<p style="margin-top:3mm"><strong>' + label + '</strong> ' +
           blockInstr(b.rate, k) + roundsNote(b.rate * k) +
           ' Then stop and check your measurements (box below).</p>';
    out += "\n" + chkHtml + "\n";
    if (b.n - k > 0) {
      out += '<p style="margin-top:3mm"><strong>' + contLabel + '</strong> ' +
             blockInstr(b.rate, b.n - k) + roundsNote(b.rate * (b.n - k)) + '</p>';
    }
  });

  // When a worked prefix precedes this block it has already defined Round 1
  // and Round 2; repeating them mid-section makes the document read as two
  // patterns stapled together.
  const heads = omitIntro ? "" : (roundsIntro + "\n" + round1 + "\n" + round2 + "\n");
  return heads + out + bodyOnly;
}

// ── Mid-yoke checkpoint ────────────────────────────────────────────────
// solveCheckpoint: locate a mid-yoke position where the knitter stops, blocks,
// and measures, so a gauge drift can be caught while the schedule below still
// has enough unworked rounds to absorb a correction.
//
// The knitter measures WHAT IS ON THE NEEDLE — not a band below it. One stitch
// count, one circumference, one place. Measuring below the needle would put two
// different stitch counts in play at once (the count on the needle vs the count
// at the measured band) and invite the knitter to think their count is wrong.
//
// Anchor, scenario A (slow block present):
//   the end of the m-th slow-block repeat, m = round(n2 / 2) — the midpoint of
//   the slow block. Each slow repeat is [inc round, then (r2 - 1) plain rounds],
//   so this lands the checkpoint on a plain band of (r2 - 1) rounds, keeping the
//   top of the fabric clear of the local distortion an increase round creates.
//
// Anchor, scenarios B and C (no slow block):
//   mid fast block, m = 0, plain band of 1 round. In C the promoted Round 2A's
//   sit at the BOTTOM of the raglan section (promotion is bottom-up), so a
//   midpoint checkpoint is above them whenever raglan_with_body_inc <= half the
//   section; the caller passes rag_paired_top to bound this exactly.
//
//   R_inc        total raglan increase rounds in the section (A2_pairs)
//   blocks       { n1, n2, r2, n3 } or null (B/C)
//   rag_paired_top  raglan inc rounds at the top that are plain-paired (C: A2 -
//                   raglan_with_body_inc; A/B: R_inc)
//   sr_rows      short-row rows already worked at centre back
//   Y2_total     stitch count after short rows
// Returns null when the yoke is too short to place a meaningful checkpoint.
function solveCheckpoint(R_inc, blocks, rag_paired_top, sr_rows, Y2_total) {
  if (!Number.isInteger(R_inc) || R_inc < 4) return null;  // too short to be useful
  let inc_rounds, rounds_from_neck, plain_band;
  if (blocks && blocks.n2 > 0) {
    const m = Math.round(blocks.n2 / 2);
    if (m < 1) return null;
    inc_rounds       = blocks.n1 + m;
    rounds_from_neck = sr_rows + 2 * blocks.n1 + blocks.r2 * m;
    plain_band       = blocks.r2 - 1;
  } else {
    inc_rounds       = Math.round(R_inc / 2);
    rounds_from_neck = sr_rows + 2 * inc_rounds;
    plain_band       = 1;
  }
  // Stitch count: every plain-paired raglan inc round adds 8 sts. In scenario C
  // an inc round beyond rag_paired_top carries a Round 2A, adding 4 body sts on
  // top of the 8. Clamped at 0 so A/B (rag_paired_top === R_inc) reduces to 8n.
  const with_body = Math.max(0, inc_rounds - rag_paired_top);
  const sts_total = Y2_total + 8 * inc_rounds + 4 * with_body;
  return { inc_rounds, rounds_from_neck, plain_band, sts_total };
}

// renderCheckpointHTML: the knitter-facing checkpoint box. Finished HTML, so the
// formatter substitutes it verbatim (calculator owns rendering).
//   chk:      solveCheckpoint() result
//   circ_cm, depth_cm: expected measurements at the checkpoint
//   contact:  support address for out-of-tolerance reports
// ── Resume mode (Phase 2) ──────────────────────────────────────────────
// solveResumeSchedule: re-solve the REMAINDER of the yoke for a knitter who
// stopped at the checkpoint, measured, and came back out of tolerance.
//
// The governing decision: resume targets the ORIGINAL FINISHED MEASUREMENTS,
// not the original stitch counts. Re-targeting counts would be a far smaller
// change but would not fix the fit — which is the whole point. So the targets
// (upper arm, chest, armhole depth) are recomputed at the knitter's EFFECTIVE
// gauge, while everything already on the needle is treated as fixed history.
//
// Two things are immovable and must be treated as boundary conditions:
//   - the stitches on the needle (cur_*), which no amount of solving can change
//   - the rounds already worked (rounds_worked), which are spent from the
//     armhole row budget
// Everything below the checkpoint is free. The solver is the same A/B/C
// machinery as a fresh pattern, run on a reduced budget.
//
// Returns { ok: true, ... } or { ok: false, reason } — a false result means the
// remaining schedule cannot reach the target and the case needs manual review.
// That is a legitimate outcome, not a bug: a knitter who checkpoints very late,
// or whose gauge is far off, may simply have too little yoke left.
//
//   cur         { rb, slv, f, lb, total } stitches on the needle now
//   rounds_worked  rows from below the neckband, including short rows
//   gs_e, gr_e  effective gauge, sts and rows per cm, from the measurements
//   t           { upper_arm_cm, C_cm, target_armhole_cm, Rag, Rag4,
//                 ua_fraction } targets carried over from the original order
function solveResumeSchedule(cur, rounds_worked, gs_e, gr_e, t) {
  const round = Math.round, max = Math.max, min = Math.min, ceil = Math.ceil;
  const roundHalfDownEven = (x) => Math.ceil(x / 2 - 0.5) * 2;

  // ── Targets at effective gauge ──
  // Same derivations the fresh path uses (STEP 8/9/10b), only the gauge differs.
  const T = solveTargets(t.upper_arm_cm, t.C_cm, t.target_armhole_cm,
                         t.ua_fraction, gs_e, gr_e);
  const upper_arm_sts = T.upper_arm_sts;
  const UA_base = T.UA_base;
  const slv_raw = upper_arm_sts - UA_base;
  // Sleeve growth is 2 sts per side per raglan round, so the gap from the
  // CURRENT sleeve count must be even — parity is measured against cur.slv,
  // not against the original Y2_slv.
  const slv_target = (slv_raw - cur.slv) % 2 === 0 ? slv_raw : slv_raw + 1;
  const R_rem = (slv_target - cur.slv) / 2;
  if (R_rem < 0) {
    return { ok: false, reason: "sleeve_already_too_wide",
      detail: "The sleeve is already wider than the target at the measured gauge "
        + "(" + cur.slv + " sts on the needle vs " + slv_target + " wanted). "
        + "No schedule can remove stitches — the yoke would need reknitting." };
  }

  // ── Body target at effective gauge ──
  const body_raw = T.body_raw;
  const cur_body = cur.rb + cur.lb + cur.f;
  // Same mod-4 alignment nudge as STEP 10, measured against the CURRENT body
  // count. Rounds up only, so the fix never undersizes the garment.
  const gap4 = (body_raw - cur_body) % 4;
  const body_target = gap4 === 0 ? body_raw : body_raw + (4 - gap4) % 4;
  const body_sts_needed = body_target - t.Rag4 - UA_base * 2 - cur_body;
  if (body_sts_needed < 0) {
    return { ok: false, reason: "body_already_too_wide",
      detail: "The body is already wider than the target at the measured gauge. "
        + "The yoke would need reknitting." };
  }
  if (body_sts_needed % 4 !== 0) {
    return { ok: false, reason: "body_parity",
      detail: "Body stitches needed (" + body_sts_needed + ") is not divisible by 4 "
        + "after the alignment nudge — needs review." };
  }
  const body_pairs_needed = body_sts_needed / 4;

  // ── Row budget ──
  const target_rows = T.target_rows;
  let available_rows = target_rows - rounds_worked;
  // available_rows must be even for the pair cadence to close. rounds_worked is
  // whatever the knitter actually worked and may be odd, so round DOWN to even
  // — overshooting the armhole is worse than finishing 1 row shallow.
  if (available_rows % 2 !== 0) available_rows -= 1;
  if (available_rows <= 0) {
    return { ok: false, reason: "no_rows_left",
      detail: "At the measured row gauge the yoke has already reached its full "
        + "depth (" + rounds_worked + " rounds worked, " + target_rows
        + " wanted). There is no room left to shape." };
  }
  const half_ar = available_rows / 2;

  // Sleeve growth alone cannot outrun the budget: every raglan round needs a
  // partner row, so R_rem pairs is the floor on the section's height.
  if (R_rem > half_ar) {
    return { ok: false, reason: "sleeve_grows_too_fast",
      detail: "The sleeve needs " + R_rem + " more increase rounds but only "
        + half_ar + " pairs of rows remain. The armhole would end up too deep." };
  }

  // ── Same A/B/C solve as a fresh pattern, on the reduced budget ──
  let scenario, A2_pairs = R_rem, A3_pairs = 0, plain_pairs = 0;
  let blocks = null, promote_in_raglan = 0, promote_in_body_only = 0, doubled = 0;
  let raglan_paired_inc = 0, raglan_with_body_inc = 0;
  let body_only_paired_inc = 0, body_only_consecutive_inc = 0, body_only_doubled_inc = 0;

  if (body_pairs_needed <= half_ar) {
    A3_pairs = body_pairs_needed - R_rem;
    if (A3_pairs < 0) {
      return { ok: false, reason: "sleeve_grows_too_fast",
        detail: "The sleeve needs more increase rounds (" + R_rem + ") than the body ("
          + body_pairs_needed + "). With sleeve-only rounds removed, no schedule fits." };
    }
    plain_pairs = half_ar - R_rem - A3_pairs;
    // resuming = true: no leading fast block (see compoundRaglanBlocks).
    blocks = compoundRaglanBlocks(R_rem, 2 * plain_pairs, true);
    if (blocks === null) {
      return { ok: false, reason: "no_block_schedule",
        detail: "No compound raglan block schedule exists for " + R_rem
          + " increases and " + (2 * plain_pairs) + " surplus rows." };
    }
    scenario = plain_pairs > 0 ? "A" : "B";
    raglan_paired_inc = R_rem;
    body_only_paired_inc = A3_pairs;
  } else {
    scenario = "C";
    A3_pairs = half_ar - R_rem;
    let excess = body_pairs_needed - half_ar;
    promote_in_body_only = min(excess, A3_pairs);
    let rest = excess - promote_in_body_only;
    promote_in_raglan = min(rest, R_rem);
    rest -= promote_in_raglan;
    doubled = min(rest, A3_pairs + promote_in_body_only);
    rest -= doubled;
    if (rest > 0) {
      return { ok: false, reason: "compression_insufficient",
        detail: "The body needs " + rest + " more increase events than the remaining "
          + "rows can carry, even with every plain round promoted and the bottom "
          + "rounds doubled. The armhole is too shallow for the width needed." };
    }
    raglan_paired_inc = R_rem - promote_in_raglan;
    raglan_with_body_inc = promote_in_raglan;
    body_only_paired_inc = A3_pairs - promote_in_body_only;
    body_only_consecutive_inc = 2 * promote_in_body_only - doubled;
    body_only_doubled_inc = doubled;
  }

  // ── Final counts ──
  const fin_slv = cur.slv + 2 * R_rem;
  const fin_rb  = cur.rb + R_rem + raglan_with_body_inc + body_only_paired_inc
                + body_only_consecutive_inc + 2 * body_only_doubled_inc;
  const fin_lb  = cur.lb + R_rem + raglan_with_body_inc + body_only_paired_inc
                + body_only_consecutive_inc + 2 * body_only_doubled_inc;
  const fin_f   = cur.f + 2 * (R_rem + raglan_with_body_inc + body_only_paired_inc
                + body_only_consecutive_inc + 2 * body_only_doubled_inc);
  const fin_total = fin_rb + fin_lb + fin_f + 2 * fin_slv + t.Rag4;

  // Closure: rows used must equal the budget, and body events must equal demand.
  const rows_used = blocks
    ? (2 * blocks.n1 + blocks.r2 * blocks.n2 + 2 * blocks.n3) + 2 * A3_pairs
    : 2 * raglan_paired_inc + 2 * raglan_with_body_inc + 2 * body_only_paired_inc
      + body_only_consecutive_inc + body_only_doubled_inc;
  if (rows_used !== available_rows) {
    return { ok: false, reason: "closure_rows",
      detail: "Row closure failed: " + rows_used + " !== " + available_rows + "." };
  }
  const body_events = R_rem + raglan_with_body_inc + body_only_paired_inc
    + body_only_consecutive_inc + 2 * body_only_doubled_inc;
  if (body_events !== body_pairs_needed) {
    return { ok: false, reason: "closure_body",
      detail: "Body-event closure failed: " + body_events + " !== "
        + body_pairs_needed + "." };
  }

  const B_sts = fin_rb + fin_lb + fin_f + t.Rag4 + UA_base * 2;
  const SL_sts = fin_slv + UA_base;
  return {
    ok: true, scenario, R_rem, blocks,
    A3_pairs, plain_pairs, UA_base,
    raglan_paired_inc, raglan_with_body_inc,
    body_only_paired_inc, body_only_consecutive_inc, body_only_doubled_inc,
    rounds_remaining: available_rows,
    total_rows: rounds_worked + available_rows,
    fin_rb, fin_lb, fin_f, fin_slv, fin_total,
    B_sts, SL_sts,
    chest_cm: +(B_sts / gs_e).toFixed(1),
    upper_arm_cm: +(SL_sts / gs_e).toFixed(1),
    yoke_depth_cm: +((rounds_worked + available_rows) / gr_e).toFixed(1),
  };
}

// renderResumeHTML: the "you are here" header for a resumed pattern. The
// schedule itself is rendered by renderCompoundRaglanHTML as normal; this block
// tells the knitter what changed and why, so a revised pattern is not silently
// different from the one they started.
function renderResumeHTML(r, cur, rounds_worked, gs_e, gr_e, orig_gs, orig_gr) {
  return '<div class="checkpoint-box">' +
    "\n" + '<span class="checkpoint-title">Revised from your measurements</span>' +
    "\n" + '<p>This pattern picks up from where you are. Everything above this ' +
    'point you have already knitted — the instructions below replace the rest ' +
    'of the yoke.</p>' +
    "\n" + '<div class="checkpoint-figures">' +
    "\n" + '<span class="label">Your measured gauge</span>' +
    "\n" + '<span class="fig"><strong>' + (gs_e * 10).toFixed(1) + '</strong> sts and <strong>' +
    (gr_e * 10).toFixed(1) + '</strong> rows per 10 cm' +
    ' <em>(the original pattern assumed ' + (orig_gs * 10).toFixed(0) + ' × ' +
    (orig_gr * 10).toFixed(0) + ')</em></span>' +
    "\n" + '<span class="fig">You are at <strong>' + cur.total + '</strong> sts, ' +
    '<strong>' + rounds_worked + '</strong> rounds from below the neckband</span>' +
    "\n" + '</div>' +
    "\n" + '<p>Worked as written below, your sweater will finish at a chest of ' +
    '<strong>' + r.chest_cm + ' cm</strong>, an upper sleeve of <strong>' +
    r.upper_arm_cm + ' cm</strong>, and a yoke depth of <strong>' + r.yoke_depth_cm +
    ' cm</strong> — the measurements your original pattern was designed for.</p>' +
    "\n" + '<p>Keep knitting at the tension you have been using. The schedule below ' +
    'is built around it, so changing needle size now would undo the correction.</p>' +
    "\n" + '</div>';
}

// ── Target derivations ─────────────────────────────────────────────────
// solveTargets: the four gauge-dependent targets a yoke is solved against.
//
// Shared between the fresh path (STEP 8/9/10b) and solveResumeSchedule. A
// resume differs from a fresh pattern in exactly one respect — the gauge it
// converts against — so the conversions themselves must not be duplicated. If
// they were, editing the upper-arm formula in one place would leave resumed
// patterns silently targeting a different sweater from fresh ones, and nothing
// downstream would notice: every internal check would still pass, because each
// path would be self-consistent.
//
// Deliberately NOT included: the mod-4 body alignment nudge and the sleeve
// parity bump. Those are measured against different baselines in each path —
// fresh against Y2_slv and the fresh body count, resume against the stitches
// already on the knitter's needle — so they are genuinely different
// calculations, not duplicated ones.
//
//   upper_arm_cm       finished upper-arm circumference (cm)
//   C_cm               finished chest circumference (cm)
//   target_armhole_cm  target yoke depth (cm)
//   ua_fraction        underarm cast-on as a fraction of upper arm
//   gs, gr             stitch and row gauge, per cm
function solveTargets(upper_arm_cm, C_cm, target_armhole_cm, ua_fraction, gs, gr) {
  const round = Math.round, max = Math.max;
  const roundHalfDownEven = (x) => Math.ceil(x / 2 - 0.5) * 2;
  return {
    upper_arm_sts: round(upper_arm_cm * gs / 2) * 2,
    UA_base: round(max(3, upper_arm_cm * ua_fraction) * gs / 2) * 2,
    body_raw: roundHalfDownEven(C_cm * gs),
    // Rounded to nearest even so available_rows stays even (sr_rows is even by
    // construction), which lets the pair cadence close without half-integers.
    target_rows: round(target_armhole_cm * gr / 2) * 2,
  };
}

// ── Sleeve & cuff schedule ─────────────────────────────────────────────
// solveSleeveSchedule: cuff stitch count + decrease distribution for a sleeve.
//
// Extracted so the fresh path (STEP 15/16/16b) and the resumed path (STEP 16c)
// run the SAME code. A resumed sweater has a different sleeve stitch count at a
// different gauge, so its decrease schedule and cuff count both move — and if
// this logic were duplicated, the two paths would drift apart the first time
// either was edited, producing a resumed pattern whose sleeve quietly disagrees
// with a fresh one.
//
//   SL_sts             sleeve sts after the underarm pick-up
//   upper_arm_cm_fin   finished upper-arm circumference (cm)
//   sleeve_length_cm   underarm to cuff edge (cm)
//   gs_rib_            rib gauge, sts per cm
//   gr_                row gauge, rows per cm
function solveSleeveSchedule(SL_sts, upper_arm_cm_fin, sleeve_length_cm, gs_rib_, gr_) {
  const round = Math.round, max = Math.max, floor = Math.floor;
  // Cuff-to-upper-arm ratio rises as the sleeve gets shorter: a sleeve ending
  // at mid-forearm needs a wider cuff than one ending at the wrist.
  //   full length (44 cm, wrist)       -> 0.70
  //   mid-forearm (30 cm, current cap) -> 0.88
  const CUFF_FULL_LEN_CM = 44, CUFF_MID_LEN_CM = 30;
  const CUFF_RATIO_FULL  = 0.70, CUFF_RATIO_MID = 0.88;
  const t_raw = (CUFF_FULL_LEN_CM - sleeve_length_cm)
              / (CUFF_FULL_LEN_CM - CUFF_MID_LEN_CM);
  const t = Math.max(0, Math.min(1, t_raw));
  const ratio = +(CUFF_RATIO_FULL + t * (CUFF_RATIO_MID - CUFF_RATIO_FULL)).toFixed(4);
  const cuff_target_cm = upper_arm_cm_fin * ratio;

  // Cuff is worked in half-twisted rib, which runs denser than stockinette, so
  // the conversion uses the rib gauge. Rounded even for the k1tbl/p1 repeat.
  const CU_sts = round(cuff_target_cm * gs_rib_ / 2) * 2;
  const dec_rounds = (SL_sts - CU_sts) / 2;

  const cuff_rib_cm = 10;
  const sleeve_stockinette_cm = +(sleeve_length_cm - cuff_rib_cm).toFixed(1);
  const sleeve_stockinette_rows = round(sleeve_stockinette_cm * gr_);
  // Bookended distribution: a gap before the first decrease and after the last,
  // with the non-divisible remainder placed on top.
  const budget_rows = sleeve_stockinette_rows;
  const plain_rows_total = budget_rows - dec_rounds;
  const dec_gap = dec_rounds > 0 ? max(1, floor(plain_rows_total / (dec_rounds + 1))) : 0;
  const dec_end_plain = dec_gap;
  const dec_top_plain = budget_rows - dec_rounds * (dec_gap + 1) - dec_end_plain;
  const dec_every_nth = dec_rounds > 0 ? (dec_gap + 1) : 2;

  return {
    CUFF_TO_UPPERARM_RATIO: ratio,
    cuff_target_cm, CU_sts, dec_rounds,
    dec_rounds_integer: Number.isInteger(dec_rounds),
    cuff_rib_cm, sleeve_stockinette_cm, sleeve_stockinette_rows,
    dec_gap, dec_top_plain, dec_end_plain, dec_every_nth,
    dec_section_rows: dec_rounds * dec_every_nth,
    sleeve_plain_rounds: dec_top_plain + dec_end_plain,
    too_short: dec_top_plain < 0 || dec_gap < 1,
  };
}

// ── Worked prefix (resume) ─────────────────────────────────────────────
// splitWorkedBlocks: how many increase rounds of each original block the
// knitter has already worked. The original raglan section is three blocks in a
// fixed order — n1 fast, n2 slow, n3 fast — so worked rounds fill them from
// the top down: as many as the block holds, or as many as remain, whichever is
// fewer.
//
// The result is also a consistency check on the knitter's two reported numbers.
// The rounds those worked increases consume (2 per fast, r2 per slow) must
// equal the rounds they say they have knitted below the neckband. If they do
// not, the stitch count and the round count describe different positions and
// the case cannot be solved from here.
//
// Returns { w1, w2, w3, rounds_consumed } or null if blocks are absent.
function splitWorkedBlocks(blocks, inc_worked) {
  if (!blocks) return null;
  const w1 = Math.min(inc_worked, blocks.n1);
  const w2 = Math.min(inc_worked - w1, blocks.n2);
  const w3 = inc_worked - w1 - w2;
  if (w3 > blocks.n3) return null;             // more worked than the section holds
  return {
    w1, w2, w3,
    rounds_consumed: 2 * w1 + blocks.r2 * w2 + 2 * w3,
  };
}

// renderWorkedPrefixHTML: the already-knitted part of the raglan section, shown
// as reference rather than instruction. Without it the revised pattern jumps
// straight from the short rows to a schedule that begins partway up the yoke,
// with 25 rounds of the knitter's actual work simply absent from the document —
// which reads as though those rounds were never meant to happen.
//
// Sections keep the numbering and names they had in the original pattern, so a
// knitter can lay the two PDFs side by side and see exactly where the join is.
function renderWorkedPrefixHTML(blocks, w, raglan_sts) {
  const parts = [];
  if (blocks.n1 > 0) parts.push({ n: blocks.n1, worked: w.w1, rate: 2, where: "neck to shoulder" });
  if (blocks.n2 > 0) parts.push({ n: blocks.n2, worked: w.w2, rate: blocks.r2, where: "across the upper chest" });
  if (blocks.n3 > 0) parts.push({ n: blocks.n3, worked: w.w3, rate: 2, where: "to the underarm" });

  let out = '<p><em>Round 1 and Round 2 are defined here and referred to ' +
    'throughout the sections below.</em></p>' +
    "\n" + '<div class="instr"><strong>Round 1 (raglan inc):</strong> ' +
    '*Knit to marker, M1R, SM, k' + raglan_sts + ', SM, M1L* — repeat * to * 3 more ' +
    'times, knit to end of round. <em>(8 sts increased)</em></div>' +
    "\n" + '<div class="instr"><strong>Round 2 (plain):</strong> Knit to end.</div>' +
    "\n" + '<p style="margin-top:3mm">The raglan increases are worked in sections at ' +
    'different rates.</p>' +
    "\n" + '<p><em>The sections below you have already knitted. They are shown so you ' +
    'can confirm where you are; there is nothing to do here.</em></p>';

  parts.forEach(function (b, i) {
    if (b.worked <= 0) return;                 // not reached yet — belongs to the remainder
    const label = 'Section ' + (i + 1) + ' (' + b.where + ')';
    const partial = b.worked < b.n;
    let body;
    body = blockInstr(b.rate, b.worked);
    out += "\n" + '<p style="margin-top:3mm"><strong>' + label + ':</strong> ' + body +
      roundsNote(b.rate * b.worked) +
      ' — <strong>already worked' +
      (partial ? ', ' + b.worked + ' of ' + b.n + ' repeats' : ' in full') +
      '</strong></p>';
  });
  return out;
}

// Wording: Yulia, 16 Nov 2026. formUrl = the correction form (Tally Y5X1Eq)
// prefilled with this order, so the knitter only types her email and the five
// numbers; the pipeline then builds the revised pattern (resume mode).
const CORRECTION_FORM = "https://tally.so/r/Y5X1Eq";
function correctionFormUrl(o) {
  const q = [
    ["bust", o.bust_cm], ["gauge_st", o.gauge_sts], ["gauge_row", o.gauge_rows],
    ["ease", o.ease_preference], ["length_pref", o.length_preference],
    ["sleeve_len", o.sleeve_length_cm],
    ["construction", "Knitted in one piece, from the top down (seamless)"],
  ].map(function (kv) { return kv[0] + "=" + encodeURIComponent(String(kv[1])); });
  return CORRECTION_FORM + "?" + q.join("&");
}

function renderCheckpointHTML(chk, circ_cm, depth_cm, contact, formUrl) {
  if (!chk) return "";
  const band = chk.plain_band;
  return '<div class="checkpoint-box">' +
    "\n" + '<span class="checkpoint-title">Optional — but worth it: check your measurements</span>' +
    "\n" + '<p>At this point you can check if your sweater is turning out to be the right ' +
    'size, or if the gauge has drifted.</p>' +
    "\n" + '<p>You should be at this point after <strong>' + chk.inc_rounds +
    '</strong> raglan increase rounds, with <strong>' + chk.sts_total +
    '</strong> sts on the needle. ' +
    (band === 1 ? 'The last round was plain.</p>' : 'The last <strong>' + band + '</strong> rounds were plain.</p>') +
    "\n" + '<div class="checkpoint-figures">' +
    "\n" + '<span class="label">Expected at this point</span>' +
    "\n" + '<span class="fig">Circumference, all the way around the yoke including both ' +
    'sleeves: <strong>' + circ_cm + ' cm</strong></span>' +
    "\n" + '<span class="fig">Depth at centre back, from below the neckband to the needle: ' +
    '<strong>' + depth_cm + ' cm</strong></span>' +
    "\n" + '</div>' +
    "\n" + '<p>Measure your work after blocking; check the cable is long enough that no ' +
    'stitches slip off or use two cables and try to measure the circumference at the ' +
    'stitches\' natural distribution. Measure the circumference just above the needle. ' +
    'Measure depth from the end of the neckband (not including it) to the base of the ' +
    'stitches, not to the needle.</p>' +
    "\n" + '<div class="checkpoint-verdict">' +
    "\n" + '<p>If your measurements are within <strong>±5%</strong> of the above on both, ' +
    'we suggest you carry on.</p>' +
    "\n" + '<p>If the measurements are off by more than 5% on either, enter both ' +
    'measurements, your stitch count, and the number of raglan increase rounds worked in ' +
    '<a href="' + formUrl + '">this short form</a> (your order details are already filled in), ' +
    'or email them to <a href="mailto:' + contact + '">' + contact + '</a>. ' +
    'We\'ll send a revised pattern that picks up from where you are, and will provide for a ' +
    'transition from the original pattern. If the difference is too large or there is no ' +
    'plausible solution, we will still tell you your options.</p>' +
    "\n" + '</div>' +
    "\n" + '</div>';
}

export default {
  async fetch(request, env) {

    // ── CORS ─────────────────────────────────────────────────
    const corsHeaders = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      "Content-Type": "application/json",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: corsHeaders });
    }

    // ── Auth (sis-parity #1) ─────────────────────────────────
    // Required X-API-Key header matched against env.API_KEY. Failing closed
    // when env.API_KEY is unset is intentional — that's a deployment
    // misconfiguration, not a reason to silently accept open requests.
    const apiKey = request.headers.get("X-API-Key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(JSON.stringify({ error: "Unauthorised" }), {
        status: 401, headers: corsHeaders,
      });
    }

    // ── Parse body (sis-parity #4: strip markdown fences) ────
    // If a caller wraps the JSON in ```json ... ``` (e.g. when forwarded
    // through an LLM step), strip the fences before JSON.parse.
    let body;
    try {
      const raw = await request.text();
      const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
      body = JSON.parse(cleaned);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: corsHeaders });
    }

    // ── INPUTS ───────────────────────────────────────────────
    const bust_cm           = parseFloat(body.bust_cm);
    const ease_preference   = String(body.ease_preference).trim().toLowerCase();
    const length_preference = String(body.length_preference).trim().toLowerCase();
    const gauge_sts         = parseFloat(body.gauge_sts)  || 21;
    const gauge_rows        = parseFloat(body.gauge_rows) || 28;
    const sleeve_length_cm  = parseFloat(body.sleeve_length_cm);

    // ── Resume input (Phase 2) ──
    // Optional. Present when a knitter has stopped at the mid-yoke checkpoint,
    // measured, and needs the rest of the yoke re-solved. All four fields are
    // required together: two describe where the knitter is, two describe what
    // their fabric is actually doing. Any one missing and the request is a
    // normal fresh-pattern request.
    let resume_in = null;
    let resume_input_error = null;
    if (body.resume && typeof body.resume === "object") {
      const rw   = parseFloat(body.resume.rounds_worked);
      const sts  = parseFloat(body.resume.sts_on_needle);
      const circ = parseFloat(body.resume.measured_circ_cm);
      const dep  = parseFloat(body.resume.measured_depth_cm);
      const bad = [];
      if (!Number.isFinite(rw)   || rw   <= 0) bad.push("rounds_worked");
      if (!Number.isFinite(sts)  || sts  <= 0) bad.push("sts_on_needle");
      if (!Number.isFinite(circ) || circ <= 0) bad.push("measured_circ_cm");
      if (!Number.isFinite(dep)  || dep  <= 0) bad.push("measured_depth_cm");
      if (!Number.isInteger(sts)) bad.push("sts_on_needle (must be a whole number)");
      if (!Number.isInteger(rw))  bad.push("rounds_worked (must be a whole number)");
      if (bad.length) {
        resume_input_error = "resume requires positive values for: " + bad.join(", ");
      } else {
        resume_in = { rounds_worked: rw, sts_on_needle: sts,
                      measured_circ_cm: circ, measured_depth_cm: dep };
        // The knitter also reports how many raglan increase rounds they have
        // worked. That number is redundant — the stitch count already pins it —
        // which is exactly why it is worth having: two independent statements
        // of the same fact, so a miscount shows up as a disagreement instead of
        // silently producing a schedule built on the wrong starting point.
        // Optional, so existing callers keep working.
        if (body.resume.inc_rounds_worked !== undefined
            && body.resume.inc_rounds_worked !== null
            && body.resume.inc_rounds_worked !== "") {
          const ir = parseFloat(body.resume.inc_rounds_worked);
          if (!Number.isInteger(ir) || ir < 0) {
            resume_input_error = "resume.inc_rounds_worked must be a non-negative whole number";
          } else {
            resume_in.inc_rounds_worked = ir;
          }
        }
      }
    }
    if (resume_input_error) {
      return new Response(JSON.stringify({ error: resume_input_error }), {
        status: 400, headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    if (isNaN(bust_cm)) {
      return new Response(JSON.stringify({ error: "bust_cm is required and must be a number" }), {
        status: 400, headers: corsHeaders,
      });
    }
    // sis-parity #2: bust range validation. The reference patterns and the
    // internal lookup tables only have meaningful values for 80 ≤ bust ≤ 150.
    // Anything outside this range produces extrapolated nonsense.
    if (bust_cm < 80 || bust_cm > 150) {
      return new Response(JSON.stringify({
        error: `bust_cm ${bust_cm} is out of range (80–150)`,
      }), { status: 400, headers: corsHeaders });
    }
    if (isNaN(sleeve_length_cm) || sleeve_length_cm <= 0) {
      return new Response(JSON.stringify({ error: "sleeve_length_cm is required and must be a positive number" }), {
        status: 400, headers: corsHeaders,
      });
    }
    // sis-parity #3: length_preference enum validation. Previously any value
    // (including typos like "regulr") silently fell through to the 0-adjustment
    // branch. Now we reject unknown values with a clear error.
    if (!["standard", "cropped", "long"].includes(length_preference)) {
      return new Response(JSON.stringify({
        error: `length_preference must be: standard | cropped | long (got "${length_preference}")`,
      }), { status: 400, headers: corsHeaders });
    }

    // ── HELPERS ──────────────────────────────────────────────
    const gs    = gauge_sts  / 10;
    const gr    = gauge_rows / 10;
    const round = (x) => Math.round(x);
    const floor = (x) => Math.floor(x);
    const ceil  = (x) => Math.ceil(x);
    const max   = (a, b) => Math.max(a, b);
    const min   = (a, b) => Math.min(a, b);
    const roundHalfDownEven = (x) => Math.ceil(x / 2 - 0.5) * 2;
    // English ordinal suffix, e.g. 3 -> "3rd", 6 -> "6th", 21 -> "21st".
    // PATCHED (item #15): the template used to hardcode "th" for every
    // dec_every_nth value, which is wrong for 1/2/3 (and 21/22/23 etc).
    function ordinalSuffix(n) {
      const s = ["th", "st", "nd", "rd"];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    }

    // RIB_GAUGE_RATIO = rib sts/10cm ÷ stockinette sts/10cm for the
    // HALF-twisted rib (k1 tbl, p1) used throughout this pattern (collar,
    // cuff, hem).
    // Measured swatch (2026-07): unstretched/tight ratio = 1.64.
    // The working value is deliberately LOWER (1.25): the calculator
    // converts *worn* target circumferences (neck_cm, cuff_target_cm)
    // into rib stitch counts, and rib sits under slight stretch in wear,
    // so the as-worn effective ratio applies, not the relaxed one.
    // Do NOT plug in the unstretched 1.64: CO_sts feeds the Y1 yoke
    // start directly (collar→yoke has no stitch-count change → yoke
    // would flare ~64%), and CU_sts would exceed SL_sts at many sizes
    // (negative dec_rounds → pipeline breaks).
    // Defined here (not just at the cuff, Step 15) because the neck
    // cast-on (Step 3) also needs it — the collar is rib too.
    const RIB_GAUGE_RATIO = 1.25;
    const rib_gauge_sts   = +(gauge_sts * RIB_GAUGE_RATIO).toFixed(1);
    const gs_rib          = rib_gauge_sts / 10;

    // PATCHED (item #37): single-value flag so the template's TDCR_IF can
    // pick exactly one of the two collar round-count branches (9/10/19 vs
    // 6/7/13 rounds) instead of printing both and asking the knitter to
    // choose. Threshold stays on stockinette gauge_sts, matching the
    // original branch design (it's about overall fabric density, not the
    // rib stitch itself).
    const collar_dense_gauge = gauge_sts > 15 ? 1 : 0;

    // ── STEP 1: Ease ─────────────────────────────────────────
    // PATCHED v13: aligned with industry standards (matches SIS v3).
    //   close: 10→0, relaxed: 20→7.5, oversized: 30→20.
    function lookupEaseCm(e) {
      if (e === "close")     return 0;
      if (e === "relaxed")   return 7.5;
      if (e === "oversized") return 20;
      return null;
    }
    const ease_cm = lookupEaseCm(ease_preference);
    if (ease_cm === null) {
      return new Response(JSON.stringify({ error: "ease_preference must be: close | relaxed | oversized" }), {
        status: 400, headers: corsHeaders,
      });
    }

    // ── STEP 2: Finished chest target ────────────────────────
    const C_cm           = bust_cm + ease_cm;
    // ── Shared target derivations ──
    // Same function solveResumeSchedule uses, so the two paths cannot drift.
    // Declared here because Y5_body_st_raw (below) is the earliest consumer;
    // the sleeve and armhole targets are read from it in STEP 8/9/10b.
    const upper_arm_cm = 0.18 * C_cm + upperArmIntercept(ease_preference);
    const _T = solveTargets(upper_arm_cm, C_cm,
                            targetArmholeCm(bust_cm, ease_preference),
                            uaFraction(ease_preference, bust_cm), gs, gr);
    const Y5_body_st_raw = _T.body_raw;

    // ── STEP 3: Neck cast-on ─────────────────────────────────
    // PATCHED v13: aligned with SIS-v3 lookupNeckWidth × 2.3 scoop factor.
    //   Base (close-fit, 0 ease) values from industry-standards report Chart 1.
    //   Per-fit offsets +0 / +0.5 / +1.5 (Chart 1→2→3 deltas, uniform).
    //   SIS gives the horizontal neck-opening WIDTH (one half of body); top-down
    //   construction needs the full neckline circumference. A scoop neckline
    //   approximates an ellipse; circumference ≈ width × 2.3 in practice.
    function lookupNeckCm(b, ease) {
      const sis_neck_offset = ease === "oversized" ? 1.5
                            : ease === "relaxed"   ? 0.5
                            : 0;
      let base;
      if      (b < 85)  base = 16;
      else if (b < 90)  base = 16.5;
      else if (b < 95)  base = 16.5;
      else if (b < 100) base = 17;
      else if (b < 110) base = 18;
      else if (b < 120) base = 18.5;
      else if (b < 130) base = 19;
      else if (b < 140) base = 19.5;
      else              base = 20;
      return (base + sis_neck_offset) * 2.3;
    }
    const neck_cm = lookupNeckCm(bust_cm, ease_preference);
    // PATCHED (item #31): collar is half-twisted rib, denser than
    // stockinette, so converting neck_cm to a stitch count must use the
    // rib gauge (gs_rib) — using stockinette gauge here undersizes the
    // cast-on and the collar comes out tighter than intended.
    const CO_sts  = round(neck_cm * gs_rib / 2) * 2;

    // ── STEP 4: Raglan sts per line ──────────────────────────
    // Moved here (was Step 8) so Rag4 is available for Step 5.
    // v6 fix: Y1 distribution uses Rag4 instead of hardcoded 12.
    const Rag  = Math.max(2, Math.min(4, round(1.43 * gs)));
    const Rag4 = Rag * 4;

    // ── STEP 5: Y1 sleeve + section counts ───────────────────
    const Y1_slv_cm      = 0.0486 * bust_cm + 2.06;
    const Y1_slv         = round(Y1_slv_cm * gs / 2) * 2;
    const Y1_F_EXTRA_CM  = 1.9;
    const Y1_f_extra_sts = round(Y1_F_EXTRA_CM * gs / 2) * 2;
    const Y1_remaining   = CO_sts - Rag4 - 2 * Y1_slv;   // v6: Rag4 not hardcoded 12
    const Y1_back_total  = (Y1_remaining - Y1_f_extra_sts) / 2;
    const Y1_rb          = floor(Y1_back_total / 2);
    const Y1_lb          = Y1_back_total - Y1_rb;
    const Y1_f           = Y1_back_total + Y1_f_extra_sts;
    const Y1_total       = CO_sts;
    const Y1_closure     = (Y1_rb + Rag + Y1_slv + Rag + Y1_f + Rag + Y1_slv + Rag + Y1_lb) === CO_sts;

    // ── STEP 6: Short rows ───────────────────────────────────
    // Phase 1 = the short rows where increases are made only within the
    // back and sleeve sections (the turns have not yet reached far enough
    // around to involve the front).
    // Phase1 must be a multiple of 4 rows (EVEN pair count) so each sleeve's
    // Phase-1 gain (1 st/pair) is even — required for the k1tbl/p1 cuff rib.
    // Round to NEAREST 4 (rounding up overshoots the back-neck lift band).
    const Phase1   = Math.max(4, Math.round((5 * gr * (4 / 14)) / 4) * 4);
    const Phase2   = max(4, Math.ceil(5 * gr * (10 / 14) / 2) * 2);
    const SR_extra = max(0, (Phase2 - 4) / 2);

    const SHORT_ROW_GAINS = [];
    for (let i = 0; i < Phase1 / 2; i++) {
      SHORT_ROW_GAINS.push([0, 0, 0, 1, 1]);
      SHORT_ROW_GAINS.push([1, 1, 0, 0, 0]);
    }
    SHORT_ROW_GAINS.push([0, 0, 1, 2, 1]);
    SHORT_ROW_GAINS.push([1, 2, 1, 0, 0]);
    SHORT_ROW_GAINS.push([0, 0, 1, 2, 1]);
    SHORT_ROW_GAINS.push([1, 2, 1, 0, 0]);
    for (let i = 0; i < SR_extra; i++) {
      SHORT_ROW_GAINS.push([0, 0, 1, 2, 1]);
      SHORT_ROW_GAINS.push([1, 2, 1, 0, 0]);
    }
    const SR = SHORT_ROW_GAINS.reduce(
      (acc, row) => acc.map((v, i) => v + row[i]), [0, 0, 0, 0, 0]
    );
    const SR_total_increases = SHORT_ROW_GAINS.reduce(
      (acc, row) => acc + row.reduce((a, b) => a + b, 0), 0
    );
    const sr_rows = Phase1 + Phase2;

    // ── STEP 6b: Short-row template fields ───────────────────
    // The pattern template renders Rows 1-4 as fixed single-point shaping
    // rows; Phase1 is gauge-scaled and may need one extra row pair beyond
    // that baseline of 4. Phase1_extra_pairs/extra_row_n/extra_turn_sts let
    // the template show that extra pair (when present) without the
    // formatter doing any arithmetic of its own — it only substitutes
    // values that already exist in this JSON.
    // KNOWN LIMITATION: the template's TDCR_IF block only supports ONE
    // extra pair. If Phase1_extra_pairs > 1 (denser gauges), this still
    // needs manual pattern review — flag any such case in QA.
    const Phase1_extra_pairs = max(0, (Phase1 - 4) / 2);
    const extra_row_n        = 5;
    const extra_row_n_plus1  = 6;
    const extra_turn_sts     = 2;
    // Deepest (first) short-row turn: German short rows step IN by 2 sts each
    // pair, so the very first turn must be the furthest from the marker.
    // For (Phase1/2) single-point pairs the first turn is Phase1 sts before
    // the marker, then 2 fewer on each successive pair down to 2.
    const sr_turn_first = Phase1;
    // Each successive short-row pair turns 2 sts closer to the marker than
    // the previous pair: Row1/2 = sr_turn_first, Row3/4 = sr_turn_first-2,
    // Row5/6 (extra pair) = sr_turn_first-4. Expressed "X sts before next
    // marker" so each value is absolute from the marker, not relative.
    const sr_turn_2 = sr_turn_first - 2;
    const sr_turn_3 = sr_turn_first - 4;
    // GUARD: the first (deepest) short-row turn eats sr_turn_first sts before
    // the marker. It must not exceed the sleeve stitch width (Y1_slv), or the
    // turn would run past the raglan into/through the sleeve and the geometry
    // breaks. Hard-fail (flag for review) rather than silently capping.
    const sr_turn_too_deep = (sr_turn_first > Y1_slv);

    // Row5-8 labels shift by 2 for each extra single-point pair rendered.
    const Row5_n = 4 + 2 * Phase1_extra_pairs + 1;
    const Row6_n = Row5_n + 1;
    const Row7_n = Row6_n + 1;
    const Row8_n = Row7_n + 1;

    // ── STEP 7: Y2 section counts ────────────────────────────
    const Y2_rb      = Y1_rb   + SR[0];
    const Y2_lb      = Y1_lb   + SR[4];
    const Y2_f       = Y1_f    + SR[2];
    const Y2_slv     = Y1_slv  + SR[1];
    const Y2_total   = CO_sts  + SR_total_increases;
    const Y2_body    = Y2_rb + Y2_lb + Y2_f;
    const Y2_closure = (Y2_rb + Rag + Y2_slv + Rag + Y2_f + Rag + Y2_slv + Rag + Y2_lb) === Y2_total;

    // ── STEP 8: Upper arm target ─────────────────────────────
    // PATCHED v13: intercepts re-derived for the new C_cm range. Calibration
    // target = standards-report set-in chart M values + ~5 cm raglan offset:
    //   close (0):     0.18·96.5 + 17.5 = 34.87  → set-in 30.5 + 4.4 ≈ raglan 35
    //   relaxed (+7.5):0.18·104   + 18.5 = 37.22  → set-in 32   + 5   ≈ raglan 37
    //   oversized(+20):0.18·116.5 + 19.0 = 39.97  → set-in 35   + 5   ≈ raglan 40
    // Plus-size upper arms still come out 2-3 cm narrow (linear formula
    // breaks down beyond ~120 cm bust); same caveat as v12.
    function upperArmIntercept(ease) {
      if (ease === "close")     return 17.5;
      if (ease === "relaxed")   return 18.5;
      if (ease === "oversized") return 19.0;
      return 18.5;
    }
    const upper_arm_sts = _T.upper_arm_sts;

    // ── STEP 9: UA base + raglan pairs ───────────────────────
    function uaFraction(ease, bust) {
      if (ease === "close") return bust < 130 ? 0.08 : 0.16;
      return Math.min(0.22, 0.08 + max(0, bust - 80) * 0.002);
    }
    const UA_base      = _T.UA_base;
    const Y4_slv_raw   = upper_arm_sts - UA_base;
    const Y4_Sleeve_st_full = (Y4_slv_raw - Y2_slv) % 2 === 0 ? Y4_slv_raw : Y4_slv_raw + 1;
    const raglan_pairs_full = (Y4_Sleeve_st_full - Y2_slv) / 2;
    // v15 PATCH (2026-11-10, small sizes): sleeve-only rounds are not allowed, so
    // the sleeve can never get more raglan increase rounds than the body. For
    // small busts (80-85 cm) the sleeve target can need 1-2 rounds more than
    // the body. Instead of failing, give the sleeve the body's count: the upper
    // arm comes out 2 sts narrower per round dropped (max 4 sts, ~2 cm at
    // fine gauges). More than 2 rounds short still fails (sleeve_grows_too_fast).
    // The finished upper arm reported later is derived from the realised
    // sleeve stitches, so it reflects this automatically.
    const _pre_gap   = (Y5_body_st_raw - Y2_body) % 4;
    const _pre_tgt   = _pre_gap === 0 ? Y5_body_st_raw : Y5_body_st_raw + 2;
    const _pre_bpn   = (_pre_tgt - Rag4 - UA_base * 2 - Y2_body) / 4;
    const sleeve_inc_shortfall =
      (Number.isInteger(_pre_bpn) && Number.isInteger(raglan_pairs_full) &&
       raglan_pairs_full > _pre_bpn && raglan_pairs_full - _pre_bpn <= 2)
        ? raglan_pairs_full - _pre_bpn : 0;
    const raglan_pairs = raglan_pairs_full - sleeve_inc_shortfall;
    const Y4_Sleeve_st = Y4_Sleeve_st_full - 2 * sleeve_inc_shortfall;
    const raglan_pairs_integer = Number.isInteger(raglan_pairs) && raglan_pairs >= 0;

    // Step 9 computes preliminary Y3 assuming all raglans are full raglans.
    // (Sleeve-only rounds have been removed; A1_pairs is always 0.) The body
    // counts are corrected after Step 11 once the scenario is known.
    let Y3_rb      = Y2_rb  + raglan_pairs;
    let Y3_slv     = Y2_slv + 2 * raglan_pairs;
    let Y3_lb      = Y2_lb  + raglan_pairs;
    let Y3_f       = Y2_f   + 2 * raglan_pairs;
    let Y3_total   = Y2_total + raglan_pairs * 8;
    let Y3_closure = false; // deferred — set after Y3 is finalised in Step 11

    // ── STEP 10: Body-only rounds needed ─────────────────────
    // Body sts needed above Y2 (UA fixed at UA_base — no overflow mechanism).
    // Raglan rounds deliver 4 body sts each; remaining sts come from bop rounds.
    //
    // PATCH (parity fix): Rag4 and UA_base*2 are always %4===0 by construction
    // (Rag4 = Rag*4; UA_base is itself rounded to an even number, so UA_base*2
    // is a multiple of 4). That means body_sts_needed's divisibility by 4 is
    // determined entirely by (Y5_body_st_raw − Y2_body) mod 4. Y5_body_st_raw
    // is only ever rounded to the nearest *even* number (roundHalfDownEven),
    // not to a multiple of 4, so on some bust/gauge/ease combinations it lands
    // 2 sts off from Y2_body mod 4 — and the raglan/body-only round schedule
    // (Step 11) has no remainder mechanism to absorb that, so it fails closed
    // (raglan_pairs_non_integer / Y3_closure / Y4_closure all fail together).
    //
    // Fix: nudge the chest stitch target up by the minimum amount needed (0 or
    // +2 sts, i.e. ≤1cm finished chest) to restore mod-4 alignment. Rounding
    // UP (never down) means the fix never undersizes the garment relative to
    // what the customer asked for. Y5_body_st_raw is otherwise unused anywhere
    // else in the file (no other closure check references it), so this is a
    // fully isolated change — the actual finished_chest_cm reported to the
    // customer is derived later from the realized schedule output (B_sts),
    // so it will automatically reflect this small adjustment.
    const Y5_parity_gap     = (Y5_body_st_raw - Y2_body) % 4;
    const Y5_body_st_target = Y5_parity_gap === 0 ? Y5_body_st_raw : Y5_body_st_raw + 2;
    const body_sts_needed  = Y5_body_st_target - Rag4 - UA_base * 2 - Y2_body;
    const body_from_raglan = raglan_pairs * 4;
    const body_remaining   = max(0, body_sts_needed - body_from_raglan);
    const bop_rounds       = ceil(body_remaining / 4);

    // ── STEP 11: Target armhole + unified Bresenham ──────────
    // All increase rounds (raglan + bop) are scheduled together across the
    // full available rows above Y2.  No sequential phases, no overflow to UA.
    // Rounds 1..raglan_pairs  → raglan type (+4 body, +4 sleeve per round)
    // Rounds raglan_pairs+1.. → body-only type (+4 body, +0 sleeve per round)
    // PATCHED v13: aligned with SIS-v3 lookupArmholeDepth + 4 cm raglan offset.
    //   Patty Lyons: raglan armholes run ~4–5 cm deeper than set-in. SIS uses
    //   set-in depth; TDCR adds +4 cm to every base value.
    //   Base = SIS-v3 close-fit (0 ease) values + 4 cm.
    //   Per-fit offsets +0/+1/+3 match SIS-v3 exactly (Chart 1→2→3 deltas, uniform).
    function targetArmholeCm(bust, ease) {
      const rows = [
        [80,  84,  22],     // SIS 18   + 4
        [85,  89,  23],     // SIS 19   + 4
        [90,  94,  23.5],   // SIS 19.5 + 4
        [95,  99,  24.5],   // SIS 20.5 + 4
        [100, 109, 26],     // SIS 22   + 4
        [110, 119, 27],     // SIS 23   + 4
        [120, 129, 28.5],   // SIS 24.5 + 4
        [130, 139, 29.5],   // SIS 25.5 + 4
        [140, 150, 31],     // SIS 27   + 4
      ];
      const offset = ease === "oversized" ? 3
                   : ease === "relaxed"   ? 1
                   : 0;
      for (const [lo, hi, val] of rows) {
        if (bust >= lo && bust <= hi) return val + offset;
      }
      return null;
    }

    const target_armhole_cm   = targetArmholeCm(bust_cm, ease_preference);
    // Round to nearest even so available_rows = target − sr_rows stays even
    // (sr_rows is even by construction). Even available_rows lets the I-P
    // cadence math close cleanly without half-integer A3 counts.
    const target_armhole_rows = _T.target_rows;
    const available_rows      = max(0, target_armhole_rows - sr_rows);

    // UA stays at base in this version (no overflow inflation).
    const UA = UA_base;

    // body_pairs_needed = total body increase pairs required
    //   (each pair adds 4 body sts)
    //   = body_sts_needed / 4 = raglan_pairs + bop_rounds in default cadence
    const body_pairs_needed = body_sts_needed / 4;
    const half_ar = available_rows / 2;

    // Section pair counts (default cadence: each pair = 1 increase row + 1 plain row):
    //   A.1 — sleeve-only raglan rows  (+4 sleeve, +0 body)
    //   A.2 — full raglan rows          (+4 sleeve, +4 body)
    //   A.3 — body-only section rounds  (+4 body, +0 sleeve; in C may include doubles +8 body)
    let scenario;
    let A1_pairs = 0, A2_pairs = 0, A3_pairs = 0;
    let trailing_plain_rows = 0;
    // ── Promotion / doubling counts (scenario C only; 0 in A/B) ──
    let excess_pairs = 0;
    let promote_in_body_only = 0;
    let promote_in_raglan = 0;
    let doubled = 0;
    // ── Render-time fields (all scenarios; consumed by template) ──
    let raglan_paired_inc        = 0;  // raglan I followed by plain (Round 1, Round 2)
    let raglan_with_body_inc     = 0;  // raglan I followed by Round 2A (C only)
    let body_only_paired_inc     = 0;  // body-only I followed by plain (top of section)
    let body_only_consecutive_inc = 0; // body-only I with no plain after (middle/bottom)
    let body_only_doubled_inc    = 0;  // doubled (+8 body) I at very bottom (C only)
    // ── New (sleeve-only removed): plain-pair spread in raglan section (A only) ──
    let raglan_plain_pairs       = 0;  // surplus armhole rows as plain pairs (A)
    // Compound raglan blocks (A/B): { n1, n2, r2, n3 } — see compoundRaglanBlocks().
    // Replaces the old raglan_spread_runs Bresenham output.
    let raglan_blocks            = null;
    let schedule_error = null;
    // Structured incompatibility code — null when valid, else one of:
    //   "raglan_pairs_non_integer"  — Step 9 parity issue (defensive)
    //   "sleeve_grows_too_fast"     — raglan_pairs > half_ar (A/B with A3<0, or C raglan-overflow)
    //   "section_pair_negative"     — A2_pairs < 0 (slack > raglan demand)
    //   "compression_insufficient"  — scenario C, even doubling can't fit
    //   "sleeve_too_short"          — sleeve_length_cm too short to fit decreases (Step 16b)
    let incompatibility = null;

    if (sr_turn_too_deep) {
      scenario = "ERROR";
      schedule_error = "First short-row turn (" + sr_turn_first
        + " sts before marker) exceeds sleeve width (Y1_slv=" + Y1_slv
        + "). Short-row depth is too great for this sleeve — needs review.";
      incompatibility = "short_row_turn_too_deep";
    } else if (!Number.isInteger(raglan_pairs) || raglan_pairs < 0) {
      // Pre-Step 11 sanity: a non-integer raglan_pairs from upstream
      // (Step 9 parity bug) would cascade nonsense through the scenario
      // logic. Surface a clean error and skip the scenario branch.
      scenario = "ERROR";
      schedule_error = "raglan_pairs is not a non-negative integer ("
        + raglan_pairs + ") — upstream parity issue in Step 9.";
      incompatibility = "raglan_pairs_non_integer";
} else if (!Number.isInteger(body_pairs_needed)) {
  scenario = "ERROR";
  schedule_error = "body_pairs_needed is not an integer ("
    + body_pairs_needed + ") — body_sts_needed not divisible by 4.";
  incompatibility = "raglan_pairs_non_integer";
    } else if (body_pairs_needed <= half_ar) {
      // ── Scenarios A and B — default I-P cadence fits ──
      // NEW MODEL (sleeve-only rounds removed): all raglan_pairs are FULL raglans
      // (+4 sleeve, +4 body each). Surplus armhole rows are absorbed as PLAIN
      // pairs spread evenly through the raglan section, NOT as sleeve-only rounds.
      //
      // Geometry constraint: a full raglan grows body and sleeve together. If the
      // sleeve needs more growth events than the body (raglan_pairs >
      // body_pairs_needed), the leftover sleeve growth could ONLY come from
      // sleeve-only rounds — which this design forbids. Such sizes are errored out.
      A1_pairs = 0;                                  // sleeve-only rounds abolished
      A2_pairs = raglan_pairs;                       // every raglan is a full raglan
      A3_pairs = body_pairs_needed - raglan_pairs;   // body-only pairs (may be < 0 → error)
      raglan_plain_pairs = half_ar - raglan_pairs - A3_pairs; // surplus → plain

      if (A3_pairs < 0) {
        // Sleeve needs more growth than the body; sleeve-only rounds would be
        // required, but they are no longer permitted. Error out per design.
        schedule_error = "Sleeve requires more increase rounds (" + raglan_pairs
          + ") than the body (" + body_pairs_needed + "). With sleeve-only rounds "
          + "removed, no valid schedule exists for this size. Revisit upper-arm "
          + "sizing or target_armhole_cm.";
        incompatibility = "sleeve_grows_too_fast";
      } else if (raglan_plain_pairs < 0) {
        schedule_error = "Negative plain-pair count (" + raglan_plain_pairs
          + ") — raglan + body-only pairs exceed available rows. Bug in worker.";
        incompatibility = "section_pair_negative";
      }

      // Compound raglan block solve (replaces the Bresenham plain-pair spread).
      // The surplus rows are absorbed by ONE contiguous slow-rate block in the
      // middle of the raglan section, not by isolated plain pairs scattered
      // through it — see compoundRaglanBlocks() for the geometry and the
      // parity argument.
      raglan_blocks = null;
      if (incompatibility === null) {
        const surplus_rows = 2 * raglan_plain_pairs;
        raglan_blocks = compoundRaglanBlocks(raglan_pairs, surplus_rows);
        if (raglan_blocks === null) {
          schedule_error = "No compound raglan block schedule exists for "
            + "raglan_pairs (" + raglan_pairs + ") and surplus rows ("
            + surplus_rows + "). Every slow rate from 3 upward would need more "
            + "slow-rate increases than the sleeve has. Revisit target_armhole_cm "
            + "or upper-arm sizing.";
          incompatibility = "no_block_schedule";
        }
      }

      // Closure: total rows used must equal available_rows. The raglan section
      // is now block-shaped (2*n1 + r2*n2 + 2*n3), not pair-shaped; the
      // body-only section below is still pairs.
      const rag_rows = raglan_blocks
        ? 2 * raglan_blocks.n1 + raglan_blocks.r2 * raglan_blocks.n2 + 2 * raglan_blocks.n3
        : 2 * (raglan_pairs + raglan_plain_pairs);
      const used_rows = rag_rows + 2 * A3_pairs;
      if (incompatibility === null && used_rows !== available_rows) {
        schedule_error = "A/B closure failure: used_rows (" + used_rows
          + ") !== available_rows (" + available_rows
          + "). A2 + A3 + plain must equal half_ar by construction — bug in worker.";
        incompatibility = "section_pair_negative";
      }
      trailing_plain_rows = 0;
      scenario = (raglan_plain_pairs > 0) ? "A" : "B";

      // Render fields for A/B: no promotion, no doubling, no sleeve-only.
      raglan_paired_inc         = A2_pairs;          // full raglans (Round 1 + Round 2)
      raglan_with_body_inc      = 0;
      body_only_paired_inc      = A3_pairs;          // body-only (Round 2A + Round 2B)
      body_only_consecutive_inc = 0;
      body_only_doubled_inc     = 0;
    } else {
      // ── Scenario C — body increases overflow default cadence ──
      // A.1 = 0 (no slack), all raglan rounds are full raglans.
      scenario = "C";
      A1_pairs = 0;
      A2_pairs = raglan_pairs;
      A3_pairs = half_ar - raglan_pairs;

      // Sanity: if raglan section alone (every 2nd row) overruns available_rows,
      // no amount of body-side compression can rescue it — sleeve growth is too
      // fast for the armhole depth.
      if (2 * raglan_pairs > available_rows) {
        schedule_error = "Raglan section alone (" + (2 * raglan_pairs)
          + " rows) exceeds available_rows (" + available_rows
          + "). Sleeve grows too fast for armhole depth.";
        incompatibility = "sleeve_grows_too_fast";
      } else {
        // Promotion algorithm: convert plain rows to body-only inc rounds,
        // bottom-up. Body-only section first (its plains are physically lowest),
        // then raglan section if needed. Doubling is the last resort, applied
        // at the very bottom of the body-only section.
        excess_pairs = body_pairs_needed - half_ar;

        // Step 1: promote plain rows in body-only section (bottom-up).
        // Each promotion adds 1 body event in 0 extra rows.
        promote_in_body_only = min(excess_pairs, A3_pairs);
        let remaining = excess_pairs - promote_in_body_only;

        // Step 2: promote plain rows in raglan section (bottom-up).
        // Each promoted plain becomes a Round 2A (body-only inc).
        promote_in_raglan = min(remaining, A2_pairs);
        remaining -= promote_in_raglan;

        // Step 3: double up inc rounds at the very bottom of body-only section.
        // Each double converts a single I (+4 body) into a D (+8 body), adding
        // 1 body event per double. Cap = total inc rounds in body-only after
        // promotion = A3_pairs + promote_in_body_only.
        const double_cap = A3_pairs + promote_in_body_only;
        doubled = min(remaining, double_cap);
        remaining -= doubled;

        if (remaining > 0) {
          schedule_error = "Cannot fit body increases in armhole: " + remaining
            + " body events still over after full promotion and doubling. "
            + "Increase target_armhole_cm or revisit upper-arm sizing.";
          incompatibility = "compression_insufficient";
        }
      }

      // Render fields for C.
      // Body-only section structure (top → bottom):
      //   1. paired pairs:    (A3_pairs - promote_in_body_only) of [I, P]
      //   2. consecutive Is:  2*promote_in_body_only - doubled
      //   3. doubled Ds:      doubled  (at the very bottom)
      // Total rows: 2*A3_pairs (unchanged).
      raglan_paired_inc         = A2_pairs - promote_in_raglan;
      raglan_with_body_inc      = promote_in_raglan;
      body_only_paired_inc      = A3_pairs - promote_in_body_only;
      body_only_consecutive_inc = 2 * promote_in_body_only - doubled;
      body_only_doubled_inc     = doubled;

      // Closure: total rows used must equal available_rows.
      const c_used_rows =
        2 * raglan_paired_inc + 2 * raglan_with_body_inc +     // raglan section
        2 * body_only_paired_inc +                              // top of body-only
        body_only_consecutive_inc +                             // middle/bottom singles
        body_only_doubled_inc;                                  // very bottom doubles
      if (incompatibility === null && c_used_rows !== available_rows) {
        schedule_error = "Scenario C closure failure: used_rows (" + c_used_rows
          + ") !== available_rows (" + available_rows + "). Bug in worker.";
        incompatibility = "compression_insufficient";
      }

      // Closure: total body events must equal body_pairs_needed.
      const c_body_events =
        A2_pairs                          // raglan inc rounds
        + raglan_with_body_inc            // Round 2A's
        + body_only_paired_inc            // paired singles
        + body_only_consecutive_inc       // consecutive singles
        + 2 * body_only_doubled_inc;      // doubles count for 2 each
      if (incompatibility === null && c_body_events !== body_pairs_needed) {
        schedule_error = "Scenario C body-event closure failure: events ("
          + c_body_events + ") !== body_pairs_needed (" + body_pairs_needed
          + "). Bug in worker.";
        incompatibility = "compression_insufficient";
      }
      // trailing_plain_rows = 0 in C
    }

    // ── STEP 11b: Override Y3 stitch counts based on scenario ──
    // Step 9's Y3 assumed all raglans were full. Recompute body-side counts
    // using A2 (full raglans) and raglan_with_body_inc (Round 2A's in C).
    // Y3_slv unchanged: every raglan round (full or sleeve-only) adds 2 sleeve
    // sts per side regardless of body contribution.
    Y3_rb       = Y2_rb + A2_pairs + raglan_with_body_inc;
    Y3_lb       = Y2_lb + A2_pairs + raglan_with_body_inc;
    Y3_f        = Y2_f  + 2 * A2_pairs + 2 * raglan_with_body_inc;
    // Y3_total computed independently for closure check
    Y3_total    = Y2_total
                + A2_pairs * 8
                + A1_pairs * 4
                + raglan_with_body_inc * 4;
    Y3_closure  = (Y3_rb + Rag + Y3_slv + Rag + Y3_f + Rag + Y3_slv + Rag + Y3_lb) === Y3_total;

    // ── STEP 11c: Rendered raglan-section HTML (scenario A/B only) ──────
    // For A/B, the calculator owns the raglan-section wording so the formatter
    // substitutes a single [raglan_section_html] placeholder verbatim. Scenario
    // C keeps its existing render-field/template path (raglan_section_html unused).
    let raglan_section_html = "";
    if (scenario === "A" || scenario === "B") {
      // Render the COMPLETE A/B yoke-increase section (raglan spread + body-only)
      // into one HTML string. The legacy round-type/bracketed-schedule fields are
      // then zeroed so the old template blocks (used only by scenario C) vanish
      // for A/B — keeping the template free of nested conditionals.
      raglan_section_html = renderCompoundRaglanHTML(
        raglan_blocks, Rag, body_only_paired_inc,
        { rb: Y3_rb, slv: Y3_slv, f: Y3_f, lb: Y3_lb }
      );
      raglan_paired_inc         = 0;
      raglan_with_body_inc      = 0;
      body_only_paired_inc      = 0;
      body_only_consecutive_inc = 0;
      body_only_doubled_inc     = 0;
    }
    // Numeric discriminator for the template: 1 = use the pre-rendered
    // [raglan_section_html] (scenario A/B); 0 = use the legacy round-type +
    // bracketed-schedule path (scenario C). Formatter conditions are numeric.
    const use_rendered_raglan = (scenario === "A" || scenario === "B") ? 1 : 0;

    // ── STEP 11d: Mid-yoke measurement checkpoint ───────────────────────
    // A stop-and-measure point partway through the raglan section. Its purpose
    // is to catch gauge drift while the remaining schedule can still absorb a
    // correction — a difference found at the divide cannot be fixed without
    // reknitting. See solveCheckpoint() for the anchor geometry.
    //
    // chk_circ_cm is the circumference of the whole yoke tube — both sleeves
    // included — NOT the chest. It is not comparable to finished_chest_cm.
    const SUPPORT_CONTACT = "yulia@knitpage.com";
    // In C, promoted Round 2A's sit at the bottom of the raglan section, so the
    // plain-paired inc rounds are the top (A2_pairs - promote_in_raglan).
    const chk_rag_paired_top = A2_pairs - promote_in_raglan;
    const chk = (incompatibility === null)
      ? solveCheckpoint(A2_pairs, raglan_blocks, chk_rag_paired_top, sr_rows, Y2_total)
      : null;

    const chk_inc_rounds       = chk ? chk.inc_rounds       : 0;
    const chk_rounds_from_neck = chk ? chk.rounds_from_neck : 0;
    const chk_plain_band       = chk ? chk.plain_band       : 0;
    const chk_sts_total        = chk ? chk.sts_total        : 0;
    const chk_circ_cm  = chk ? +(chk_sts_total / gs).toFixed(1)        : 0;
    const chk_depth_cm = chk ? +(chk_rounds_from_neck / gr).toFixed(1) : 0;
    const has_checkpoint = chk ? 1 : 0;
    const checkpoint_html = renderCheckpointHTML(
      chk, chk_circ_cm, chk_depth_cm, SUPPORT_CONTACT,
      correctionFormUrl({ bust_cm, gauge_sts, gauge_rows, ease_preference,
                          length_preference, sleeve_length_cm })
    );
    // 2026-11-16: place the box INSIDE the raglan section, where the knitter
    // stops (A/B: re-render the section with the box; C: template splits the
    // legacy step list using the chk_c_* fields below).
    let checkpoint_inline = 0;
    if (chk && use_rendered_raglan === 1) {
      raglan_section_html = renderCompoundRaglanHTML(
        raglan_blocks, Rag, A3_pairs,
        { rb: Y3_rb, slv: Y3_slv, f: Y3_f, lb: Y3_lb },
        0, false, checkpoint_html, chk.inc_rounds
      );
      checkpoint_inline = raglan_section_html.indexOf(checkpoint_html) >= 0 ? 1 : 0;
    }
    // Scenario C (legacy step list): split the step that contains the checkpoint.
    //   where 1 = inside [Round 1, Round 2B] (raglan_paired_inc)
    //   where 2 = inside [Round 1, Round 2A] (raglan_with_body_inc)
    let chk_c_where = 0, chk_c_first = 0, chk_c_rest = 0;
    if (chk && use_rendered_raglan === 0 && scenario === "C") {
      if (chk.inc_rounds <= raglan_paired_inc) {
        chk_c_where = 1; chk_c_first = chk.inc_rounds; chk_c_rest = raglan_paired_inc - chk.inc_rounds;
      } else if (chk.inc_rounds <= raglan_paired_inc + raglan_with_body_inc) {
        chk_c_where = 2; chk_c_first = chk.inc_rounds - raglan_paired_inc;
        chk_c_rest = raglan_paired_inc + raglan_with_body_inc - chk.inc_rounds;
      }
    }

    // ── STEP 11e: Resume mode (Phase 2) ─────────────────────────────────
    // When the request carries a `resume` block, the knitter has stopped at the
    // checkpoint, measured, and come back out of tolerance. Re-solve the
    // remainder of the yoke against their EFFECTIVE gauge, targeting the
    // original finished measurements.
    //
    // Everything above (collar, short rows, Y1/Y2, and the raglan rounds the
    // knitter has already worked) is HISTORY — knitted at whatever gauge it was
    // knitted at, and not recomputed. Only the schedule below the current
    // position is re-solved. This is why the resume solver takes cur.* rather
    // than deriving its starting point from Y2.
    let resume_active = 0, resume_ok = 0, resume_review_required = 0;
    let resume_reason = "", resume_detail = "", resume_html = "";
    let resume_schedule_html = "";
    let resume_gs = 0, resume_gr = 0, resume_inc_worked = 0;
    let resume_out = null;
    if (resume_in) {
      resume_active = 1;
      const rw   = resume_in.rounds_worked;
      const sts  = resume_in.sts_on_needle;
      const circ = resume_in.measured_circ_cm;
      const dep  = resume_in.measured_depth_cm;
      // Effective gauge, back-computed from the garment itself. This is a far
      // better measurement than a swatch — the stitch count is known exactly,
      // and the fabric is the actual garment under its own weight.
      const gs_e = sts / circ;
      const gr_e = rw / dep;
      resume_gs = +(gs_e * 10).toFixed(2);
      resume_gr = +(gr_e * 10).toFixed(2);
      // Reconstruct the section split from the total. Every raglan increase
      // round adds 8 sts, so the count on the needle pins how many were worked.
      // This only holds inside the raglan section (before any body-only round),
      // which is where the checkpoint sits by construction.
      const inc_worked = (sts - Y2_total) / 8;
      resume_inc_worked = inc_worked;
      if (!Number.isInteger(inc_worked) || inc_worked < 0) {
        resume_review_required = 1;
        resume_reason = "stitch_count_unexpected";
        resume_detail = "A stitch count of " + sts + " does not correspond to a whole "
          + "number of raglan increase rounds from " + Y2_total + " sts after the short "
          + "rows. Either the count is miscounted or the knitter is past the raglan "
          + "section — needs review.";
      } else if (inc_worked > raglan_pairs) {
        resume_review_required = 1;
        resume_reason = "past_raglan_section";
        resume_detail = "The reported count implies " + inc_worked + " raglan increase "
          + "rounds, more than the " + raglan_pairs + " the pattern contains — the "
          + "knitter is past the yoke shaping. Needs review.";
      } else if (resume_in.inc_rounds_worked !== undefined
                 && resume_in.inc_rounds_worked !== inc_worked) {
        // Two independent statements of where the knitter is, disagreeing.
        // We cannot tell which is wrong from here — a miscounted stitch count
        // and a miscounted round tally look identical — so neither is trusted
        // and the case goes to a human rather than guessing. Guessing would
        // build the whole revised schedule on the wrong starting point.
        resume_review_required = 1;
        resume_reason = "position_disagreement";
        resume_detail = "The knitter reports " + resume_in.inc_rounds_worked
          + " raglan increase rounds worked, but a stitch count of " + sts
          + " implies " + inc_worked + " (each increase round adds 8 sts to the "
          + Y2_total + " sts after the short rows). One of the two is miscounted "
          + "— ask them to recount both before issuing a revised pattern.";
      } else {
        const cur = {
          rb:  Y2_rb  + inc_worked,
          lb:  Y2_lb  + inc_worked,
          f:   Y2_f   + 2 * inc_worked,
          slv: Y2_slv + 2 * inc_worked,
          total: sts,
        };
        resume_out = solveResumeSchedule(cur, rw, gs_e, gr_e, {
          upper_arm_cm, C_cm, target_armhole_cm, Rag, Rag4,
          ua_fraction: uaFraction(ease_preference, bust_cm),
        });
        if (resume_out.ok) {
          resume_ok = 1;
          resume_html = renderResumeHTML(resume_out, cur, rw, gs_e, gr_e, gs, gr);
          // The remaining schedule renders through the SAME renderer as a fresh
          // pattern, so the knitter reads instructions in the format they are
          // already used to — only the numbers differ.
          if (resume_out.scenario === "A" || resume_out.scenario === "B") {
            // Assemble the whole yoke section here, in knitting order:
            //   worked prefix → "revised from your measurements" box → remainder
            // The box lands AT the checkpoint by construction, rather than
            // wherever a template placeholder happened to sit. That is why
            // resume_html is folded in here instead of staying a placeholder.
            const worked = splitWorkedBlocks(raglan_blocks, resume_inc_worked);
            let prefix = "", startSection = 0;
            if (worked && worked.rounds_consumed === rw - sr_rows) {
              prefix = renderWorkedPrefixHTML(raglan_blocks, worked, Rag);
              // Count only blocks that exist AND were reached, or the remainder
              // would skip a section number.
              startSection =
                (raglan_blocks.n1 > 0 && worked.w1 > 0 ? 1 : 0) +
                (raglan_blocks.n2 > 0 && worked.w2 > 0 ? 1 : 0) +
                (raglan_blocks.n3 > 0 && worked.w3 > 0 ? 1 : 0);
            }
            const remainder = renderCompoundRaglanHTML(
              resume_out.blocks, Rag, resume_out.body_only_paired_inc,
              { rb: cur.rb + resume_out.R_rem, slv: resume_out.fin_slv,
                f: cur.f + 2 * resume_out.R_rem, lb: cur.lb + resume_out.R_rem },
              startSection, prefix !== ""
            );
            resume_schedule_html = prefix
              + (prefix ? "\n" + '<hr class="divider"/>' : "")
              + "\n" + resume_html
              + "\n" + remainder;
            // Folded into the schedule above, so the standalone placeholder is
            // cleared — otherwise the box would render twice, once in the wrong
            // place.
            resume_html = "";
            // renderCompoundRaglanHTML closes after the body-only instruction
            // and does not emit a yoke-complete box, because on a fresh pattern
            // the template supplies one. The template's copy is suppressed on a
            // resume (show_original_yoke=0), so the resumed schedule has to
            // carry its own — without it the knitter is never told what count
            // to expect at the divide.
            resume_schedule_html +=
              "\n" + '<p>Yoke is complete.</p>' +
              "\n" + '<div class="stitch-box">' +
              "\n" + '<span class="label">Yoke complete</span>' +
              "\n" + '<strong>' + resume_out.fin_rb + '</strong> sts (right back) · ' + Rag +
              ' raglan sts · <strong>' + resume_out.fin_slv + '</strong> sts (right sleeve) · ' + Rag +
              ' raglan sts · <strong>' + resume_out.fin_f + '</strong> sts (front) · ' + Rag +
              ' raglan sts · <strong>' + resume_out.fin_slv + '</strong> sts (left sleeve) · ' + Rag +
              ' raglan sts · <strong>' + resume_out.fin_lb + '</strong> sts (left back)<br/>' +
              "\n" + '<strong>Total: ' + resume_out.fin_total + ' sts</strong>' +
              "\n" + '</div>';
          }
        } else {
          resume_review_required = 1;
          resume_reason = resume_out.reason;
          resume_detail = resume_out.detail;
        }
      }
    }

    // ── STEP 12: Y4 body section distribution ────────────────
    // body_after_raglan_sts = body sts added from divide point of view in body-only section.
    // = body_sts_needed minus body sts added in raglan section
    //   (= 4 × A2_pairs from full raglans + 4 × raglan_with_body_inc from Round 2A's).
    const body_after_raglan_sts = body_sts_needed - 4 * (A2_pairs + raglan_with_body_inc);
    const body_at_Y3      = Y3_rb + Y3_lb + Y3_f + Rag4;
    const min_B_sts       = body_at_Y3 + UA_base * 2;
    const yoke_at_divide  = min_B_sts + body_after_raglan_sts;
    const non_rag         = yoke_at_divide - Rag4 - UA_base * 2;
    // Apply the body-only (Round 2A) increases DIRECTLY to the Y3 section counts,
    // so the printed box matches what the instruction actually knits. Each
    // body-only round adds +2 to the front and +1 to each back (M1R after the
    // right underarm raglan, M1L before the left underarm raglan — see Round 2A
    // text). No independent re-distribution, no parity overwrite.
    const body_only_rounds = body_after_raglan_sts / 4; // 4 body sts per round
    let Y4_f   = Y3_f  + 2 * body_only_rounds;
    let Y4_rb  = Y3_rb + 1 * body_only_rounds;
    let Y4_lb  = Y3_lb + 1 * body_only_rounds;
    let full_back = Y4_rb + Y4_lb;
    // Parity flags (informational only — not forced, since forcing would break
    // the box↔instruction match). front/back parity follows non_rag parity.
    const parity_bump_front = 0;
    const full_back_even = (full_back % 2 === 0);
    const Y4_slv          = Y4_Sleeve_st;
    const Y4_total        = Y4_rb + Rag + Y4_slv + Rag + Y4_f + Rag + Y4_slv + Rag + Y4_lb;
    // Independent expectation: each bop round adds 4 body sts, 0 sleeve sts.
    // So Y4_total should equal Y3_total + body sts gained in bop section.
    const Y4_total_expected = Y3_total + body_after_raglan_sts;
    const Y4_closure      = Y4_total === Y4_total_expected;

    const Y5_rb    = Y4_rb;
    const Y5_lb    = Y4_lb;
    const Y5_f     = Y4_f;
    const Y5_total = Y4_total;

    // ── STEP 13: Divide ──────────────────────────────────────
    // Sleeve stitch count must be EVEN so the k1tbl/p1 cuff rib closes cleanly.
    // Y4_Sleeve_st can be odd (short rows can leave Y2_slv odd) and UA is even,
    // so SL_sts_raw may be odd. When it is, add 1 stitch at the underarm pick-up
    // (bumps the picked-up sleeve to the next even count); UA_extra records it so
    // the divide/pick-up wording and B_sts accounting stay consistent.
    const SL_sts_raw         = Y4_Sleeve_st + UA;
    const SL_parity_bump     = (SL_sts_raw % 2 === 0) ? 0 : 1;
    const SL_sts             = SL_sts_raw + SL_parity_bump;
    const UA_pickup          = UA + SL_parity_bump; // sts actually picked up at underarm
    const B_sts              = Y4_rb + Y4_lb + Y4_f + Rag4 + UA * 2;
    const finished_chest_cm  = +(B_sts / gs).toFixed(1);
    const finished_upper_arm_cm = +(SL_sts / gs).toFixed(1);
    const B1_body_check      = B_sts === (yoke_at_divide - UA_base * 2 + UA * 2);
    const sleeve_sts_even    = SL_sts % 2 === 0;

    // ── STEP 14: Armhole depth ───────────────────────────────
    const armhole_depth_rows    = sr_rows + available_rows;
    const armhole_depth_cm      = +(armhole_depth_rows / gr).toFixed(1);
    const armhole_depth_in_range = armhole_depth_cm >= 18 && armhole_depth_cm <= 44;

    // ── STEP 15: Cuff ────────────────────────────────────────
    // PATCHED v15 (item #21): replaced the flat-cm bust-bracketed lookup
    // with a ratio of the actual computed upper-arm circumference.
    //
    // Root cause of the v13/v14 approach: lookupCuffCm's per-fit offset was
    // a flat +1/+1.5/+2 cm bump regardless of bust, while upper_arm_cm grows
    // by close to the full ease amount. That made the cuff/upper-arm ratio
    // collapse as ease increased — verified at 47-50% across the full valid
    // bust range (86-147cm) at the oversized tier, vs 62-90% in three real
    // published raglan/yoke patterns (27 data points, ease 6.5-30cm).
    // Pooled mean ratio across all three:
    // 72.2% ± 5.1, with no significant trend vs ease (R²=0.033) — i.e. the
    // ratio is a property of raglan/yoke sleeve geometry, not ease level.
    // (Set-in construction tapers harder — CYC close-fit chart: ~53% — but
    // that's a different construction, not an ease effect, and isn't mixed
    // into this ratio.)
    //
    // Fix: derive cuff directly from finished_upper_arm_cm using the pooled
    // ratio, so cuff growth automatically tracks whatever upper-arm width
    // the raglan math produces at any bust/ease/gauge combo, instead of
    // chasing a second, independently-maintained bust-bracketed table.
    // This also removes the old table's bust<80/bust>150 gap (masked today
    // by the API's own input validation, but a real latent edge case).
    // PATCHED v17: the 0.70 ratio was calibrated on FULL-LENGTH sleeves that
    // end at the wrist (narrowest point). A shorter sleeve ends higher up the
    // forearm, where the arm is thicker, so a wrist-width cuff binds. The arm
    // tapers from wrist (~x1.0) toward mid-forearm (~x1.25 vs wrist — women's
    // ANSUR/anthropometric: wrist ~15cm, mid-forearm ~19-20cm), so the cuff
    // ratio must rise as the sleeve gets shorter.
    //
    // Anchors (cuff-to-upper-arm ratio vs sleeve length, underarm-to-cuff):
    //   full length  (44 cm, wrist)        -> 0.70
    //   mid-forearm  (30 cm, current cap)  -> 0.88
    // Linear interpolation between the two, clamped at both ends. Tally caps
    // sleeve length at mid-forearm, so we never extrapolate past 0.88.
    const _slv = solveSleeveSchedule(SL_sts, finished_upper_arm_cm,
                                     sleeve_length_cm, gs_rib, gr);
    const CUFF_TO_UPPERARM_RATIO = _slv.CUFF_TO_UPPERARM_RATIO;
    const cuff_target_cm         = _slv.cuff_target_cm;
    const CU_sts                 = _slv.CU_sts;
    const cuff_sts_even          = CU_sts % 2 === 0;

    // ── STEP 16: Sleeve decreases ────────────────────────────
    const dec_rounds         = _slv.dec_rounds;
    const dec_rounds_integer = _slv.dec_rounds_integer;

    // ── STEP 16b: Sleeve schedule ────────────────────────────
    const cuff_rib_cm             = _slv.cuff_rib_cm;
    const sleeve_stockinette_cm   = _slv.sleeve_stockinette_cm;
    const sleeve_stockinette_rows = _slv.sleeve_stockinette_rows;
    const dec_gap                 = _slv.dec_gap;
    const dec_top_plain           = _slv.dec_top_plain;
    const dec_end_plain           = _slv.dec_end_plain;
    const dec_every_nth           = _slv.dec_every_nth;
    const dec_every_nth_ordinal   = ordinalSuffix(dec_every_nth);
    const dec_section_rows        = _slv.dec_section_rows;
    const sleeve_plain_rounds     = _slv.sleeve_plain_rounds;
    const sleeve_too_short        = _slv.too_short;
    if (sleeve_too_short && schedule_error === null) {
      schedule_error = "Sleeve length too short: stockinette section ("
        + sleeve_stockinette_rows + " rows) cannot fit " + dec_rounds
        + " decreases at every " + dec_every_nth + "th round ("
        + dec_section_rows + " rows). Increase sleeve_length_cm.";
      incompatibility = "sleeve_too_short";
    }

    // ── STEP 16c: Resumed sleeve schedule ────────────────────
    // A resumed sweater reaches the divide with a DIFFERENT sleeve stitch count
    // at a DIFFERENT gauge, so its cuff count and decrease spacing both move.
    // Same function, effective gauge, revised sleeve count.
    let resume_slv = null;
    if (resume_ok === 1 && resume_out) {
      const gs_e_ = resume_gs / 10;
      const gr_e_ = resume_gr / 10;
      resume_slv = solveSleeveSchedule(
        resume_out.SL_sts, resume_out.upper_arm_cm, sleeve_length_cm,
        gs_e_ * RIB_GAUGE_RATIO, gr_e_
      );
      if (resume_slv.too_short) {
        // The revised sleeve cannot fit its decreases. The yoke is fine, so
        // this is not a whole-order failure — but it is not something to ship
        // silently either.
        resume_ok = 0;
        resume_review_required = 1;
        resume_reason = "resumed_sleeve_too_short";
        resume_detail = "The revised sleeve needs " + resume_slv.dec_rounds
          + " decreases but the stockinette section is only "
          + resume_slv.sleeve_stockinette_rows + " rounds at the measured gauge. "
          + "The sleeve length or cuff width needs adjusting by hand.";
        resume_html = "";
        resume_schedule_html = "";
      }
    }

    // ── STEP 17: Body length ─────────────────────────────────
    // PATCHED v13: base table and per-fit offsets aligned with SIS-v3.
    //   Base = TRUE close-fit (0 ease) values from Chart 1.
    //   Per-fit offsets bust-bracketed (Chart 1→2 deltas vary 2–2.5 cm,
    //   Chart 1→3 deltas vary 5–6.5 cm — plus sizes grade body length
    //   faster than misses for oversized fits).
    //   length_preference adjustment of ±10 cm (cropped/long) — aligned with SIS
    //   and industry convention (Amy Herzog, CYC) for cropped/tunic step.
    let base_length;
    if      (bust_cm < 85)  base_length = 57;
    else if (bust_cm < 90)  base_length = 58;
    else if (bust_cm < 95)  base_length = 58;
    else if (bust_cm < 100) base_length = 58.5;
    else if (bust_cm < 110) base_length = 59.5;
    else if (bust_cm < 120) base_length = 60;
    else if (bust_cm < 130) base_length = 60.5;
    else if (bust_cm < 140) base_length = 60.5;
    else                    base_length = 62;

    const length_ease_adj = ease_preference === "oversized"
                              ? (bust_cm < 95  ? 5 : bust_cm < 120 ? 6 : 6.5)
                          : ease_preference === "relaxed"
                              ? (bust_cm < 120 ? 2 : 2.5)
                          : 0;
    const length_adj      = length_preference === "cropped" ? -10
                          : length_preference === "long"    ?  10 : 0;
    const body_length_cm  = base_length + length_ease_adj + length_adj;

    // PATCHED (item #16): the Body section's stockinette-only length is the
    // full body_length_cm minus the hem rib (always 6 cm in this template).
    // Previously the template rendered this as a raw arithmetic expression
    // ("[body_length_cm] cm minus 6 cm") instead of a single computed
    // figure — the formatter only substitutes, it never computes, so this
    // field must originate here.
    const HEM_RIB_CM = 6;
    const body_stockinette_cm = +(body_length_cm - HEM_RIB_CM).toFixed(1);

    // ── CHECKS ───────────────────────────────────────────────
    const bop_rounds_integer = Number.isInteger(bop_rounds) && bop_rounds >= 0;
    const any_error = !Y1_closure || !Y2_closure || !Y3_closure || !Y4_closure
                    || !B1_body_check || !raglan_pairs_integer
                    || !bop_rounds_integer || !dec_rounds_integer
                    || !armhole_depth_in_range
                    || schedule_error !== null;

    // ── OUTPUT ───────────────────────────────────────────────
    const result = {
      // Routing flag for sis-formatter-v7.js (selects TDCR KV keys)
      pattern_type: "tdcr",

      // PATCH v14: parity-gap adjustment (0 if no adjustment was needed)
      body_parity_adjustment_sts: Y5_body_st_target - Y5_body_st_raw,

      // Inputs echoed back (lowercase) — required by formatter prompt's calculation log
      bust_cm,
      ease_preference,
      length_preference,
      gauge_sts,
      gauge_rows,
      sleeve_length_cm,

      // Derived values
      C_cm,
      Ease_:       ease_cm,
      neck_cm:     +neck_cm.toFixed(1),
      Gauge_sts:   gauge_sts,
      Gauge_rows:  gauge_rows,
      N_sts:       CO_sts,
      Y1_rb,  Y1_slv, Y1_f,  Y1_lb,  Y1_total,
      Y2_rb,  Y2_slv, Y2_f,  Y2_lb,  Y2_total,
      raglan_pairs,
      sleeve_inc_shortfall,
      bop_rounds,
      available_rows,
      scenario,
      A1_pairs,
      A2_pairs,
      A3_pairs,
      trailing_plain_rows,
      // ── Promotion / doubling counts (scenario C; 0 in A/B) ──
      excess_pairs,
      promote_in_body_only,
      promote_in_raglan,
      doubled,
      // ── Render fields consumed by template ──
      raglan_paired_inc,
      raglan_with_body_inc,
      body_only_paired_inc,
      body_only_consecutive_inc,
      body_only_doubled_inc,
      // ── New (sleeve-only removed): plain-pair spread fields (A only) ──
      raglan_plain_pairs,
      // Compound raglan blocks (A/B). rag_slow_rate is 2 when there is no slow
      // block (scenario B), in which case rag_slow_count is 0.
      rag_fast_top:    raglan_blocks ? raglan_blocks.n1 : 0,
      rag_slow_count:  raglan_blocks ? raglan_blocks.n2 : 0,
      rag_slow_rate:   raglan_blocks ? raglan_blocks.r2 : 2,
      rag_fast_bottom: raglan_blocks ? raglan_blocks.n3 : 0,

      // ── Mid-yoke measurement checkpoint (STEP 11d) ──
      // chk_circ_cm is the whole yoke tube, both sleeves included — not chest.
      has_checkpoint,
      chk_inc_rounds,
      chk_rounds_from_neck,
      chk_plain_band,
      chk_sts_total,
      chk_circ_cm,
      chk_depth_cm,
      checkpoint_html,
      checkpoint_inline,
      chk_c_where, chk_c_first, chk_c_rest,

      // ── Resume mode (STEP 11e) ──
      // resume_active: a resume block was supplied at all.
      // resume_ok: the remainder was solved; resume_schedule_html is usable.
      // resume_review_required: solved OR parsed and failed — the case needs a
      //   human. resume_reason / resume_detail say why, in words that can be
      //   pasted into a reply to the knitter.
      resume_active,
      resume_ok,
      resume_review_required,
      resume_reason,
      resume_detail,
      resume_gs,
      resume_gr,
      resume_inc_worked,
      resume_scenario:        resume_out && resume_out.ok ? resume_out.scenario : "",
      resume_raglan_rounds:   resume_out && resume_out.ok ? resume_out.R_rem : 0,
      resume_body_only_pairs: resume_out && resume_out.ok ? resume_out.body_only_paired_inc : 0,
      resume_rounds_remaining: resume_out && resume_out.ok ? resume_out.rounds_remaining : 0,
      resume_total_rows:      resume_out && resume_out.ok ? resume_out.total_rows : 0,
      resume_fin_total:       resume_out && resume_out.ok ? resume_out.fin_total : 0,
      resume_B_sts:           resume_out && resume_out.ok ? resume_out.B_sts : 0,
      resume_SL_sts:          resume_out && resume_out.ok ? resume_out.SL_sts : 0,
      resume_chest_cm:        resume_out && resume_out.ok ? resume_out.chest_cm : 0,
      resume_upper_arm_cm:    resume_out && resume_out.ok ? resume_out.upper_arm_cm : 0,
      resume_yoke_depth_cm:   resume_out && resume_out.ok ? resume_out.yoke_depth_cm : 0,
      resume_UA_base:         resume_out && resume_out.ok ? resume_out.UA_base : 0,
      resume_html,
      resume_schedule_html,
      // Resumed sleeve & cuff (STEP 16c). A resumed sweater divides with a
      // different sleeve count at a different gauge, so these replace the
      // normal sleeve section — they are NOT the same as the fields above.
      resume_CU_sts:              resume_slv ? resume_slv.CU_sts : 0,
      resume_dec_rounds:          resume_slv ? resume_slv.dec_rounds : 0,
      resume_dec_every_nth:       resume_slv ? resume_slv.dec_every_nth : 0,
      resume_dec_every_nth_ordinal: resume_slv ? ordinalSuffix(resume_slv.dec_every_nth) : "",
      resume_dec_top_plain:       resume_slv ? resume_slv.dec_top_plain : 0,
      resume_dec_end_plain:       resume_slv ? resume_slv.dec_end_plain : 0,
      resume_sleeve_plain_rounds: resume_slv ? resume_slv.sleeve_plain_rounds : 0,
      resume_sleeve_stockinette_cm: resume_slv ? resume_slv.sleeve_stockinette_cm : 0,
      resume_cuff_cm:             resume_slv ? +(resume_slv.CU_sts / (resume_gs / 10 * RIB_GAUGE_RATIO)).toFixed(1) : 0,
      raglan_section_html,
      use_rendered_raglan,
      sr_rows,
      // ── Render-mode discriminators (let the template stay flat) ──
      // raglan_render_mode: 0 = empty section, 1 = paired only, 2 = with-body only, 3 = mixed
      raglan_render_mode: (
        raglan_paired_inc === 0 && raglan_with_body_inc === 0 ? 0 :
        raglan_with_body_inc === 0 ? 1 :
        raglan_paired_inc === 0   ? 2 : 3
      ),
      // body_only_complex_sum: 0 → render simple "work N times" text; >0 → render ordered list
      body_only_complex_sum: body_only_consecutive_inc + body_only_doubled_inc,
      // round2A_needed / round2B_needed: single-value flags for the merged
      // Raglan Increases template, which can only test ONE field per
      // TDCR_IF (the formatter grammar has no OR/AND). Round 2A's
      // definition is needed if ANY step uses it; same for Round 2B.
      round2A_needed: (
        raglan_with_body_inc + body_only_paired_inc +
        body_only_consecutive_inc + body_only_doubled_inc > 0 ? 1 : 0
      ),
      round2B_needed: (
        raglan_paired_inc + body_only_paired_inc > 0 ? 1 : 0
      ),
      incompatibility,
      Y3_rb,  Y3_slv, Y3_f,  Y3_lb,  Y3_total,
      Y4_rb,  Y4_slv, Y4_f,  Y4_lb,  Y4_total,
      Y5_total, Y5_rb, Y5_f, Y5_lb,
      UA_base, UA, UA_pickup, SL_parity_bump, sleeve_sts_even, cuff_sts_even,
      parity_bump_front, full_back_even,
      B_sts,
      body_length_cm,
      body_stockinette_cm,
      SL_sts, dec_every_nth, dec_every_nth_ordinal, dec_rounds, CU_sts,
      // "Knit 1 rounds plain" reads as a bug to a knitter even though the
      // number is right. Supplied as a word so the template stays
      // substitution-only. Overridden below on a resume.
      dec_top_plain_word: dec_top_plain === 1 ? "round" : "rounds",
      collar_dense_gauge,
      rib_gauge_sts, RIB_GAUGE_RATIO,
      // ── Sleeve schedule fields (Step 16b) ──
      cuff_rib_cm,
      sleeve_stockinette_cm,
      sleeve_stockinette_rows,
      dec_section_rows,
      sleeve_plain_rounds,
      dec_top_plain,
      dec_end_plain,
      // ── Aliases for template placeholders ──
      // The HTML template uses these names. Keep them as aliases pointing
      // to the canonical fields so the calculator's internal names stay
      // unchanged while the template gets stable insertion points.
      body_only_pairs: bop_rounds,
      raglan_sts:      Rag,
      SR_extra,
      sr_extra_times: SR_extra === 1 ? "once" : SR_extra + " times",
      sr_pair_total: SR_extra + 1,
      sr_turn_first,
      sr_turn_2,
      sr_turn_3,
      Phase1_extra_pairs,
      extra_row_n,
      extra_row_n_plus1,
      extra_turn_sts,
      Row5_n, Row6_n, Row7_n, Row8_n,
      cuff_cm:         +(CU_sts / gs_rib).toFixed(1),
      upper_sleeve_cm: finished_upper_arm_cm,
      yoke_depth_cm:   armhole_depth_cm,
      upper_arm_cm:           +upper_arm_cm.toFixed(1),
      finished_chest_cm,
      finished_upper_arm_cm,
      target_armhole_cm,
      armhole_depth_cm,
      armhole_depth_rows,
      checks: {
        Y1_closure,
        Y2_closure,
        Y3_closure,
        Y4_closure,
        B1_body_check,
        raglan_pairs_integer,
        bop_rounds_integer,
        dec_rounds_integer,
        armhole_depth_in_range,
        even_sections_after_split:
          ((Y4_f + Y4_rb + Y4_lb) % 2 === 0) &&
          (SL_sts % 2 === 0),
      },
    };

    if (any_error) {
      result.calculation_error = true;
      const failed = [];
      if (!Y1_closure)           failed.push("Y1_closure");
      if (!Y2_closure)           failed.push("Y2_closure");
      if (!Y3_closure)           failed.push("Y3_closure");
      if (!Y4_closure)           failed.push("Y4_closure");
      if (!B1_body_check)        failed.push("B1_body_check");
      if (!raglan_pairs_integer) failed.push("raglan_pairs_integer");
      if (!bop_rounds_integer)   failed.push("bop_rounds_integer");
      if (!dec_rounds_integer)   failed.push("dec_rounds_integer");
      if (!armhole_depth_in_range) failed.push("armhole_depth_in_range");
      if (schedule_error)        failed.push("schedule: " + schedule_error);
      result.error_detail = "Failed checks: " + failed.join(", ");
    }

    // ── Reference check ──────────────────────────────────────
    // Always populated (we use nearest-bust matching). The check compares
    // finished cm dimensions against the CYC industry-standard chart at the
    // ease tier closest to the actual ease_cm. Computed even when
    // calculation_error is true, so callers can see what cm targets the
    // calc was aiming for.
    result.reference_check = buildReferenceCheck(result, ease_cm, bust_cm, ease_preference);

    // ── Resume overrides ─────────────────────────────────────
    // A resumed pattern is the ORIGINAL pattern with the yoke schedule below
    // the checkpoint replaced — but every section downstream of the divide
    // depends on numbers the new schedule changed. The body divides at a
    // different count, the sleeve picks up a different count at a different
    // gauge, and the finished measurements land on different figures.
    //
    // Rather than duplicating the body, sleeve and measurement blocks in the
    // template with a second set of placeholders, the FIELDS THEMSELVES are
    // overridden here. Those sections then need no template changes at all,
    // and cannot drift out of step with the fresh path — there is only one
    // copy of each block, and it always reads whatever is correct for the
    // pattern being generated.
    //
    // Only the yoke schedule and the checkpoint box need template gating,
    // because those are the two places where the ORIGINAL text must be
    // suppressed rather than merely renumbered.
    if (resume_ok === 1 && resume_out && resume_slv) {
      const UAb = resume_out.UA_base;
      Object.assign(result, {
        // Yoke-complete section counts
        Y4_rb: resume_out.fin_rb,
        Y4_lb: resume_out.fin_lb,
        Y4_f:  resume_out.fin_f,
        Y4_slv: resume_out.fin_slv,
        Y4_total: resume_out.fin_total,
        // Body divide
        Y5_rb: resume_out.fin_rb,
        Y5_lb: resume_out.fin_lb,
        Y5_f:  resume_out.fin_f,
        B_sts: resume_out.B_sts,
        UA: UAb,
        UA_pickup: UAb,
        // Sleeve & cuff
        SL_sts: resume_out.SL_sts,
        CU_sts: resume_slv.CU_sts,
        dec_rounds: resume_slv.dec_rounds,
        dec_every_nth: resume_slv.dec_every_nth,
        dec_every_nth_ordinal: ordinalSuffix(resume_slv.dec_every_nth),
        dec_top_plain: resume_slv.dec_top_plain,
        dec_top_plain_word: resume_slv.dec_top_plain === 1 ? "round" : "rounds",
        dec_end_plain: resume_slv.dec_end_plain,
        sleeve_plain_rounds: resume_slv.sleeve_plain_rounds,
        sleeve_stockinette_cm: resume_slv.sleeve_stockinette_cm,
        // Finished measurements
        finished_chest_cm: resume_out.chest_cm,
        finished_upper_arm_cm: resume_out.upper_arm_cm,
        yoke_depth_cm: resume_out.yoke_depth_cm,
        armhole_depth_cm: resume_out.yoke_depth_cm,
        // Gauge shown to the knitter is the one their fabric is actually
        // producing, not the one they ordered with.
        // Gauge shown to the knitter is rounded to 1dp — it is a measurement
        // read off a ruler, and printing 20.96 implies a precision the reading
        // does not have. resume_gs/resume_gr keep full precision for the maths.
        Gauge_sts: +resume_gs.toFixed(1),
        Gauge_rows: +resume_gr.toFixed(1),
        gauge_sts: +resume_gs.toFixed(1),
        gauge_rows: +resume_gr.toFixed(1),
        rib_gauge_sts: +(resume_gs * RIB_GAUGE_RATIO).toFixed(1),
        // C_cm drives the size-guide and finishing text. On a fresh pattern it
        // is the target (bust + ease); on a resume the garment lands on the
        // achievable count, so leaving C_cm at the target would have page 1
        // promise 104.5 cm while the measurements table says 105.
        C_cm: resume_out.chest_cm,
        Ease_: +(resume_out.chest_cm - bust_cm).toFixed(1),
      });
      // Derived display fields that the template reads downstream. These are
      // renderings of the resumed numbers, not part of the yoke solve.
      Object.assign(result, {
        Y5_total: resume_out.fin_total,
        Y5_slv: resume_out.fin_slv,
        upper_sleeve_cm: resume_out.upper_arm_cm,
        dec_section_rows: resume_slv.dec_section_rows,
        sleeve_stockinette_rows: resume_slv.sleeve_stockinette_rows,
        cuff_target_cm: resume_slv.cuff_target_cm,
        CUFF_TO_UPPERARM_RATIO: resume_slv.CUFF_TO_UPPERARM_RATIO,
        // The checkpoint belongs to the ORIGINAL pattern: this knitter has
        // already passed it and this pattern is the answer to it. Clearing the
        // flag suppresses both the box and TDCR-24, whose expected figures were
        // computed against the ordered gauge and no longer describe anything.
        has_checkpoint: 0,
        chk_inc_rounds: 0,
        chk_rounds_from_neck: 0,
        chk_plain_band: 0,
        chk_sts_total: 0,
        chk_circ_cm: 0,
        chk_depth_cm: 0,
        checkpoint_html: "",
      });
    }

    // ── Section visibility flags ─────────────────────────────
    // The formatter's TDCR_IF grammar takes a single field per condition — no
    // AND — so any condition that is really a conjunction has to be resolved
    // to one flag here. Each of these answers exactly one question: does this
    // block appear in this pattern?
    //
    // On a resumed pattern the ORIGINAL yoke schedule must not print. Leaving
    // it in would have the knitter work the whole original schedule and then
    // the replacement — the single most damaging thing this pipeline could
    // put in front of someone.
    const _res = resume_ok === 1 ? 1 : 0;
    // Scenario C has no rendered-HTML path — renderCompoundRaglanHTML only
    // handles the A/B block structure. A C resume therefore reuses the LEGACY
    // step-list block, with its step counts overridden below to the resumed
    // values. Without this a C resume would suppress the original schedule and
    // supply nothing in its place, leaving the yoke section blank.
    const _res_legacy = (_res && resume_out && resume_out.scenario === "C") ? 1 : 0;
    result.show_rendered_raglan = (use_rendered_raglan === 1 && !_res) ? 1 : 0;
    result.show_legacy_raglan   = _res_legacy
      ? 1
      : ((use_rendered_raglan === 0 && !_res) ? 1 : 0);
    // The yoke-complete box reads Y4_*, which the overrides above have already
    // switched to the resumed counts — so it is correct to show it on a C
    // resume. On an A/B resume the box is carried inside resume_schedule_html
    // instead, so the template's copy stays suppressed.
    result.show_original_yoke   = _res ? _res_legacy : 1;
    // The checkpoint box invites the knitter to stop and measure. On a resumed
    // pattern they already did that — this pattern IS the answer — so showing
    // it again would tell them to report a problem they have already reported.
    result.show_checkpoint      = (has_checkpoint === 1 && !_res) ? 1 : 0;
    // 2026-11-16 checkpoint placement flags (template TDCR_IF takes one field).
    //   A/B: box is inside raglan_section_html (checkpoint_inline=1).
    //   C:   template splits the legacy step that contains it (chk_c_*).
    //   Otherwise (should not happen): the old standalone box after the steps.
    const _cw = result.show_checkpoint === 1 ? chk_c_where : 0;
    result.chk_c_split_paired = _cw === 1 ? 1 : 0;
    result.chk_c_split_wb     = _cw === 2 ? 1 : 0;
    result.show_checkpoint_standalone =
      (result.show_checkpoint === 1 && checkpoint_inline === 0 && _cw === 0) ? 1 : 0;
    // Legacy-path step counts: on a C resume they carry the REMAINING schedule;
    // on an A/B resume the whole legacy block is suppressed, so zero them.
    if (_res_legacy) {
      result.raglan_paired_inc         = resume_out.raglan_paired_inc;
      result.raglan_with_body_inc      = resume_out.raglan_with_body_inc;
      result.body_only_paired_inc      = resume_out.body_only_paired_inc;
      result.body_only_consecutive_inc = resume_out.body_only_consecutive_inc;
      result.body_only_doubled_inc     = resume_out.body_only_doubled_inc;
      result.round2A_needed = (resume_out.raglan_with_body_inc
        + resume_out.body_only_paired_inc + resume_out.body_only_consecutive_inc) > 0 ? 1 : 0;
      result.round2B_needed = (resume_out.raglan_paired_inc
        + resume_out.body_only_paired_inc) > 0 ? 1 : 0;
      result.use_rendered_raglan = 0;
    } else if (_res) {
      result.round2A_needed = 0;
      result.round2B_needed = 0;
      result.body_only_doubled_inc = 0;
      result.raglan_paired_inc = 0;
      result.raglan_with_body_inc = 0;
      result.body_only_paired_inc = 0;
      result.body_only_consecutive_inc = 0;
      result.use_rendered_raglan = 0;
    }

    // Legacy (scenario C) step-list counts for the UNSPLIT lines; the split
    // line is printed by its own template block instead.
    result.legacy_paired_line = result.chk_c_split_paired ? 0 : result.raglan_paired_inc;
    result.legacy_wb_line     = result.chk_c_split_wb     ? 0 : result.raglan_with_body_inc;
    // "once" instead of "1 times" in the legacy step list (Yulia, 16 Nov 2026).
    const _tot = (n) => n === 1 ? "once" : "a total of " + n + " times";
    const _tms = (n) => n === 1 ? "once" : n + " times";
    // Full sentences for the legacy (scenario C) step list, same ** to ** notation.
    result.legacy_paired_text = repBlock('Work Round 1, then Round 2', result.legacy_paired_line || 1);
    result.legacy_wb_text     = repBlock('Work Round 1, then Round 3', result.legacy_wb_line || 1);
    result.chk_c_first_paired_text = repBlock('Work Round 1, then Round 2', result.chk_c_first || 1);
    result.chk_c_rest_paired_text  = repBlock('Work Round 1, then Round 2', result.chk_c_rest || 1);
    result.chk_c_first_wb_text     = repBlock('Work Round 1, then Round 3', result.chk_c_first || 1);
    result.chk_c_rest_wb_text      = repBlock('Work Round 1, then Round 3', result.chk_c_rest || 1);
    result.body_only_paired_text   = repBlock('Work Round 3, then Round 2', result.body_only_paired_inc || 1);
    const _single = (r, n) => n === 1 ? 'Work Round ' + r + ' once.'
      : 'Work Round ' + r + ' a total of <strong>' + n + '</strong> times, with no plain rounds in between.';
    result.body_only_consecutive_text = _single('3', result.body_only_consecutive_inc || 1);
    result.body_only_doubled_text     = _single('4', result.body_only_doubled_inc || 1);
    result.legacy_paired_times = _tot(result.legacy_paired_line);
    result.legacy_wb_times     = _tot(result.legacy_wb_line);
    result.chk_c_first_times   = _tms(result.chk_c_first);
    result.chk_c_rest_times    = result.chk_c_rest === 1 ? "1 more time" : result.chk_c_rest + " more times";
    result.body_only_paired_times      = _tot(result.body_only_paired_inc);
    result.body_only_consecutive_times = result.body_only_consecutive_inc === 1 ? "once more" : "a further " + result.body_only_consecutive_inc + " times";
    result.body_only_doubled_times     = _tot(result.body_only_doubled_inc);

    // Sleeve decreases in the ** to ** style (Yulia, 17 Nov 2026). Uses the
    // final (possibly resume-overridden) fields. dec_top_plain varies 0-8 by
    // size, so it is printed only when > 0.
    {
      const top = result.dec_top_plain, gap = result.dec_every_nth - 1, n = result.dec_rounds;
      const rw = (k) => k + (k === 1 ? ' round' : ' rounds');
      const pre = top > 0 ? 'Knit ' + rw(top) + ', then: ' : '';
      // Two decrease rounds (k2tog before BOR, then ssk after BOR on the next
      // round), so the decreases do not stack on the same round. Each repeat is
      // still dec_every_nth rounds: (gap - 1) plain + 2 decrease rounds.
      const decs = 'work 2 decrease rounds as follows: knit to last 3 sts, k2tog, k1; ' +
        'on the next round, k1, ssk, knit to end of round (2 sts decreased)';
      const inner = gap > 1 ? 'Knit ' + rw(gap - 1) + ', then ' + decs
                            : decs.charAt(0).toUpperCase() + decs.slice(1);
      result.sleeve_dec_text = n <= 0 ? '' : pre + (n === 1 ? inner + '.'
        : '**' + inner + '.** Repeat ** to ** a total of <strong>' + n + '</strong> times.') +
        ' This way the decreases are aligned; otherwise they would sit one on top of another.';
    }
    // Blocking is done flat, so the pattern gives the half-circumference width.
    result.finished_half_chest_cm = +(result.finished_chest_cm / 2).toFixed(1);

    return new Response(JSON.stringify(result), { headers: corsHeaders });
  },
};
