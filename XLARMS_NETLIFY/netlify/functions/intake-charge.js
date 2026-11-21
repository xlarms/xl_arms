// intake-charge.js — XL Arms pickup-intake $15 background-check service fee.
//
// POST /.netlify/functions/intake-charge  (redirected as /api/intake-charge)
//   Charges the $15.00 pickup service fee for a customer who reached the
//   pickup-intake form WITHOUT a paid pickup order on file — a phone-order
//   customer sent the intake link, or anyone who landed on the form
//   directly. Online-checkout customers already paid the $15 at checkout;
//   they never reach this function (intake-submit finds their paid order
//   and accepts the intake with no charge).
//
//   The browser NEVER sends card numbers here — the card is tokenized in
//   the browser by Authorize.net Accept.js (same pattern as checkout.js),
//   which returns a one-time opaqueData token. This function sends that
//   token to Authorize.net createTransactionRequest (authCaptureTransaction)
//   and charges exactly $15.00 — a fixed fee the server sets, never an
//   amount the browser claims.
//
//   On approval it creates a paid pickup order record in Wasabi under
//   orders-private/<orderId>/record.json (same shape as a checkout pickup
//   order, kind 'intake-pickup-fee'), so intake-submit can find it and the
//   intake links to a real paid order. A staff alert email goes to
//   info@xlarms.us. Email failure never fails a charge that already
//   succeeded — the record is stored first.
//
//   Points (v1, 2026-11-21): if the customer is signed in to a Netlify
//   Identity account, the JWT they send (Authorization: Bearer) is read
//   from context.clientContext.user and the account link is stored on the
//   order record (account + isAccountHolder), so the pickup earns points
//   when staff marks it picked up (see intake-view.js). Guests have no
//   account link and earn nothing. The body's email is only the contact
//   email and is never trusted for identity.
//
//   Test mode (Transaction Processing Mode disabled) never creates a
//   transaction: the gateway answers with a flat "Successful." and no
//   createTransactionResponse. That is treated as a test approval with
//   transId 0 and status 'test' — and intake-submit does NOT accept a
//   'test' order as paid, so a test payment can never unlock a real
//   background check. A real (processing-on) approval always carries a
//   transactionResponse.
//
// Env vars (Netlify — names only, values set by Jonathan):
//   AUTHNET_MODE=sandbox|live, AUTHNET_API_LOGIN_ID,
//   AUTHNET_TRANSACTION_KEY (secret), AUTHNET_CLIENT_KEY,
//   WASABI_BUCKET, WASABI_REGION, WASABI_KEY, WASABI_SECRET,
//   INTAKE_SMTP_PASS (reused for the staff email — same mailbox as the
//   pickup-intake alert).

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ORDERS_PREFIX = 'orders-private';
const PHONE = '(678) 691-6375';
const ALERT_FROM = 'storage@xlarms.us';
const ALERT_TO = 'info@xlarms.us';
const FEE_CENTS = 1500; // $15.00 background-check service fee — fixed, server-side

