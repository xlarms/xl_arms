// authnet-charge.js — XL Arms online checkout (Authorize.net via Accept.js).
//
// POST /.netlify/functions/authnet-charge  (redirected as /api/authnet-charge)
//   Charges one order. The browser NEVER sends card numbers here — the card
//   is tokenized in the browser by Authorize.net Accept.js, which returns a
//   one-time opaqueData token (dataDescriptor + dataValue). This function
//   sends that token to Authorize.net createTransactionRequest
//   (authCaptureTransaction) and charges the amount IT computes from the
//   catalog — never the amount the browser claims. Prices and stock are
//   re-checked against the live catalog for every SKU, so a tampered cart
//   can never change what is charged.
//
// GET /.netlify/functions/authnet-charge
//   Returns the PUBLIC checkout config the browser needs to load Accept.js:
//   mode, apiLoginID, clientKey and the Accept.js script URL. The API Login
//   ID and the Public Client Key are public identifiers by design (the
//   Client Key is meant to be embedded in web pages). The Transaction Key
//   is NEVER returned here and NEVER leaves the server.
//
// Money model (Jonathan — do not change without him):
//   * Norcross pickup: the ONLY money taken online is the $15.00
//     background-check service fee (not a deposit). The customer pays the
//     balance at pickup, after the $15 credit. The order record stores the
//     balance due so staff can see it at the counter.
//   * Ship to FFL: full items total + flat-rate shipping, charged online.
//   * No sales tax is charged online by this function.
//
// Env vars (Netlify — names only, values set by Jonathan):
//   AUTHNET_MODE=sandbox|live   (default sandbox — a missing setting can
//                                 never charge a live card)
//   AUTHNET_API_LOGIN_ID        (sandbox account while testing; live account
//                                 only when going live — the two are different
//                                 accounts and their keys do not mix)
//   AUTHNET_TRANSACTION_KEY     (secret — never in code, logs, or replies)
//   AUTHNET_CLIENT_KEY          (Public Client Key from the Authorize.net
//                                 merchant interface: Settings > Security
//                                 Settings > General Security Settings)
//   WASABI_BUCKET, WASABI_REGION, WASABI_KEY, WASABI_SECRET (already set)
//   INTAKE_SMTP_PASS            (reused for the order email — same mailbox
//                                 as the pickup-intake alert)
//
// Order records: stored in Wasabi under orders-private/<orderId>/record.json
// (same bucket, same AES256 encryption, never on the CDN — the intake
// pattern). A staff alert email goes to info@xlarms.us. Email failure never
// fails an order that is already charged — the record is stored first and
// the failure is logged.

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// --- Money: single source of truth for what an order costs. ---
// PICKUP_FEE_CENTS: the $15.00 background-check service fee — the ONLY
// money taken online for a Norcross pickup order.
const PICKUP_FEE_CENTS = 1500;
// TODO (Jonathan): set the flat-rate shipping charge for ship-to-FFL orders.
// Until this is set, ship-to-FFL orders are charged the items total only
// ($0 shipping). Do NOT invent a price here — Jonathan sets this number.
const SHIPPING_FLAT_RATE_CENTS = 0;

const ORDERS_PREFIX = 'orders-private';
const PHONE = '(678) 691-6375';
const ALERT_FROM = 'storage@xlarms.us';
const ALERT_TO = 'info@xlarms.us';
const MAX_LINES = 100;
const MAX_QTY = 99;

