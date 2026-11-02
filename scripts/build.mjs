// Turns the raw crawl (data/raw/*.jsonl) into the site's data files:
//   site/data/videos.json   summary of every qualifying video (home grid)
//   site/data/meta.json     build stats + the qualification rule
//   site/data/v/<id>.json   every HN mention of one video + related videos
//
// A video qualifies when it was linked by at least MIN_PEOPLE distinct HN
// users in at least MIN_YEARS distinct calendar years (UTC). A "mention" is a
// story submission whose URL/text links the video, or a comment that links it.
// Comments that link the video inside that video's own submission thread are
// not counted: they discuss the submission rather than recommend it again.
//
// Usage: node scripts/build.mjs [--stats] [--min-people N] [--min-years N]

import fs from 'node:fs';
import path from 'node:path';
import { extractVideoIds, htmlToText } from './lib/extract.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW_DIR = path.join(ROOT, 'data/raw');
const CACHE_FILE = path.join(ROOT, 'data/cache/oembed.json');
const OUT_DIR = path.join(ROOT, 'site/data');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : Number(args[i + 1]);
};
const MIN_PEOPLE = opt('--min-people', 5);
const MIN_YEARS = opt('--min-years', 5);
const STATS_ONLY = args.includes('--stats');

const yearOf = (t) => new Date(t * 1000).getUTCFullYear();

// ---------- load + dedupe raw hits ----------
const items = new Map();
for (const f of fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(RAW_DIR, f), 'utf8').split('\n')) {
    if (!line) continue;
    const h = JSON.parse(line);
    items.set(h.objectID, h);
  }
}

// ---------- extract mentions ----------
function snippetAround(text, id) {
  const flat = text.replace(/\s+/g, ' ').trim();
  let at = flat.indexOf(id);
  if (at === -1) at = flat.search(/youtu/i);
  if (at === -1) at = 0;
  const start = Math.max(0, at - 220);
  const end = Math.min(flat.length, at + 120);
  return (start > 0 ? '… ' : '') + flat.slice(start, end) + (end < flat.length ? ' …' : '');
}

const videos = new Map(); // videoId -> mention[]
let commentsSkippedOwnThread = 0;
for (const h of items.values()) {
  if (!h.author) continue;
  const isComment = h.comment_text != null;
  let ids;
  if (isComment) {
    ids = extractVideoIds(h.comment_text);
    const threadVideos = new Set(h.story_url ? extractVideoIds(h.story_url) : []);
    const before = ids.length;
    ids = ids.filter((id) => !threadVideos.has(id));
    commentsSkippedOwnThread += before - ids.length;
  } else {
    ids = extractVideoIds([h.url ?? '', h.story_text ?? ''].join(' '));
  }
  for (const id of ids) {
    const m = {
      item: Number(h.objectID),
      kind: isComment ? 'comment' : 'story',
      author: h.author,
      t: h.created_at_i,
      story: isComment ? h.story_id : Number(h.objectID),
      storyTitle: isComment ? h.story_title ?? null : h.title ?? null,
    };
    if (isComment) m.text = snippetAround(htmlToText(h.comment_text), id);
    else {
      m.points = h.points ?? 0;
      m.comments = h.num_comments ?? 0;
      if (h.story_text) m.text = snippetAround(htmlToText(h.story_text), id);
    }
    if (!videos.has(id)) videos.set(id, []);
    videos.get(id).push(m);
  }
}

function summarize(id, mentions) {
  mentions.sort((a, b) => a.t - b.t);
  const people = new Set(mentions.map((m) => m.author));
  const byYear = {};
  for (const m of mentions) byYear[yearOf(m.t)] = (byYear[yearOf(m.t)] ?? 0) + 1;
  const stories = mentions.filter((m) => m.kind === 'story');
  return {
    id,
    people: people.size,
    years: Object.keys(byYear).length,
    byYear,
    mentions: mentions.length,
    stories: stories.length,
    comments: mentions.length - stories.length,
    topPoints: Math.max(0, ...stories.map((s) => s.points)),
    first: mentions[0].t,
    last: mentions.at(-1).t,
  };
}

const all = [...videos].map(([id, ms]) => summarize(id, ms));
const qualifying = all.filter((v) => v.people >= MIN_PEOPLE && v.years >= MIN_YEARS);

