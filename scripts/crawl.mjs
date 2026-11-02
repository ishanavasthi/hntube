// Crawls every HN comment and story that mentions a YouTube link, via the
// HN Algolia API, into data/raw/<name>.jsonl. Resumable: re-running continues
// from the oldest item already saved for each query.
//
// Algolia caps any single query at 1000 hits, so we page by time instead:
// fetch the newest 1000 hits at or before T, then move T to the oldest
// timestamp seen and repeat until a page comes back short.

import fs from 'node:fs';
import path from 'node:path';

const API = 'https://hn.algolia.com/api/v1/search_by_date';
const RAW_DIR = path.resolve(import.meta.dirname, '../data/raw');
const PAGE = 1000;

const QUERIES = [
  { name: 'comments-youtube', tags: 'comment', query: 'youtube.com' },
  { name: 'comments-youtu.be', tags: 'comment', query: 'youtu.be' },
  { name: 'stories-youtube', tags: 'story', query: 'youtube.com' },
  { name: 'stories-youtu.be', tags: 'story', query: 'youtu.be' },
];

const FIELDS = [
  'objectID', 'author', 'created_at_i', 'points', 'num_comments',
  'title', 'url', 'story_text', 'comment_text',
  'story_id', 'story_title', 'story_url', 'parent_id',
].join(',');

// Cheap pre-filter so raw files only keep hits that can contain a link.
const LOOSE = /youtu(?:\.be|be(?:-nocookie)?\.com)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(q, before) {
  const params = new URLSearchParams({
    query: q.query,
    tags: q.tags,
    hitsPerPage: String(PAGE),
    typoTolerance: 'false',
    attributesToHighlight: 'none',
    attributesToSnippet: 'none',
    attributesToRetrieve: FIELDS,
  });
  if (before != null) params.set('numericFilters', `created_at_i<=${before}`);
  const url = `${API}?${params}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'hntube-crawler (static site build)' } });
      if (res.ok) return await res.json();
      if (attempt >= 8 || (res.status < 500 && res.status !== 429)) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
    } catch (err) {
      if (attempt >= 8) throw err;
    }
    await sleep(Math.min(60_000, 1000 * 2 ** attempt));
  }
}

function loadExisting(file) {
  const seen = new Set();
  let oldest = null;
  if (!fs.existsSync(file)) return { seen, oldest };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const h = JSON.parse(line);
    seen.add(h.objectID);
    if (oldest == null || h.created_at_i < oldest) oldest = h.created_at_i;
  }
  return { seen, oldest };
}

async function crawl(q) {
  const file = path.join(RAW_DIR, `${q.name}.jsonl`);
  const doneFile = `${file}.done`;
  if (fs.existsSync(doneFile)) {
    console.log(`[${q.name}] already complete`);
    return;
  }
  // `seen` covers every hit returned (kept or not) in this run, plus kept hits
  // from earlier runs, so boundary-second overlap never double-counts.
  const { seen, oldest } = loadExisting(file);
  const out = fs.createWriteStream(file, { flags: 'a' });
  let before = oldest; // resume point (inclusive; duplicates are skipped)
  let pages = 0;
  let kept = 0;
  for (;;) {
    const data = await fetchPage(q, before);
    const hits = data.hits;
    pages++;
    let fresh = 0;
    let minT = Infinity;
    for (const h of hits) {
      minT = Math.min(minT, h.created_at_i);
      if (seen.has(h.objectID)) continue;
      seen.add(h.objectID);
      fresh++;
      const text = [h.comment_text, h.story_text, h.url].filter(Boolean).join(' ');
      if (!LOOSE.test(text)) continue;
      out.write(JSON.stringify(h) + '\n');
      kept++;
    }
    const when = Number.isFinite(minT) ? new Date(minT * 1000).toISOString().slice(0, 10) : '-';
    console.log(`[${q.name}] page ${pages}: ${hits.length} hits, ${fresh} new, kept total ${kept}, reached ${when}`);
    if (hits.length < PAGE) break;
    // Normal case: continue from the oldest second (inclusive, deduped).
    // If a full page was all duplicates, every hit shares that second; step past it.
    before = fresh === 0 ? minT - 1 : minT;
    await sleep(250);
  }
  await new Promise((r) => out.end(r));
  fs.writeFileSync(doneFile, new Date().toISOString());
  console.log(`[${q.name}] done: ${pages} pages, ${kept} kept`);
}

fs.mkdirSync(RAW_DIR, { recursive: true });
const only = process.argv[2];
await Promise.all(QUERIES.filter((q) => !only || q.name === only).map(crawl));
