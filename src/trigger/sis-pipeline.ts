import { task, logger, wait } from "@trigger.dev/sdk";
import { Resend } from "resend";

// ── Types ────────────────────────────────────────────────────────────

// TDCR payload uses the same Tally-extractor field format as SIS
// (Bust_cm, Gauge_st, Gauge_row, etc.). Translation to the lowercase
// names the TDCR calculator expects happens inside the task.
interface TdcrPayload {
  email?: string;
  Bust_cm: number;
  Gauge_st: number;
  Gauge_row: number;
  Ease_preference: string;
  Length_preference: string;
  Sleeve_length_cm: number;
  construction_method?: string;
}

interface SisPayload {
  email?: string;
  Bust_cm: number;
  Gauge_st: number;
  Gauge_row: number;
  Ease_preference: string;
  Length_preference: string;
  Front_neck_depth_for_V_cm: number;
  Sleeve_length_cm: number;
  construction_method?: string;
  special_details?: string;
  Variant?: string;
}

// Cardigan reuses every SIS input. Variant must be "cardigan".
// No new fields in V1; future versions may add Front_band_width_cm.
interface CardiganPayload extends SisPayload {
  garment_type?: string;
}

interface TallyWebhookPayload {
  data: {
    fields: Array<{
      label: string;
      type: string;
      value: any;
    }>;
  };
}

// ── SIS pipeline task ────────────────────────────────────────────────

