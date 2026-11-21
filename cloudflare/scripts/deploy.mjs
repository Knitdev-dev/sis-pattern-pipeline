// Deploys repo files to Cloudflare. Called by .github/workflows/cloudflare-deploy.yml.
//   cloudflare/workers/<name>.js          -> Worker <name>, code only (settings/secrets untouched)
//   cloudflare/kv/<NAMESPACE>/<key>.<ext> -> KV value <key> in namespace titled <NAMESPACE>
// Before each upload the live version is saved to cloudflare-backup/ (kept as a run artifact).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) throw new Error("CLOUDFLARE_API_TOKEN secret is missing");
const API = "https://api.cloudflare.com/client/v4";
const H = { Authorization: `Bearer ${TOKEN}` };

async function cf(url, opts = {}) {
  const r = await fetch(API + url, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  return r;
}
async function cfJson(url, opts) {
  const r = await cf(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`${url}: HTTP ${r.status} ${JSON.stringify(j.errors || j)}`);
  return j.result;
}

let ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!ACCOUNT) {
  const accts = await cfJson("/accounts");
  if (accts.length !== 1) throw new Error("Set the CLOUDFLARE_ACCOUNT_ID repository variable (token sees " + accts.length + " accounts)");
  ACCOUNT = accts[0].id;
}
fs.mkdirSync("cloudflare-backup", { recursive: true });

const files = process.argv.slice(2).filter(Boolean);
let nsCache = null;
async function namespaceId(title) {
  if (!nsCache) nsCache = await cfJson(`/accounts/${ACCOUNT}/storage/kv/namespaces?per_page=100`);
  const ns = nsCache.find((n) => n.title === title);
  if (!ns) throw new Error(`KV namespace "${title}" not found`);
  return ns.id;
}

for (const f of files) {
  const parts = f.split("/");
  if (parts[0] !== "cloudflare") continue;

  if (parts[1] === "workers" && parts.length === 3 && f.endsWith(".js")) {
    const name = path.basename(f, ".js");
    // Safety: the code must at least parse.
    execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
    // Backup the live code.
    const old = await cf(`/accounts/${ACCOUNT}/workers/scripts/${name}/content/v2`);
    if (!old.ok) throw new Error(`Worker "${name}" not found (HTTP ${old.status}) — this workflow only updates existing Workers`);
    fs.writeFileSync(`cloudflare-backup/worker-${name}.js`, Buffer.from(await old.arrayBuffer()));
    // Find the live main module name so we replace like-for-like.
    const settings = await cfJson(`/accounts/${ACCOUNT}/workers/scripts/${name}/settings`).catch(() => ({}));
    const mainModule = (settings && settings.main_module) || "worker.js";
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ main_module: mainModule })], { type: "application/json" }));
    form.append(mainModule, new Blob([fs.readFileSync(f)], { type: "application/javascript+module" }), mainModule);
    await cfJson(`/accounts/${ACCOUNT}/workers/scripts/${name}/content`, { method: "PUT", body: form });
    console.log(`✅ Worker ${name}: code updated (${mainModule})`);
    continue;
  }

  if (parts[1] === "kv" && parts.length === 4) {
    const title = parts[2];
    const key = path.basename(parts[3], path.extname(parts[3]));
    const id = await namespaceId(title);
    const body = fs.readFileSync(f);
    if (body.length === 0) throw new Error(`${f} is empty — refusing to overwrite KV`);
    const old = await cf(`/accounts/${ACCOUNT}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`);
    if (old.ok) fs.writeFileSync(`cloudflare-backup/kv-${title}-${parts[3]}`, Buffer.from(await old.arrayBuffer()));
    await cfJson(`/accounts/${ACCOUNT}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`, {
      method: "PUT", body, headers: { "Content-Type": "text/plain" },
    });
    // Read back and compare.
    const check = await cf(`/accounts/${ACCOUNT}/storage/kv/namespaces/${id}/values/${encodeURIComponent(key)}`);
    const got = Buffer.from(await check.arrayBuffer());
    if (!got.equals(body)) throw new Error(`KV ${title}/${key}: read-back does not match what was written`);
    console.log(`✅ KV ${title}/${key}: written (${body.length} bytes, read-back OK)`);
    continue;
  }

  console.log(`skipped (not a deployable path): ${f}`);
}
