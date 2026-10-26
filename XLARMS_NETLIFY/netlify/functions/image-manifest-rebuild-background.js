// Manifest rebuild: Wasabi staging -> live image prefix -> Blobs manifest.
// NO FTP AT ALL. Built 2026-10-26 because RSR's FTPS data connections die
// intermittently (see image-sync-background.js), while Jonathan already
// holds the standard-photo tree on an external drive (Nov 2025 snapshot:
// ftp_images/rsr_number/<shard>/<SKU>_<n>.jpg + new_images/, NO high-res).
//
// How it is used:
//   1. Jonathan bulk-uploads the drive's shard folders (the folders INSIDE
//      rsr_number/, plus the new_images/ folder) into Wasabi with a plain
//      folder copy (Cyberduck etc.) under the staging prefix, e.g.:
//        products-staging/a/AZ16119_1.jpg
//        products-staging/new_images/XX1234_1.jpg
//      Do NOT upload categories/ or manufacturers/ (the site's tiles are
//      already set) and do NOT touch the old site's ftp_images/ tree.
//   2. After the upload, trigger one shard at a time (same discipline as
//      the FTP sync — never two manifest writers at once):
//        /.netlify/functions/image-manifest-rebuild-background?shard=a
//        ... ?shard=b ... ?shard=num ... ?shard=%23  ('#' must be encoded)
//        /.netlify/functions/image-manifest-rebuild-background?new-images=1
//   OR skip the upload entirely with ?source=bucket (added 2026-10-26
//   when Jonathan caught the redundancy mid-transfer): the same standard
//   photos already live in this bucket under the old site's ftp_images/
//   tree, so the function can copy straight from there —
//   ftp_images/rsr_number/<shard>/ (or ftp_images/new_images/) — into
//   the live layout, with no drive upload at all:
//        /.netlify/functions/image-manifest-rebuild-background?shard=a&source=bucket
//   Whether the bucket tree covers every product is unproven (it is a
//   snapshot from whenever it was last filled); the rebuild log's
//   skusCopied count shows it per shard, and staging (drive) remains as
//   the gap-fill source for any shard that comes up short.
//   HI FROM STAGING (last resort when FTP hi is unusable): the hi tree
//   is NOT on the drive and NOT in the bucket's old tree, so hi must be
//   fetched from RSR FTP somehow. If Netlify→RSR data connections prove
//   unusable even with retries, Jonathan can download
//   /ftp_highres_images/rsr_number/ with FileZilla (his connection works)
//   and upload it to Wasabi staging-hi, then trigger per shard:
//        /.netlify/functions/image-manifest-rebuild-background?shard=a&hi=1
//   Hi files are named <SKU>_<n>_HR.jpg; the function copies them to
//   <hiPrefix>/<SKU>/<n>.jpg and records hiCount/hiSizes, preserving the
//   standard entries — the mirror image of the standard rebuild. Hi mode
//   always uses staging-hi, never the bucket source.
//   3. The function server-side-copies each staged file into the live
//      layout the storefront serves — <prefix>/<SKU>/<n>.jpg, i.e. the
//      shard folder is dropped and <SKU>_<n>.jpg is split into a folder
//      plus a number — and records it in the Blobs manifest, so product
//      pages start showing the photos. No bytes are downloaded anywhere.
//
// Rules it follows:
//   - Numbering is gapless per SKU, like the FTP sync: only the 1,2,3...
//     prefix is copied; files past a numbering gap are skipped (logged).
//   - The side a run does not own is PRESERVED: standard runs keep hi
//     entries, hi runs keep standard entries, so the two tracks merge in
//     either order.
//   - A SKU whose standard sizes changed vs the manifest gets its Bunny
//     prefix purged (same as the FTP sync); brand-new SKUs need no purge.
//   - A copy failure on one SKU never kills the run; 20 straight copy
//     failures aborts it (e.g. bad credentials), still saving the manifest
//     with progress so far.
//   Progress is saved every 500 SKUs and already-done SKUs (identical
//   sizes already in the manifest) are skipped, so a timed-out run
//   resumes on re-trigger instead of starting over. A manifest LOAD
//   failure (e.g. an expired Blobs token) aborts the run — it must never
//   proceed with a fresh manifest, or the save at the end would wipe
//   existing entries.
//
// Env vars (same Wasabi vars as the image sync; NEVER in chat or code):
//   WASABI_BUCKET, WASABI_KEY, WASABI_SECRET (secret), WASABI_REGION
//   WASABI_ENDPOINT      (optional override, else s3.<region>.wasabisys.com)
//   WASABI_PREFIX        (live target, default 'products')
//   WASABI_STAGING_PREFIX (upload target, default 'products-staging')
//   BUNNY_HOSTNAME       (purge only; rebuild works without it)
//   BUNNY_API_KEY        (optional — purge only)
const MAX_IMAGES_PER_SKU = 10;

