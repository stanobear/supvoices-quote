// Shared code for the Supvoices order form signing functions.
import postgres from "npm:postgres@3.4.5";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

export const cfg = {
  supabaseUrl: env("SUPABASE_URL").replace(/\/$/, ""),
  // Address the signing page uses to reach the functions (the same as SUPABASE_URL on Supabase).
  publicUrl: (env("PUBLIC_SUPABASE_URL") || env("SUPABASE_URL")).replace(/\/$/, ""),
  serviceKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  dbUrl: env("SUPABASE_DB_URL"),
  adminKey: env("SALES_ADMIN_KEY"),
  signPageUrl: env("SIGN_PAGE_URL", "https://stanobear.github.io/supvoices-quote/sign.html"),
  mailFrom: env("MAIL_FROM", "sales@supvoices.com"),
  mailCopyTo: env("MAIL_COPY_TO"), // optional extra copy of signed order forms
  msTenant: env("MS_TENANT_ID"),
  msClient: env("MS_CLIENT_ID"),
  msSecret: env("MS_CLIENT_SECRET"),
  msLoginBase: env("MS_LOGIN_BASE", "https://login.microsoftonline.com"),
  msGraphBase: env("MS_GRAPH_BASE", "https://graph.microsoft.com"),
  bucket: "sales-docs",
};

export const sql = postgres(cfg.dbUrl, { prepare: false, max: 3, idle_timeout: 20 });

/* ---------------- http ---------------- */
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-sales-key, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "content-type": "application/json" } });
export const fail = (message: string, status = 400) => json({ error: message }, status);
export const pdfResponse = (bytes: Uint8Array, name: string) =>
  new Response(bytes as unknown as BodyInit, { headers: { ...cors, "content-type": "application/pdf", "content-disposition": `inline; filename="${name}"` } });

export function clientInfo(req: Request) {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const ip = (req.headers.get("cf-connecting-ip") || fwd.split(",")[0] || req.headers.get("x-real-ip") || "").trim();
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 400);
  return { ip, ua };
}

/* ---------------- crypto ---------------- */
export async function sha256Hex(data: Uint8Array | string) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}
export function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
export const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/^data:[^,]+,/, "")), (c) => c.charCodeAt(0));
export function bytesToB64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function maskEmail(e: string) {
  const [u, d] = e.split("@");
  if (!d) return e;
  return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.min(6, u.length - 2))) + "@" + d;
}
export const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/* ---------------- storage ---------------- */
async function storageFetch(path: string, init: RequestInit = {}) {
  return await fetch(`${cfg.supabaseUrl}/storage/v1/object/${cfg.bucket}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.serviceKey}`, apikey: cfg.serviceKey, ...(init.headers ?? {}) },
  });
}
export async function putPdf(path: string, bytes: Uint8Array) {
  const r = await storageFetch(path, { method: "POST", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: bytes as unknown as BodyInit });
  if (!r.ok) throw new Error(`storage upload failed (${r.status}): ${await r.text()}`);
}
export async function getPdf(path: string) {
  const r = await storageFetch(path);
  if (!r.ok) throw new Error(`storage download failed (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

/* ---------------- events ---------------- */
export async function logEvent(requestId: string, type: string, info: { ip?: string; ua?: string } = {}, detail: Record<string, unknown> = {}) {
  await sql`insert into sales.sign_events (request_id, type, ip, user_agent, detail)
            values (${requestId}, ${type}, ${info.ip ?? null}, ${info.ua ?? null}, ${sql.json(detail as any)})`;
}

/* ---------------- email (Microsoft Graph, from the sales mailbox) ---------------- */
let tokenCache: { token: string; exp: number } | null = null;
async function graphToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  if (!cfg.msTenant || !cfg.msClient || !cfg.msSecret) throw new Error("email isn't set up: MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET are needed");
  const r = await fetch(`${cfg.msLoginBase}/${cfg.msTenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.msClient, client_secret: cfg.msSecret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`Microsoft sign-in failed: ${j.error_description ?? r.status}`);
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}
export async function sendMail(opts: { to: string[]; subject: string; html: string; attachments?: { name: string; bytes: Uint8Array }[] }) {
  const token = await graphToken();
  const message = {
    subject: opts.subject,
    body: { contentType: "HTML", content: opts.html },
    toRecipients: opts.to.map((a) => ({ emailAddress: { address: a } })),
    attachments: (opts.attachments ?? []).map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment", name: a.name, contentType: "application/pdf", contentBytes: bytesToB64(a.bytes),
    })),
  };
  const r = await fetch(`${cfg.msGraphBase}/v1.0/users/${encodeURIComponent(cfg.mailFrom)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!r.ok) throw new Error(`sending email failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
}

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
export function mailLayout(title: string, bodyHtml: string) {
  return `<!doctype html><html><body style="margin:0;background:#EEF2F6;font-family:Segoe UI,Arial,sans-serif;color:#14233C">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2F6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#14233C;padding:18px 24px;color:#ffffff;font-size:20px;font-weight:bold">Supvoices</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.5">
<h1 style="font-size:19px;margin:0 0 14px">${esc(title)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #D6DEE8;font-size:12px;color:#5B6B82">Supvoices · ${esc(cfg.mailFrom)}</td></tr>
</table></td></tr></table></body></html>`;
}
export const button = (href: string, label: string) =>
  `<p style="margin:22px 0"><a href="${esc(href)}" style="background:#24395E;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">${esc(label)}</a></p>`;
