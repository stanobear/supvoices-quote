# Supvoices Quote Builder

A phone-first calculator for pricing Supvoices during client meetings. You enter the client's
answers as you talk (invoice volume, minutes per invoice, staff cost, reservation system) and it
shows the monthly fee, setup fee, estimated saving and payback as you go.

There's no server and no database. Everything runs in the browser and quotes are saved on the device.

## Features
- Live quote: monthly fee (built from an invoice allowance), price per invoice above the allowance,
  setup fee, first-year total, savings and payback
- Two PDFs per client, numbered SV-YYYY-NNN:
  - **Quote**: prices, savings estimate, what's included, onboarding, terms, and a link to the order form
  - **Order form**: the contract the client signs. It follows the Order Form in the Supvoices legal pack
    (parties, what you are buying, fees, term, onboarding, special terms, the documents accepted by
    reference with their versions, and signatures). Empty fields print as blank lines.
- Early-adopter offer (reduced monthly fee for 12 months in return for references), printed as a special term
- JSON export of one quote, or a backup of all quotes and settings; import either one
- Settings for prices, your company details, legal document version and quote numbering
- Works offline once opened, and installs to the home screen

## Online signing of the order form
From the quote, tap **Send to sign**. The client gets a link, reads the order form on their phone,
confirms their email with a one-time code and signs (drawn or typed). Both sides get the signed PDF
by email, with the signature in the signature box and a signature certificate (audit trail) as the
last page.

- `sign.html` is the client's signing page.
- `supabase/` holds the database section (`sales` schema, private `sales-docs` bucket) and two
  edge functions, `sign-admin` (used by the quote app, protected by a sales key) and `sign-public`
  (used by the signing page, addressed by the secret link).
- Email goes out from `sales@supvoices.com` through Microsoft Graph.
- One-time setup: [docs/online-signing-setup.md](docs/online-signing-setup.md).

## Commercial model (matches the legal pack)
- One-off setup fee, invoiced on signature
- Monthly subscription fee with an allowance of Processed Invoices, invoiced monthly in advance
- Processed Invoices above the allowance at a per-invoice price, invoiced monthly in arrears
- Accounting connection (optional):
  - **Xero posting** (standard add-on, fixed setup + monthly): approved bills and credit notes are posted to Xero,
    with a daily integrity check across Supvoices, the reservation system and Xero. Approval happens in Supvoices.
  - **Approval in Xero** (custom): bills are approved in Xero and their status comes back to Supvoices. Built from
    an Integration Specification signed by both parties; setup covers a set number of days, extra days at a day rate.
- 12-month initial term (or 24), renewing for 12 months unless 3 months' notice is given
- Payment within 7 days of the invoice date, prices exclude VAT, unlimited named users, SharePoint records included

## Use it
Open the GitHub Pages URL on your phone, then use **Share → Add to Home Screen** (iPhone) or
**Install app** (Android/Chrome).

## Files
- `index.html` contains the whole app (calculator, PDF layout, storage)
- `vendor/` holds jsPDF 2.5.2 and jspdf-autotable 3.8.4, kept locally so it works offline
- `sw.js` caches the app for offline use
- `manifest.webmanifest` and the `icon-*` files handle home-screen install

## Change prices and defaults
Change prices and company details in the app's **Settings** tab. Changes are stored on that device.

To share them with every device, tap **Save as defaults** at the bottom of Settings. This commits
`defaults.json` to this repository. New devices start from it, and **Reset to defaults** goes back to it.
Saved quotes and the next quote number are never touched.

Saving needs a GitHub fine-grained token, entered once in Settings and kept on that device only:
GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
Repository access: only `stanobear/supvoices-quote`. Permissions: Contents, Read and write.

The repository is public, so `defaults.json` (prices and company details) can be read by anyone.

After changing code files, raise `CACHE` in `sw.js` so installed copies update.