function wasabiClient() {
  let s3;
  try {
    s3 = require('@aws-sdk/client-s3');
  } catch {
    throw new Error('@aws-sdk/client-s3 is not installed — add it to package.json and redeploy before triggering the manifest rebuild.');
  }
  const region = process.env.WASABI_REGION || 'us-east-1';
  const endpoint = process.env.WASABI_ENDPOINT || `https://s3.${region}.wasabisys.com`;
  return {
    client: new s3.S3Client({
      region,
      endpoint,
      credentials: { accessKeyId: process.env.WASABI_KEY, secretAccessKey: process.env.WASABI_SECRET },
      forcePathStyle: false,
    }),
    ListObjectsV2Command: s3.ListObjectsV2Command,
    CopyObjectCommand: s3.CopyObjectCommand,
    bucket: process.env.WASABI_BUCKET,
  };
}

async function bunnyPurgePrefix(hostname, prefix, sku) {
  const apiKey = process.env.BUNNY_API_KEY;
  if (!apiKey || !hostname) return 'skipped (no BUNNY_API_KEY or BUNNY_HOSTNAME)';
  const url = `https://${hostname}/${prefix}/${sku}/*`;
  const res = await fetch(`https://api.bunny.net/purge?url=${encodeURIComponent(url)}&async=true`, {
    method: 'POST',
    headers: { AccessKey: apiKey },
  });
  if (!res.ok) throw new Error(`Bunny purge ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200));
  return 'purged';
}

async function loadManifest(blobs) {
  // Fail CLOSED on load errors (e.g. an expired Blobs token): the caller
  // must abort, never proceed with a fresh manifest — saving that at the
  // end would wipe every existing entry. Only a genuinely absent manifest
  // (get returns null) yields a fresh one.
  const store = blobs.getStore('xl-arms-catalog');
  const m = await store.get('images.json', { type: 'json' });
  if (m && m.images && typeof m.images === 'object') return m;
  return { generated: null, prefix: null, hiPrefix: null, images: {} };
}

// Automatic backfill: record a finished job sweep in backfill-auto.json
// (same Blobs store as the manifest). Callers treat failures as
// non-fatal warnings — the scheduler re-triggering a finished job is
// harmless because it self-completes via skip-if-done.
async function markJobDone(blobs, jobKey) {
  const store = blobs.getStore('xl-arms-catalog');
  const state = (await store.get('backfill-auto.json', { type: 'json' })) || {};
  state.done = state.done || {};
  state.done[jobKey] = { at: new Date().toISOString() };
  await store.set('backfill-auto.json', JSON.stringify(state));
}

async function listAllKeys(s3, ListObjectsV2Command, bucket, prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token }));
    for (const obj of (res.Contents || [])) {
      if (obj && obj.Key) keys.push({ key: obj.Key, size: obj.Size || 0 });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

exports.handler = async (event) => {
  // Background function: Netlify returns 202 immediately; progress is in
  // the Functions log. The caller does NOT see this summary in the response.
  try {
    const qs = event.queryStringParameters || {};
    const prefix = process.env.WASABI_PREFIX || 'products';
    const staging = process.env.WASABI_STAGING_PREFIX || 'products-staging';
    const hostname = process.env.BUNNY_HOSTNAME || '';
    if (!process.env.WASABI_BUCKET || !process.env.WASABI_KEY || !process.env.WASABI_SECRET) {
      throw new Error('Missing Wasabi env vars — set WASABI_BUCKET, WASABI_KEY, WASABI_SECRET (and WASABI_REGION) in Netlify, then redeploy.');
    }
    const { client: s3, ListObjectsV2Command, CopyObjectCommand, bucket } = wasabiClient();

    // Decide the source: one shard, or the new_images folder. The listing
    // tries the plain staging layout first, then the layout you get if the
    // whole rsr_number/ (or ftp_images/) folder was dragged in instead.
    // With ?source=bucket the existing bucket tree is the source instead.
    // Hi mode (?hi=1) always uses staging-hi: hi files live only on RSR
    // FTP, never in the bucket's old tree, so there is no bucket source.
    const fromBucket = qs.source === 'bucket';
    const hiMode = qs.hi === '1';
    const hiStaging = process.env.WASABI_HI_STAGING_PREFIX || 'products-staging-hi';
    let mode, candidates;
    if (qs['new-images']) {
      mode = hiMode ? 'hi-new-images' : 'new-images';
      candidates = hiMode
        ? [`${hiStaging}/new_images/`, `${hiStaging}/ftp_highres_images/new_images/`]
        : fromBucket
          ? [`ftp_images/new_images/`]
          : [`${staging}/new_images/`, `${staging}/ftp_images/new_images/`];
    } else if (qs.shard) {
      const shard = String(qs.shard).toLowerCase();
      mode = hiMode ? `hi-shard:${shard}` : `shard:${shard}`;
      candidates = hiMode
        ? [`${hiStaging}/${shard}/`, `${hiStaging}/rsr_number/${shard}/`, `${hiStaging}/ftp_highres_images/rsr_number/${shard}/`]
        : fromBucket
          ? [`ftp_images/rsr_number/${shard}/`]
          : [`${staging}/${shard}/`, `${staging}/rsr_number/${shard}/`, `${staging}/ftp_images/rsr_number/${shard}/`];
    } else {
      throw new Error('Pass ?shard=<a-z,num,#> (use %23 for #) or ?new-images=1.');
    }
    let sourcePrefix = null;
    let staged = [];
    for (const cand of candidates) {
      const found = await listAllKeys(s3, ListObjectsV2Command, bucket, cand);
      if (found.length > 0) { sourcePrefix = cand; staged = found; break; }
    }
    if (!sourcePrefix) {
      throw new Error(`Nothing found for ${mode} — looked under: ${candidates.join(', ')}. ` + (hiMode
        ? `Upload the hi shard folders into Wasabi '${hiStaging}/' first (see file header).`
        : fromBucket
          ? `That shard may genuinely have no photos there (drive staging can fill gaps).`
          : `Upload the shard folders into Wasabi '${staging}/' first (see file header).`));
    }

    let blobs;
    try { blobs = require('@netlify/blobs'); } catch {
      throw new Error('@netlify/blobs is not installed.');
    }
    try { blobs.connectLambda(event); } catch (e) { console.warn('connectLambda skipped:', e.message); }
    const manifest = await loadManifest(blobs);
    manifest.prefix = prefix;
    if (!manifest.hiPrefix) manifest.hiPrefix = prefix + '-hi';
    const hiPrefix = manifest.hiPrefix;
    const targetPrefix = hiMode ? hiPrefix : prefix;

    // Group staged files by SKU. The basename pattern is folder-agnostic,
    // so rsr_number/<shard>/ and new_images/ (flat or nested) both work.
    // Hi files carry the _HR suffix: <SKU>_<n>_HR.jpg.
    const namePattern = hiMode ? /^(.+?)_(\d+)_HR\.jpg$/i : /^(.+?)_(\d+)\.jpg$/i;
    const bySku = new Map();
    for (const { key, size } of staged) {
      const base = key.split('/').pop();
      const m = base.match(namePattern);
      if (!m) continue; // not a product photo (e.g. a category tile) — skip
      const sku = m[1];
      const n = parseInt(m[2], 10);
      if (!bySku.has(sku)) bySku.set(sku, new Map());
      bySku.get(sku).set(n, { key, size });
    }

    const results = [];
    let consecutiveCopyErrors = 0;
    let abortErr = null;
    let filesCopied = 0;
    let bytesCopied = 0;
    let skippedBeyondGap = 0;
    const sortedSkus = [...bySku.keys()].sort();
    const saveManifest = async () => {
      manifest.generated = new Date().toISOString();
      await blobs.getStore('xl-arms-catalog').set('images.json', JSON.stringify(manifest));
    };
    for (let idx = 0; idx < sortedSkus.length; idx++) {
      const sku = sortedSkus[idx];
      // Save progress regularly: if the run times out, at most the last
      // batch is lost, and the next run of the same shard resumes (see
      // the already-done skip below) instead of starting over. This also
      // makes the log visibly advance instead of staying quiet.
      if (idx > 0 && idx % 500 === 0) {
        await saveManifest();
        console.log('Manifest rebuild progress', JSON.stringify({ mode, hi: hiMode, processed: idx, skusTotal: sortedSkus.length, filesCopied }));
      }
      try {
        const nums = bySku.get(sku);
        // Gapless prefix only: 1,2,3... until the first missing number.
        const sizes = [];
        const toCopy = [];
        for (let n = 1; n <= MAX_IMAGES_PER_SKU; n++) {
          if (!nums.has(n)) break;
          toCopy.push({ n, ...nums.get(n) });
          sizes.push(nums.get(n).size);
        }
        skippedBeyondGap += [...nums.keys()].filter((n) => n > sizes.length).length;
        if (toCopy.length === 0) { results.push({ sku, status: 'no-gapless-images' }); continue; }
        const prev = manifest.images[sku];
        // Already done by an earlier run that saved progress: identical
        // sizes on the side this run owns mean the live files are already
        // correct — skip the copies.
        const prevSideSizes = hiMode ? (prev && prev.hiSizes) : (prev && prev.sizes);
        if (prevSideSizes && JSON.stringify(prevSideSizes) === JSON.stringify(sizes)) {
          results.push({ sku, status: 'already-done', count: sizes.length });
          consecutiveCopyErrors = 0;
          continue;
        }
        for (const f of toCopy) {
          const copySource = `${bucket}/${f.key.split('/').map(encodeURIComponent).join('/')}`;
          await s3.send(new CopyObjectCommand({
            Bucket: bucket,
            CopySource: copySource,
            Key: `${targetPrefix}/${sku}/${f.n}.jpg`,
            ContentType: 'image/jpeg',
            MetadataDirective: 'REPLACE',
          }));
          filesCopied++;
          bytesCopied += f.size;
        }
        const changed = !!prev && prevSideSizes && JSON.stringify(prevSideSizes) !== JSON.stringify(sizes);
        let purge = 'n/a (new SKU, nothing cached yet)';
        if (changed) {
          try { purge = await bunnyPurgePrefix(hostname, targetPrefix, sku); }
          catch (e) { purge = `FAILED (logged, rebuild continues): ${e.message}`; }
        }
        // The side this run does NOT own is preserved untouched: standard
        // mode preserves hi, hi mode preserves standard.
        manifest.images[sku] = hiMode
          ? { count: (prev && prev.count) || 0, sizes: (prev && prev.sizes) || [], hiCount: sizes.length, hiSizes: sizes }
          : { count: sizes.length, sizes, hiCount: (prev && prev.hiCount) || 0, hiSizes: (prev && prev.hiSizes) || [] };
        results.push({ sku, status: 'ok', count: sizes.length, changed, purge });
        consecutiveCopyErrors = 0;
      } catch (e) {
        results.push({ sku, status: 'error', error: e.message });
        consecutiveCopyErrors++;
        if (consecutiveCopyErrors >= 20) { abortErr = e; break; }
      }
    }

    await saveManifest();
    // Automatic backfill: record this sweep as done (only for a run that
    // was NOT aborted — a timed-out/aborted run writes no marker, so the
    // scheduler triggers it again and it resumes via skip-if-done).
    // mode: 'shard:a' | 'hi-shard:a' | 'new-images' | 'hi-new-images'
    // jobKey: 'shard:a:standard' | 'shard:a:hi' | 'new-images:standard' | 'new-images:hi'
    if (!abortErr) {
      const jobKey = mode.startsWith('hi-') ? mode.slice(3) + ':hi' : mode + ':standard';
      try { await markJobDone(blobs, jobKey); }
      catch (e) { console.warn('Backfill marker NOT saved (scheduler will re-trigger once):', e.message); }
    }
    const ok = results.filter((r) => r.status === 'ok');
    console.log('Manifest rebuild OK', JSON.stringify({
      mode, hi: hiMode, source: hiMode ? 'staging-hi' : (fromBucket ? 'bucket' : 'staging'), sourcePrefix, targetPrefix,
      skusCopied: ok.length, filesCopied, bytesCopied, skippedBeyondGap,
      skippedAlreadyDone: results.filter((r) => r.status === 'already-done').length,
      purged: ok.filter((r) => r.changed).map((r) => r.sku),
      errors: results.filter((r) => r.status === 'error'),
      aborted: !!abortErr,
    }));
    if (abortErr) {
      console.error('Manifest rebuild ABORTED after 20 consecutive copy failures:', abortErr.message);
      return { statusCode: 202, body: JSON.stringify({ ok: false, error: 'Aborted: ' + abortErr.message }) };
    }
    return { statusCode: 202, body: JSON.stringify({ ok: true, note: 'Background manifest rebuild started — check Functions log for Manifest rebuild OK.' }) };
  } catch (e) {
    console.error('Manifest rebuild FAILED:', e.message);
    return { statusCode: 202, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