export { esc };

/* ---------------- PDF stamping ---------------- */
// pdf-lib's standard fonts only cover WinAnsi; anything else becomes "?".
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function winAnsi(s: string) {
  return String(s ?? "").replace(/[−]/g, "-").replace(/[  ]/g, " ")
    .split("").map((ch) => {
      const c = ch.charCodeAt(0);
      return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch) ? ch : "?";
    }).join("");
}

export type Box = { x: number; y: number; w: number; h: number }; // PDF points, measured from the top-left of the page
export type SignBox = { page: number; sig?: Box; name?: Box; title?: Box; date?: Box };

export type StampInput = {
  unsigned: Uint8Array;
  signBox?: SignBox | null;
  signaturePng?: Uint8Array | null;
  typedSignature?: string | null;
  name: string; title: string; email: string;
  signedAt: Date;
  quoteNo: string; company: string;
  unsignedSha256: string;
  ip: string; ua: string;
  events: { type: string; at: Date; ip?: string | null }[];
  supplier: string;
};

const EVENT_LABEL: Record<string, string> = {
  created: "Order form issued by the supplier", emailed: "Signing link emailed to the signer", opened: "Signing page opened",
  code_sent: "One-time code emailed to the signer", code_verified: "One-time code confirmed", signed: "Order form signed",
};
const fmt = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

