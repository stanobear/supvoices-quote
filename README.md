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

## Commercial model (matches the legal pack)
- One-off setup fee, invoiced on signature
- Monthly subscription fee with an allowance of Processed Invoices, invoiced monthly in advance
- Processed Invoices above the allowance at a per-invoice price, invoiced monthly in arrears
- 12-month initial term (or 24), renewing for 12 months unless 3 months' notice is given
- Payment within 30 days, prices exclude VAT, unlimited named users, SharePoint records included

## Use it
Open the GitHub Pages URL on your phone, then use **Share → Add to Home Screen** (iPhone) or
**Install app** (Android/Chrome).

## Files
- `index.html` contains the whole app (calculator, PDF layout, storage)
- `vendor/` holds jsPDF 2.5.2 and jspdf-autotable 3.8.4, kept locally so it works offline
- `sw.js` caches the app for offline use
- `manifest.webmanifest` and the `icon-*` files handle home-screen install

## Change prices
Use the **Price list** tab (which also holds your company details and the quote and order form terms) in the app. Your changes are stored on the device. To change the defaults
for everyone, edit `DEFAULT_PRICES` and `DEFAULT_SELLER` in `index.html`.

After changing files, raise `CACHE` in `sw.js` (e.g. `svq-v2`) so installed copies update.