export const sisPipelineTask = task({
  id: "sis-pipeline",
  maxDuration: 1800,
  retry: { maxAttempts: 2 },

  run: async (payload: SisPayload, { ctx }) => {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const adminEmail = process.env.ADMIN_EMAIL!;
    const fromEmail = process.env.FROM_EMAIL!;
    const appUrl = process.env.APP_URL!;

    logger.log("SIS pipeline started", {
      bust: payload.Bust_cm,
      email: payload.email,
      runId: ctx.run.id,
    });

    // ── Pre-flight: gauge sanity check ────────────────────────────
    // If row gauge is suspiciously low relative to stitch gauge, the
    // customer has likely swapped sts and rows. Fire a friendly email
    // and exit before consuming a calculator attempt.
    const gaugeRatio = payload.Gauge_row / payload.Gauge_st;
    if (gaugeRatio < 0.75) {
      if (payload.email) {
        await resend.emails.send({
          from: fromEmail,
          to: [payload.email],
          subject: "Pattern generation failed — please check your gauge",
          html: `
            <p>Hi,</p>
            <p>We were unable to generate your pattern because your gauge looks unusual: you entered <strong>${payload.Gauge_st} stitches</strong> and <strong>${payload.Gauge_row} rows</strong> per 10 cm.</p>
            <p>For most knitting, row gauge is higher than stitch gauge (e.g. 20 sts × 28 rows). It looks like your stitch and row gauge may have been entered the wrong way round.</p>
            <p>Please re-measure your swatch and re-submit. If you're not sure how to measure, count the <strong>stitches across</strong> your swatch for stitch gauge, and the <strong>rows up</strong> for row gauge.</p>
            <p>We have not charged you for this submission.</p>
            <p><a href="${process.env.TALLY_FORM_URL || appUrl}">Re-submit your measurements →</a></p>
            <p>If you have any questions, simply reply to this email.</p>
          `,
        });
        logger.log("Gauge-sanity resubmit email sent to customer", { to: payload.email });
      }
      await resend.emails.send({
        from: fromEmail,
        to: [adminEmail],
        subject: `ℹ️ SIS pre-flight — gauge looks swapped — ${payload.email || "no email"}`,
        html: `
          <p>Customer likely swapped stitch/row gauge. Friendly resubmit email sent.</p>
          <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · Gauge ${payload.Gauge_st} sts / ${payload.Gauge_row} rows · ratio ${gaugeRatio.toFixed(2)}</p>
          <p><strong>Run ID:</strong> ${ctx.run.id}</p>
        `,
      });
      return { status: "user_input_error", reason: "gauge_possibly_swapped" };
    }

    // ── Steps 1 & 2: Calculator + Validator (with retry) ──────────
    let calcJson: any;
    let validation: any;

    for (let attempt = 1; attempt <= 3; attempt++) {
      logger.log(`Calculator attempt ${attempt}...`);
      const calcResult = await callWorker(
        process.env.CALCULATOR_URL!,
        process.env.CALCULATOR_API_KEY!,
        payload
      );

      if (calcResult.error || calcResult.data?.error) {
        const msg = calcResult.error || calcResult.data?.error;
        const incompatibility = calcResult.data?.incompatibility;

        logger.error(`Calculator attempt ${attempt} failed`, { msg, incompatibility });

        // ── User-input error: V-neck too shallow for gauge ─────────
        // Deterministic — retrying won't change the answer. Send the
        // customer a friendly resubmit email and exit cleanly.
        if (incompatibility === "v_neck_too_shallow") {
          if (payload.email) {
            await resend.emails.send({
              from: fromEmail,
              to: [payload.email],
              subject: "Pattern generation failed — V-neck depth too shallow for your gauge",
              html: `
                <p>Hi,</p>
                <p>Unfortunately we were unable to generate your pattern. Your V-neck depth of <strong>${payload.Front_neck_depth_for_V_cm} cm</strong> is too shallow for your gauge (<strong>${payload.Gauge_st} sts / ${payload.Gauge_row} rows per 10 cm</strong>): the neck shaping would need to start before the armhole shaping has finished, which produces an invalid shaping schedule.</p>
                <p>Please re-submit with a V-neck depth of at least <strong>18 cm</strong>. If you are unsure, a depth of 18–22 cm works reliably across all sizes and gauges.</p>
                <p>We have not charged you for this submission.</p>
                <p><a href="${process.env.TALLY_FORM_URL || appUrl}">Re-submit your measurements →</a></p>
                <p>If you have any questions, simply reply to this email.</p>
              `,
            });
            logger.log("V-neck-too-shallow resubmit email sent to customer", { to: payload.email });
          }
          // Quiet admin notice — not a system alert, just a record.
          await resend.emails.send({
            from: fromEmail,
            to: [adminEmail],
            subject: `ℹ️ SIS user-input error — V-neck too shallow — ${payload.email || "no email"}`,
            html: `
              <p>Customer hit the V-neck-too-shallow guard. Friendly resubmit email sent automatically.</p>
              <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · V ${payload.Front_neck_depth_for_V_cm}cm · Gauge ${payload.Gauge_st}/${payload.Gauge_row} · ${payload.Ease_preference}</p>
              <p><strong>Run ID:</strong> ${ctx.run.id}</p>
            `,
          });
          return { status: "user_input_error", reason: "v_neck_too_shallow" };
        }
// ── Developer-only alerts: flag to admin, no customer email ──
        // YY ≥ 2 and sleeve-too-short are deterministic — retrying won't
        // help. Send a clear admin alert and exit cleanly. Customer
        // gets nothing automated; admin emails them manually.
        if (incompatibility === "v_neck_too_deep_for_fit" || incompatibility === "sleeve_too_short") {
          if (incompatibility === "sleeve_too_short" && payload.email) {
            await resend.emails.send({
              from: fromEmail,
              to: [payload.email],
              subject: "Pattern generation failed — sleeve length too short for your size",
              html: `
                <p>Hi,</p>
                <p>Unfortunately we were unable to generate your pattern. Your sleeve length of <strong>${payload.Sleeve_length_cm} cm</strong> is too short for your size at this gauge: the sleeve increases would need to be worked every other row or faster, which produces an unwearably steep taper.</p>
                <p>Please re-submit with a longer sleeve length. A typical sleeve length for your size is <strong>58–65 cm</strong>.</p>
                <p>We have not charged you for this submission.</p>
                <p><a href="${process.env.TALLY_FORM_URL || appUrl}">Re-submit your measurements →</a></p>
                <p>If you have any questions, simply reply to this email.</p>
              `,
            });
            logger.log("Sleeve-too-short resubmit email sent to customer", { to: payload.email });
          }
          await resend.emails.send({
            from: fromEmail,
            to: [adminEmail],
            subject: `⚠️ SIS calculator user-input error — ${incompatibility} — ${payload.email || "no email"}`,
            html: `
              <h3>Customer hit a calculator guard — manual response needed</h3>
              <p><strong>Incompatibility:</strong> ${incompatibility}</p>
              <p><strong>Calculator message:</strong> ${msg}</p>
              <p><strong>Customer email:</strong> ${payload.email || "(none)"}</p>
              <p><strong>Inputs:</strong></p>
              <ul>
                <li>Bust: ${payload.Bust_cm} cm</li>
                <li>Gauge: ${payload.Gauge_st} sts / ${payload.Gauge_row} rows per 10 cm</li>
                <li>Ease: ${payload.Ease_preference}</li>
                <li>V-neck depth: ${payload.Front_neck_depth_for_V_cm} cm</li>
                <li>Sleeve length: ${payload.Sleeve_length_cm} cm</li>
              </ul>
              <p><strong>Run ID:</strong> ${ctx.run.id}</p>
            `,
          });
          logger.log("Developer-alert sent for user-input error", { incompatibility });
          return { status: "user_input_error", reason: incompatibility };
        }
        if (attempt === 3) {
          await sendAlert(resend, fromEmail, adminEmail, "Calculator error", msg, payload);
          throw new Error(`Calculator failed after 3 attempts: ${msg}`);
        }
        continue;
      }
      calcJson = calcResult.data;
      logger.log(`Calculator attempt ${attempt} complete`, {
        nodes_active: calcJson.decision_path?.nodes_active,
        flags: calcJson.decision_path?.flags,
      });

      logger.log(`Validator attempt ${attempt}...`);
      const validatorResult = await callWorker(
        process.env.VALIDATOR_URL!,
        process.env.VALIDATOR_API_KEY!,
        calcJson
      );

      if (validatorResult.error) {
        await sendAlert(resend, fromEmail, adminEmail, "Validator error", validatorResult.error, payload);
        throw new Error(`Validator failed: ${validatorResult.error}`);
      }

      validation = validatorResult.data;
      logger.log(`Validator attempt ${attempt} complete`, {
        pass: validation.pass,
        failed: validation.failed,
      });

      if (validation.pass) {
        logger.log(`Validation passed on attempt ${attempt}`);
        if (validation.data) {
          calcJson = validation.data;
        }
        break;
      }

      logger.warn(`Validation failed on attempt ${attempt}`, { failed: validation.failed });

      if (attempt === 3) {
        await sendAlert(
          resend, fromEmail, adminEmail,
          "Validation failed after 3 attempts",
          `Failed checks:\n${JSON.stringify(validation.failed, null, 2)}`,
          payload
        );
        if (payload.email) {
          await resend.emails.send({
            from: fromEmail,
            to: [payload.email],
            subject: "Your knitting pattern — we're checking something",
            html: `<p>Thank you for your order. We noticed a small issue with the calculations and our team will review and send your pattern shortly.</p>`,
          });
        }
        return { status: "validation_failed", failed: validation.failed };
      }
    }

    // ── Step 3: Formatter — Pattern HTML ──────────────────────────
    logger.log("Calling formatter /output1...");
    const output1Result = await callWorker(
      process.env.FORMATTER_URL! + "/output1",
      process.env.FORMATTER_API_KEY!,
      calcJson
    );

    if (output1Result.error || !output1Result.data?.output1) {
      const msg = output1Result.error || "No output1 returned";
      await sendAlert(resend, fromEmail, adminEmail, "Formatter output1 error", msg, payload);
      throw new Error(`Formatter output1 failed: ${msg}`);
    }

    const patternHtml = output1Result.data.output1;
    logger.log("Pattern HTML generated", { chars: patternHtml.length });

    // ── Step 4: Formatter — Check Sheet + Log ─────────────────────
    logger.log("Calling formatter /output23...");
    const output23Result = await callWorker(
      process.env.FORMATTER_URL! + "/output23",
      process.env.FORMATTER_API_KEY!,
      calcJson
    );

    const checkSheetHtml = output23Result.data?.output2 || null;
    const calcLog = output23Result.data?.output3 || null;

    if (!checkSheetHtml) {
      logger.warn("Check sheet not generated", { error: output23Result.error });
      await sendAlert(resend, fromEmail, adminEmail, "Check sheet warning", output23Result.error || "No output2", payload);
    }

    // ── Step 5: Convert pattern HTML → PDF ────────────────────────
    logger.log("Converting pattern to PDF...");
    const pdfBuffer = await htmlToPdf(patternHtml);
    logger.log("PDF generated", { bytes: pdfBuffer.byteLength });

    // ── Step 6: Admin approval gate ───────────────────────────────
    logger.log("Sending admin preview for approval...");

    const token = await wait.createToken({
      timeout: "48h",
    });

    const approveUrl = `${appUrl}/approve?tokenId=${token.id}&action=approve`;
    const rejectUrl  = `${appUrl}/approve?tokenId=${token.id}&action=reject`;

    const pdfBase64 = bufferToBase64(pdfBuffer);

    await resend.emails.send({
      from: fromEmail,
      to: [adminEmail],
      subject: `⏳ REVIEW NEEDED — SIS Pattern — ${payload.email || "no email"} — Bust ${payload.Bust_cm}cm`,
      html: `
        <h2>Pattern ready for review</h2>
        <p>A new pattern has been generated. Please review the attached PDF before it is sent to the customer.</p>
        <p><strong>Customer:</strong> ${payload.email || "no email"}</p>
        <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · Gauge ${payload.Gauge_st}st/${payload.Gauge_row}row · ${payload.Ease_preference} · ${payload.Length_preference}</p>
        <p><strong>Nodes active:</strong> ${JSON.stringify(calcJson.decision_path?.nodes_active)}</p>
        <p><strong>Validation warnings:</strong> ${JSON.stringify(validation.warnings || [])}</p>
        <hr>
        <p>
          <a href="${approveUrl}" style="background:#22c55e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;margin-right:12px">
            ✅ Approve — Send to customer
          </a>
          <a href="${rejectUrl}" style="background:#ef4444;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">
            ❌ Reject — Do not send
          </a>
        </p>
        <hr>
        <h3>Calculation Log</h3>
        <pre style="font-size:11px;background:#f5f5f5;padding:12px">${calcLog || "not generated"}</pre>
      `,
      attachments: [
        {
          filename: `pattern-${payload.Bust_cm}cm.pdf`,
          content: pdfBase64,
        },
      ],
    });

    // ── Step 7: Wait for admin approval (up to 48 hours) ──────────
    logger.log("Waiting for admin approval...");
    const approvalResult = await wait.forToken<{ action: string }>(token.id);

    logger.log("Approval result", { result: JSON.stringify(approvalResult) });

    const output = approvalResult.ok ? (approvalResult.output as any) : null;
    const action = output?.data?.action || output?.action;
    if (action !== "approve") {
      logger.log("Pattern rejected or timed out — not sending to customer");
      await resend.emails.send({
        from: fromEmail,
        to: [adminEmail],
        subject: `❌ Pattern NOT sent — ${payload.email || "no email"} — Bust ${payload.Bust_cm}cm`,
        html: `<p>The pattern was <strong>rejected</strong> (or approval timed out) and was <strong>not</strong> sent to the customer.</p>`,
      });
      return { status: "rejected", runId: ctx.run.id };
    }

    logger.log("Pattern approved — sending to customer...");

    // ── Step 8: Send pattern PDF to customer ──────────────────────
    if (payload.email) {
      await resend.emails.send({
        from: fromEmail,
        to: [payload.email],
        subject: "Your personalised knitting pattern is ready 🧶",
        html: `
          <p>Hello,</p>
          <p>Thank you for your order. Your personalised set-in sleeve sweater pattern is attached as a PDF.</p>
          <p>If you have any questions, simply reply to this email.</p>
          <p>Happy knitting!</p>
        `,
        attachments: [
          {
            filename: `your-sweater-pattern.pdf`,
            content: pdfBase64,
          },
        ],
      });
      logger.log("Pattern PDF sent to customer", { to: payload.email });
    }

    // ── Step 9: Send admin confirmation copy ──────────────────────
    await resend.emails.send({
      from: fromEmail,
      to: [adminEmail],
      subject: `✅ Pattern SENT — ${payload.email || "no email"} — Bust ${payload.Bust_cm}cm`,
      html: `
        <h2>Pattern sent successfully</h2>
        <p><strong>Run ID:</strong> ${ctx.run.id}</p>
        <p><strong>Customer:</strong> ${payload.email || "no email"}</p>
        <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · Gauge ${payload.Gauge_st}st/${payload.Gauge_row}row · ${payload.Ease_preference} · ${payload.Length_preference}</p>
        <p><strong>Nodes active:</strong> ${JSON.stringify(calcJson.decision_path?.nodes_active)}</p>
        <p><strong>Validation warnings:</strong> ${JSON.stringify(validation.warnings || [])}</p>
        <hr>
        <h3>Calculation Log</h3>
        <pre style="font-size:11px;background:#f5f5f5;padding:12px">${calcLog || "not generated"}</pre>
      `,
      attachments: [
        {
          filename: `pattern-${payload.Bust_cm}cm.pdf`,
          content: pdfBase64,
        },
      ],
    });

    logger.log("Pipeline complete ✅");
    return { status: "success", runId: ctx.run.id };
  },
});

