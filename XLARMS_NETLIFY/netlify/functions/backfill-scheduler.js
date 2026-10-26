// Backfill scheduler: the fully automatic backfill driver.
//
// Netlify wakes this function on its own timer (see netlify.toml:
// [functions."backfill-scheduler"], every 30 minutes, UTC). Each wake it:
//   1. Reads backfill-auto.json from the Blobs store 'xl-arms-catalog'
//      (the same store as the image manifest). That file records which
//      backfill jobs have finished sweeps, and when the last job was
//      triggered.
//   2. Picks the first job in the queue that is NOT marked done. The
//      queue is: for each shard a..z, num, #: standard rebuild (bucket
//      source), then hi pass (FTP hi-only); finally new-images standard
//      (bucket source).
//   3. If every job is done, it logs "Backfill complete" and does nothing.
//   4. If the last trigger was less than 20 minutes ago, it skips this
//      wake: the previous background run may still be going (they cap at
//      15 minutes), and two runs must never write the manifest at once.
//   5. Otherwise it fires the job's background trigger URL (the same URL
//      a person would open) and records the trigger time. The background
//      function answers 202 immediately, so this wake finishes in seconds
//      — well inside the scheduled function's 30-second limit. The heavy
//      work happens in the background function, not here.
//
// How a job gets marked done: the rebuild and sync functions write a
// marker into backfill-auto.json when a run finishes a full sweep
// WITHOUT aborting. A timed-out run writes no marker, so the scheduler
// simply triggers it again and it resumes via the manifest's skip-if-done
// logic. A run that completes with a few per-SKU errors still marks done
// (the sweep finished; failed SKUs are gap-fill candidates, not a reason
// to block every later shard).
//
// NOT in the automatic queue (manual, later): gap-fill for SKUs missing
// from the bucket snapshot or added since it, and hi for new-images (the
// hi tree has no confirmed new_images folder). Staging-hi rebuilds are
// also manual — they are the last resort, not the default path.
//
// Pause: set env var BACKFILL_AUTO_PAUSED=1 (then redeploy) and the
// scheduler logs "paused" and triggers nothing. Remove it (and redeploy)
// to resume. To stop permanently, remove the schedule from netlify.toml
// and redeploy.
//
// Manual triggering after this is deployed is NOT safe: a manual trigger
// can overlap a scheduler-triggered run and race on the manifest. Let
// the scheduler own all triggering. If a manual trigger is ever needed,
// pause the scheduler first (above) and wait 20 minutes.

const STORE = 'xl-arms-catalog';
const STATE_KEY = 'backfill-auto.json';
const MIN_TRIGGER_GAP_MS = 20 * 60 * 1000; // background runs cap at 15 min

const SHARDS = [...'abcdefghijklmnopqrstuvwxyz', 'num', '#'];

function buildQueue() {
  const jobs = [];
  for (const shard of SHARDS) {
    jobs.push({ key: `shard:${shard}:standard`, kind: 'rebuild', shard });
    jobs.push({ key: `shard:${shard}:hi`, kind: 'sync', shard });
  }
  jobs.push({ key: 'new-images:standard', kind: 'rebuild', newImages: true });
  return jobs;
}

function triggerUrlFor(job, siteUrl) {
  const base = String(siteUrl).replace(/\/$/, '');
  if (job.kind === 'rebuild') {
    if (job.newImages) return `${base}/.netlify/functions/image-manifest-rebuild-background?new-images=1&source=bucket`;
    return `${base}/.netlify/functions/image-manifest-rebuild-background?shard=${encodeURIComponent(job.shard)}&source=bucket`;
  }
  return `${base}/.netlify/functions/image-sync-background?shard=${encodeURIComponent(job.shard)}&hi-only=1`;
}

// Pure decision logic (exported for testing): given the done map and the
// last trigger time, what should this wake do?
function pickNextJob(done, lastTriggeredAt, nowMs) {
  const queue = buildQueue();
  const next = queue.find((j) => !done || !done[j.key]);
  if (!next) return { action: 'complete' };
  if (lastTriggeredAt) {
    const gap = nowMs - Date.parse(lastTriggeredAt);
    if (!Number.isNaN(gap) && gap < MIN_TRIGGER_GAP_MS) {
      return { action: 'wait', job: next, gapMs: gap };
    }
  }
  return { action: 'trigger', job: next };
}

exports.handler = async (event) => {
  try {
    if (process.env.BACKFILL_AUTO_PAUSED === '1') {
      console.log('Backfill scheduler: paused (BACKFILL_AUTO_PAUSED=1) — triggering nothing.');
      return { statusCode: 200, body: JSON.stringify({ paused: true }) };
    }
    let blobs;
    try { blobs = require('@netlify/blobs'); } catch {
      throw new Error('@netlify/blobs is not installed.');
    }
    try { blobs.connectLambda(event); } catch (e) { console.warn('connectLambda skipped:', e.message); }
    const store = blobs.getStore(STORE);
    let state = null;
    try {
      state = await store.get(STATE_KEY, { type: 'json' });
    } catch (e) {
      // Fail closed: do NOT trigger blindly when the state cannot be read
      // (a blind trigger could overlap a run). Next wake retries.
      console.error('Backfill scheduler: cannot read state, skipping this wake:', e.message);
      return { statusCode: 200, body: JSON.stringify({ skipped: 'state-read-failed' }) };
    }
    if (!state || typeof state !== 'object') state = { done: {}, lastTriggeredAt: null, lastTriggeredJob: null };
    state.done = state.done || {};
    const decision = pickNextJob(state.done, state.lastTriggeredAt, Date.now());
    if (decision.action === 'complete') {
      console.log('Backfill scheduler: all jobs done — backfill complete, triggering nothing.');
      return { statusCode: 200, body: JSON.stringify({ complete: true }) };
    }
    if (decision.action === 'wait') {
      console.log(`Backfill scheduler: last trigger ${Math.round(decision.gapMs / 1000)}s ago (< 20 min) — previous job may still run, skipping this wake. Next job: ${decision.job.key}.`);
      return { statusCode: 200, body: JSON.stringify({ waiting: true, nextJob: decision.job.key }) };
    }
    const siteUrl = process.env.URL || 'https://xl-arms.netlify.app';
    const url = triggerUrlFor(decision.job, siteUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      console.error(`Backfill scheduler: trigger fetch failed for ${decision.job.key}:`, e.message);
      return { statusCode: 200, body: JSON.stringify({ triggerFailed: decision.job.key }) };
    }
    clearTimeout(timer);
    if (res.status !== 202) {
      console.error(`Backfill scheduler: trigger for ${decision.job.key} returned ${res.status} (expected 202) — not recording trigger, next wake retries.`);
      return { statusCode: 200, body: JSON.stringify({ triggerFailed: decision.job.key, status: res.status }) };
    }
    state.lastTriggeredAt = new Date().toISOString();
    state.lastTriggeredJob = decision.job.key;
    try {
      await store.set(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      // The trigger already fired; a failed state save only means the
      // next wake may re-trigger the same job (harmless — it resumes).
      console.warn('Backfill scheduler: trigger recorded in memory only, state save failed:', e.message);
    }
    console.log(`Backfill scheduler: triggered ${decision.job.key} — ${url}`);
    return { statusCode: 200, body: JSON.stringify({ triggered: decision.job.key }) };
  } catch (e) {
    console.error('Backfill scheduler FAILED:', e.message);
    return { statusCode: 200, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.pickNextJob = pickNextJob;
module.exports.buildQueue = buildQueue;
module.exports.triggerUrlFor = triggerUrlFor;
