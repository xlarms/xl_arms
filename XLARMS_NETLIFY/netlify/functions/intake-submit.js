// intake-submit.js — XL Arms secure pre-pickup intake (submission endpoint).
//
// Accepts the pickup-intake.html form (JSON with base64 ID photo) over
// HTTPS and stores it in a SEPARATE private Wasabi prefix, intake-private/,
// inside the existing bucket. NEVER connected to the Bunny CDN, NEVER a
// public URL, server-side encryption on every upload.
//
// What is stored per submission (key intake-private/<id>/):
//   record.json   — name, contact, order ref, pickup day, typed pre-signature,
//                   submitted_at, pickup_at (null until staff marks picked up), status
//   id-front.jpg  — front of Georgia ID/license (required)
//   id-back.jpg   — back of ID (optional)
// This is a PRE-COPY only — NOT the official Form 4473. No eligibility
// questions are asked. The official form is signed in person at pickup and
// lives in XL Arms' own acquisition/disposition log, never in this store.
//
// Retention (Jonathan, 2026-11-05): ID photo + record are deleted 30 days
// after pickup_at if picked up, or 30 days after submitted_at if never
// picked up. See intake-cleanup.js.
//
// Env vars (Netlify, read only — never hardcode values here):
//   WASABI_BUCKET, WASABI_REGION, WASABI_KEY, WASABI_SECRET
//   (WASABI_ENDPOINT optional override, else s3.<region>.wasabisys.com)
//   INTAKE_SMTP_PASS — password for storage@xlarms.us (set as a secret in
//   Netlify by Jonathan). Sender and recipient are fixed in code below:
//   from storage@xlarms.us, to info@xlarms.us. No new env vars needed for them.
// No new dependency: @aws-sdk/client-s3 is already in package.json.
// nodemailer is added in package.json for the staff alert email.

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const PREFIX = 'intake-private';
const PHONE = '(678) 691-6375';
const ALERT_FROM = 'storage@xlarms.us';
const ALERT_TO = 'info@xlarms.us';
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8 MB per photo
const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

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

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

// The customer-facing error. Never echo the ID image or field contents back.
function fail(message) {
  return json(400, { ok: false, error: message, phone: PHONE });
}

function parsePhoto(photo, label, required) {
  if (!photo) {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }
  const data = photo.data || photo.base64 || '';
  const type = (photo.type || '').toLowerCase();
  if (!ALLOWED_TYPES[type]) {
    throw new Error(`${label} must be a JPG, PNG or WebP photo.`);
  }
  const buf = Buffer.from(String(data).replace(/^data:[^,]+,/, ''), 'base64');
  if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) {
    throw new Error(`${label} photo is missing or too large (max 8 MB).`);
  }
  return { buf, ext: ALLOWED_TYPES[type], type };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'Method not allowed.' });
    }
    if (!process.env.WASABI_BUCKET || !process.env.WASABI_KEY || !process.env.WASABI_SECRET) {
      console.error('intake-submit: missing Wasabi env vars');
      return fail('We could not receive your information right now. Please call ' + PHONE + ' and we will take it by phone.');
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return fail('We could not read the form. Please try again or call ' + PHONE + '.');
    }

    const fullName = String(body.fullName || '').trim();
    const phone = String(body.phone || '').trim();
    const email = String(body.email || '').trim();
    const product = String(body.product || '').trim();
    const orderRef = String(body.orderRef || '').trim();
    const pickupDay = String(body.pickupDay || '').trim();
    const preSignature = String(body.preSignature || '').trim();

    if (!fullName) return fail('Full legal name is required.');
    if (!phone) return fail('Phone number is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('A valid email address is required.');
    if (!product) return fail('Product you ordered is required.');
    if (!preSignature) return fail('Pre-signature is required — type your full name as on your ID.');
    if (preSignature.toLowerCase() !== fullName.toLowerCase()) {
      return fail('Pre-signature must match the full legal name on the form.');
    }
    if (!body.acknowledged) return fail('Please tick the acknowledgement that this is a pre-copy only and you will sign the official Form 4473 in person at pickup.');

    let front;
    let back = null;
    try {
      front = parsePhoto(body.idFront, 'Front of ID', true);
      back = parsePhoto(body.idBack, 'Back of ID', false);
    } catch (e) {
      return fail(e.message + ' Please try again or call ' + PHONE + '.');
    }

    const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const submittedAt = new Date().toISOString();
    const files = [`id-front.${front.ext}`];
    if (back) files.push(`id-back.${back.ext}`);

    const record = {
      id,
      kind: 'pickup-intake-pre-copy',
      fullName,
      phone,
      email,
      product,
      orderRef,
      pickupDay,
      preSignature,
      submitted_at: submittedAt,
      pickup_at: null,
      status: 'received',
      files,
    };

    const { client, bucket } = wasabiClient();
    const put = (Key, Body, ContentType) =>
      client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${PREFIX}/${id}/${Key}`,
        Body,
        ContentType,
        ServerSideEncryption: 'AES256', // encrypted at rest; never a public URL
      }));

    await put(`id-front.${front.ext}`, front.buf, front.type);
    if (back) await put(`id-back.${back.ext}`, back.buf, back.type);
    await put('record.json', Buffer.from(JSON.stringify(record, null, 2), 'utf8'), 'application/json');

    // Private staff alert in the function log only — name + order ref, NO ID image.
    console.log(`New pickup intake for ${fullName}, order ref: ${orderRef || '(none)'}, pickup day: ${pickupDay || '(none)'}, id: ${id}`);
    // Email alert to staff (best-effort: a failed email must NEVER fail the
    // submission — the intake is already safely stored above). Sends from
    // storage@xlarms.us via HostGator SMTP to info@xlarms.us. The email
    // carries name / product / order ref / pickup day only — NO ID photo,
    // NO pre-signature. Staff open the photo in intake-view.
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
          subject: `New pickup intake: ${fullName} — ${orderRef || 'no order ref'}`,
          text: `New pickup intake received.\n\nName: ${fullName}\nProduct: ${product}\nOrder ref: ${orderRef || '(none)'}\nPickup day: ${pickupDay || '(none)'}\nPhone: ${phone}\nEmail: ${email}\nSubmission id: ${id}\n\nOpen it in the staff intake list (intake-view). Do not reply to this email with ID photos.`,
        });
      } catch (e) {
        console.error('intake-submit: alert email failed (submission already stored):', e && e.message);
      }
    } else {
      console.log('intake-submit: INTAKE_SMTP_PASS not set — no alert email sent.');
    }

    return json(200, {
      ok: true,
      id,
      message: 'Received. We will call you to confirm your pickup time. Bring your original Georgia ID/license and sign the official Form 4473 in person at pickup.',
    });
  } catch (e) {
    console.error('intake-submit error:', e && e.message);
    return fail('Something went wrong sending your information — nothing was lost on your phone, but we did not receive it. Please call ' + PHONE + ' and we will take it by phone.');
  }
};