// ── SIS Cardigan pipeline task ──────────────────────────────────────

export const sisCardiganPipelineTask = task({
  id: "sis-cardigan-pipeline",
  maxDuration: 1800,
  retry: { maxAttempts: 2 },

  run: async (payload: SisPayload /* CardiganPayload */, { ctx }) => {
    // Defensive: ensure Variant is set. tallyWebhookTask should have set
    // it already, but if this task is triggered directly (e.g. from a
    // manual retry), guarantee correctness here.
    payload.Variant = "cardigan";

    const resend = new Resend(process.env.RESEND_API_KEY);
    const adminEmail = process.env.ADMIN_EMAIL!;
    const fromEmail = process.env.FROM_EMAIL!;
    const appUrl = process.env.APP_URL!;

    logger.log("SIS-Cardigan pipeline started", {
      bust: payload.Bust_cm,
      email: payload.email,
      runId: ctx.run.id,
    });

    // ── Pre-flight: gauge sanity check ────────────────────────────
    const gaugeRatio = payload.Gauge_row / payload.Gauge_st;
    if (gaugeRatio < 0.75) {
      if (payload.email) {
        await resend.emails.send({
          from: fromEmail,
          to: [payload.email],
          subject: "Pattern generation failed — please check your gauge",
          html: `
            <p>Hi,</p>
            <p>We were unable to generate your pattern because your gauge looks unusual: you entered <strong>${payload.Gauge_st} stitches</strong> and <strong>${payload.Gauge_row} rows</strong> per 10 cm.</p>
            <p>For most knitting, row gauge is higher than stitch gauge (e.g. 20 sts × 28 rows). It looks like your stitch and row gauge may have been entered the wrong way round.</p>
            <p>Please re-measure your swatch and re-submit. If you're not sure how to measure, count the <strong>stitches across</strong> your swatch for stitch gauge, and the <strong>rows up</strong> for row gauge.</p>
            <p>We have not charged you for this submission.</p>
            <p><a href="${process.env.TALLY_FORM_URL || appUrl}">Re-submit your measurements →</a></p>
            <p>If you have any questions, simply reply to this email.</p>
          `,
        });
        logger.log("Gauge-sanity resubmit email sent to customer", { to: payload.email });
      }
      await resend.emails.send({
        from: fromEmail,
        to: [adminEmail],
        subject: `ℹ️ Cardigan pre-flight — gauge looks swapped — ${payload.email || "no email"}`,
        html: `
          <p>Customer likely swapped stitch/row gauge. Friendly resubmit email sent.</p>
          <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · Gauge ${payload.Gauge_st} sts / ${payload.Gauge_row} rows · ratio ${gaugeRatio.toFixed(2)}</p>
          <p><strong>Run ID:</strong> ${ctx.run.id}</p>
        `,
      });
      return { status: "user_input_error", reason: "gauge_possibly_swapped" };
    }

    // ── Steps 1 & 2: Calculator + Validator (with retry) ──────────
    let calcJson: any;
    let validation: any;

    for (let attempt = 1; attempt <= 3; attempt++) {
      logger.log(`Cardigan Calculator attempt ${attempt}...`);
      const calcResult = await callWorker(
        process.env.CALCULATOR_URL!,
        process.env.CALCULATOR_API_KEY!,
        payload
      );

      if (calcResult.error || calcResult.data?.error) {
        const msg = calcResult.error || calcResult.data?.error;
        const incompatibility = calcResult.data?.incompatibility;

        logger.error(`Cardigan Calculator attempt ${attempt} failed`, { msg, incompatibility });

        // ── User-input error: V-neck too shallow for gauge ─────────
        if (incompatibility === "v_neck_too_shallow") {
          if (payload.email) {
            await resend.emails.send({
              from: fromEmail,
              to: [payload.email],
              subject: "Pattern generation failed — V-neck depth too shallow for your gauge",
              html: `
                <p>Hi,</p>
                <p>Unfortunately we were unable to generate your cardigan pattern. Your V-neck depth of <strong>${payload.Front_neck_depth_for_V_cm} cm</strong> is too shallow for your gauge (<strong>${payload.Gauge_st} sts / ${payload.Gauge_row} rows per 10 cm</strong>): the neck shaping would need to start before the armhole shaping has finished, which produces an invalid shaping schedule.</p>
                <p>Please re-submit with a V-neck depth of at least <strong>18 cm</strong>. If you are unsure, a depth of 18–22 cm works reliably across all sizes and gauges.</p>
                <p>We have not charged you for this submission.</p>
                <p><a href="${process.env.TALLY_FORM_URL || appUrl}">Re-submit your measurements →</a></p>
                <p>If you have any questions, simply reply to this email.</p>
              `,
            });
            logger.log("Cardigan V-neck-too-shallow resubmit email sent to customer", { to: payload.email });
          }
          await resend.emails.send({
            from: fromEmail,
            to: [adminEmail],
            subject: `ℹ️ Cardigan user-input error — V-neck too shallow — ${payload.email || "no email"}`,
            html: `
              <p>Customer hit the V-neck-too-shallow guard. Friendly resubmit email sent automatically.</p>
              <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · V ${payload.Front_neck_depth_for_V_cm}cm · Gauge ${payload.Gauge_st}/${payload.Gauge_row} · ${payload.Ease_preference}</p>
              <p><strong>Run ID:</strong> ${ctx.run.id}</p>
            `,
          });
          return { status: "user_input_error", reason: "v_neck_too_shallow" };
        }

        // ── User-input error: Node A path not supported (cardigan v1) ──
        // Deep V-neck where V-split would happen before underarm bind-off.
        // Friendly customer email + admin notice. Deterministic — won't
        // retry.
        if (incompatibility === "cardigan_node_a_unsupported") {
          if (payload.email) {
            await resend.emails.send({
              from: fromEmail,
              to: [payload.email],
              subject: "Pattern generation failed — V-neck depth too deep for cardigan",
              html: `
                <p>Hi,</p>
                <p>Unfortunately we were unable to generate your cardigan pattern. Your V-neck depth of <strong>${payload.Front_neck_depth_for_V_cm} cm</strong> is too deep for your finished length: the V split would need to happen before the armhole shaping starts, which our cardigan pattern generator doesn't yet support.</p>
                <p>Please re-submit with a V-neck depth of <strong>22 cm or less</strong>, or increase the finished length.</p>
                <p>We have not charged you for this submission.</p>
                <p><a href="${process.env.TALLY_FORM_URL || appUrl}">Re-submit your measurements →</a></p>
              `,
            });
            logger.log("Cardigan deep-V resubmit email sent", { to: payload.email });
          }
          await resend.emails.send({
            from: fromEmail,
            to: [adminEmail],
            subject: `ℹ️ Cardigan user-input error — Node A unsupported — ${payload.email || "no email"}`,
            html: `<p>Cardigan rejected for Node A path. Resubmit email sent.</p><p>Run ID: ${ctx.run.id}</p>`,
          });
          return { status: "user_input_error", reason: "cardigan_node_a_unsupported" };
        }

        // ── Developer-only alerts: flag to admin, no customer email ──
        if (incompatibility === "v_neck_too_deep_for_fit" || incompatibility === "sleeve_too_short" || incompatibility === "cardigan_band_too_narrow") {
          if (incompatibility === "sleeve_too_short" && payload.email) {
            await resend.emails.send({
              from: fromEmail,
              to: [payload.email],
              subject: "Pattern generation failed — sleeve length too short for your size",
              html: `
                <p>Hi,</p>
                <p>Unfortunately we were unable to generate your pattern. Your sleeve length of <strong>${payload.Sleeve_length_cm} cm</strong> is too short for your size at this gauge: the sleeve increases would need to be worked every other row or faster, which produces an unwearably steep taper.</p>
                <p>Please re-submit with a longer sleeve length. A typical sleeve length for your size is <strong>58–65 cm</strong>.</p>
                <p>We have not charged you for this submission.</p>
                <p><a href="${process.env.TALLY_FORM_URL || appUrl}">Re-submit your measurements →</a></p>
                <p>If you have any questions, simply reply to this email.</p>
              `,
            });
            logger.log("Sleeve-too-short resubmit email sent to customer", { to: payload.email });
          }
          if (incompatibility === "cardigan_band_too_narrow" && payload.email) {
            await resend.emails.send({
              from: fromEmail,
              to: [payload.email],
              subject: "Pattern generation failed — cardigan band too narrow for your gauge",
              html: `
                <p>Hi,</p>
                <p>Unfortunately we were unable to generate your pattern. Your gauge of <strong>${payload.Gauge_st} sts per 10 cm</strong> produces a front band that is too narrow to accommodate the buttonholes.</p>
                <p>This usually happens with a very fine gauge. Please <a href="${process.env.TALLY_FORM_URL || appUrl}">contact us</a> and we'll help you find the best solution for your yarn.</p>
                <p>We have not charged you for this submission.</p>
              `,
            });
            logger.log("Band-too-narrow resubmit email sent to customer", { to: payload.email });
          }
          await resend.emails.send({
            from: fromEmail,
            to: [adminEmail],
            subject: `⚠️ Cardigan calculator user-input error — ${incompatibility} — ${payload.email || "no email"}`,
            html: `
              <h3>Customer hit a calculator guard — manual response needed</h3>
              <p><strong>Incompatibility:</strong> ${incompatibility}</p>
              <p><strong>Calculator message:</strong> ${msg}</p>
              <p><strong>Customer email:</strong> ${payload.email || "(none)"}</p>
              <p><strong>Inputs:</strong></p>
              <ul>
                <li>Bust: ${payload.Bust_cm} cm</li>
                <li>Gauge: ${payload.Gauge_st} sts / ${payload.Gauge_row} rows per 10 cm</li>
                <li>Ease: ${payload.Ease_preference}</li>
                <li>V-neck depth: ${payload.Front_neck_depth_for_V_cm} cm</li>
                <li>Sleeve length: ${payload.Sleeve_length_cm} cm</li>
              </ul>
              <p><strong>Run ID:</strong> ${ctx.run.id}</p>
            `,
          });
          logger.log("Developer-alert sent for cardigan user-input error", { incompatibility });
          return { status: "user_input_error", reason: incompatibility };
        }

        if (attempt === 3) {
          await sendAlert(resend, fromEmail, adminEmail, "Cardigan Calculator error", msg, payload);
          throw new Error(`Cardigan Calculator failed after 3 attempts: ${msg}`);
        }
        continue;
      }

      calcJson = calcResult.data;
      logger.log(`Cardigan Calculator attempt ${attempt} complete`, {
        nodes_active: calcJson.decision_path?.nodes_active,
        flags: calcJson.decision_path?.flags,
        cardigan_present: !!calcJson.cardigan,
      });

      logger.log(`Cardigan Validator attempt ${attempt}...`);
      const validatorResult = await callWorker(
        process.env.VALIDATOR_URL!,
        process.env.VALIDATOR_API_KEY!,
        calcJson
      );

      if (validatorResult.error) {
        await sendAlert(resend, fromEmail, adminEmail, "Cardigan Validator error", validatorResult.error, payload);
        throw new Error(`Cardigan Validator failed: ${validatorResult.error}`);
      }

      validation = validatorResult.data;
      logger.log(`Cardigan Validator attempt ${attempt} complete`, {
        pass: validation.pass,
        failed: validation.failed,
      });

      if (validation.pass) {
        logger.log(`Cardigan Validation passed on attempt ${attempt}`);
        if (validation.data) {
          calcJson = validation.data;
        }
        break;
      }

      logger.warn(`Cardigan Validation failed on attempt ${attempt}`, { failed: validation.failed });

      if (attempt === 3) {
        await sendAlert(
          resend, fromEmail, adminEmail,
          "Cardigan Validation failed after 3 attempts",
          `Failed checks:\n${JSON.stringify(validation.failed, null, 2)}`,
          payload
        );
        if (payload.email) {
          await resend.emails.send({
            from: fromEmail,
            to: [payload.email],
            subject: "Your knitting pattern — we're checking something",
            html: `<p>Thank you for your order. We noticed a small issue with the calculations and our team will review and send your pattern shortly.</p>`,
          });
        }
        return { status: "validation_failed", failed: validation.failed };
      }
    }

    // ── Step 3: Formatter — Pattern HTML ──────────────────────────
    // The shared formatter worker reads body.inputs.Variant to route to
    // cardigan_pattern_template + cardigan_formatter_prompt KV keys.
    logger.log("Calling cardigan formatter /output1...");
    const output1Result = await callWorker(
      process.env.FORMATTER_URL! + "/output1",
      process.env.FORMATTER_API_KEY!,
      calcJson
    );

    if (output1Result.error || !output1Result.data?.output1) {
      const msg = output1Result.error || "No output1 returned";
      await sendAlert(resend, fromEmail, adminEmail, "Cardigan Formatter output1 error", msg, payload);
      throw new Error(`Cardigan Formatter output1 failed: ${msg}`);
    }

    const patternHtml = output1Result.data.output1;
    logger.log("Cardigan Pattern HTML generated", { chars: patternHtml.length });

    // ── Step 4: Formatter — Check Sheet + Log ─────────────────────
    logger.log("Calling cardigan formatter /output23...");
    const output23Result = await callWorker(
      process.env.FORMATTER_URL! + "/output23",
      process.env.FORMATTER_API_KEY!,
      calcJson
    );

    const checkSheetHtml = output23Result.data?.output2 || null;
    const calcLog = output23Result.data?.output3 || null;

    if (!checkSheetHtml) {
      logger.warn("Cardigan Check sheet not generated", { error: output23Result.error });
      await sendAlert(resend, fromEmail, adminEmail, "Cardigan Check sheet warning", output23Result.error || "No output2", payload);
    }

    // ── Step 5: Convert pattern HTML → PDF ────────────────────────
    logger.log("Converting cardigan pattern to PDF...");
    const pdfBuffer = await htmlToPdf(patternHtml);
    logger.log("Cardigan PDF generated", { bytes: pdfBuffer.byteLength });

    // ── Step 6: Admin approval gate ───────────────────────────────
    logger.log("Sending cardigan admin preview for approval...");

    const token = await wait.createToken({
      timeout: "48h",
    });

    const approveUrl = `${appUrl}/approve?tokenId=${token.id}&action=approve`;
    const rejectUrl  = `${appUrl}/approve?tokenId=${token.id}&action=reject`;

    const pdfBase64 = bufferToBase64(pdfBuffer);

    await resend.emails.send({
      from: fromEmail,
      to: [adminEmail],
      subject: `⏳ REVIEW NEEDED — Cardigan Pattern — ${payload.email || "no email"} — Bust ${payload.Bust_cm}cm`,
      html: `
        <h2>Cardigan Pattern ready for review</h2>
        <p>A new V-neck cardigan pattern has been generated. Please review the attached PDF before it is sent to the customer.</p>
        <p><strong>Customer:</strong> ${payload.email || "no email"}</p>
        <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · Gauge ${payload.Gauge_st}st/${payload.Gauge_row}row · ${payload.Ease_preference} · ${payload.Length_preference}</p>
        <p><strong>Nodes active:</strong> ${JSON.stringify(calcJson.decision_path?.nodes_active)}</p>
        <p><strong>Cardigan info:</strong> ${JSON.stringify({
          front_sts: calcJson.cardigan?.Cardigan_front_sts,
          band_sts: calcJson.cardigan?.Front_band_sts_total,
          buttons: calcJson.cardigan?.Button_count,
        })}</p>
        <p><strong>Validation warnings:</strong> ${JSON.stringify(validation.warnings || [])}</p>
        <hr>
        <p>
          <a href="${approveUrl}" style="background:#22c55e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;margin-right:12px">
            ✅ Approve — Send to customer
          </a>
          <a href="${rejectUrl}" style="background:#ef4444;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">
            ❌ Reject — Do not send
          </a>
        </p>
        <hr>
        <h3>Calculation Log</h3>
        <pre style="font-size:11px;background:#f5f5f5;padding:12px">${calcLog || "not generated"}</pre>
      `,
      attachments: [
        {
          filename: `cardigan-pattern-${payload.Bust_cm}cm.pdf`,
          content: pdfBase64,
        },
      ],
    });

    // ── Step 7: Wait for admin approval (up to 48 hours) ──────────
    logger.log("Waiting for cardigan admin approval...");
    const approvalResult = await wait.forToken<{ action: string }>(token.id);

    logger.log("Cardigan Approval result", { result: JSON.stringify(approvalResult) });

    const output = approvalResult.ok ? (approvalResult.output as any) : null;
    const action = output?.data?.action || output?.action;
    if (action !== "approve") {
      logger.log("Cardigan Pattern rejected or timed out — not sending to customer");
      await resend.emails.send({
        from: fromEmail,
        to: [adminEmail],
        subject: `❌ Cardigan Pattern NOT sent — ${payload.email || "no email"} — Bust ${payload.Bust_cm}cm`,
        html: `<p>The cardigan pattern was <strong>rejected</strong> (or approval timed out) and was <strong>not</strong> sent to the customer.</p>`,
      });
      return { status: "rejected", runId: ctx.run.id };
    }

    logger.log("Cardigan Pattern approved — sending to customer...");

    // ── Step 8: Send pattern PDF to customer ──────────────────────
    if (payload.email) {
      await resend.emails.send({
        from: fromEmail,
        to: [payload.email],
        subject: "Your personalised cardigan pattern is ready 🧶",
        html: `
          <p>Hello,</p>
          <p>Thank you for your order. Your personalised set-in sleeve cardigan pattern is attached as a PDF.</p>
          <p>If you have any questions, simply reply to this email.</p>
          <p>Happy knitting!</p>
        `,
        attachments: [
          {
            filename: `your-cardigan-pattern.pdf`,
            content: pdfBase64,
          },
        ],
      });
      logger.log("Cardigan Pattern PDF sent to customer", { to: payload.email });
    }

    // ── Step 9: Send admin confirmation copy ──────────────────────
    await resend.emails.send({
      from: fromEmail,
      to: [adminEmail],
      subject: `✅ Cardigan Pattern SENT — ${payload.email || "no email"} — Bust ${payload.Bust_cm}cm`,
      html: `
        <h2>Cardigan Pattern sent successfully</h2>
        <p><strong>Run ID:</strong> ${ctx.run.id}</p>
        <p><strong>Customer:</strong> ${payload.email || "no email"}</p>
        <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · Gauge ${payload.Gauge_st}st/${payload.Gauge_row}row · ${payload.Ease_preference} · ${payload.Length_preference}</p>
        <p><strong>Nodes active:</strong> ${JSON.stringify(calcJson.decision_path?.nodes_active)}</p>
        <p><strong>Cardigan info:</strong> ${JSON.stringify({
          front_sts: calcJson.cardigan?.Cardigan_front_sts,
          band_sts: calcJson.cardigan?.Front_band_sts_total,
          buttons: calcJson.cardigan?.Button_count,
        })}</p>
        <p><strong>Validation warnings:</strong> ${JSON.stringify(validation.warnings || [])}</p>
        <hr>
        <h3>Calculation Log</h3>
        <pre style="font-size:11px;background:#f5f5f5;padding:12px">${calcLog || "not generated"}</pre>
      `,
      attachments: [
        {
          filename: `cardigan-pattern-${payload.Bust_cm}cm.pdf`,
          content: pdfBase64,
        },
      ],
    });

    logger.log("Cardigan Pipeline complete ✅");
    return { status: "success", runId: ctx.run.id };
  },
});

