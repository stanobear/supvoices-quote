# Supvoices Quote Builder

A phone-first calculator for pricing Supvoices during client meetings. You enter the client's
answers as you talk (invoice volume, minutes per invoice, staff cost, reservation system) and it
shows the monthly fee, setup fee, estimated saving and payback as you go.

There's no server and no database. Everything runs in the browser and quotes are saved on the device.

## Features
- Live quote: monthly fee (tiered per-invoice pricing), setup fee, first-year total, savings, payback
- Two PDFs per client: a **quote** (prices, savings, what's included) and an **order form** to sign
  (customer and supplier details, subscription, setup fees, billing, terms, signatures for both parties).
  Download, preview, or share both at once to email/WhatsApp on phones. Empty order-form fields print as
  blank lines for the client to fill in by hand.
- JSON export of a single quote, or a backup of all quotes and your price list; import either one
- Editable price list and "your details" shown on the PDF
- Works offline once it has been opened, and can be installed to the home screen

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
