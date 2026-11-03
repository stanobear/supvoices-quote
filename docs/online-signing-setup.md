# Online signing: one-time setup

Clients sign the order form on their phone. You send it from the quote app, the client
gets a link, confirms their email with a 6-digit code, signs, and both of you receive the
signed PDF by email. The signed PDF has the client's signature in the signature box and a
signature certificate with the audit trail as its last page.

Everything runs in your existing Supabase project, in its own `sales` section of the
database and a private `sales-docs` storage bucket. It doesn't touch the Supvoices app's
tables, and demo resets don't affect it.

Allow about 45 minutes. You need: admin access to the Supabase project, admin access to the
Microsoft 365 tenant that holds `sales@supvoices.com`, and a computer with Node.js.

---

## 1. Create the database section

1. Supabase dashboard → your project → **SQL Editor** → **New query**.
2. Paste the whole of `supabase/migrations/20261103000001_sales_signing.sql` and click **Run**.
3. Check: **Table Editor** → schema `sales` shows `sign_requests`, `sign_codes` and
   `sign_events`; **Storage** shows a private bucket `sales-docs`.

It is safe to run again.

## 2. Let Supvoices send email from sales@supvoices.com

The functions send email through Microsoft Graph as `sales@supvoices.com`. The mailbox can be
a shared mailbox (no licence needed).

**2a. Register an app** (Microsoft Entra admin centre → **App registrations** → **New registration**)

- Name: `Supvoices signing mail`. Single tenant. No redirect URI.
- Copy the **Application (client) ID** and **Directory (tenant) ID**.
- **Certificates & secrets** → **New client secret** → copy the **Value** now (it is shown once).
  Put the expiry date in your calendar.

**2b. Allow it to send as the sales mailbox only** (recommended)

Don't add the Graph `Mail.Send` permission in Entra: that would let the app send as anyone in
the tenant. Instead, grant it for the one mailbox in Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline
# Object ID: Entra → Enterprise applications → Supvoices signing mail → Object ID
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Supvoices signing mail"
New-ManagementScope -Name "Supvoices sales mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'sales@supvoices.com'"
New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" -CustomResourceScope "Supvoices sales mailbox"
# Check:
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource sales@supvoices.com
```

Simpler but broader alternative: in the app registration, **API permissions** → **Microsoft
Graph** → **Application permissions** → `Mail.Send` → **Grant admin consent**.

## 3. Deploy the two functions

From this repository folder on your computer:

```bash
npx supabase login
npx supabase functions deploy sign-admin sign-public --project-ref <your-project-ref>
```

`supabase/config.toml` already switches off the Supabase login check for both functions
(they check their own keys). Your project ref is the `xxxx` in `https://xxxx.supabase.co`.
This adds the two functions next to the app's own functions; it doesn't change those.

## 4. Set the secrets

Make a long random sales key, for example with `openssl rand -hex 32`. Then:

```bash
npx supabase secrets set --project-ref <your-project-ref> \
  SALES_ADMIN_KEY=<your long random key> \
  MAIL_FROM=sales@supvoices.com \
  MS_TENANT_ID=<tenant-id> MS_CLIENT_ID=<client-id> MS_CLIENT_SECRET=<secret value> \
  SIGN_PAGE_URL=https://stanobear.github.io/supvoices-quote/sign.html
```

Optional: `MAIL_COPY_TO=you@example.com` sends an extra copy of every signed order form.
You can also set these in the dashboard: **Edge Functions** → **Secrets**.

## 5. Connect the quote app

On your phone: quote app → **Settings** → **Online signing** → enter
`https://<your-project-ref>.supabase.co` and the sales key → **Save and test**.
It should say "Connected. Emails are sent from sales@supvoices.com."

The key stays on that device and isn't included in backups. Repeat on each device you use.

## 6. Try it on yourself

Make a test quote with your own email as the client, tap **Send to sign**, and sign it from
your phone. Then delete nothing: signed order forms can't be deleted (by design). Test rows
stay in `sales.sign_requests`; that's fine.

---

## Good to know

- **Free plan:** Supabase pauses free projects after 7 days without activity. If your project
  is on the free plan and pauses, signing links stop working until you restore it. Keep using
  it regularly, or move it to the paid plan before sending order forms to real clients.
- **Where things are:** PDFs in Storage → `sales-docs` (`unsigned/` and `signed/`); requests and
  the audit trail in the `sales` tables. The audit trail can't be edited or deleted, and a
  signed request can't be changed.
- **Links:** each link is secret and works until it expires (30 days by default) or is
  withdrawn. "Email a new link" replaces the old link. Codes expire after 10 minutes; after 5
  wrong codes the client must ask for a new one.
- **Client secret expiry:** when the Microsoft secret expires, emails stop. Make a new secret
  and update `MS_CLIENT_SECRET`.
- **Moving later:** to move signing to its own project, run step 1, 3 and 4 against the new
  project and change the URL in the quote app. Signing links already sent keep pointing to the
  old project.