// ── TDCR pipeline task ───────────────────────────────────────────────

export const tdcrPipelineTask = task({
  id: "tdcr-pipeline",
  maxDuration: 1800,
  retry: { maxAttempts: 2 },

  run: async (payload: TdcrPayload, { ctx }) => {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const adminEmail = process.env.ADMIN_EMAIL!;
    const fromEmail = process.env.FROM_EMAIL!;
    const appUrl = process.env.APP_URL!;

    logger.log("TDCR pipeline started", {
      bust: payload.Bust_cm,
      email: payload.email,
      runId: ctx.run.id,
    });

    // Translate Tally-format payload to TDCR calculator format
    // (calculator expects lowercase keys + plural gauge_sts / gauge_rows)
    const calcInput = {
      bust_cm: payload.Bust_cm,
      gauge_sts: payload.Gauge_st,
      gauge_rows: payload.Gauge_row,
      ease_preference: payload.Ease_preference,
      length_preference: payload.Length_preference,
      sleeve_length_cm: payload.Sleeve_length_cm,
    };

    // ── Steps 1 & 2: Calculator + Validator (with retry) ──────────
    let calcJson: any;
    let validation: any;

    for (let attempt = 1; attempt <= 3; attempt++) {
      logger.log(`TDCR Calculator attempt ${attempt}...`);
      const calcResult = await callWorker(
        process.env.TDCR_CALCULATOR_URL!,
        process.env.TDCR_CALCULATOR_API_KEY!,
        calcInput
      );

      if (calcResult.error || calcResult.data?.error) {
        const msg = calcResult.error || calcResult.data?.error;
        logger.error(`TDCR Calculator attempt ${attempt} failed`, { msg });
        if (attempt === 3) {
          await sendAlert(resend, fromEmail, adminEmail, "TDCR Calculator error", msg, payload);
          throw new Error(`TDCR Calculator failed after 3 attempts: ${msg}`);
        }
        continue;
      }

      calcJson = calcResult.data;
      logger.log(`TDCR Calculator attempt ${attempt} complete`, {
        checks: calcJson.checks,
        calculation_error: calcJson.calculation_error || false,
      });

      logger.log(`TDCR Validator attempt ${attempt}...`);
      const validatorResult = await callWorker(
        process.env.TDCR_VALIDATOR_URL!,
        process.env.TDCR_VALIDATOR_API_KEY!,
        calcJson
      );

      if (validatorResult.error) {
        await sendAlert(resend, fromEmail, adminEmail, "TDCR Validator error", validatorResult.error, payload);
        throw new Error(`TDCR Validator failed: ${validatorResult.error}`);
      }

      validation = validatorResult.data;
      logger.log(`TDCR Validator attempt ${attempt} complete`, {
        pass: validation.pass,
        failed: validation.failed,
      });

      if (validation.pass) {
        logger.log(`TDCR Validation passed on attempt ${attempt}`);
        break;
      }

      logger.warn(`TDCR Validation failed on attempt ${attempt}`, { failed: validation.failed });

      // TDCR calculator is deterministic — retrying after a validation
      // failure won't change the output. Fail fast on the first attempt.
      await sendAlert(
        resend, fromEmail, adminEmail,
        "TDCR Validation failed",
        `Failed checks:\n${JSON.stringify(validation.failed, null, 2)}`,
        payload
      );
      if (payload.email) {
        await resend.emails.send({
          from: fromEmail,
          to: [payload.email],
          subject: "Your knitting pattern — we're checking something",
          html: `<p>Thank you for your order. We noticed a small issue with the calculations and our team will review and send your pattern shortly.</p>`,
        });
      }
      return { status: "validation_failed", failed: validation.failed };
    }

    // ── Step 3: Formatter — Pattern HTML ──────────────────────────
    // calcJson already contains pattern_type: "tdcr" (set by the calculator)
    // which routes the formatter to the TDCR KV keys.
    logger.log("Calling TDCR formatter /output1...");
    const output1Result = await callWorker(
      process.env.FORMATTER_URL! + "/output1",
      process.env.FORMATTER_API_KEY!,
      calcJson
    );

    if (output1Result.error || !output1Result.data?.output1) {
      const msg = output1Result.error || "No output1 returned";
      await sendAlert(resend, fromEmail, adminEmail, "TDCR Formatter output1 error", msg, payload);
      throw new Error(`TDCR Formatter output1 failed: ${msg}`);
    }

    const patternHtml = output1Result.data.output1;
    logger.log("TDCR Pattern HTML generated", { chars: patternHtml.length });

    // ── Step 4: Formatter — Calculation Log only (no check sheet for TDCR) ──
    logger.log("Calling TDCR formatter /output23 (log only)...");
    const output23Result = await callWorker(
      process.env.FORMATTER_URL! + "/output23",
      process.env.FORMATTER_API_KEY!,
      calcJson
    );

    const calcLog = output23Result.data?.output3 || null;

    if (!calcLog) {
      logger.warn("TDCR Calculation log not generated", { error: output23Result.error });
    }

    // ── Step 5: Convert pattern HTML → PDF ────────────────────────
    logger.log("Converting TDCR pattern to PDF...");
    const pdfBuffer = await htmlToPdf(patternHtml);
    logger.log("TDCR PDF generated", { bytes: pdfBuffer.byteLength });

    // ── Step 6: Admin approval gate ───────────────────────────────
    logger.log("Sending TDCR admin preview for approval...");

    const token = await wait.createToken({
      timeout: "48h",
    });

    const approveUrl = `${appUrl}/approve?tokenId=${token.id}&action=approve`;
    const rejectUrl  = `${appUrl}/approve?tokenId=${token.id}&action=reject`;

    const pdfBase64 = bufferToBase64(pdfBuffer);

    await resend.emails.send({
      from: fromEmail,
      to: [adminEmail],
      subject: `⏳ REVIEW NEEDED — TDCR Pattern — ${payload.email || "no email"} — Bust ${payload.Bust_cm}cm`,
      html: `
        <h2>TDCR Pattern ready for review</h2>
        <p>A new top-down circle raglan pattern has been generated. Please review the attached PDF before it is sent to the customer.</p>
        <p><strong>Customer:</strong> ${payload.email || "no email"}</p>
        <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · Gauge ${payload.Gauge_st}st/${payload.Gauge_row}row · ${payload.Ease_preference} · ${payload.Length_preference}</p>
        <p><strong>Calculator checks:</strong> ${JSON.stringify(calcJson.checks)}</p>
        <p><strong>Validation warnings:</strong> ${JSON.stringify(validation.warnings || [])}</p>
        <hr>
        <p>
          <a href="${approveUrl}" style="background:#22c55e;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;margin-right:12px">
            ✅ Approve — Send to customer
          </a>
          <a href="${rejectUrl}" style="background:#ef4444;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold">
            ❌ Reject — Do not send
          </a>
        </p>
        <hr>
        <h3>Calculation Log</h3>
        <pre style="font-size:11px;background:#f5f5f5;padding:12px">${calcLog || "not generated"}</pre>
      `,
      attachments: [
        {
          filename: `tdcr-pattern-${payload.Bust_cm}cm.pdf`,
          content: pdfBase64,
        },
      ],
    });

    // ── Step 7: Wait for admin approval (up to 48 hours) ──────────
    logger.log("Waiting for TDCR admin approval...");
    const approvalResult = await wait.forToken<{ action: string }>(token.id);

    logger.log("TDCR Approval result", { result: JSON.stringify(approvalResult) });

    const output = approvalResult.ok ? (approvalResult.output as any) : null;
    const action = output?.data?.action || output?.action;
    if (action !== "approve") {
      logger.log("TDCR Pattern rejected or timed out — not sending to customer");
      await resend.emails.send({
        from: fromEmail,
        to: [adminEmail],
        subject: `❌ TDCR Pattern NOT sent — ${payload.email || "no email"} — Bust ${payload.Bust_cm}cm`,
        html: `<p>The TDCR pattern was <strong>rejected</strong> (or approval timed out) and was <strong>not</strong> sent to the customer.</p>`,
      });
      return { status: "rejected", runId: ctx.run.id };
    }

    logger.log("TDCR Pattern approved — sending to customer...");

    // ── Step 8: Send pattern PDF to customer ──────────────────────
    if (payload.email) {
      await resend.emails.send({
        from: fromEmail,
        to: [payload.email],
        subject: "Your personalised knitting pattern is ready 🧶",
        html: `
          <p>Hello,</p>
          <p>Thank you for your order. Your personalised top-down raglan sweater pattern is attached as a PDF.</p>
          <p>If you have any questions, simply reply to this email.</p>
          <p>Happy knitting!</p>
        `,
        attachments: [
          {
            filename: `your-sweater-pattern.pdf`,
            content: pdfBase64,
          },
        ],
      });
      logger.log("TDCR Pattern PDF sent to customer", { to: payload.email });
    }

    // ── Step 9: Send admin confirmation copy ──────────────────────
    await resend.emails.send({
      from: fromEmail,
      to: [adminEmail],
      subject: `✅ TDCR Pattern SENT — ${payload.email || "no email"} — Bust ${payload.Bust_cm}cm`,
      html: `
        <h2>TDCR Pattern sent successfully</h2>
        <p><strong>Run ID:</strong> ${ctx.run.id}</p>
        <p><strong>Customer:</strong> ${payload.email || "no email"}</p>
        <p><strong>Inputs:</strong> Bust ${payload.Bust_cm}cm · Gauge ${payload.Gauge_st}st/${payload.Gauge_row}row · ${payload.Ease_preference} · ${payload.Length_preference}</p>
        <p><strong>Calculator checks:</strong> ${JSON.stringify(calcJson.checks)}</p>
        <p><strong>Validation warnings:</strong> ${JSON.stringify(validation.warnings || [])}</p>
        <hr>
        <h3>Calculation Log</h3>
        <pre style="font-size:11px;background:#f5f5f5;padding:12px">${calcLog || "not generated"}</pre>
      `,
      attachments: [
        {
          filename: `tdcr-pattern-${payload.Bust_cm}cm.pdf`,
          content: pdfBase64,
        },
      ],
    });

    logger.log("TDCR Pipeline complete ✅");
    return { status: "success", runId: ctx.run.id };
  },
});