export async function stampPdf(i: StampInput) {
  const pdf = await PDFDocument.load(i.unsigned);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const oblique = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const ink = rgb(20 / 255, 35 / 255, 60 / 255), muted = rgb(96 / 255, 110 / 255, 132 / 255), green = rgb(43 / 255, 182 / 255, 115 / 255);
  const sigImage = i.signaturePng ? await pdf.embedPng(i.signaturePng) : null;
  const dateText = i.signedAt.toISOString().slice(0, 10);

  // 1. Fill the customer's signature cells on the order form itself.
  const pages = pdf.getPages();
  const sb = i.signBox;
  if (sb && sb.page >= 1 && sb.page <= pages.length) {
    const page = pages[sb.page - 1];
    const H = page.getHeight();
    const text = (b: Box | undefined, s: string, size = 9.5) => {
      if (!b || !s) return;
      let t = winAnsi(s), sz = size;
      while (sz > 6 && helv.widthOfTextAtSize(t, sz) > b.w - 4) sz -= 0.5;
      page.drawText(t, { x: b.x + 2, y: H - b.y - b.h / 2 - sz / 3, size: sz, font: helv, color: ink });
    };
    if (sb.sig) {
      const b = sb.sig, pad = 1.5;
      if (sigImage) {
        const scale = Math.min((b.w - pad * 2) / sigImage.width, (b.h - pad * 2) / sigImage.height);
        const w = sigImage.width * scale, h = sigImage.height * scale;
        page.drawImage(sigImage, { x: b.x + pad, y: H - b.y - pad - h, width: w, height: h });
      } else if (i.typedSignature) {
        let sz = 16; const t = winAnsi(i.typedSignature);
        while (sz > 8 && oblique.widthOfTextAtSize(t, sz) > b.w - 6) sz -= 1;
        page.drawText(t, { x: b.x + 3, y: H - b.y - b.h / 2 - sz / 3, size: sz, font: oblique, color: ink });
      }
    }
    text(sb.name, i.name); text(sb.title, i.title); text(sb.date, dateText);
  }

  // 2. Add a signature certificate page.
  const page = pdf.addPage([595.28, 841.89]);
  const W = page.getWidth(), L = 51, R = W - 51;
  let y = 841.89 - 60;
  page.drawRectangle({ x: 0, y: 841.89 - 30, width: W, height: 30, color: ink });
  page.drawText("Supvoices", { x: L, y: 841.89 - 20, size: 12, font: bold, color: rgb(1, 1, 1) });
  page.drawText("SIGNATURE CERTIFICATE", { x: R - bold.widthOfTextAtSize("SIGNATURE CERTIFICATE", 9), y: 841.89 - 19, size: 9, font: bold, color: rgb(1, 1, 1) });
  page.drawText(winAnsi(`Order Form ${i.quoteNo}`), { x: L, y, size: 18, font: bold, color: ink }); y -= 20;
  page.drawText(winAnsi(`${i.company} and ${i.supplier}`), { x: L, y, size: 10.5, font: helv, color: muted }); y -= 26;

  const wrap = (s: string, font = helv, size = 9.5, width = R - L) => {
    const words = winAnsi(s).split(/\s+/); const lines: string[] = []; let cur = "";
    for (const w of words) { const t = cur ? cur + " " + w : w; if (font.widthOfTextAtSize(t, size) > width && cur) { lines.push(cur); cur = w } else cur = t }
    if (cur) lines.push(cur); return lines;
  };
  const row = (label: string, value: string, mono = false) => {
    page.drawText(winAnsi(label), { x: L, y, size: 8.5, font: bold, color: muted });
    const lines = wrap(value, mono ? helv : helv, mono ? 8.5 : 9.5, R - L - 150);
    lines.forEach((ln, k) => page.drawText(ln, { x: L + 150, y: y - k * 12, size: mono ? 8.5 : 9.5, font: helv, color: ink }));
    y -= Math.max(1, lines.length) * 12 + 7;
    page.drawLine({ start: { x: L, y: y + 3 }, end: { x: R, y: y + 3 }, thickness: 0.4, color: rgb(214 / 255, 222 / 255, 232 / 255) });
    y -= 6;
  };
  row("Signed by", i.name);
  row("Job title", i.title);
  row("Email", `${i.email} (confirmed with a one-time code sent to this address)`);
  row("Signed at", fmt(i.signedAt));
  row("IP address", i.ip || "not available");
  row("Device", i.ua || "not available");
  row("Document", `Order Form ${i.quoteNo}, pages 1 to ${pages.length}`);
  row("SHA-256 of the document as issued", i.unsignedSha256, true);

  y -= 6;
  page.drawText("Signature", { x: L, y, size: 8.5, font: bold, color: muted }); y -= 8;
  page.drawRectangle({ x: L, y: y - 58, width: 230, height: 58, borderColor: rgb(214 / 255, 222 / 255, 232 / 255), borderWidth: 0.6 });
  if (sigImage) {
    const scale = Math.min(222 / sigImage.width, 50 / sigImage.height);
    page.drawImage(sigImage, { x: L + 4, y: y - 54, width: sigImage.width * scale, height: sigImage.height * scale });
  } else if (i.typedSignature) {
    page.drawText(winAnsi(i.typedSignature), { x: L + 8, y: y - 34, size: 18, font: oblique, color: ink });
  }
  page.drawText(sigImage ? "Drawn by the signer" : "Typed by the signer", { x: L + 240, y: y - 12, size: 8.5, font: helv, color: muted });
  y -= 76;

  page.drawText("Declaration", { x: L, y, size: 8.5, font: bold, color: muted }); y -= 13;
  for (const ln of wrap(`By signing, ${i.name} confirmed that they are authorised to sign for ${i.company}, that ${i.company} has had the opportunity to read the documents listed in section 7 of the Order Form and accepts them, and that they intend this electronic signature to have the same effect as a handwritten signature.`)) {
    page.drawText(ln, { x: L, y, size: 9.5, font: helv, color: ink }); y -= 12.5;
  }
  y -= 12;

  page.drawText("Audit trail", { x: L, y, size: 8.5, font: bold, color: muted }); y -= 14;
  for (const e of i.events) {
    if (y < 80) break;
    page.drawCircle({ x: L + 3, y: y + 3, size: 2, color: green });
    page.drawText(fmt(e.at), { x: L + 12, y, size: 8.5, font: helv, color: muted });
    page.drawText(winAnsi((EVENT_LABEL[e.type] ?? e.type) + (e.ip ? `  (IP ${e.ip})` : "")), { x: L + 125, y, size: 8.5, font: helv, color: ink });
    y -= 13;
  }

  page.drawLine({ start: { x: L, y: 50 }, end: { x: R, y: 50 }, thickness: 0.4, color: rgb(214 / 255, 222 / 255, 232 / 255) });
  page.drawText(winAnsi(`This page forms part of signed Order Form ${i.quoteNo}.`), { x: L, y: 38, size: 7.5, font: helv, color: muted });

  pdf.setModificationDate(i.signedAt);
  return await pdf.save();
}
