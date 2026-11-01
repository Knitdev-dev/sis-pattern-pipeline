// @ts-nocheck
// Automatic pre-test checks -- 2026-11-01
//
// Runs every morning (and can be run by hand from the Trigger.dev dashboard:
// task "pretest-checks" -> Test). It never creates an order, never emails a
// customer and never writes anything: it only READS the live Tally form and
// calls the calculator / validator / formatter Workers with fixed sample
// sizes, then knits the brioche result with the simulator.
//
// It emails Yulia ONLY when something is wrong ("Pre-test checks FAILED").
//
// What it catches:
//   1. Tally drift   -- a question title / field name / option the pipeline
//                       reads has been renamed or removed in the live form.
//   2. Routing       -- a brioche and a raglan sample answer go through the
//                       same field extraction + routing code as real orders.
//   3. Brioche chain -- calculator -> validator -> formatter (live KV
//                       template) -> knitting simulator, two sizes.
//   4. TDCR chain    -- calculator -> validator -> formatter (live KV
//                       template), two sizes, no leftover [placeholders].
//   5. preview-api   -- answers (an unknown id must give 404, not 500).

import { schedules, logger } from "@trigger.dev/sdk";
import { Resend } from "resend";
import { simulate } from "./brioche-simulator";
import { extractTallyFields, isTdcrOrder } from "./sis-pipeline";

const TALLY_FORM_URL = "https://tally.so/r/RGRXVK";

// Every label the pipeline maps (extractTallyFields) for brioche + raglan.
// A pair means "either spelling is fine" (title or input name).
const REQUIRED_LABELS: Array<string | string[]> = [
  "Garment_type",
  "Bust/chest measurement (cm)",
  "Stitches per 10 cm",
  "Rows per 10 cm",
  "Ease/fit preference",
  "Length preference",
  "Sleeve_length_cm",
  ["Body length (cm)", "Body_length_cm"],
  "Upper_arm_cm",
  "Armhole depth (cm)",
];
// Option texts the routing / calculators depend on.
const REQUIRED_OPTIONS = ["raglan", "brioche", "close", "relaxed", "oversized", "cropped", "standard", "long"];

const BRIOCHE_SIZES = [
  { bust_cm: 97, upper_arm_cm: 35, neck_cm: 56, armhole_cm: 25.5, body_length_cm: 60, sleeve_length_cm: 43, gauge_sts: 14, gauge_rows: 40, fit: "relaxed" },
  { bust_cm: 140, upper_arm_cm: 45, neck_cm: 56, armhole_cm: 28, body_length_cm: 66, sleeve_length_cm: 46, gauge_sts: 18, gauge_rows: 44, fit: "close" },
];
const TDCR_SIZES = [
  { bust_cm: 97, gauge_sts: 22, gauge_rows: 30, ease_preference: "relaxed", length_preference: "standard", sleeve_length_cm: 45 },
  { bust_cm: 140, gauge_sts: 18, gauge_rows: 26, ease_preference: "oversized", length_preference: "long", sleeve_length_cm: 47 },
];

async function callWorker(url: string, apiKey: string, body: object) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain", "X-API-Key": apiKey }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) return { error: `HTTP ${r.status}: ${text.slice(0, 300)}` };
    try { return { data: JSON.parse(text) }; } catch { return { error: "not JSON: " + text.slice(0, 200) }; }
  } catch (e: any) { return { error: e.message }; }
}

const leftovers = (html: string) => (html.match(/\[[a-z][a-z0-9_]*\]/g) || []).slice(0, 10);

