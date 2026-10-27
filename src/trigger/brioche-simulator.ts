// @ts-nocheck
// Copy of the knitting simulator (layer 3). Source of truth: project claude/brioche-simulator.js
// Knitting simulator (layer 3) -- 2026-10-21
//
// Reads ONLY the finished pattern text (the HTML the PDF is made from) and
// knits it on paper: round by round, stitch count by stitch count. It has no
// access to the calculator. Every number it can re-derive is compared with
// the number printed in the pattern. Wording it does not recognise is
// reported as "not understood", so changed wording never slips through.
//
// simulate(html) -> { ok, checks: [{ ok, what, detail }], notUnderstood: [] }

const STS = { brkyobrk: 2, brk4st: 4, decrease: -2, sl2yo: -1, p2tog: -1, k2tog: -1, ssk: -1 };

export function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<br\s*\/?>/g, "\n").replace(/<\/(p|div|li|tr|h1|h2|h3|section)>/g, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

// stitch change of one written instruction (one round)
export function delta(instr) {
  let s = instr.replace(/\([^()]*\)/g, " "); // parentheticals are explanations, not stitches
  let total = 0;
  // [ ... ] N times / 1 time
  s = s.replace(/\[([^\]]*)\]\s*(\d+)\s*times?/g, (m, inner, n) => { total += delta(inner) * +n; return " "; });
  // * ... *, repeat * to * a total of K times
  s = s.replace(/\*([^*]*)\*,?\s*repeat \* to \* a total of (\d+) times/g, (m, inner, n) => { total += delta(inner) * +n; return " "; });
  const count = (re) => (s.match(re) || []).length;
  total += STS.brkyobrk * count(/brkyobrk/g);
  total += STS.brk4st * count(/brk4st/g);
  total += STS.decrease * count(/brioche decrease/g);
  total += STS.sl2yo * count(/sl2yo/g);
  total += STS.p2tog * count(/p2tog/g);
  total += STS.k2tog * count(/k2tog/g);
  total += STS.ssk * count(/\bssk\b/g);
  return total;
}