// ── Tally webhook handler task ───────────────────────────────────────

export const tallyWebhookTask = task({
  id: "tally-webhook-handler",
  maxDuration: 30,

  run: async (payload: any) => {
    const tallyData = payload.payload || payload;
    logger.log("Raw fields", { f: JSON.stringify(tallyData.data?.fields?.map((f:any) => f.label)) });
    const fields = extractTallyFields(tallyData);

    if ("error" in fields) {
      logger.error("Failed to parse Tally payload", { error: fields.error });
      throw new Error(fields.error);
    }

    logger.log("Tally fields extracted", {
      bust: fields.Bust_cm || fields.bust_cm,
      ease: fields.Ease_preference || fields.ease_preference,
      construction: fields.construction_method,
    });

    const isTdcr     = fields.construction_method === 'knitted in one piece, from the top down (seamless)';
    const isCardigan = typeof fields.garment_type === 'string' && fields.garment_type.includes('cardigan');
    const isSacasis  = !isTdcr && !isCardigan && typeof fields.special_details === 'string' && fields.special_details.includes('sand cable');

    // Variant precedence: cardigan > sacasis > sis. Cardigan and sacasis
    // are mutually exclusive in V1 (no sand-cable cardigan yet).
    if (isCardigan) {
      fields.Variant = 'cardigan';
    } else if (isSacasis) {
      fields.Variant = 'sacasis';
    }

    // Routing: TDCR is its own pipeline (different construction).
    // Cardigan is its own pipeline (different shape, different formatter
    // template) but shares calculator + validator workers via Variant.
    // SIS pullover is the default.
    if (isTdcr) {
      const handle = await tdcrPipelineTask.trigger(fields);
      logger.log("TDCR pipeline triggered", { runId: handle.id });
      return { status: "triggered", pipeline: "tdcr", runId: handle.id };
    } else if (isCardigan) {
      const handle = await sisCardiganPipelineTask.trigger(fields);
      logger.log("SIS-Cardigan pipeline triggered", { runId: handle.id });
      return { status: "triggered", pipeline: "sis-cardigan", runId: handle.id };
    } else {
      const handle = await sisPipelineTask.trigger(fields);
      logger.log("SIS pipeline triggered", { runId: handle.id });
      return { status: "triggered", pipeline: "sis", runId: handle.id };
    }
  },
});