export const pretestChecks = schedules.task({
  id: "pretest-checks",
  cron: "17 5 * * *", // 05:17 UTC = 06:17 Paris (winter)
  maxDuration: 600,
  run: async () => {
    const problems: string[] = [];
    const passed: string[] = [];
    const ok = (cond: boolean, what: string, detail = "") => (cond ? passed : problems).push(cond ? what : `${what}${detail ? " — " + detail : ""}`);

    // ── 1. Tally drift ──────────────────────────────────────────────
    try {
      const r = await fetch(TALLY_FORM_URL, { headers: { "User-Agent": "knitpage-pretest" } });
      const page = await r.text();
      ok(r.ok, "Tally form loads", `HTTP ${r.status}`);
      if (r.ok) {
        for (const l of REQUIRED_LABELS) {
          const alts = Array.isArray(l) ? l : [l];
          ok(alts.some((a) => page.includes(a)), `Tally label "${alts.join('" or "')}"`, "not found in the live form");
        }
        const low = page.toLowerCase();
        for (const o of REQUIRED_OPTIONS) ok(low.includes(o), `Tally option text "${o}"`, "not found in the live form");
      }
    } catch (e: any) { ok(false, "Tally form loads", e.message); }

    // ── 2. Routing (same code as real orders) ──────────────────────
    const fakeTally = (garment: string, extra: Record<string, any>) => ({
      data: { fields: [
        { label: "Garment_type", type: "MULTIPLE_CHOICE", value: ["g"], options: [{ id: "g", text: garment }] },
        { label: "Bust/chest measurement (cm)", type: "INPUT_NUMBER", value: 97 },
        { label: "Stitches per 10 cm", type: "INPUT_NUMBER", value: 14 },
        { label: "Rows per 10 cm", type: "INPUT_NUMBER", value: 40 },
        { label: "Ease/fit preference", type: "DROPDOWN", value: ["e"], options: [{ id: "e", text: "relaxed" }] },
        { label: "Sleeve_length_cm", type: "INPUT_NUMBER", value: 43 },
        { label: "Email_address", type: "INPUT_EMAIL", value: "test@example.com" },
        ...Object.entries(extra).map(([label, value]) => ({ label, type: "INPUT_NUMBER", value })),
      ] },
    });
    const b = extractTallyFields(fakeTally("brioche pullover (top-down, funnel neck)", { Upper_arm_cm: 35, "Armhole depth (cm)": 25.5, Body_length_cm: 60 }) as any);
    ok(!b.error && b.garment_type?.includes("brioche") && !isTdcrOrder(b, true), "Routing: brioche sample → brioche", b.error || JSON.stringify(b).slice(0, 200));
    const t = extractTallyFields({ data: { fields: [...fakeTally("top-down raglan sweater (stockinette, round neck)", {}).data.fields,
      { label: "Length preference", type: "DROPDOWN", value: ["l"], options: [{ id: "l", text: "standard" }] }] } } as any);
    ok(!t.error && isTdcrOrder(t, false), "Routing: raglan sample → TDCR (no construction answer needed)", t.error || JSON.stringify(t).slice(0, 200));

    // ── 3. Brioche chain ────────────────────────────────────────────
    for (const s of BRIOCHE_SIZES) {
      const tag = `Brioche ${s.bust_cm} cm`;
      const c = await callWorker(process.env.BRIOCHE_CALCULATOR_URL!, process.env.BRIOCHE_CALCULATOR_API_KEY!, s);
      if (c.error || c.data?.error || c.data?.ok === false) { ok(false, `${tag}: calculator`, c.error || c.data?.error || "ok:false"); continue; }
      const v = await callWorker(process.env.BRIOCHE_VALIDATOR_URL!, process.env.BRIOCHE_VALIDATOR_API_KEY!, c.data);
      ok(!v.error && v.data?.pass, `${tag}: validator`, v.error || JSON.stringify(v.data?.failed).slice(0, 300));
      const f = await callWorker(process.env.BRIOCHE_FORMATTER_URL!, process.env.BRIOCHE_FORMATTER_API_KEY!, { calcJson: c.data, template_key: "brioche_pattern_template" });
      if (f.error || !f.data?.ok) { ok(false, `${tag}: formatter`, f.error || f.data?.error || "ok:false"); continue; }
      ok(leftovers(f.data.html).length === 0, `${tag}: no leftover [placeholders]`, leftovers(f.data.html).join(" "));
      try {
        const sim = simulate(f.data.html);
        const bad = [...sim.failed.map((x: any) => `${x.what}: ${x.detail}`), ...sim.notUnderstood.map((x: string) => `not understood: ${x}`)];
        ok(bad.length === 0, `${tag}: knitting simulator (${sim.checks.length} checks)`, bad.slice(0, 8).join(" | "));
      } catch (e: any) { ok(false, `${tag}: knitting simulator`, `crashed: ${e.message}`); }
    }

    // ── 4. TDCR chain ───────────────────────────────────────────────
    for (const s of TDCR_SIZES) {
      const tag = `TDCR ${s.bust_cm} cm`;
      const c = await callWorker(process.env.TDCR_CALCULATOR_URL!, process.env.TDCR_CALCULATOR_API_KEY!, s);
      if (c.error || c.data?.error || c.data?.calculation_error) { ok(false, `${tag}: calculator`, c.error || c.data?.error || "calculation_error"); continue; }
      const v = await callWorker(process.env.TDCR_VALIDATOR_URL!, process.env.TDCR_VALIDATOR_API_KEY!, c.data);
      ok(!v.error && v.data?.pass, `${tag}: validator`, v.error || JSON.stringify(v.data?.failed).slice(0, 300));
      const f = await callWorker(process.env.BRIOCHE_FORMATTER_URL!, process.env.BRIOCHE_FORMATTER_API_KEY!, { calcJson: c.data, template_key: "tdcr_pattern_template" });
      if (f.error || !f.data?.ok) { ok(false, `${tag}: formatter`, f.error || f.data?.error || "ok:false"); continue; }
      ok(leftovers(f.data.html).length === 0, `${tag}: no leftover [placeholders]`, leftovers(f.data.html).join(" "));
    }

    // ── 5. preview-api answers ──────────────────────────────────────
    try {
      const r = await fetch(process.env.PREVIEW_API_URL! + "/api/preview?id=pretestcheck0");
      ok(r.status === 404 || r.status === 400, "preview-api answers (unknown id → 404)", `HTTP ${r.status}`);
    } catch (e: any) { ok(false, "preview-api answers", e.message); }

    logger.log("Pre-test checks", { passed: passed.length, problems });

    if (problems.length) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.FROM_EMAIL!,
        to: [process.env.ADMIN_EMAIL!],
        subject: `Pre-test checks FAILED (${problems.length})`,
        html: `<h2>Pre-test checks: ${problems.length} problem(s)</h2><ul>${problems.map((p) => `<li>❌ ${p.replace(/</g, "&lt;")}</li>`).join("")}</ul>`
          + `<p>${passed.length} checks passed. Nothing was ordered or sent to customers.</p>`,
      });
    }
    return { ok: problems.length === 0, passed: passed.length, problems };
  },
});