export function simulate(html) {
  const t = toText(html);
  const checks = [], notUnderstood = [];
  const ok = (cond, what, detail = "") => checks.push({ ok: !!cond, what, detail });
  const need = (re, label, from = t) => { const m = from.match(re); if (!m) notUnderstood.push(label); return m; };
  const num = (x) => (x === undefined ? NaN : +x);
  const odd = (r) => r % 2 === 1;
  const after = (anchor) => { const i = t.indexOf(anchor); return i < 0 ? "" : t.slice(i); };

  // gauge (cover page)
  const g = need(/(\d+(?:\.\d+)?) sts & (\d+(?:\.\d+)?) rows/, "gauge on cover");
  const gr = g ? num(g[2]) : NaN;
  const cm = (rounds) => Math.round((rounds * 10 / gr) * 10) / 10;

  // ── neck ──
  const co = need(/Cast on (\d+) sts \((\d+) ribs\)/, "cast-on");
  let S = co ? num(co[1]) : NaN;
  ok(co && num(co[1]) === 2 * num(co[2]), "cast-on sts = 2 × ribs", co && co[0]);
  const pre = need(/Work Rounds 1 and 2 a total of (\d+) times/, "pre-neck rounds");
  let R = pre ? 2 + 2 * num(pre[1]) : NaN; // set-up A + B + pairs
  const red = need(/Reduction Round[\s\S]*?BRK round: ([^\n]*)\n\s*(\d+) sts \((\d+) ribs\)/, "reduction round");
  if (red) {
    R += 1; ok(odd(R), "reduction round is a BRK round", `round ${R}`);
    S += delta(red[1]); ok(S === num(red[2]), "stitch count after the reduction round", `knitted ${S}, printed ${red[2]}`);
  }
  const plain1 = need(/Work rounds (\d+)–(\d+) in brioche\./, "neck plain rounds");
  if (plain1) { ok(num(plain1[1]) === R + 1, "neck plain rounds start right after the reduction round", `${plain1[1]} vs ${R + 1}`); R = num(plain1[2]); }
  // section counts after markers
  const secs = need(/right back: (\d+) sts[^·]*· right sleeve: (\d+) sts[^·]*· front: (\d+) sts[^·]*· left sleeve: (\d+) sts[^·]*· left back: (\d+) sts/, "marker section counts");
  if (secs) ok(secs.slice(1).reduce((a, b) => a + num(b), 0) === S, "marker sections add up to the stitch count", `${secs.slice(1).join("+")} vs ${S}`);

  // ── one-time increase ──
  const one = need(/One-Time Increase Round[\s\S]*?Next BRK round: ([^\n]*)/, "one-time increase round");
  const oneCount = need(/(\d+) sts \((\d+) ribs\): right back (\d+) sts[^,]*, right sleeve (\d+) sts[^,]*, front (\d+) sts[^,]*, left sleeve (\d+) sts[^,]*, left back (\d+) sts/, "one-time stitch counts");
  let onetimeRound = NaN;
  if (one) {
    R += 1; onetimeRound = R; ok(odd(R), "one-time increase round is a BRK round", `round ${R}`);
    S += delta(one[1]); R += 1; // + its BRP round
    if (oneCount) {
      ok(S === num(oneCount[1]), "stitch count after the one-time increase", `knitted ${S}, printed ${oneCount[1]}`);
      ok([3, 4, 5, 6, 7].reduce((a, i) => a + num(oneCount[i]), 0) === num(oneCount[1]), "one-time sections add up", oneCount[0].slice(0, 60));
    }
  }

  // ── raglan blocks ──
  const chevronRounds = [];
  let blockLen = NaN;
  const yokeA = after("Raglan Increases and Chevron");
  const plainSec = yokeA.match(/\*\*Round 1 \(BRK round\)\n\s*([^\n]*)[\s\S]*?Work rounds 2–(\d+) in brioche\.[\s\S]*?(?:Repeat \*\* to \*\* a total of (\d+) times|Work \*\* to \*\* once)/);
  const chevSec = need(/Raglan Increases \d+ onward — with chevron[\s\S]*?You will repeat them (\d+) times\.[\s\S]*?i\. ([^\n]*)\n[\s\S]*?iii\. ([^\n]*)\n[\s\S]*?Work rounds 2–(\d+) in brioche\.\*\*\s*\n\s*Repeat \*\* to \*\* a total of (\d+) times/, "raglan + chevron section");
  const chevronDelta = 0; // chevron shape: 2 brioche decreases + brk4st on centre rib = 0 (verified below)
  const chevSteps = need(/ii\. Work a chevron shape:\n([\s\S]*?)\n\s*iii\./, "chevron steps");
  if (chevSteps) ok(delta(chevSteps[1].replace(/Use X and Y[^\n]*\n/, "")) === 0, "chevron shape is stitch-neutral", `delta ${delta(chevSteps[1])}`);
  if (plainSec && plainSec.index < (yokeA.indexOf("onward — with chevron") >>> 0)) {
    const reps = plainSec[3] ? num(plainSec[3]) : 1;
    blockLen = num(plainSec[2]);
    const d = delta(plainSec[1]);
    for (let k = 0; k < reps; k++) { R += 1; ok(odd(R), "raglan increase round is a BRK round", `round ${R}`); S += d; R += blockLen - 1; }
  }
  if (chevSec) {
    const reps = num(chevSec[1]); ok(reps === num(chevSec[5]), "chevron raglan repeats stated twice agree", `${chevSec[1]} vs ${chevSec[5]}`);
    if (Number.isNaN(blockLen)) blockLen = num(chevSec[4]); else ok(blockLen === num(chevSec[4]), "block length is the same in all raglan sections", `${blockLen} vs ${chevSec[4]}`);
    const d = delta(chevSec[2]) + chevronDelta + delta(chevSec[3]);
    for (let k = 0; k < reps; k++) { R += 1; ok(odd(R), "raglan + chevron round is a BRK round", `round ${R}`); chevronRounds.push(R); S += d; R += blockLen - 1; }
  }
  // ── light raglan round ──
  const light = need(/Light Raglan Round\n[\s\S]*?i\. ([^\n]*)\n[\s\S]*?iii\. ([^\n]*)\n[\s\S]*?Work rounds 2–(\d+) in brioche\./, "light raglan round");
  if (light) {
    R += 1; ok(odd(R), "light raglan round is a BRK round", `round ${R}`); chevronRounds.push(R);
    S += delta(light[1]) + delta(light[2]); ok(num(light[3]) === blockLen, "light block has the same length", `${light[3]} vs ${blockLen}`); R += num(light[3]) - 1;
  }
  // ── transition: body-only increases OR chevron before dividing ──
  const bodyOnly = t.match(/Body-Only Increases\n\s*Remove markers[\s\S]*?i\. ([^\n]*)\n[\s\S]*?iii\. ([^\n]*)\n[\s\S]*?Work rounds 2–(\d+) in brioche\./);
  const cbd = t.match(/Chevron Before Dividing\n\s*Round 1 \(BRK round\)[\s\S]*?Round 2: work a BRP round\./);
  if (bodyOnly) { R += 1; ok(odd(R), "body-only round is a BRK round", `round ${R}`); chevronRounds.push(R); S += delta(bodyOnly[1]) + delta(bodyOnly[2]); R += num(bodyOnly[3]) - 1; }
  else if (cbd) { R += 1; ok(odd(R), "chevron-before-dividing round is a BRK round", `round ${R}`); chevronRounds.push(R); R += 1; }
  else notUnderstood.push("transition (body-only increases / chevron before dividing)");
  ok(!(bodyOnly && cbd), "only one transition section is shown");

  // ── divide ──
  const div = need(/divide for the body and sleeves:\n[\s\S]*?right back's (\d+) sts[\s\S]*?cast on (\d+) sts for the underarm[\s\S]*?Slip the next (\d+) sts[\s\S]*?front's (\d+) sts[\s\S]*?Cable cast on (\d+) sts[\s\S]*?left sleeve's (\d+) sts[\s\S]*?left back's (\d+) sts[\s\S]*?Stitch count\s+(\d+) sts on the needle for the body/, "dividing round");
  let divideRound = NaN, held = NaN, UA = NaN;
  if (div) {
    R += 1; divideRound = R; ok(odd(R), "dividing round is a BRK round", `round ${R}`);
    const [rb, ua1, rs, fr, ua2, ls, lb, body] = div.slice(1, 9).map(num);
    held = rs; UA = ua1;
    ok(rb + rs + fr + ls + lb === S, "stitches before the divide = yoke stitch count", `${rb}+${rs}+${fr}+${ls}+${lb} = ${rb + rs + fr + ls + lb}, knitted ${S}`);
    ok(rs === ls, "both sleeves have the same stitches", `${rs} / ${ls}`);
    ok(ua1 === ua2, "both underarm cast-ons equal", `${ua1} / ${ua2}`);
    ok(ua1 >= 4, "underarm cast-on at least 4 sts", `${ua1}`);
    ok(rb + fr + lb + ua1 + ua2 === body, "body stitch count = backs + front + 2 underarm cast-ons", `knitted ${rb + fr + lb + ua1 + ua2}, printed ${body}`);
    R += 1; // BRP round completing the divide
  }
  const yokeRounds = divideRound - onetimeRound;
  const printedArmhole = t.match(/Yoke depth \/ armhole depth[\s\S]*?(\d+(?:\.\d+)?) cm/);
  if (printedArmhole) ok(Math.abs(cm(yokeRounds) - num(printedArmhole[1])) <= 0.05, "armhole depth printed = rounds knitted (one-time increase round → divide)", `${yokeRounds} rounds = ${cm(yokeRounds)} cm, printed ${printedArmhole[1]} cm`);
  else notUnderstood.push("printed armhole depth (finished measurements)");

  // ── body ──
  const lead = need(/Work (\d+) more rounds in brioche before beginning the chevron repeats/, "body lead-in");
  if (lead) R += num(lead[1]);
  const body = need(/Body — Chevron Repeats\n[\s\S]*?Work rounds 2–(\d+) in brioche\.\*\*\s*\n\s*Repeat \*\* to \*\* a total of (\d+) times/, "body chevron repeats");
  let bodyChevronRounds = 0;
  if (body) {
    ok(num(body[1]) === blockLen, "body block length = yoke block length", `${body[1]} vs ${blockLen}`);
    for (let k = 0; k < num(body[2]); k++) { R += 1; ok(odd(R), "body chevron round is a BRK round", `round ${R}`); chevronRounds.push(R); R += num(body[1]) - 1; bodyChevronRounds++; }
  }
  for (let i = 1; i < chevronRounds.length; i++) {
    const gap = chevronRounds[i] - chevronRounds[i - 1];
    if (gap !== blockLen) { ok(false, "chevron rounds exactly one block apart", `rounds ${chevronRounds[i - 1]} → ${chevronRounds[i]} = ${gap}, block ${blockLen}`); break; }
    if (i === chevronRounds.length - 1) ok(true, "chevron rounds exactly one block apart", `${chevronRounds.length} chevrons`);
  }
  const bodyMeasure = t.match(/The body should now measure approximately (\d+(?:\.\d+)?) cm from the underarm cast-on/);
  if (bodyMeasure) {
    const rounds = R - divideRound + 1;
    const diff = Math.abs(cm(rounds) - num(bodyMeasure[1]));
    checks.push({ ok: diff <= 0.5, warn: true, what: "body length below the underarm printed ≈ rounds knitted", detail: `${rounds} rounds = ${cm(rounds)} cm, printed ${bodyMeasure[1]} cm` });
  }
  const hem = need(/Work (\d+) rounds \((\d+(?:\.\d+)?) cm\) in honeycomb brioche/, "hem");
  if (hem) { ok(num(hem[1]) % 2 === 0, "hem ends on a BRP round (even count)", hem[1]); R += num(hem[1]); }
  const printedBody = t.match(/Body length, measured from the mid-back below the funnel neck to the end of hem[\s\S]*?(\d+(?:\.\d+)?) cm/);
  if (printedBody) {
    const rounds = R - onetimeRound + 1;
    ok(Math.abs(cm(rounds) - num(printedBody[1])) <= 0.05, "body length printed (b) = rounds knitted (one-time increase round → end of hem)", `${rounds} rounds = ${cm(rounds)} cm, printed ${printedBody[1]} cm`);
  } else notUnderstood.push("printed body length b (finished measurements)");

  // ── sleeve ──
  const slStart = after("Right sleeve: starting the sleeve");
  const sHeld = need(/Slip the right sleeve's (\d+) sts/, "sleeve held sts", slStart);
  if (sHeld) ok(num(sHeld[1]) === held, "sleeve sts from the holder = sleeve sts put on hold", `${sHeld[1]} vs ${held}`);
  const pk1 = need(/Pick up and knit (\d+) sts from the underarm cast-on edge/, "sleeve pick-up (first half)", slStart);
  const pk2 = slStart.match(/Pick up and knit (\d+) sts from the rest of the underarm cast-on edge/);
  const r1 = need(/Stitch count\s+(\d+) sts \(/, "sleeve set-up round A stitch count", slStart);
  let SS = NaN, SR = 2;
  if (pk1 && r1) {
    const a = num(pk1[1]), b = pk2 ? num(pk2[1]) : 0;
    ok(a + b === UA, "underarm pick-up = underarm cast-on", `${a}+${b} vs ${UA}`);
    ok(a % 2 === 0 && b % 2 === 0 && b >= 2, "pick-up halves even, at least 2 sts after the right corner", `${a} / ${b}`);
    SS = held + a + b + 2; ok(SS === num(r1[1]), "sleeve set-up round A stitch count", `knitted ${SS}, printed ${r1[1]}`);
  }
  const rb = need(/Set up Round B \(BRP round\), closing the corners\s*\n([\s\S]*?)Stitch count[^\n]*?(\d+) sts \((\d+) ribs\)/, "sleeve set-up round B", slStart);
  if (rb) {
    const body = rb[1];
    if (/Variant/.test(body)) notUnderstood.push("sleeve set-up round B still has variants");
    const d = delta(body.split(/Variant B/)[0]);
    SS += d; ok(SS === num(rb[2]), "sleeve set-up round B stitch count", `knitted ${SS}, printed ${rb[2]}`);
  }
  // motif
  const WORDS = { once: 1, twice: 2 };
  const mot = need(/You will work the sleeve motif (once|twice|(\d+) times)/, "sleeve motif count");
  if (/time\(s\)/.test(t)) notUnderstood.push("'time(s)' wording still in the pattern");
  const motifRounds = [...t.matchAll(/Round (1|7|21|27) \(BRK\): ([^\n]*)/g)];
  ok(motifRounds.length === 4, "4 motif shaping rounds found", `${motifRounds.length}`);
  motifRounds.forEach((m) => ok(delta(m[2]) === 0, `motif round ${m[1]} is stitch-neutral`, `delta ${delta(m[2])}`));
  const decAll = /Round 39 is a sleeve decrease round in every motif/.test(t);
  const decOnly = t.match(/Round 39 is a sleeve decrease round in motif No ([\d ,and]+?) only/);
  const r39 = t.match(/Round 39 \(BRK\), sleeve decrease: ([^\n]*)/);
  const nMot = mot ? (WORDS[mot[1]] || num(mot[2])) : NaN;
  let nDec = 0;
  if (decAll) nDec = nMot; else if (decOnly) nDec = decOnly[1].split(/,|and/).filter((x) => x.trim()).length;
  if (r39) SS += nDec * delta(r39[1].replace(/— \d+ sts decreased\./, ""));
  SR = 2 + 40 * nMot; // absolute sleeve round, tracked internally; the pattern numbers each section from 1 (2026-10-27)
  const worked = need(/You have worked the motif (once|twice|(\d+) times)\./, "motifs worked");
  if (worked) ok((WORDS[worked[1]] || num(worked[2])) === nMot, "motifs worked = motifs announced", `${worked[1]} vs ${nMot}`);
  const afterMot = need(/You have worked the motif [^\n]*\n\s*Stitch count\s+(\d+) sts/, "stitch count after motifs");
  if (afterMot) ok(SS === num(afterMot[1]), "stitch count after the motifs", `knitted ${SS}, printed ${afterMot[1]}`);
  // every section from here starts on a BRK round: absolute round SR+1 must be odd
  const secStart = (name) => ok(odd(SR + 1), `${name} starts on a BRK round`, `absolute round ${SR + 1}`);
  const plain = t.match(/Rounds 1–(\d+): work in brioche\./);
  if (plain) { secStart("plain rounds"); ok(num(plain[1]) % 2 === 0, "plain rounds: even count (next section starts on BRK)", plain[1]); SR += num(plain[1]); }
  const two = need(/Final decreases\n\s*Rounds 1–2: work in brioche\./, "final decreases: rounds 1–2");
  if (two) { secStart("final decreases"); }
  const secBase = SR; if (two) SR += 2;
  const extra = t.match(/Round 3 \(BRK\), sleeve decrease: work as round 39 of the motif — 4 sts decreased\. Rounds 4–6: work in brioche\./);
  if (extra) { SR += 1; ok(odd(SR - secBase) && odd(SR), "extra sleeve decrease is a BRK round", `section round ${SR - secBase}`); SS -= 4; SR += 3; }
  const fin = need(/Round (\d+) \(BRK\), final decrease round: ([^\n]*)/, "final decrease round");
  if (fin) {
    SR += 1; ok(num(fin[1]) === SR - secBase && odd(SR), "final decrease round number (BRK, section-relative)", `printed ${fin[1]}, knitted section round ${SR - secBase}`);
    SS += delta(fin[2].replace(/— \d+ sts decreased\./, ""));
  }
  const brp = need(/Round (\d+) \(BRP\): work a BRP round\./, "BRP round after the final decrease");
  if (brp) { SR += 1; ok(num(brp[1]) === SR - secBase && !odd(SR), "BRP round after the final decrease", `printed ${brp[1]}, knitted section round ${SR - secBase}`); }
  const finCount = need(/work a BRP round\.\n\s*Stitch count\s+(\d+) sts/, "stitch count after the final decrease");
  if (finCount) ok(SS === num(finCount[1]), "stitch count after the final decrease", `knitted ${SS}, printed ${finCount[1]}`);
  const cuff = need(/Work (\d+) rounds \((\d+(?:\.\d+)?) cm\) in half-twisted rib:/, "cuff");
  if (cuff) {
    secStart("cuff");
    const r2 = t.match(/Rounds 2–(\d+): \*k1 tbl, p1\*/);
    ok(!!/Round 1: \*k1 \(the slipped stitch together with its yarnover\), p1\*/.test(t), "cuff round 1 closes the yarnovers");
    if (r2) ok(num(r2[1]) === num(cuff[1]), "cuff rounds 2–N end at the cuff count", `${r2[1]} vs ${cuff[1]}`); else notUnderstood.push("cuff rounds 2–N");
    SR += num(cuff[1]);
  }
  const slen = need(/The sleeve measures approximately (\d+(?:\.\d+)?) cm from the underarm/, "sleeve length");
  if (slen) ok(Math.abs(cm(SR) - num(slen[1])) <= 0.05, "sleeve length printed = rounds knitted", `${SR} rounds = ${cm(SR)} cm, printed ${slen[1]} cm`);

  const failed = checks.filter((c) => !c.ok && !c.warn);
  return { ok: failed.length === 0 && notUnderstood.length === 0, checks, failed, warnings: checks.filter((c) => !c.ok && c.warn), notUnderstood };
}
