// Supvoices: create and manage order-form signing requests.
// Called by the quote app. Protected by the SALES_ADMIN_KEY secret (header x-sales-key).
import {
  b64ToBytes, button, cfg, cors, esc, fail, getPdf, isEmail, json, logEvent, mailLayout, pdfResponse, putPdf,
  randomToken, safeEqual, sendMail, sha256Hex, sql, clientInfo,
} from "../_shared/signing.ts";

const MAX_PDF = 8 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("Use POST", 405);
  if (!cfg.adminKey) return fail("SALES_ADMIN_KEY isn't set on the server", 500);
  if (!safeEqual(req.headers.get("x-sales-key") ?? "", cfg.adminKey)) return fail("Wrong sales key", 401);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail("Send JSON"); }
  const info = clientInfo(req);

  try {
    switch (body.action) {
      case "ping": {
        await sql`select 1 from sales.sign_requests limit 1`;
        return json({ ok: true, mailFrom: cfg.mailFrom, emailReady: !!(cfg.msTenant && cfg.msClient && cfg.msSecret) });
      }

      case "create": {
        const email = String(body.signerEmail ?? "").trim().toLowerCase();
        if (!isEmail(email)) return fail("Enter a valid email address for the person signing");
        const quoteNo = String(body.quoteNo ?? "").trim();
        if (!quoteNo) return fail("The quote has no number yet");
        if (typeof body.pdfBase64 !== "string") return fail("The order form PDF is missing");
        const pdf = b64ToBytes(body.pdfBase64);
        if (pdf.length > MAX_PDF) return fail("The order form PDF is too large");
        if (String.fromCharCode(...pdf.subarray(0, 5)) !== "%PDF-") return fail("That isn't a PDF");

        const token = randomToken();
        const tokenHash = await sha256Hex(token);
        const sha = await sha256Hex(pdf);
        const days = Math.min(90, Math.max(1, Number(body.expiresDays) || 30));
        const [row] = await sql`
          insert into sales.sign_requests (token_hash, quote_no, company, signer_email, signer_name, signer_title, summary, sign_box,
                                           unsigned_path, unsigned_sha256, expires_at)
          values (${tokenHash}, ${quoteNo}, ${String(body.company ?? "")}, ${email}, ${String(body.signerName ?? "")},
                  ${String(body.signerTitle ?? "")}, ${sql.json(body.summary ?? {})}, ${body.signBox ? sql.json(body.signBox) : null},
                  'pending', ${sha}, now() + make_interval(days => ${days}))
          returning id, expires_at`;
        const path = `unsigned/${row.id}.pdf`;
        await putPdf(path, pdf);
        await sql`update sales.sign_requests set unsigned_path = ${path} where id = ${row.id}`;
        await logEvent(row.id, "created", info, { quoteNo, sha256: sha });

        const url = `${cfg.signPageUrl}#t=${token}&f=${encodeURIComponent(cfg.publicUrl)}`;
        let emailed = false, emailError: string | null = null;
        if (body.sendEmail !== false) {
          try {
            await sendInvite(email, String(body.signerName ?? ""), String(body.company ?? ""), quoteNo, url, new Date(row.expires_at), String(body.message ?? ""));
            emailed = true;
            await logEvent(row.id, "emailed", {}, { to: email });
          } catch (e) { emailError = (e as Error).message; }
        }
        return json({ id: row.id, url, status: "sent", expiresAt: row.expires_at, emailed, emailError });
      }

      case "status": {
        const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((x: unknown) => typeof x === "string").slice(0, 200) : [];
        if (!ids.length) return json({ requests: [] });
        const rows = await sql`
          select id, quote_no, status, signer_email, created_at, opened_at, signed_at, signed_name, signed_title, expires_at, cancelled_at,
                 signed_sha256
          from sales.sign_requests where id = any(${ids}::uuid[])`;
        return json({ requests: rows });
      }

      case "download": {
        const [r] = await sql`select quote_no, unsigned_path, signed_path, status from sales.sign_requests where id = ${String(body.id)}::uuid`;
        if (!r) return fail("Signing request not found", 404);
        const signed = body.which !== "unsigned" && r.status === "signed";
        const bytes = await getPdf(signed ? r.signed_path : r.unsigned_path);
        return pdfResponse(bytes, `Supvoices-Order-Form-${r.quote_no}${signed ? "-signed" : ""}.pdf`);
      }

      case "resend": {
        const [r] = await sql`select * from sales.sign_requests where id = ${String(body.id)}::uuid`;
        if (!r) return fail("Signing request not found", 404);
        if (r.status === "signed" || r.status === "cancelled") return fail(`This order form is already ${r.status}`);
        // A new link replaces the old one, so a forwarded or lost email can't be used.
        const token = randomToken();
        await sql`update sales.sign_requests set token_hash = ${await sha256Hex(token)},
                  expires_at = greatest(expires_at, now() + interval '7 days') where id = ${r.id}`;
        const url = `${cfg.signPageUrl}#t=${token}&f=${encodeURIComponent(cfg.publicUrl)}`;
        await sendInvite(r.signer_email, r.signer_name, r.company, r.quote_no, url, new Date(r.expires_at), "");
        await logEvent(r.id, "emailed", {}, { to: r.signer_email, resent: true });
        return json({ ok: true, url });
      }

      case "cancel": {
        const [r] = await sql`update sales.sign_requests set status = 'cancelled', cancelled_at = now()
                              where id = ${String(body.id)}::uuid and status in ('sent','opened') returning id`;
        if (!r) return fail("Only an unsigned order form can be cancelled");
        await logEvent(r.id, "cancelled", info);
        return json({ ok: true });
      }

      default:
        return fail("Unknown action");
    }
  } catch (e) {
    console.error(e);
    return fail((e as Error).message || "Something went wrong", 500);
  }
});

async function sendInvite(to: string, name: string, company: string, quoteNo: string, url: string, expires: Date, message: string) {
  const exp = expires.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const html = mailLayout(`Order form ${quoteNo} is ready to sign`, `
<p>${name ? "Hello " + esc(name.split(" ")[0]) + "," : "Hello,"}</p>
${message ? `<p>${esc(message).replace(/\n/g, "<br>")}</p>` : ""}
<p>The Supvoices order form ${esc(quoteNo)}${company ? " for " + esc(company) : ""} is ready for you to review and sign. It takes a couple of minutes and works on your phone.</p>
${button(url, "Review and sign")}
<p style="font-size:13px;color:#5B6B82">We'll email a one-time code to this address to confirm it's you. The link works until ${esc(exp)}. If you weren't expecting this, you can ignore this email.</p>`);
  await sendMail({ to: [to], subject: `Supvoices order form ${quoteNo} to sign`, html });
}