function mode() {
  return (process.env.AUTHNET_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
}
function apiUrl(m) {
  return m === 'live'
    ? 'https://api.authorize.net/xml/v1/request.api'
    : 'https://apitest.authorize.net/xml/v1/request.api';
}
function acceptJsUrl(m) {
  return m === 'live'
    ? 'https://js.authorize.net/v1/Accept.js'
    : 'https://jstest.authorize.net/v1/Accept.js';
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
function fail(statusCode, message) {
  return json(statusCode, { ok: false, error: message, phone: PHONE });
}
const centsToDollars = (c) => (c / 100).toFixed(2);
const money = (c) => '$' + centsToDollars(c);
const s = (v) => String(v == null ? '' : v).trim();
const toCents = (price) => Math.round(Number(price || 0) * 100);

function wasabiClient() {
  const region = process.env.WASABI_REGION || 'us-east-1';
  const endpoint = process.env.WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`;
  return {
    client: new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.WASABI_KEY,
        secretAccessKey: process.env.WASABI_SECRET,
      },
    }),
    bucket: process.env.WASABI_BUCKET,
  };
}

// --- Catalog lookup: same pattern as get-products.js. Primary source is
// the per-letter full-index chunk in the Blobs store (rebuilt daily);
// fallback is the bundled data/products.json sample, so a Blobs outage
// does not take checkout down entirely (it can only price the SKUs in
// that file — anything else fails closed with "not found").
async function loadSkuChunk(event, sku) {
  const first = String(sku || '')[0] ? String(sku)[0].toUpperCase() : '0';
  const key = /^[A-Z]$/.test(first) ? first : '0';
  try {
    const { getStore, connectLambda } = require('@netlify/blobs');
    try { connectLambda(event); } catch (e) {}
    const chunk = await getStore('xl-arms-catalog').get(`full-index-${key}.json`, { type: 'json' });
    if (chunk && Array.isArray(chunk.products)) return chunk.products;
  } catch (e) { /* fall through to the bundled file */ }
  return null;
}
async function loadCatalogFallback() {
  try {
    const fs = require('fs');
    const path = require('path');
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'products.json'), 'utf8'));
    return Array.isArray(d.products) ? d.products : [];
  } catch (e) { return []; }
}
// Returns a Map of upper-case SKU -> { sku, title, price, stock_qty, is_firearm }
// for exactly the SKUs in the order. Throws a customer-facing message on
// any problem (unknown SKU, unpriced, out of stock, not enough stock).
async function priceOrderItems(event, items) {
  const wanted = new Map();
  for (const it of items) wanted.set(String(it.sku).toUpperCase(), it);
  const byLetter = {};
  for (const sku of wanted.keys()) {
    const first = /^[A-Z]$/.test(sku[0]) ? sku[0] : '0';
    (byLetter[first] = byLetter[first] || []).push(sku);
  }
  const found = new Map();
  for (const letter of Object.keys(byLetter)) {
    const chunk = await loadSkuChunk(event, byLetter[letter][0]);
    if (!chunk) continue;
    for (const p of chunk) {
      const up = String(p.sku || '').toUpperCase();
      if (wanted.has(up)) found.set(up, p);
    }
  }
  const missing = [...wanted.keys()].filter((sku) => !found.has(sku));
  if (missing.length) {
    // Last resort: the bundled sample file (covers its SKUs only).
    const fallback = await loadCatalogFallback();
    for (const p of fallback) {
      const up = String(p.sku || '').toUpperCase();
      if (wanted.has(up) && !found.has(up)) found.set(up, p);
    }
  }
  const stillMissing = [...wanted.keys()].filter((sku) => !found.has(sku));
  if (stillMissing.length) {
    throw new Error(`We could not price this item right now (${stillMissing[0]}). Please call ${PHONE} and we will take the order by phone.`);
  }
  const lines = [];
  let itemsCents = 0;
  for (const it of items) {
    const p = found.get(String(it.sku).toUpperCase());
    const unitCents = toCents(p.price);
    if (!(unitCents > 0)) {
      throw new Error(`"${p.title}" is priced on request — please call ${PHONE} for a price.`);
    }
    if (!(p.stock_qty > 0)) {
      throw new Error(`"${p.title}" is out of stock — please call ${PHONE} and we will help.`);
    }
    if (it.qty > p.stock_qty) {
      throw new Error(`Only ${p.stock_qty} of "${p.title}" are in stock — please lower the quantity or call ${PHONE}.`);
    }
    const lineCents = unitCents * it.qty;
    itemsCents += lineCents;
    lines.push({
      sku: p.sku,
      title: p.title,
      price: unitCents / 100,
      qty: it.qty,
      lineTotal: lineCents / 100,
      is_firearm: !!p.is_firearm,
    });
  }
  return { lines, itemsCents };
}

function authnetErrorText(ctr) {
  // Prefer the transaction-level error (declines), then the top-level
  // message (bad request / bad credentials). Never include credentials.
  try {
    const tr = ctr && ctr.transactionResponse;
    if (tr && Array.isArray(tr.errors) && tr.errors[0] && tr.errors[0].errorText) {
      return tr.errors[0].errorText;
    }
    if (tr && Array.isArray(tr.messages) && tr.messages[0] && tr.messages[0].description) {
      return tr.messages[0].description;
    }
    if (ctr && ctr.messages && Array.isArray(ctr.messages.message) && ctr.messages.message[0]) {
      const m = ctr.messages.message[0];
      return m.text || m.code || 'Payment could not be processed.';
    }
  } catch (e) { /* fall through */ }
  return 'Payment could not be processed.';
}

exports.handler = async (event) => {
  // --- GET: public checkout config (no secrets). ---
  if (event.httpMethod === 'GET') {
    const m = mode();
    const configured = Boolean(
      process.env.AUTHNET_API_LOGIN_ID &&
      process.env.AUTHNET_TRANSACTION_KEY &&
      process.env.AUTHNET_CLIENT_KEY,
    );
    return json(200, {
      ok: true,
      mode: m,
      apiLoginID: process.env.AUTHNET_API_LOGIN_ID || '',
      clientKey: process.env.AUTHNET_CLIENT_KEY || '',
      acceptJsUrl: acceptJsUrl(m),
      shippingFlatRate: SHIPPING_FLAT_RATE_CENTS / 100,
      pickupFee: PICKUP_FEE_CENTS / 100,
      configured,
    });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Method not allowed.' });
  }

  const m = mode();
  const apiLoginID = process.env.AUTHNET_API_LOGIN_ID;
  const transactionKey = process.env.AUTHNET_TRANSACTION_KEY;
  const clientKey = process.env.AUTHNET_CLIENT_KEY;
  if (!apiLoginID || !transactionKey || !clientKey) {
    console.error('authnet-charge: Authorize.net env vars not set (AUTHNET_API_LOGIN_ID / AUTHNET_TRANSACTION_KEY / AUTHNET_CLIENT_KEY)');
    return fail(503, `Online checkout is not set up yet. Please call ${PHONE} and we will take your order by phone.`);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return fail(400, 'We could not read the order. Please try again or call ' + PHONE + '.');
  }

  // --- Validate the order (everything the browser claims is re-checked). ---
  const fulfillment = s(body.fulfillment);
  if (fulfillment !== 'pickup' && fulfillment !== 'ship') {
    return fail(400, 'Choose pickup or ship to FFL.');
  }
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_LINES) {
    return fail(400, 'Your cart is empty or too large. Please call ' + PHONE + '.');
  }
  const items = [];
  for (const it of body.items) {
    const sku = s(it && it.sku);
    const qty = Number(it && it.qty);
    if (!sku || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return fail(400, 'Your cart has an item we could not read. Please call ' + PHONE + '.');
    }
    items.push({ sku, qty });
  }
  const firstName = s(body.firstName);
  const lastName = s(body.lastName);
  const phone = s(body.phone);
  const email = s(body.email);
  const billingZip = s(body.billingZip);
  if (!firstName || !lastName) return fail(400, 'Full name is required.');
  if (!phone) return fail(400, 'Phone number is required.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'A valid email address is required.');
  if (!/^\d{5}(-\d{4})?$/.test(billingZip)) return fail(400, 'Billing ZIP code is required.');

  const pickupDay = s(body.pickupDay);
  let ffl = null;
  let shippingAddress = null;
  if (fulfillment === 'ship') {
    // The FFL rule is decided AFTER pricing (below) because it depends on
    // whether the cart actually contains a firearm — see priceOrderItems.
    ffl = body.ffl || null;
    shippingAddress = body.shippingAddress || null;
  }

  const od = body.opaqueData || {};
  const dataDescriptor = s(od.dataDescriptor);
  const dataValue = s(od.dataValue);
  if (!dataDescriptor || !dataValue) {
    return fail(400, 'The card could not be read. Please check the card details and try again, or call ' + PHONE + '.');
  }

  // --- Price the order from the catalog (never trust the browser's total). ---
  let priced;
  try {
    priced = await priceOrderItems(event, items);
  } catch (e) {
    return fail(400, e.message);
  }
  const { lines, itemsCents } = priced;
  const hasFirearm = lines.some((l) => l.is_firearm);

  if (fulfillment === 'ship') {
    if (hasFirearm) {
      const f = ffl || {};
      if (!s(f.name) || !s(f.city) || !s(f.state)) {
        return fail(400, 'A receiving FFL is required for a firearm order — name, city and state at minimum. Pick one from the dealer search or enter it manually.');
      }
      ffl = { name: s(f.name), street: s(f.street), city: s(f.city), state: s(f.state).toUpperCase(), zip: s(f.zip) };
    } else {
      const a = shippingAddress || {};
      if (!s(a.street) || !s(a.city) || !s(a.state) || !/^\d{5}(-\d{4})?$/.test(s(a.zip))) {
        return fail(400, 'A shipping address is required — street, city, state and ZIP.');
      }
      shippingAddress = { street: s(a.street), city: s(a.city), state: s(a.state).toUpperCase(), zip: s(a.zip) };
    }
  }

  // --- Amount: pickup = $15 fee only; ship = items + flat-rate shipping. ---
  const shippingCents = fulfillment === 'ship' ? SHIPPING_FLAT_RATE_CENTS : 0;
  const chargeCents = fulfillment === 'pickup' ? PICKUP_FEE_CENTS : itemsCents + shippingCents;
  const balanceDueCents = fulfillment === 'pickup' ? Math.max(0, itemsCents - PICKUP_FEE_CENTS) : 0;
  if (!(chargeCents > 0)) {
    return fail(400, 'This order has no chargeable amount. Please call ' + PHONE + '.');
  }

  // Order ID: ORD-YYYYMMDD-XXXXXX (19 chars — fits Authorize.net's 20-char
  // invoiceNumber / refId limits).
  const now = new Date();
  const orderId = `ORD-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

  // --- Charge via Authorize.net (authCapture = authorize + capture). ---
  const lineItems = lines.length <= 30 ? {
    lineItem: lines.map((l) => ({
      itemId: String(l.sku).slice(0, 31),
      name: String(l.title).slice(0, 31),
      description: String(l.sku).slice(0, 255),
      quantity: String(l.qty),
      unitPrice: centsToDollars(toCents(l.price)),
    })),
  } : undefined;

  const payload = {
    createTransactionRequest: {
      merchantAuthentication: { name: apiLoginID, transactionKey },
      refId: orderId,
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: centsToDollars(chargeCents),
        payment: { opaqueData: { dataDescriptor, dataValue } },
        order: {
          invoiceNumber: orderId,
          description: fulfillment === 'pickup'
            ? 'XL Arms online order — Norcross pickup ($15 service fee)'
            : 'XL Arms online order — Ship to FFL',
        },
        ...(lineItems ? { lineItems } : {}),
        billTo: { firstName, lastName, zip: billingZip },
        customer: { email },
        transactionSettings: {
          setting: [{ settingName: 'duplicateWindow', settingValue: '120' }],
        },
      },
    },
  };

  let ctr;
  let gatewayError = null;
  try {
    const res = await fetch(apiUrl(m), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* non-JSON reply */ }
    ctr = data && data.createTransactionResponse;
    // Authorize.net returns some gateway-level errors (e.g. E00007
    // authentication failure) in a flat format with no
    // createTransactionResponse wrapper — surface the real reason instead
    // of the generic "did not answer" message.
    if (!ctr && data && data.messages && Array.isArray(data.messages.message) && data.messages.message[0]) {
      const em = data.messages.message[0];
      gatewayError = (em.text || em.code || '').toString();
    }
    if (!ctr && !data) {
      console.error('authnet-charge: non-JSON reply from Authorize.net, HTTP', res.status, String(text).slice(0, 200));
    }
  } catch (e) {
    console.error('authnet-charge: Authorize.net request failed:', e && e.message);
    return fail(502, `The payment system did not answer. Nothing was charged. Please try again or call ${PHONE}.`);
  }
  if (!ctr) {
    console.error('authnet-charge: no createTransactionResponse from Authorize.net', gatewayError || '');
    if (gatewayError) {
      return fail(400, gatewayError + ' Nothing was charged. Please try again or call ' + PHONE + '.');
    }
    return fail(502, `The payment system did not answer. Nothing was charged. Please try again or call ${PHONE}.`);
  }

  const tr = ctr.transactionResponse || {};
  // Log only IDs and codes — never the token, never card data (we never
  // receive card data in the first place).
  console.log(`authnet-charge ${orderId} mode=${m} amount=${money(chargeCents)} resultCode=${ctr.messages && ctr.messages.resultCode} responseCode=${tr.responseCode || ''} transId=${tr.transId || ''}`);

  if (ctr.messages && ctr.messages.resultCode === 'Ok' && tr.responseCode === '1' && tr.transId) {
    // ---- Approved: store the order, then email staff (both best-effort
    // after a successful charge — the customer MUST still get their
    // confirmation even if storage or email has a problem). ----
    const record = {
      id: orderId,
      kind: 'online-order',
      fulfillment,
      items: lines,
      itemsTotal: itemsCents / 100,
      shipping: shippingCents / 100,
      amountCharged: chargeCents / 100,
      balanceDueAtPickup: fulfillment === 'pickup' ? balanceDueCents / 100 : null,
      customer: { firstName, lastName, phone, email, billingZip },
      pickupDay: fulfillment === 'pickup' ? pickupDay : null,
      ffl: fulfillment === 'ship' && hasFirearm ? ffl : null,
      shippingAddress: fulfillment === 'ship' && !hasFirearm ? shippingAddress : null,
      transaction: {
        transId: String(tr.transId),
        authCode: String(tr.authCode || ''),
        responseCode: String(tr.responseCode),
        avsResultCode: String(tr.avsResultCode || ''),
        cardType: String(tr.accountType || ''),
        cardLast4: String(tr.accountNumber || '').replace(/[^0-9]/g, '').slice(-4),
        mode: m,
      },
      submitted_at: now.toISOString(),
      status: 'paid',
    };

    if (process.env.WASABI_BUCKET && process.env.WASABI_KEY && process.env.WASABI_SECRET) {
      try {
        const { client, bucket } = wasabiClient();
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${ORDERS_PREFIX}/${orderId}/record.json`,
          Body: Buffer.from(JSON.stringify(record, null, 2), 'utf8'),
          ContentType: 'application/json',
          ServerSideEncryption: 'AES256',
        }));
      } catch (e) {
        console.error(`authnet-charge ${orderId}: order record storage FAILED (charge succeeded):`, e && e.message);
      }
    } else {
      console.error(`authnet-charge ${orderId}: Wasabi env vars not set — order record NOT stored (charge succeeded).`);
    }

    if (process.env.INTAKE_SMTP_PASS) {
      try {
        const mailer = nodemailer.createTransport({
          host: 'mail.xlarms.us',
          port: 465,
          secure: true,
          auth: { user: ALERT_FROM, pass: process.env.INTAKE_SMTP_PASS },
        });
        const itemLines = lines.map((l) => `  - ${l.title} (${l.sku}) x${l.qty} @ ${money(toCents(l.price))} = ${money(toCents(l.lineTotal))}`).join('\n');
        const fflText = record.ffl
          ? `\nReceiving FFL:\n  ${record.ffl.name}\n  ${[record.ffl.street, record.ffl.city, record.ffl.state, record.ffl.zip].filter(Boolean).join(', ')}\n`
          : '';
        const shipText = record.shippingAddress
          ? `\nShip to:\n  ${record.shippingAddress.street}\n  ${record.shippingAddress.city}, ${record.shippingAddress.state} ${record.shippingAddress.zip}\n`
          : '';
        const pickupText = fulfillment === 'pickup'
          ? `\nPickup:\n  Preferred pickup day: ${pickupDay || '(not given)'}\n  Balance due at pickup: ${money(balanceDueCents)} (the $15 fee is credited toward the price)\n  Customer still needs to send the 4473 pre-copy via pickup-intake.html.\n`
          : '';
        await mailer.sendMail({
          from: ALERT_FROM,
          to: ALERT_TO,
          subject: `New online order ${orderId} — ${money(chargeCents)} — ${fulfillment === 'pickup' ? 'Norcross pickup' : 'Ship to FFL'}`,
          text: `New online order — charged ${money(chargeCents)} via Authorize.net (${m}).\n\nOrder: ${orderId}\nAuthorize.net transaction: ${record.transaction.transId} (auth ${record.transaction.authCode || 'n/a'})\nCard: ${record.transaction.cardType || ''} ending ${record.transaction.cardLast4 || 'n/a'}\n\nCustomer: ${firstName} ${lastName}\nPhone: ${phone}\nEmail: ${email}\n\nItems:\n${itemLines}\n\nItems total: ${money(itemsCents)}${fulfillment === 'ship' ? `\nShipping: ${money(shippingCents)}` : ''}\nCharged today: ${money(chargeCents)}${pickupText}${fflText}${shipText}\nOrder record: Wasabi ${ORDERS_PREFIX}/${orderId}/record.json\n`,
        });
      } catch (e) {
        console.error(`authnet-charge ${orderId}: order email failed (charge succeeded, record stored):`, e && e.message);
      }
    } else {
      console.log(`authnet-charge ${orderId}: INTAKE_SMTP_PASS not set — no order email sent.`);
    }

    return json(200, {
      ok: true,
      orderId,
      transactionId: String(tr.transId),
      authCode: String(tr.authCode || ''),
      amount: chargeCents / 100,
      fulfillment,
      balanceDueAtPickup: fulfillment === 'pickup' ? balanceDueCents / 100 : null,
      mode: m,
    });
  }

  // ---- Not approved: no charge was captured. Show Authorize.net's own
  // error text so the customer knows what to fix. ----
  const errText = authnetErrorText(ctr);
  console.log(`authnet-charge ${orderId}: declined/error — ${errText}`);
  return fail(400, errText + ` Nothing was charged. Please check the card details and try again, or call ${PHONE}.`);
};
