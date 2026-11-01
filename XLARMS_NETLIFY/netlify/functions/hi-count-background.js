// Hi counter: counts every file in RSR's high-res FTP tree — nothing else.
//
// Trigger once:
//   /.netlify/functions/hi-count-background
// Read the result two ways:
//   - Watch this function's log live when triggering: the final line is
//     'Hi count OK' with the totals.
//   - Or open /.netlify/functions/hi-count afterwards: it returns the
//     saved hi-count.json from Blobs (no log-watching needed).
//
// SAFETY: this function is READ-ONLY. It only LISTs FTP directories —
// it downloads no files, writes nothing to the image manifest, and
// touches no Wasabi photo. It is safe to run at any time, even while
// the backfill scheduler is running jobs, because the only thing it
// writes is its own separate Blobs key (hi-count.json).
//
// What it counts: /ftp_highres_images/rsr_number/<shard>/ for shards
// a..z, num, # (files named <SKU>_<n>_HR.jpg), plus
// /ftp_highres_images/new_images/ if that folder exists (reported
// separately; a 550 "not found" there is normal and is not an error).
// A shard whose listing fails after retries is recorded in `errors`
// with zero counts — re-triggering recounts it; totals then include it.

const SHARDS = [...'abcdefghijklmnopqrstuvwxyz', 'num', '#'];
const HI_PATTERN = /^(.+?)_(\d+)_HR\.jpg$/i;

// Pure counting logic (exported for testing): given one directory
// listing (basic-ftp FileInfo entries with .name and .size), count the
// hi files, distinct SKUs, total bytes, and non-hi entries skipped.
function countHiEntries(entries) {
  const skus = new Set();
  let files = 0, bytes = 0, skippedOther = 0;
  for (const e of (entries || [])) {
    const name = e.name || '';
    const m = name.match(HI_PATTERN);
    if (!m) { skippedOther++; continue; }
    files++;
    skus.add(m[1]);
    bytes += (typeof e.size === 'number' ? e.size : 0);
  }
  return { files, skus: skus.size, bytes, skippedOther };
}

async function ftpConnect() {
  const ftp = require('basic-ftp');
  const client = new ftp.Client();
  client.ftp.verbose = false;
  await client.access({
    host: process.env.RSR_FTP_HOST,
    port: parseInt(process.env.RSR_FTP_PORT || '2222', 10),
    user: process.env.RSR_FTP_USER,
    password: process.env.RSR_FTP_PASS,
    secure: true,
  });
  return client;
}

// LIST with a fresh client per retry: RSR's FTPS data connections die
// intermittently, and a dead client rejects every later attempt, so a
// retry must reconnect instead of reusing the dead client.
async function listDirWithRetry(path) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let client = null;
    try {
      client = await ftpConnect();
      const list = await client.list(path);
      try { await client.close(); } catch {}
      return list;
    } catch (e) {
      lastErr = e;
      try { if (client) await client.close(); } catch {}
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

exports.handler = async (event) => {
  // Background function: Netlify returns 202 immediately; the totals are
  // in the Functions log ('Hi count OK') and in Blobs hi-count.json.
  try {
    if (!process.env.RSR_FTP_HOST || !process.env.RSR_FTP_USER || !process.env.RSR_FTP_PASS) {
      throw new Error('Missing RSR FTP env vars — set RSR_FTP_HOST, RSR_FTP_USER, RSR_FTP_PASS in Netlify, then redeploy.');
    }
    let blobs;
    try { blobs = require('@netlify/blobs'); } catch {
      throw new Error('@netlify/blobs is not installed.');
    }
    try { blobs.connectLambda(event); } catch (e) { console.warn('connectLambda skipped:', e.message); }

    const shards = {};
    const errors = [];
    for (const shard of SHARDS) {
      const path = `/ftp_highres_images/rsr_number/${shard}/`;
      try {
        const list = await listDirWithRetry(path);
        const c = countHiEntries(list);
        shards[shard] = c;
        console.log(`Hi count shard ${shard}:`, JSON.stringify(c));
      } catch (e) {
        shards[shard] = { files: 0, skus: 0, bytes: 0, skippedOther: 0 };
        errors.push({ shard, error: e.message });
        console.warn(`Hi count shard ${shard} FAILED (counted as zero, re-trigger to recount):`, e.message);
      }
    }

    // Optional new_images bucket: 550 means the folder does not exist,
    // which is normal and is not recorded as an error.
    let newImages = null;
    try {
      const list = await listDirWithRetry('/ftp_highres_images/new_images/');
      newImages = countHiEntries(list);
      console.log('Hi count new-images:', JSON.stringify(newImages));
    } catch (e) {
      if (/550/.test(e.message || '')) {
        console.log('Hi count new-images: folder absent (550) — skipped, not an error.');
      } else {
        errors.push({ shard: 'new-images', error: e.message });
        console.warn('Hi count new-images FAILED:', e.message);
      }
    }

    const totals = { files: 0, skus: 0, bytes: 0 };
    for (const c of Object.values(shards)) {
      totals.files += c.files;
      totals.skus += c.skus;
      totals.bytes += c.bytes;
    }
    if (newImages) {
      totals.files += newImages.files;
      totals.skus += newImages.skus;
      totals.bytes += newImages.bytes;
    }
    const result = { generated: new Date().toISOString(), shards, newImages, totals, errors };
    await blobs.getStore('xl-arms-catalog').set('hi-count.json', JSON.stringify(result));
    console.log('Hi count OK', JSON.stringify({ totals, errors }));
    return { statusCode: 202, body: JSON.stringify({ ok: true, note: 'Background hi count started — check Functions log for Hi count OK, or open /.netlify/functions/hi-count afterwards.' }) };
  } catch (e) {
    console.error('Hi count FAILED:', e.message);
    return { statusCode: 202, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

module.exports.countHiEntries = countHiEntries;
module.exports.SHARDS = SHARDS;
