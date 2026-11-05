// intake-submit.js — XL Arms secure pre-pickup intake (submission endpoint).
//
// Accepts the pickup-intake.html form (JSON with base64 ID photo) over
// HTTPS and stores it in a SEPARATE private Wasabi prefix, intake-private/,
// inside the existing bucket. NEVER connected to the Bunny CDN, NEVER a
// public URL, server-side encryption on every upload.
//
// What is stored per submission (key intake-private/<id>/):
//   record.json   — name, contact, order ref, pickup day, typed pre-signature,
//                   plus form4473: the full Form 4473 Section A transferee
//                   information (address, place of birth, height, weight, sex,
//                   date of birth, SSN/UPIN if given, ethnicity, race,
//                   questions 11a–11l, question 12 if applicable, state of
//                   residence, country of citizenship, non-citizen detail if
//                   applicable), submitted_at, pickup_at (null until staff
//                   marks picked up), status
//   id-front.jpg  — front of Georgia ID/license (required)
//   id-back.jpg   — back of ID (optional)
// This is a PRE-COPY only — NOT the official Form 4473. No eligibility
// questions are asked on the official form in person at pickup. The official
// form is signed in person at pickup and lives in XL Arms' own
// acquisition/disposition log, never in this store. No dealer-side
// (Section B/D) fields are collected here.
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

    const fullName = [String(body.firstName || '').trim(), String(body.middleName || '').trim(), String(body.lastName || '').trim()].filter(Boolean).join(' ');
    const phone = String(body.phone || '').trim();
    const email = String(body.email || '').trim();
    const product = String(body.product || '').trim();
    // Order reference: if the customer has no order number they put their
    // phone number here instead (per the form label). If it is still blank,
    // fill it with their phone number so the staff list and the alert-email
    // subject always have something to find the submission by.
    let orderRef = String(body.orderRef || '').trim();
    if (!orderRef) orderRef = phone;
    const pickupDay = String(body.pickupDay || '').trim();
    const preSignature = String(body.preSignature || '').trim();

    // --- Form 4473 Section A (pre-copy) fields ---
    const s = (v) => String(v == null ? '' : v).trim();
    const f4473 = {
      lastName: s(body.lastName),
      firstName: s(body.firstName),
      middleName: s(body.middleName),
      addressStreet: s(body.addressStreet),
      addressCity: s(body.addressCity),
      addressState: s(body.addressState),
      addressZip: s(body.addressZip),
      placeOfBirth: s(body.placeOfBirth),
      heightFt: s(body.heightFt),
      heightIn: s(body.heightIn),
      weightLbs: s(body.weight),
      sex: s(body.sex),
      dob: s(body.dob),
      ssn: s(body.ssn),
      upin: s(body.upin),
      ethnicity: s(body.ethnicity),
      race: Array.isArray(body.race) ? body.race.map((r) => s(r)).filter(Boolean) : [],
      q11: {
        a: s(body.q11a), b: s(body.q11b), c: s(body.q11c), d: s(body.q11d),
        e: s(body.q11e), f: s(body.q11f), g: s(body.q11g), h: s(body.q11h),
        i: s(body.q11i), j: s(body.q11j), k: s(body.q11k), l: s(body.q11l),
      },
      q12: s(body.q12),
      q12Detail: s(body.q12Detail),
      stateOfResidence: s(body.stateOfResidence),
      countryOfCitizenship: s(body.countryOfCitizenship),
      nonCitizenDetail: s(body.nonCitizenDetail),
    };
    const yn = (v) => v === 'yes' || v === 'no';
    const isUSCitizen = ['united states', 'usa', 'us', 'u.s.', 'u.s.a.', 'america'].includes(f4473.countryOfCitizenship.toLowerCase());

    if (!f4473.lastName || !f4473.firstName) return fail('Full legal name is required.');
    if (!phone) return fail('Phone number is required.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('A valid email address is required.');
    if (!product) return fail('Product you ordered is required.');
    if (!f4473.addressStreet || !f4473.addressCity || !f4473.addressState || !f4473.addressZip) return fail('Current residence address (street, city, state, ZIP) is required.');
    if (/p\.?\s*o\.?\s*box/i.test(f4473.addressStreet)) return fail('Your residence address cannot be a P.O. Box.');
    if (!f4473.placeOfBirth) return fail('Place of birth is required.');
    const ft = parseInt(f4473.heightFt, 10);
    const inch = parseInt(f4473.heightIn, 10);
    const lbs = parseInt(f4473.weightLbs, 10);
    if (Number.isNaN(ft) || ft < 2 || ft > 8 || Number.isNaN(inch) || inch < 0 || inch > 11) return fail('Height (feet and inches) is required.');
    if (Number.isNaN(lbs) || lbs < 50 || lbs > 999) return fail('Weight in pounds is required.');
    if (f4473.sex !== 'Male' && f4473.sex !== 'Female') return fail('Sex is required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f4473.dob) || Number.isNaN(Date.parse(f4473.dob))) return fail('Date of birth is required.');
    if (f4473.ssn && !/^\d{3}-?\d{2}-?\d{4}$/.test(f4473.ssn)) return fail('Social Security Number must be 9 digits if you give one.');
    if (f4473.ethnicity !== 'Hispanic or Latino' && f4473.ethnicity !== 'Not Hispanic or Latino') return fail('Ethnicity is required.');
    if (!f4473.race.length) return fail('Please select at least one race.');
    for (const k of Object.keys(f4473.q11)) {
      if (!yn(f4473.q11[k])) return fail(`Question 11${k} must be answered Yes or No.`);
    }
    if (f4473.q11.l === 'yes' && !yn(f4473.q12)) return fail('Question 12 must be answered Yes or No.');
    if (!f4473.stateOfResidence) return fail('State of residence is required.');
    if (!f4473.countryOfCitizenship) return fail('Country of citizenship is required.');
    if (!isUSCitizen && !f4473.nonCitizenDetail) return fail('If you are not a citizen of the United States, your alien or admission number and immigration status are required.');
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
      lastName: f4473.lastName,
      firstName: f4473.firstName,
      middleName: f4473.middleName,
      phone,
      email,
      product,
      orderRef,
      pickupDay,
      preSignature,
      form4473: f4473,
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

    // Uploads run in parallel (photos + record are independent), so the
    // function answers faster than doing them one after another.
    const uploads = [put(`id-front.${front.ext}`, front.buf, front.type)];
    if (back) uploads.push(put(`id-back.${back.ext}`, back.buf, back.type));
    uploads.push(put('record.json', Buffer.from(JSON.stringify(record, null, 2), 'utf8'), 'application/json'));
    await Promise.all(uploads);

    // Private staff alert in the function log only — name + order ref, NO ID image.
    console.log(`New pickup intake for ${fullName}, order ref: ${orderRef || '(none)'}, pickup day: ${pickupDay || '(none)'}, id: ${id}`);
    // Email alert to staff (best-effort: a failed email must NEVER fail the
    // submission — the intake is already safely stored above). Sends from
    // storage@xlarms.us via HostGator SMTP to info@xlarms.us. The email
    // carries name / product / order ref / pickup day only — NO ID photo,
    // NO 4473 answers, NO pre-signature. It includes a link to the staff
    // page: staff open the link, type the staff secret code, and the
    // submission opens. Staff open the full 4473 detail + photos there.
    if (process.env.INTAKE_SMTP_PASS) {
      try {
        const mailer = nodemailer.createTransport({
          host: 'mail.xlarms.us',
          port: 465,
          secure: true,
          auth: { user: ALERT_FROM, pass: process.env.INTAKE_SMTP_PASS },
        });
        const staffLink = `https://xlarms.us/staff-intake.html?id=${encodeURIComponent(id)}`;
        await mailer.sendMail({
          from: ALERT_FROM,
          to: ALERT_TO,
          subject: `New pickup intake: ${fullName} — ${orderRef || 'no order ref'}`,
          text: `New pickup intake received.\n\nName: ${fullName}\nProduct: ${product}\nOrder ref: ${orderRef || '(none)'}\nPickup day: ${pickupDay || '(none)'}\nSubmission id: ${id}\n\nOpen the submission here:\n${staffLink}\n\nOpen the link, type the staff secret code, and the submission opens. Do not reply to this email with ID photos.`,
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
