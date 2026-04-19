import { task, logger, wait } from "@trigger.dev/sdk";
import { Resend } from "resend";

// ── Types ────────────────────────────────────────────────────────────

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

// ── Main pipeline task ───────────────────────────────────────────────

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
        logger.error(`Calculator attempt ${attempt} failed`, { msg });
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

      // Validate
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

    const approveUrl = `${appUrl}/approve?runId=${ctx.run.id}&action=approve`;
    const rejectUrl  = `${appUrl}/approve?runId=${ctx.run.id}&action=reject`;

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
    const approvalEvent = await wait.forEvent("admin-approval", {
      timeout: "48h",
    });

    if (!approvalEvent || approvalEvent.action !== "approve") {
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
        subject: "Your Set-In Sleeve Sweater Pattern is ready! 🧶",
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
      bust: fields.Bust_cm,
      ease: fields.Ease_preference,
      construction: fields.construction_method,
    });

    const handle = await sisPipelineTask.trigger(fields);
    logger.log("SIS pipeline triggered", { runId: handle.id });

    return { status: "triggered", runId: handle.id };
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

function extractTallyFields(payload: TallyWebhookPayload): SisPayload & { error?: string } {
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

    const required = [
      "Bust_cm", "Gauge_st", "Gauge_row", "Ease_preference",
      "Length_preference", "Front_neck_depth_for_V_cm", "Sleeve_length_cm",
    ];

    for (const r of required) {
      if (result[r] === undefined || result[r] === null || result[r] === "" || Number.isNaN(result[r])) {
        return { error: `Missing required field: ${r}` } as any;
      }
    }

    return result;
  } catch (e: any) {
    return { error: `Field extraction failed: ${e.message}` } as any;
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
    subject: `SIS Pipeline Alert: ${title}`,
    html: `
      <h2>SIS Pipeline Alert: ${title}</h2>
      <p><strong>Detail:</strong> ${detail}</p>
      <h3>Inputs</h3>
      <pre style="background:#f5f5f5;padding:12px">${JSON.stringify(inputs, null, 2)}</pre>
    `,
  });
}