function mode() {
  return (process.env.AUTHNET_MODE || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
}
function apiUrl(m) {
  return m === 'live'
    ? 'https://api.authorize.net/xml/v1/request.api'
    : 'https://apitest.authorize.net/xml/v1/request.api';
}
const centsToDollars = (c) => (c / 100).toFixed(2);
const money = (c) => '$' + centsToDollars(c);
const s = (v) => String(v == null ? '' : v).trim();

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

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'Method not allowed.' });
    }

    // --- Account holder (points): the user comes ONLY from
    // context.clientContext.user, which Netlify populates when the browser
    // sends a valid Identity JWT as `Authorization: Bearer <token>`. The
    // body's `email` is only the contact email and is never trusted for
    // identity. A guest has no accountUser and earns no points.
    const accountUser = (context && context.clientContext && context.clientContext.user) || null;
    const isAccountHolder = !!(accountUser && accountUser.sub);

    const m = mode();
    const apiLoginID = process.env.AUTHNET_API_LOGIN_ID;
    const transactionKey = process.env.AUTHNET_TRANSACTION_KEY;
    const clientKey = process.env.AUTHNET_CLIENT_KEY;
    if (!apiLoginID || !transactionKey || !clientKey) {
      console.error('intake-charge: Authorize.net env vars not set');
      return fail(503, `Online payment is not set up yet. Please call ${PHONE} and we will take the $15 fee by phone.`);
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return fail(400, 'We could not read the payment. Please try again or call ' + PHONE + '.');
    }

    const firstName = s(body.firstName);
    const lastName = s(body.lastName);
    const phone = s(body.phone);
    const email = s(body.email);
    const billingZip = s(body.billingZip);
    const product = s(body.product);
    const od = body.opaqueData || {};
    if (!firstName || !lastName) return fail(400, 'Full name is required.');
    if (!phone) return fail(400, 'Phone number is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'A valid email address is required.');
    if (!/^\d{5}(-\d{4})?$/.test(billingZip)) return fail(400, 'Billing ZIP code is required.');
    if (!product) return fail(400, 'Product you ordered is required.');
    if (!od.dataDescriptor || !od.dataValue) {
      return fail(400, 'The card could not be read. Nothing was charged. Please try again, or call ' + PHONE + '.');
    }

    // Order ID: ORD-YYYYMMDD-XXXXXX (19 chars — fits Authorize.net's
    // 20-char invoiceNumber / refId limits).
    const now = new Date();
    const orderId = `ORD-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

    const payload = {
      createTransactionRequest: {
        merchantAuthentication: { name: apiLoginID, transactionKey },
        refId: orderId,
        transactionRequest: {
          transactionType: 'authCaptureTransaction',
          amount: centsToDollars(FEE_CENTS),
          payment: { opaqueData: { dataDescriptor: od.dataDescriptor, dataValue: od.dataValue } },
          order: {
            invoiceNumber: orderId,
            description: 'XL Arms pickup intake — $15 background-check service fee',
          },
          // NOTE: key order matters — Authorize.net converts this JSON to
          // XML and validates the element sequence strictly. The schema
          // requires `customer` BEFORE `billTo` inside
          // transactionRequest; the reverse order is rejected with a
          // schema error (found live 2026-11-18).
          customer: { email },
          billTo: { firstName, lastName, zip: billingZip },
          transactionSettings: {
            setting: [{ settingName: 'duplicateWindow', settingValue: '120' }],
          },
        },
      },
    };

    let ctr;
    let gatewayError = null;
    let data = null;
    try {
      const res = await fetch(apiUrl(m), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      try { data = JSON.parse(text); } catch (e) { /* non-JSON reply */ }
      ctr = data && data.createTransactionResponse;
      if (!ctr && data && data.messages && Array.isArray(data.messages.message) && data.messages.message[0]) {
        const em = data.messages.message[0];
        gatewayError = (em.text || em.code || '').toString();
      }
      if (!ctr && !data) {
        console.error('intake-charge: non-JSON reply from Authorize.net, HTTP', res.status, String(text).slice(0, 200));
      }
    } catch (e) {
      console.error('intake-charge: Authorize.net request failed:', e && e.message);
      return fail(502, `The payment system did not answer. Nothing was charged. Please try again or call ${PHONE}.`);
    }

    // Test mode (Transaction Processing Mode disabled) never creates a
    // transaction: the gateway answers with a flat "Successful." and no
    // createTransactionResponse at all. Treat that as a test approval —
    // no money moves and there is no transaction ID.
    let testMode = false;
    if (!ctr && data && data.messages && data.messages.resultCode === 'Ok') {
      testMode = true;
      ctr = {
        messages: data.messages,
        transactionResponse: {
          responseCode: '1',
          transId: '0',
          authCode: '',
          avsResultCode: '',
          accountType: '',
          accountNumber: '',
        },
      };
      console.log(`intake-charge ${orderId}: test-mode approval (no transaction created, transId 0).`);
    }
    if (!ctr) {
      console.error('intake-charge: no createTransactionResponse from Authorize.net', gatewayError || '');
      if (gatewayError) {
        return fail(400, gatewayError + ' Nothing was charged. Please try again or call ' + PHONE + '.');
      }
      return fail(502, `The payment system did not answer. Nothing was charged. Please try again or call ${PHONE}.`);
    }

    const tr = ctr.transactionResponse || {};
    console.log(`intake-charge ${orderId} mode=${m} amount=${money(FEE_CENTS)} resultCode=${ctr.messages && ctr.messages.resultCode} responseCode=${tr.responseCode || ''} transId=${tr.transId || ''}`);

    if (ctr.messages && ctr.messages.resultCode === 'Ok' && tr.responseCode === '1' && tr.transId) {
      // ---- Approved: store the paid order record, then email staff
      // (both best-effort after a successful charge). ----
      const record = {
        id: orderId,
        kind: 'intake-pickup-fee',
        fulfillment: 'pickup',
        items: [{ sku: 'PICKUP-FEE', title: product, qty: 1, price: FEE_CENTS / 100, lineTotal: FEE_CENTS / 100 }],
        itemsTotal: FEE_CENTS / 100,
        shipping: 0,
        taxRate: 0,
        tax: 0,
        amountCharged: FEE_CENTS / 100,
        balanceDueAtPickup: null, // gun price confirmed by staff at pickup
        customer: { firstName, lastName, phone, email, billingZip },
        pickupDay: null,
        ffl: null,
        shippingAddress: null,
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
        status: testMode ? 'test' : 'paid',
        intakeFee: true,
        // Points: account link for a signed-in customer, so the pickup
        // earns points when staff marks it picked up (intake-view.js).
        // Guests have no account link and earn nothing.
        account: isAccountHolder ? { userId: accountUser.sub, email: accountUser.email } : null,
        isAccountHolder,
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
          console.error(`intake-charge ${orderId}: order record storage FAILED (charge succeeded):`, e && e.message);
        }
      } else {
        console.error(`intake-charge ${orderId}: Wasabi env vars not set — order record NOT stored (charge succeeded).`);
      }

      if (process.env.INTAKE_SMTP_PASS) {
        try {
          const mailer = nodemailer.createTransport({
            host: 'mail.xlarms.us',
            port: 465,
            secure: true,
            auth: { user: ALERT_FROM, pass: process.env.INTAKE_SMTP_PASS },
          });
          await mailer.sendMail({
            from: ALERT_FROM,
            to: ALERT_TO,
            subject: `Pickup intake fee paid: ${firstName} ${lastName} — ${orderId}`,
            text: `A $15 background-check service fee was paid from the pickup-intake page.\n\nName: ${firstName} ${lastName}\nPhone: ${phone}\nEmail: ${email}\nProduct: ${product}\nOrder: ${orderId}\nAuthorize.net transaction: ${tr.transId}\n\nThe customer can now submit their pickup information (Form 4473 pre-copy) against this order.`,
          });
        } catch (e) {
          console.error('intake-charge: staff email failed (charge already succeeded):', e && e.message);
        }
      }

      return json(200, {
        ok: true,
        orderId,
        transactionId: String(tr.transId),
        amount: FEE_CENTS / 100,
        testMode,
      });
    }

    // Declined / gateway error — nothing was charged.
    const trMsg = (tr.messages && tr.messages.message && tr.messages.message[0] && tr.messages.message[0].description)
      || (tr.description)
      || 'The card was declined.';
    console.log(`intake-charge ${orderId}: declined — ${trMsg}`);
    return fail(400, trMsg + ' Nothing was charged. Please check the card details and try again, or call ' + PHONE + '.');
  } catch (e) {
    console.error('intake-charge error:', e && e.message);
    return fail(500, 'Something went wrong taking the payment — nothing was charged. Please try again or call ' + PHONE + '.');
  }
};
