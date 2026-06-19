import { task, logger } from "@trigger.dev/sdk";
import { Resend } from "resend";

// ── Formatter (Claude direct call — bypasses broken Sis-formatter Worker) ──
// See generateOutput1 / generateOutput23 near the bottom of this file.

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

    // ── Step 3: Formatter — Pattern HTML (direct Claude call) ─────
    logger.log("Generating pattern HTML (direct)...");
    const output1Result = await generateOutput1(calcJson);

    if (output1Result.error || !output1Result.data?.output1) {
      const msg = output1Result.error || "No output1 returned";
      await sendAlert(resend, fromEmail, adminEmail, "Formatter output1 error", msg, payload);
      throw new Error(`Formatter output1 failed: ${msg}`);
    }

    const patternHtml = output1Result.data.output1;
    logger.log("Pattern HTML generated", {
      chars: patternHtml.length,
      doctypeCount: output1Result.data._debug_doctype_count,
      htmlTagCount: output1Result.data._debug_html_tag_count,
      start: output1Result.data._debug_start,
      end: output1Result.data._debug_end,
    });

    // ── Step 4: Formatter — Check Sheet + Log (direct Claude call) ─
    logger.log("Generating check sheet + log (direct)...");
    const output23Result = await generateOutput23(calcJson);

    const checkSheetHtml = output23Result.data?.output2 || null;
    const calcLog = output23Result.data?.output3 || null;

    if (!checkSheetHtml) {
      logger.warn("Check sheet not generated", { error: output23Result.error });
      await sendAlert(resend, fromEmail, adminEmail, "Check sheet warning", output23Result.error || "No output2", payload);
    }

    // ── Step 5: Convert pattern HTML → PDF ────────────────────────
    logger.log("Converting pattern to PDF...");
    let pdfBuffer: ArrayBuffer;
    try {
      pdfBuffer = await htmlToPdf(patternHtml);
    } catch (e: any) {
      await sendAlert(resend, fromEmail, adminEmail, "PDF generation failed", e.message, payload);
      throw e;
    }
    logger.log("PDF generated", { bytes: pdfBuffer.byteLength });

    const pdfBase64 = bufferToBase64(pdfBuffer);

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
    logger.log("Generating cardigan pattern HTML (direct)...");
    const output1Result = await generateOutput1(calcJson);

    if (output1Result.error || !output1Result.data?.output1) {
      const msg = output1Result.error || "No output1 returned";
      await sendAlert(resend, fromEmail, adminEmail, "Cardigan Formatter output1 error", msg, payload);
      throw new Error(`Cardigan Formatter output1 failed: ${msg}`);
    }

    const patternHtml = output1Result.data.output1;
    logger.log("Cardigan Pattern HTML generated", { chars: patternHtml.length });

    // ── Step 4: Formatter — Check Sheet + Log ─────────────────────
    logger.log("Generating cardigan check sheet + log (direct)...");
    const output23Result = await generateOutput23(calcJson);

    const checkSheetHtml = output23Result.data?.output2 || null;
    const calcLog = output23Result.data?.output3 || null;

    if (!checkSheetHtml) {
      logger.warn("Cardigan Check sheet not generated", { error: output23Result.error });
      await sendAlert(resend, fromEmail, adminEmail, "Cardigan Check sheet warning", output23Result.error || "No output2", payload);
    }

    // ── Step 5: Convert pattern HTML → PDF ────────────────────────
    logger.log("Converting cardigan pattern to PDF...");
    let pdfBuffer: ArrayBuffer;
    try {
      pdfBuffer = await htmlToPdf(patternHtml);
    } catch (e: any) {
      await sendAlert(resend, fromEmail, adminEmail, "Cardigan PDF generation failed", e.message, payload);
      throw e;
    }
    logger.log("Cardigan PDF generated", { bytes: pdfBuffer.byteLength });

    const pdfBase64 = bufferToBase64(pdfBuffer);

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
    logger.log("Generating TDCR pattern HTML (direct)...");
    const output1Result = await generateOutput1(calcJson);

    if (output1Result.error || !output1Result.data?.output1) {
      const msg = output1Result.error || "No output1 returned";
      await sendAlert(resend, fromEmail, adminEmail, "TDCR Formatter output1 error", msg, payload);
      throw new Error(`TDCR Formatter output1 failed: ${msg}`);
    }

    const patternHtml = output1Result.data.output1;
    logger.log("TDCR Pattern HTML generated", { chars: patternHtml.length });

    // ── Step 4: Formatter — Calculation Log only (no check sheet for TDCR) ──
    logger.log("Generating TDCR log (direct)...");
    const output23Result = await generateOutput23(calcJson);

    const calcLog = output23Result.data?.output3 || null;

    if (!calcLog) {
      logger.warn("TDCR Calculation log not generated", { error: output23Result.error });
    }

    // ── Step 5: Convert pattern HTML → PDF ────────────────────────
    logger.log("Converting TDCR pattern to PDF...");
    let pdfBuffer: ArrayBuffer;
    try {
      pdfBuffer = await htmlToPdf(patternHtml);
    } catch (e: any) {
      await sendAlert(resend, fromEmail, adminEmail, "TDCR PDF generation failed", e.message, payload);
      throw e;
    }
    logger.log("TDCR PDF generated", { bytes: pdfBuffer.byteLength });

    const pdfBase64 = bufferToBase64(pdfBuffer);

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
  const token = process.env.BROWSERLESS_TOKEN;
  const region = process.env.BROWSERLESS_REGION; // e.g. "production-sfo"

  if (!token) throw new Error("BROWSERLESS_TOKEN env var is not set");
  if (!region) throw new Error("BROWSERLESS_REGION env var is not set");

  const browserlessUrl = `https://${region}.browserless.io/pdf?token=${token}`;

  // Client-side hard cap, well above Browserless's own render timeout below,
  // so a genuinely stuck request still surfaces as an error instead of
  // hanging the Trigger.dev run indefinitely.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180_000);

  let response: Response;
  try {
    response = await fetch(browserlessUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify({
        html,
        options: {
          printBackground: true,
          // Browserless's own render timeout. Default is 30s, which is too
          // short for large pattern documents — this is what was causing
          // "Browserless API error: HTTP 408" failures.
          timeout: 150_000,
        },
      }),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e.name === "AbortError") {
      throw new Error("Browserless request timed out after 180s (client-side abort)");
    }
    throw new Error(`Browserless request failed: ${e.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Browserless PDF generation failed: HTTP ${response.status}: ${err.slice(0, 300)}`);
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

// ── Cloudflare KV fetch (REST API — separate from the broken Worker) ──

const kvCache = new Map<string, string>();

async function getKvTemplate(key: string): Promise<string> {
  if (kvCache.has(key)) return kvCache.get(key)!;

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID!;
  const namespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID!;
  const token = process.env.CLOUDFLARE_API_TOKEN!;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`KV fetch failed for key "${key}": HTTP ${response.status}: ${err.slice(0, 300)}`);
  }

  const text = await response.text();
  kvCache.set(key, text);
  return text;
}