// ── HTML → PDF ────────────────────────────────────────────────────────

async function htmlToPdf(html: string): Promise<ArrayBuffer> {
  const pdfWorkerUrl = process.env.PDF_WORKER_URL;
  const pdfApiKey   = process.env.PDF_WORKER_API_KEY || "";

  if (!pdfWorkerUrl) {
    throw new Error("PDF_WORKER_URL env var is not set");
  }

  const response = await fetch(pdfWorkerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-API-Key": pdfApiKey,
    },
    body: html,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`PDF worker failed: HTTP ${response.status}: ${err.slice(0, 300)}`);
  }

  return response.arrayBuffer();
}

// ── ArrayBuffer → base64 ──────────────────────────────────────────────

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── Field extraction ──────────────────────────────────────────────────

function extractTallyFields(payload: TallyWebhookPayload): any {
  try {
    const result: any = {};

    const emailField = payload.data?.fields?.find(
      (f) => f.type === "INPUT_EMAIL" || f.label?.toLowerCase().includes("email")
    );
    if (emailField) result.email = emailField.value;

    const fieldMap: Record<string, string> = {
      "Bust/chest measurement (cm)": "Bust_cm",
      "Stitches per 10 cm": "Gauge_st",
      "Rows per 10 cm": "Gauge_row",
      "Ease/fit preference": "Ease_preference",
      "Length preference": "Length_preference",
      "Front_neck_depth_for_V_cm": "Front_neck_depth_for_V_cm",
      "Sleeve_length_cm": "Sleeve_length_cm",
      "Construction_method": "construction_method",
      "Special details": "special_details",
      "Garment_type": "garment_type",
    };

    const numericFields = new Set([
      "Bust_cm", "Gauge_st", "Gauge_row",
      "Front_neck_depth_for_V_cm", "Sleeve_length_cm",
    ]);

    for (const field of payload.data?.fields || []) {
      const key = fieldMap[field.label];
      if (!key) continue;
      let val = field.value;
      if (Array.isArray(val) && field.options) {
        const matched = field.options.find((o: any) => o.id === val[0]);
        val = matched ? matched.text : val[0];
      }
      if (typeof val === "string") val = val.trim().toLowerCase();
      if (numericFields.has(key)) val = parseFloat(val);
      result[key] = val;
    }

    const isTdcr = result.construction_method === 'knitted in one piece, from the top down (seamless)';

    const required = isTdcr
      ? ["Bust_cm", "Gauge_st", "Gauge_row", "Ease_preference", "Length_preference",
         "Sleeve_length_cm"]
      : ["Bust_cm", "Gauge_st", "Gauge_row", "Ease_preference", "Length_preference",
         "Front_neck_depth_for_V_cm", "Sleeve_length_cm"];

    for (const r of required) {
      if (result[r] === undefined || result[r] === null || result[r] === "" || Number.isNaN(result[r])) {
        return { error: `Missing required field: ${r}` };
      }
    }

    return result;
  } catch (e: any) {
    return { error: `Field extraction failed: ${e.message}` };
  }
}

// ── Worker caller ─────────────────────────────────────────────────────

async function callWorker(url: string, apiKey: string, body: object) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();

    if (!response.ok) {
      return { error: `HTTP ${response.status}: ${text.slice(0, 500)}` };
    }

    try {
      return { data: JSON.parse(text) };
    } catch {
      return { data: { output1: text } };
    }
  } catch (e: any) {
    return { error: e.message };
  }
}

// ── Admin alert ───────────────────────────────────────────────────────

async function sendAlert(
  resend: Resend,
  from: string,
  to: string,
  title: string,
  detail: string,
  inputs: object
) {
  await resend.emails.send({
    from,
    to: [to],
    subject: `Pipeline Alert: ${title}`,
    html: `
      <h2>Pipeline Alert: ${title}</h2>
      <p><strong>Detail:</strong> ${detail}</p>
      <h3>Inputs</h3>
      <pre style="background:#f5f5f5;padding:12px">${JSON.stringify(inputs, null, 2)}</pre>
    `,
  });
}
