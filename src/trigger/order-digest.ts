// @ts-nocheck
// Order digest -- 2026-11-14
//
// Twice a day (08:05 and 20:05 Paris) this task READS the pipeline runs and
// emails Yulia ONE summary: what was sent, and what needs her ("To do").
// It never emails a customer, never approves/rejects, never re-runs anything.
//
// Sections:
//   TO DO      -- held orders still waiting for approval (any age, up to 7 days)
//              -- runs that failed / crashed
//              -- runs that finished without sending (input error, validation
//                 failed, resume review, rejected)
//              -- form submissions that could not be read
//   SENT       -- patterns sent since the last digest (auto or approved)
//
// No email is sent when nothing happened and nothing is waiting.
// Run by hand: Trigger.dev dashboard -> task "order-digest" -> Test.

import { schedules, runs, logger } from "@trigger.dev/sdk";
import { Resend } from "resend";

const PIPELINES = ["brioche-pipeline", "tdcr-pipeline", "sis-pipeline", "sis-cardigan-pipeline"];
const LABEL: Record<string, string> = {
  "brioche-pipeline": "Brioche",
  "tdcr-pipeline": "TDCR",
  "sis-pipeline": "SIS",
  "sis-cardigan-pipeline": "Cardigan",
  "tally-webhook-handler": "Form",
};
const FAILED = ["FAILED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED"];
const IGNORED_ALERTS = ["Pattern store failed"]; // known, harmless (pattern still sent)

const esc = (s: any) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function who(run: any): string {
  const p = run.payload || {};
  if (p.email) return p.email;
  const fields = (p.payload || p)?.data?.fields || [];
  const f = fields.find((x: any) => x?.type === "INPUT_EMAIL" && x?.value);
  return f?.value || "no email";
}

function inputs(run: any): string {
  const p = run.payload || {};
  if (!p.Bust_cm) return "";
  return `Bust ${p.Bust_cm} · ${p.Gauge_st}/${p.Gauge_row} · ${p.Ease_preference || ""}${p.Length_preference ? " · " + p.Length_preference : ""}`;
}