// ── Direct Anthropic call (bypasses Cloudflare Workers entirely) ──────

async function callClaudeDirect(prompt: string, maxTokens: number): Promise<{ text?: string; error?: string }> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { error: `HTTP ${response.status}: ${errText.slice(0, 500)}` };
    }

    const data = await response.json();
    const text = data.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    return { text };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ── Streaming variant — required by the API for max_tokens > ~21,333  ──
// (the API rejects/warns on long non-streaming requests). Used for
// output1, whose max_tokens (64000) is well above that threshold.
async function callClaudeStreamingDirect(prompt: string, maxTokens: number): Promise<{ text?: string; error?: string }> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { error: `HTTP ${response.status}: ${errText.slice(0, 500)}` };
    }
    if (!response.body) {
      return { error: "No response body from streaming request" };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const evt = JSON.parse(data);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            fullText += evt.delta.text;
          }
        } catch {
          // ignore malformed SSE line
        }
      }
    }

    return { text: fullText };
  } catch (e: any) {
    return { error: e.message };
  }
}

function extractOutput(text: string, label: string): string | null {
  const regex = new RegExp(
    `${label}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n###?\\s*OUTPUT \\d|$)`,
    "i"
  );
  const match = text.match(regex);
  if (!match) return null;
  return match[1].trim();
}

// ── Output 1: Pattern HTML (direct replacement for Sis-formatter /output1) ──