console.log(`items ${items.size}, distinct videos ${all.length}, own-thread comment links skipped ${commentsSkippedOwnThread}`);
if (STATS_ONLY) {
  const grid = [];
  for (const p of [2, 3, 4, 5, 6, 8, 10]) {
    const row = { people: p };
    for (const y of [2, 3, 4, 5, 6, 8]) row[`y>=${y}`] = all.filter((v) => v.people >= p && v.years >= y).length;
    grid.push(row);
  }
  console.table(grid);
  const top = [...all].sort((a, b) => b.people - a.people || b.years - a.years).slice(0, 25);
  console.table(top.map(({ id, people, years, mentions, stories, topPoints }) => ({ id, people, years, mentions, stories, topPoints })));
  process.exit(0);
}

// ---------- YouTube oEmbed (title / channel / availability) ----------
fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oembed(id) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt >= 6) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const j = await res.json();
      return { status: 200, title: j.title, channel: j.author_name, channelUrl: j.author_url };
    }
    // 400/401/403/404 are definitive answers (invalid, private, embedding
    // disabled, removed). Anything else is transient: retry, never cache.
    if ([400, 401, 403, 404].includes(res.status)) return { status: res.status };
    if (attempt >= 6) throw new Error(`oEmbed ${res.status} for ${id}`);
    await sleep(1000 * 2 ** attempt);
  }
}

const todo = qualifying.filter((v) => !cache[v.id]);
console.log(`oEmbed: ${qualifying.length - todo.length} cached, ${todo.length} to fetch`);
let done = 0;
async function worker() {
  while (todo.length) {
    const v = todo.shift();
    cache[v.id] = await oembed(v.id);
    if (++done % 100 === 0) {
      console.log(`  oEmbed ${done}`);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));

const unavailable = {};
const playable = [];
for (const v of qualifying) {
  const o = cache[v.id];
  if (o.status !== 200) {
    unavailable[o.status] = (unavailable[o.status] ?? 0) + 1;
    continue;
  }
  playable.push({ ...v, title: o.title, channel: o.channel, channelUrl: o.channelUrl });
}
playable.sort((a, b) => b.people - a.people || b.years - a.years || b.mentions - a.mentions || a.id.localeCompare(b.id));

// ---------- related videos: shared HN threads, then same channel ----------
const playableIds = new Set(playable.map((v) => v.id));
const threadsOf = new Map();
const videosInThread = new Map();
for (const v of playable) {
  const threads = new Set(videos.get(v.id).map((m) => m.story).filter(Boolean));
  threadsOf.set(v.id, threads);
  for (const s of threads) {
    if (!videosInThread.has(s)) videosInThread.set(s, new Set());
    videosInThread.get(s).add(v.id);
  }
}
const rank = new Map(playable.map((v, i) => [v.id, i]));
function related(v) {
  const score = new Map();
  for (const s of threadsOf.get(v.id)) {
    for (const other of videosInThread.get(s)) {
      if (other !== v.id) score.set(other, (score.get(other) ?? 0) + 1);
    }
  }
  const out = [...score].sort((a, b) => b[1] - a[1] || rank.get(a[0]) - rank.get(b[0])).map(([id]) => id);
  for (const o of playable) {
    if (out.length >= 12) break;
    if (o.id !== v.id && o.channel === v.channel && !out.includes(o.id)) out.push(o.id);
  }
  return out.slice(0, 12);
}

// ---------- write ----------
const vDir = path.join(OUT_DIR, 'v');
fs.rmSync(vDir, { recursive: true, force: true });
fs.mkdirSync(vDir, { recursive: true });
for (const v of playable) {
  fs.writeFileSync(path.join(vDir, `${v.id}.json`), JSON.stringify({ id: v.id, related: related(v), mentions: videos.get(v.id) }));
}
fs.writeFileSync(path.join(OUT_DIR, 'videos.json'), JSON.stringify(playable));

const crawledAt = Math.max(...fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.done')).map((f) => Date.parse(fs.readFileSync(path.join(RAW_DIR, f), 'utf8'))));
const meta = {
  builtAt: new Date().toISOString(),
  crawledAt: Number.isFinite(crawledAt) ? new Date(crawledAt).toISOString() : null,
  rule: { minPeople: MIN_PEOPLE, minYears: MIN_YEARS },
  hnItemsScanned: items.size,
  distinctVideosLinked: all.length,
  qualifying: qualifying.length,
  playable: playable.length,
  unavailable,
  ownThreadLinksSkipped: commentsSkippedOwnThread,
  firstMention: Math.min(...playable.map((v) => v.first)),
};
fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(meta);