function time(d: any): string {
  try {
    return new Date(d).toLocaleString("en-GB", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

async function collect(opts: any): Promise<any[]> {
  const out: any[] = [];
  for await (const r of runs.list(opts)) {
    out.push(r);
    if (out.length >= 200) break;
  }
  return out;
}

export const orderDigest = schedules.task({
  id: "order-digest",
  cron: { pattern: "5 8,20 * * *", timezone: "Europe/Paris" },
  maxDuration: 300,
  run: async (payload) => {
    const now = new Date(payload?.timestamp || Date.now());
    const since = new Date(payload?.lastTimestamp || now.getTime() - 12 * 3600 * 1000);
    const weekAgo = new Date(now.getTime() - 8 * 24 * 3600 * 1000);

    // Recent runs (since last digest) + anything still waiting (up to 8 days old).
    const recent = await collect({ taskIdentifier: [...PIPELINES, "tally-webhook-handler"], from: since, to: now });
    const waiting = await collect({ taskIdentifier: PIPELINES, status: ["WAITING", "EXECUTING", "QUEUED", "DELAYED"], from: weekAgo });

    const ids = new Map<string, any>();
    for (const r of [...recent, ...waiting]) ids.set(r.id, r);

    const todo: string[] = [];
    const sent: string[] = [];
    let inProgress = 0;

    for (const [id, base] of ids) {
      const task = base.taskIdentifier;
      let run: any = base;
      try { run = await runs.retrieve(id); } catch (e: any) { logger.warn("retrieve failed", { id, err: e.message }); }
      const status = run.status || base.status;
      const meta = run.metadata || {};
      const label = LABEL[task] || task;
      const line = (what: string, action: string) =>
        `<li><b>${esc(label)}</b> — ${esc(who(run))} — ${esc(inputs(run))} <span style="color:#666">(${esc(time(run.createdAt || base.createdAt))}, run ${esc(id)})</span><br>${what}${action ? `<br><b>→ ${action}</b>` : ""}</li>`;

      // The form handler only matters when it failed (submission could not be read).
      if (task === "tally-webhook-handler") {
        if (FAILED.includes(status)) todo.push(line(`Form submission could not be read: ${esc(run.error?.message || status)}`, "Check the Tally submission; ask the customer to resubmit if needed."));
        continue;
      }

      const alerts = (Array.isArray(meta.alerts) ? meta.alerts : []).filter((a: string) => !IGNORED_ALERTS.includes(a));
      const alertNote = alerts.length ? `<br>Alerts: ${esc(alerts.join("; "))}` : "";

      if (status === "WAITING" && meta.holdReasons) {
        todo.push(line(`Held for approval: ${esc([].concat(meta.holdReasons).join("; ") || "auto-send off")}${alertNote}`,
          "Open the 🔍 APPROVAL NEEDED email: check the reason, then Approve or Reject (email the customer if their input looks wrong)."));
        continue;
      }
      if (["WAITING", "EXECUTING", "QUEUED", "DELAYED", "DEQUEUED", "PENDING_VERSION"].includes(status)) {
        inProgress++;
        continue;
      }
      if (FAILED.includes(status)) {
        todo.push(line(`Run ${esc(status.toLowerCase())}: ${esc(run.error?.message || "no message")}${alertNote}`,
          "Pattern NOT sent. Look at the alert email / run; fix and re-run, or email the customer."));
        continue;
      }
      if (status === "CANCELED") continue;
      if (status !== "COMPLETED") continue;

      // Only report completed runs that finished since the last digest.
      const finished = new Date(run.finishedAt || run.updatedAt || run.createdAt);
      if (finished < since) continue;

      const out = run.output || {};
      switch (out.status) {
        case "success":
          sent.push(line(`${meta.outcome === "auto-sent" ? "Sent automatically" : "Sent after your approval"}${alertNote}`, alerts.length ? "Check the alert above." : ""));
          break;
        case "rejected":
          todo.push(line("You rejected this one — pattern NOT sent.", "Make sure the customer has been emailed."));
          break;
        case "user_input_error":
          todo.push(line(`Input problem (${esc(out.reason)}) — customer got the 'please check' email.`, "Nothing unless they reply."));
          break;
        case "validation_failed":
          todo.push(line(`Validator failed: ${esc(JSON.stringify(out.failed || "").slice(0, 300))} — pattern NOT sent.`, "Fix needed; then re-run or email the customer."));
          break;
        case "resume_review":
        case "resume_incomplete":
          todo.push(line(`Mid-work resume needs review (${esc(out.reason || out.status)}).`, "Look at the resume alert and reply to the knitter."));
          break;
        default:
          todo.push(line(`Finished with status '${esc(out.status || "unknown")}'.`, "Check the run."));
      }
    }

    if (!todo.length && !sent.length && !inProgress) {
      logger.log("Nothing to report — no email sent");
      return { todo: 0, sent: 0, inProgress: 0, emailed: false };
    }

    const subject = todo.length
      ? `📋 Knitpage orders: ${todo.length} to do · ${sent.length} sent`
      : `📋 Knitpage orders: nothing to do · ${sent.length} sent`;
    const html = `
      <p style="font-family:sans-serif;color:#666">Since ${esc(time(since))} (Paris time). Held orders are listed until you approve or reject them.</p>
      <h2 style="font-family:sans-serif">To do (${todo.length})</h2>
      ${todo.length ? `<ul style="font-family:sans-serif">${todo.join("")}</ul>` : `<p style="font-family:sans-serif">Nothing — all good.</p>`}
      <h2 style="font-family:sans-serif">Sent (${sent.length})</h2>
      ${sent.length ? `<ul style="font-family:sans-serif">${sent.join("")}</ul>` : `<p style="font-family:sans-serif">None.</p>`}
      ${inProgress ? `<p style="font-family:sans-serif;color:#666">${inProgress} order(s) still running.</p>` : ""}
    `;

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.FROM_EMAIL!,
      to: [process.env.ADMIN_EMAIL || "yulia@knitpage.com"],
      subject,
      html,
    });
    return { todo: todo.length, sent: sent.length, inProgress, emailed: true };
  },
});
