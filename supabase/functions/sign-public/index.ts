// Supvoices: the client-facing side of order-form signing.
// Everything is addressed by the secret token in the signing link; only its hash is stored.
import {
  b64ToBytes, cfg, clientInfo, cors, esc, fail, getPdf, json, logEvent, mailLayout, maskEmail, pdfResponse, putPdf,
  randomCode, sendMail, sha256Hex, sql, stampPdf,
} from "../_shared/signing.ts";

const CODE_MINUTES = 10, MAX_ATTEMPTS = 5, MAX_SENDS = 5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("Use POST", 405);
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail("Send JSON"); }
  const token = String(body.token ?? "");
  if (token.length < 30) return fail("This signing link isn't complete. Open it again from the email.", 404);
  const info = clientInfo(req);

  try {
    const [r] = await sql`select * from sales.sign_requests where token_hash = ${await sha256Hex(token)}`;
    if (!r) return fail("This signing link isn't valid any more. Ask Supvoices to send a new one.", 404);
    const expired = new Date(r.expires_at) < new Date() && r.status !== "signed";
    const supplierName = String(r.summary?.supplier ?? "Supvoices");

    switch (body.action) {
      case "open": {
        if (r.status === "sent" && !expired) {
          await sql`update sales.sign_requests set status = 'opened', opened_at = now() where id = ${r.id} and status = 'sent'`;
          await logEvent(r.id, "opened", info);
        }
        return json({
          quoteNo: r.quote_no, company: r.company, summary: r.summary,
          signerName: r.signer_name, signerTitle: r.signer_title, email: maskEmail(r.signer_email),
          status: expired ? "expired" : (r.status === "sent" ? "opened" : r.status),
          expiresAt: r.expires_at, signedAt: r.signed_at, signedName: r.signed_name,
        });
      }

      case "pdf": {
        const signed = r.status === "signed";
        const bytes = await getPdf(signed ? r.signed_path : r.unsigned_path);
        return pdfResponse(bytes, `Supvoices-Order-Form-${r.quote_no}${signed ? "-signed" : ""}.pdf`);
      }

      case "send-code": {
        if (r.status === "signed") return fail("This order form is already signed.");
        if (r.status === "cancelled") return fail("This order form was withdrawn. Ask Supvoices for a new one.");
        if (expired) return fail("This signing link has expired. Ask Supvoices to send a new one.");
        const [c] = await sql`select sent_count from sales.sign_codes where request_id = ${r.id}`;
        if (c && c.sent_count >= MAX_SENDS) return fail("Too many codes sent. Ask Supvoices to send a new link.", 429);
        const code = randomCode();
        const hash = await sha256Hex(`${r.id}:${code}`);
        await sql`insert into sales.sign_codes (request_id, code_hash, expires_at, attempts, sent_count)
                  values (${r.id}, ${hash}, now() + make_interval(mins => ${CODE_MINUTES}), 0, 1)
                  on conflict (request_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at,
                    attempts = 0, sent_count = sales.sign_codes.sent_count + 1, verified_at = null`;
        await sendMail({
          to: [r.signer_email],
          subject: `Your Supvoices signing code: ${code}`,
          html: mailLayout("Your signing code", `<p>Use this code to sign Supvoices order form ${esc(r.quote_no)}:</p>
<p style="font-size:30px;font-weight:bold;letter-spacing:6px;font-family:Consolas,monospace;margin:18px 0">${code}</p>
<p style="font-size:13px;color:#5B6B82">It works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.</p>`),
        });
        await logEvent(r.id, "code_sent", info, { to: maskEmail(r.signer_email) });
        return json({ ok: true, sentTo: maskEmail(r.signer_email), minutes: CODE_MINUTES });
      }

      case "sign": {
        if (r.status === "signed") return fail("This order form is already signed.");
        if (r.status === "cancelled") return fail("This order form was withdrawn. Ask Supvoices for a new one.");
        if (expired) return fail("This signing link has expired. Ask Supvoices to send a new one.");
        const name = String(body.name ?? "").trim().slice(0, 120);
        const title = String(body.title ?? "").trim().slice(0, 120);
        if (name.length < 2) return fail("Enter your full name.");
        if (!title) return fail("Enter your job title.");
        if (body.consent !== true) return fail("Tick the box to confirm you're authorised to sign.");
        const typed = typeof body.typedSignature === "string" ? body.typedSignature.trim().slice(0, 80) : "";
        let png: Uint8Array | null = null;
        if (typeof body.signaturePng === "string" && body.signaturePng.startsWith("data:image/png;base64,")) {
          png = b64ToBytes(body.signaturePng);
          if (png.length > 600_000) return fail("The signature image is too large.");
        }
        if (!png && !typed) return fail("Draw or type your signature.");

        // Check the one-time code.
        const code = String(body.code ?? "").replace(/\D/g, "");
        const [c] = await sql`select * from sales.sign_codes where request_id = ${r.id}`;
        if (!c) return fail("Ask for a code first.");
        if (c.attempts >= MAX_ATTEMPTS) return fail("Too many wrong codes. Ask for a new code.", 429);
        if (new Date(c.expires_at) < new Date()) return fail("That code has expired. Ask for a new one.");
        if (await sha256Hex(`${r.id}:${code}`) !== c.code_hash) {
          await sql`update sales.sign_codes set attempts = attempts + 1 where request_id = ${r.id}`;
          return fail("That code isn't right. Check the latest email and try again.");
        }
        await sql`update sales.sign_codes set verified_at = now() where request_id = ${r.id}`;
        await logEvent(r.id, "code_verified", info);

        // Stamp the PDF, then record the signature in one go.
        const signedAt = new Date();
        const unsigned = await getPdf(r.unsigned_path);
        if (await sha256Hex(unsigned) !== r.unsigned_sha256) throw new Error("The stored order form doesn't match the one issued.");
        const events = await sql`select type, at, ip from sales.sign_events where request_id = ${r.id} order by at, id`;
        const signedBytes = await stampPdf({
          unsigned, signBox: r.sign_box, signaturePng: png, typedSignature: typed || null,
          name, title, email: r.signer_email, signedAt, quoteNo: r.quote_no, company: r.company,
          unsignedSha256: r.unsigned_sha256, ip: info.ip, ua: info.ua, supplier: supplierName,
          events: [...events.map((e: any) => ({ type: e.type, at: new Date(e.at), ip: e.ip })), { type: "signed", at: signedAt, ip: info.ip }],
        });
        const signedSha = await sha256Hex(signedBytes);
        const path = `signed/${r.id}.pdf`;
        await putPdf(path, signedBytes);
        const [done] = await sql`
          update sales.sign_requests set status = 'signed', signed_at = ${signedAt}, signed_name = ${name}, signed_title = ${title},
            signed_ip = ${info.ip || null}, signed_user_agent = ${info.ua || null}, signed_path = ${path}, signed_sha256 = ${signedSha}
          where id = ${r.id} and status in ('sent','opened') returning id`;
        if (!done) return fail("This order form was signed or withdrawn a moment ago.");
        await logEvent(r.id, "signed", info, { name, title, signedSha256: signedSha, method: png ? "drawn" : "typed" });

        // Email the signed copy to the signer and to the sales mailbox.
        let emailed = true;
        try {
          const fileName = `Supvoices-Order-Form-${r.quote_no}-signed.pdf`;
          const html = mailLayout(`Signed: order form ${r.quote_no}`, `
<p>Thank you, ${esc(name.split(" ")[0])}. ${esc(r.company || "Your company")}'s order form ${esc(r.quote_no)} was signed on ${esc(signedAt.toUTCString())}.</p>
<p>The signed PDF is attached. Its last page is the signature certificate with the audit trail.</p>
<p style="font-size:12px;color:#5B6B82">SHA-256 of the signed PDF: ${signedSha}</p>`);
          const to = [r.signer_email];
          await sendMail({ to, subject: `Signed: Supvoices order form ${r.quote_no}`, html, attachments: [{ name: fileName, bytes: signedBytes }] });
          const copy = [cfg.mailFrom, ...(cfg.mailCopyTo ? cfg.mailCopyTo.split(",").map((s) => s.trim()).filter(Boolean) : [])];
          await sendMail({ to: copy, subject: `Signed: order form ${r.quote_no} (${r.company})`, html, attachments: [{ name: fileName, bytes: signedBytes }] });
        } catch (e) { emailed = false; console.error(e); }
        return json({ ok: true, signedAt, emailed });
      }

      default:
        return fail("Unknown action");
    }
  } catch (e) {
    console.error(e);
    return fail("Something went wrong on our side. Try again in a minute.", 500);
  }
});