async function generateOutput1(calcJson: any): Promise<{ data?: any; error?: string }> {
  try {
    const isTdcr = calcJson.pattern_type === "tdcr";
    const isCardigan = !isTdcr && (!!calcJson.cardigan || calcJson.inputs?.Variant === "cardigan");
    const isSacasis = !isTdcr && !isCardigan && !!calcJson.sacasis;

    const promptKey = isTdcr ? "tdcr_formatter_prompt"
                     : isCardigan ? "cardigan_formatter_prompt"
                     : "formatter_prompt";
    const templateKey = isTdcr ? "tdcr_pattern_template"
                       : isCardigan ? "cardigan_pattern_template"
                       : isSacasis ? "sacasis_pattern_template"
                       : "pattern_template";

    const [formatterPromptFull, patternTemplate] = await Promise.all([
      getKvTemplate(promptKey),
      getKvTemplate(templateKey),
    ]);

    // Drop the OUTPUT 2 / OUTPUT 3 sections entirely for this call.
    // Those sections instruct Claude to narrate a decision path / calc log —
    // leaving them in causes Claude to sometimes apply that narration
    // instinct to this output1-only call instead of returning raw HTML.
    const output2Marker = formatterPromptFull.search(/^### OUTPUT 2/m);
    const formatterPrompt = output2Marker !== -1
      ? formatterPromptFull.slice(0, output2Marker)
      : formatterPromptFull;

    // ── Strip base64 images before sending to Claude ──────────────
    const savedImages: string[] = [];
    let patternTemplateStripped = patternTemplate.replace(
      /(src=["'])(data:image\/[^;]+;base64,[^"']+)(["'])/g,
      (_match, before, base64, after) => {
        const index = savedImages.length;
        savedImages.push(base64);
        return `${before}IMAGE_PLACEHOLDER_${index}${after}`;
      }
    );

    // ── Strip inline SVG blocks before sending to Claude ───────────
    const savedSvgs: string[] = [];
    patternTemplateStripped = patternTemplateStripped.replace(
      /<svg[\s\S]*?<\/svg>/gi,
      (match) => {
        const index = savedSvgs.length;
        savedSvgs.push(match);
        return `SVG_PLACEHOLDER_${index}`;
      }
    );

    let prompt: string;
    if (isTdcr) {
      prompt = `${formatterPrompt
        .replace("{{json_from_calculator}}", JSON.stringify(calcJson, null, 2))
        .replace("{{html_pattern_template}}", patternTemplateStripped)}

IMPORTANT: Produce ONLY OUTPUT 1 — the complete filled-in Pattern HTML document.
Do not produce Output 2.
Output the full HTML from <!DOCTYPE html> to </html> and nothing else.
No markdown fences, no labels, no preamble, no comments, no extra whitespace.
Do NOT explain your reasoning, decisions, or which template path you used —
output ONLY the final HTML document, starting with <!DOCTYPE html> as the
very first characters of your response.
Keep IMAGE_PLACEHOLDER_0, IMAGE_PLACEHOLDER_1 etc. exactly as-is in src attributes — do not change them.`;
    } else {
      prompt = `${formatterPrompt
        .replace("{{json_from_call_1}}", JSON.stringify(calcJson, null, 2))
        .replace("{{html_pattern_template}}", patternTemplateStripped)
        .replace("{{html_check_sheet}}", "[NOT REQUIRED IN THIS CALL]")}

IMPORTANT: Produce ONLY OUTPUT 1 — the complete filled-in Pattern HTML document.
Do not produce Output 2 or Output 3.
Output the full HTML from <!DOCTYPE html> to </html> and nothing else.
No markdown fences, no labels, no preamble, no comments, no extra whitespace.
Do NOT explain your reasoning, decisions, or which template path you used —
output ONLY the final HTML document, starting with <!DOCTYPE html> as the
very first characters of your response.
Keep IMAGE_PLACEHOLDER_0, IMAGE_PLACEHOLDER_1 etc. exactly as-is in src attributes — do not change them.`;
    }

    let output1 = "";
    let lastError = "";
    let doctypeCount = 0;
    let htmlTagCount = 0;

    // Retry once if Claude narrates instead of returning raw HTML —
    // this is an occasional model-behavior flake, not a systemic error.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await callClaudeStreamingDirect(prompt, 64000);
      if (result.error) {
        lastError = result.error;
        continue;
      }

      let candidate = result.text!;
      savedImages.forEach((src, index) => {
        candidate = candidate.replace(`IMAGE_PLACEHOLDER_${index}`, src);
      });

      const svgVarSources: Record<string, any> = {
        C_cm: calcJson?.calculated?.C_cm,
        Finished_length_cm: calcJson?.lookups?.Finished_length_cm,
        Sleeve_length_cm: calcJson?.inputs?.Sleeve_length_cm,
        Upper_arm_cm: calcJson?.extras?.Upper_arm_cm ?? calcJson?.calculated?.Upper_arm_cm,
        Armhole_depth_cm: calcJson?.lookups?.Armhole_depth_cm,
        Shoulder_width_cm: calcJson?.lookups?.Shoulder_width_cm,
        Front_neck_depth_for_V_cm: calcJson?.inputs?.Front_neck_depth_for_V_cm,
      };
      savedSvgs.forEach((svg, index) => {
        let substituted = svg;
        Object.entries(svgVarSources).forEach(([varName, value]) => {
          if (value !== undefined && value !== null) {
            substituted = substituted.replaceAll(`{${varName}}`, String(value));
          }
        });
        candidate = candidate.replace(`SVG_PLACEHOLDER_${index}`, substituted);
      });

      doctypeCount = (candidate.match(/<!DOCTYPE html>/gi) || []).length;
      htmlTagCount = (candidate.match(/<html/gi) || []).length;

      if (doctypeCount > 0 && htmlTagCount > 0) {
        output1 = candidate;
        lastError = "";
        break;
      }

      lastError = `Formatter output1 is not valid HTML (doctype=${doctypeCount}, html_tag=${htmlTagCount}). Start: ${candidate.slice(0, 300)}`;
    }

    if (lastError) return { error: lastError };

    return {
      data: {
        output1,
        _debug_chars: output1.length,
        _debug_start: output1.slice(0, 300),
        _debug_end: output1.slice(-300),
        _debug_doctype_count: doctypeCount,
        _debug_html_tag_count: htmlTagCount,
      },
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ── Outputs 2 & 3: Check Sheet + Calculation Log (direct replacement) ──

async function generateOutput23(calcJson: any): Promise<{ data?: any; error?: string }> {
  try {
    const isTdcr = calcJson.pattern_type === "tdcr";
    const isCardigan = !isTdcr && (!!calcJson.cardigan || calcJson.inputs?.Variant === "cardigan");

    if (isTdcr) {
      const formatterPrompt = await getKvTemplate("tdcr_formatter_prompt");

      const prompt = `${formatterPrompt
        .replace("{{json_from_calculator}}", JSON.stringify(calcJson, null, 2))
        .replace("{{html_pattern_template}}", "[NOT REQUIRED IN THIS CALL]")}

IMPORTANT: Produce ONLY OUTPUT 2 — the Calculation Log.
Label it exactly as:

### OUTPUT 2 — CALCULATION LOG

[calculation log here]`;

      const result = await callClaudeDirect(prompt, 4000);
      if (result.error) return { error: result.error };

      const output3 = extractOutput(result.text!, "OUTPUT 2");
      return { data: { output2: null, output3 } };
    } else {
      const promptKey = isCardigan ? "cardigan_formatter_prompt" : "formatter_prompt";
      const checkSheetKey = isCardigan ? "cardigan_check_sheet" : "check_sheet";

      const [formatterPrompt, checkSheet] = await Promise.all([
        getKvTemplate(promptKey),
        getKvTemplate(checkSheetKey),
      ]);

      const prompt = `${formatterPrompt
        .replace("{{json_from_call_1}}", JSON.stringify(calcJson, null, 2))
        .replace("{{html_pattern_template}}", "[NOT REQUIRED IN THIS CALL]")
        .replace("{{html_check_sheet}}", checkSheet)}

IMPORTANT: Produce ONLY OUTPUT 2 and OUTPUT 3.
Label them exactly as:

### OUTPUT 2 — CHECK SHEET HTML FILE

[full check sheet HTML here]

### OUTPUT 3 — CALCULATION LOG

[calculation log here]`;

      const result = await callClaudeDirect(prompt, 8000);
      if (result.error) return { error: result.error };

      const output2 = extractOutput(result.text!, "OUTPUT 2");
      const output3 = extractOutput(result.text!, "OUTPUT 3");

      if (!output2 || !output3) {
        return { error: `Failed to parse outputs 2 and 3. Preview: ${result.text!.slice(0, 1000)}` };
      }

      return { data: { output2, output3 } };
    }
  } catch (e: any) {
    return { error: e.message };
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
