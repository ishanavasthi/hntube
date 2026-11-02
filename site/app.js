// HNTube — static, hash-routed single page app. All data comes from data/*.json
// built by scripts/build.mjs. Every string from the data is inserted as text
// (never as HTML).

const HN = 'https://news.ycombinator.com';
const PAGE_SIZE = 48;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const SORTS = [
  { key: 'people', label: 'Most recommended', icon: 'M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z',
    cmp: (a, b) => b.people - a.people || b.years - a.years || b.mentions - a.mentions },
  { key: 'years', label: 'Longest-running', icon: 'M4 5h16v15H4zM4 9h16M8 3v4M16 3v4',
    cmp: (a, b) => b.years - a.years || b.people - a.people || a.first - b.first },
  { key: 'mentions', label: 'Most mentioned', icon: 'M4 5h16v11H9l-5 4z',
    cmp: (a, b) => b.mentions - a.mentions || b.people - a.people },
  { key: 'recent', label: 'Recently resurfaced', icon: 'M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3 4v4h4',
    cmp: (a, b) => b.last - a.last },
  { key: 'oldest', label: 'Earliest finds', icon: 'M5 20V8l7-5 7 5v12H5zM10 20v-6h4v6',
    cmp: (a, b) => a.first - b.first },
];

const state = { videos: [], byId: new Map(), meta: null, channels: [], details: new Map() };
const main = document.getElementById('main');
let gridObserver = null;

// ---------- tiny DOM helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

// ---------- formatting ----------
const nf = new Intl.NumberFormat('en');
const df = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtDate = (t) => df.format(new Date(t * 1000));
const yearOf = (t) => new Date(t * 1000).getUTCFullYear();
const plural = (n, one, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;

function relTime(t) {
  const s = Date.now() / 1000 - t;
  const units = [[31557600, 'year'], [2629800, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, name] of units) {
    if (s >= secs) return `${plural(Math.floor(s / secs), name)} ago`;
  }
  return 'just now';
}

function yearSpan(v) {
  const a = yearOf(v.first);
  const b = yearOf(v.last);
  return a === b ? String(a) : `${a}–${b}`;
}

function hue(str) {
  let x = 0;
  for (const ch of str) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return x % 360;
}

function avatar(name, cls = 'avatar') {
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  return h('span', { class: cls, style: `--h:${hue(name)}`, 'aria-hidden': 'true' }, letter);
}

const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

// ---------- routing ----------
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  if (parts[0] === 'watch' && parts[1]) return { name: 'watch', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'about') return { name: 'about' };
  return {
    name: 'home',
    q: params.get('q') ?? '',
    channel: params.get('channel') ?? '',
    sort: SORTS.some((s) => s.key === params.get('sort')) ? params.get('sort') : 'people',
  };
}

function homeHash({ q = '', channel = '', sort = 'people' } = {}) {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (channel) p.set('channel', channel);
  if (sort && sort !== 'people') p.set('sort', sort);
  const s = p.toString();
  return `#/${s ? `?${s}` : ''}`;
}

function render({ keepScroll = false } = {}) {
  const route = parseRoute();
  if (gridObserver) {
    gridObserver.disconnect();
    gridObserver = null;
  }
  main.replaceChildren();
  document.body.classList.toggle('on-watch', route.name === 'watch');
  updateSidebar(route);
  // Desktop home pages keep the user's sidebar choice; the watch page and
  // small screens use it as an overlay that starts closed.
  setSidebar(route.name !== 'watch' && !isNarrow() && sidebarPref);
  const input = document.getElementById('search-input');
  if (document.activeElement !== input) input.value = route.name === 'home' ? route.q : '';
  // Live search re-renders in place; every other navigation starts at the top.
  if (!keepScroll) window.scrollTo(0, 0);
  if (route.name === 'watch') renderWatch(route.id);
  else if (route.name === 'about') renderAbout();
  else renderHome(route);
}

// ---------- sidebar ----------
function updateSidebar(route) {
  const sorts = document.getElementById('side-sorts');
  sorts.replaceChildren(
    ...SORTS.map((s) => {
      const active = route.name === 'home' && !route.q && !route.channel && route.sort === s.key;
      return h('a', { class: `side-link${active ? ' active' : ''}`, href: homeHash({ sort: s.key }) }, svgIcon(s.icon), h('span', {}, s.label));
    }),
  );
  const ch = document.getElementById('side-channels');
  ch.replaceChildren(
    ...state.channels.slice(0, 12).map(({ name, count }) => {
      const active = route.name === 'home' && route.channel === name;
      return h('a', { class: `side-link channel${active ? ' active' : ''}`, href: homeHash({ channel: name }), title: name },
        avatar(name, 'avatar sm'), h('span', { class: 'grow' }, name), h('span', { class: 'count' }, count));
    }),
  );
  document.querySelector('[data-route="about"]').classList.toggle('active', route.name === 'about');
}

let sidebarPref = true;
const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

function setSidebar(open) {
  document.body.classList.toggle('sidebar-closed', !open);
  document.getElementById('menu-btn').setAttribute('aria-expanded', String(open));
}

// ---------- home ----------
function matches(v, terms) {
  if (!terms.length) return true;
  const hay = `${v.title} ${v.channel}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function renderHome(route) {
  const sort = SORTS.find((s) => s.key === route.sort);
  const terms = route.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.videos
    .filter((v) => (!route.channel || v.channel === route.channel) && matches(v, terms))
    .sort(sort.cmp);

  document.title = route.q ? `${route.q} — HNTube` : route.channel ? `${route.channel} — HNTube` : 'HNTube — videos Hacker News keeps recommending';

  const chips = h('div', { class: 'chips', role: 'list' },
    h('a', { class: `chip${route.channel ? '' : ' active'}`, href: homeHash({ q: route.q, sort: route.sort }), role: 'listitem' }, 'All'),
    state.channels.slice(0, 24).map(({ name }) =>
      h('a', { class: `chip${route.channel === name ? ' active' : ''}`, href: homeHash({ q: route.q, channel: name, sort: route.sort }), role: 'listitem' }, name)),
  );

  const sortSelect = h('select', {
    'aria-label': 'Sort videos',
    onchange: (e) => { location.hash = homeHash({ q: route.q, channel: route.channel, sort: e.target.value }); },
  }, SORTS.map((s) => h('option', { value: s.key, selected: s.key === route.sort }, s.label)));

  let heading;
  if (route.q || route.channel) {
    const what = [route.q && `“${route.q}”`, route.channel && `channel ${route.channel}`].filter(Boolean).join(' in ');
    heading = h('h1', { class: 'list-title' }, `${plural(list.length, 'video')} for ${what}`);
  } else {
    heading = h('h1', { class: 'list-title' }, sort.label,
      h('span', { class: 'muted' }, ` · ${plural(list.length, 'video')} Hacker News keeps coming back to`));
  }

  const grid = h('div', { class: 'grid' });
  main.append(chips, h('div', { class: 'list-head' }, heading, h('label', { class: 'sort' }, 'Sort by ', sortSelect)), grid);

  if (!list.length) {
    grid.replaceWith(h('div', { class: 'empty' },
      h('p', {}, 'No videos match that search.'),
      h('a', { class: 'btn', href: homeHash() }, 'Clear filters')));
    return;
  }

  let shown = 0;
  const sentinel = h('div', { class: 'sentinel' });
  const more = () => {
    const next = list.slice(shown, shown + PAGE_SIZE);
    grid.append(...next.map(card));
    shown += next.length;
    if (shown >= list.length) {
      sentinel.remove();
      gridObserver?.disconnect();
    }
  };
  more();
  if (shown < list.length) {
    main.append(sentinel);
    gridObserver = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: '800px' });
    gridObserver.observe(sentinel);
  }
}

function card(v) {
  const href = `#/watch/${v.id}`;
  return h('article', { class: 'card' },
    h('a', { class: 'thumb', href, tabindex: '-1', 'aria-hidden': 'true' },
      h('img', { src: thumb(v.id), alt: '', loading: 'lazy', width: '320', height: '180' }),
      h('span', { class: 'badge', title: `Linked on HN in ${v.years} different years` }, `${v.years} yrs on HN`)),
    h('div', { class: 'card-body' },
      h('a', { href: homeHash({ channel: v.channel }), class: 'card-avatar', 'aria-label': v.channel }, avatar(v.channel)),
      h('div', { class: 'card-text' },
        h('h3', { class: 'card-title' }, h('a', { href, title: v.title }, v.title)),
        h('a', { class: 'card-channel', href: homeHash({ channel: v.channel }) }, v.channel),
        h('div', { class: 'card-stats' }, `${plural(v.people, 'HN user')} · ${yearSpan(v)}`))));
}

// ---------- watch ----------
async function loadDetail(id) {
  if (!state.details.has(id)) {
    state.details.set(id, fetch(`data/v/${id}.json`).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).catch((err) => {
      state.details.delete(id);
      throw err;
    }));
  }
  return state.details.get(id);
}

function renderWatch(id) {
  const v = VIDEO_ID.test(id) ? state.byId.get(id) : null;
  if (!v) {
    document.title = 'Not found — HNTube';
    main.append(h('div', { class: 'empty' },
      h('h1', {}, 'That video isn’t in HNTube'),
      h('p', {}, 'Only videos that Hacker News users have recommended repeatedly over the years are listed here.'),
      h('a', { class: 'btn', href: '#/' }, 'Back to home')));
    return;
  }
  document.title = `${v.title} — HNTube`;

  const player = h('div', { class: 'player' },
    h('iframe', {
      src: `https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&rel=0`,
      title: v.title,
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
      referrerpolicy: 'strict-origin-when-cross-origin',
      allowfullscreen: true,
    }));

  const mentionsBox = h('section', { class: 'mentions', 'aria-label': 'Hacker News mentions' }, h('p', { class: 'muted' }, 'Loading HN mentions…'));
  const upNext = h('aside', { class: 'up-next', 'aria-label': 'Up next' });

  const primary = h('div', { class: 'watch-primary' },
    player,
    h('h1', { class: 'watch-title' }, v.title),
    h('div', { class: 'watch-row' },
      h('a', { class: 'watch-channel', href: homeHash({ channel: v.channel }) }, avatar(v.channel, 'avatar lg'),
        h('span', {}, h('strong', {}, v.channel), h('span', { class: 'muted small' }, `${plural(state.videos.filter((o) => o.channel === v.channel).length, 'video')} on HNTube`))),
      h('div', { class: 'watch-actions' },
        h('a', { class: 'btn', href: `https://www.youtube.com/watch?v=${v.id}`, target: '_blank', rel: 'noopener' }, 'Open on YouTube'),
        h('a', { class: 'btn', href: `https://hn.algolia.com/?dateRange=all&type=all&query=${v.id}`, target: '_blank', rel: 'noopener' }, 'Search HN for this video'))),
    describe(v),
    mentionsBox);

  main.append(h('div', { class: 'watch' }, primary, upNext));
  renderUpNext(upNext, v, []);

  loadDetail(id).then((d) => {
    if (parseRoute().id !== id) return;
    renderMentions(mentionsBox, d.mentions);
    renderUpNext(upNext, v, d.related);
  }).catch(() => {
    mentionsBox.replaceChildren(h('p', { class: 'muted' }, 'Couldn’t load the HN mentions for this video. Try reloading the page.'));
  });
}

function describe(v) {
  const y0 = yearOf(v.first);
  const y1 = yearOf(v.last);
  const max = Math.max(...Object.values(v.byYear));
  const bars = [];
  for (let y = y0; y <= y1; y++) {
    const n = v.byYear[y] ?? 0;
    bars.push(h('div', { class: `bar${n ? '' : ' zero'}`, title: `${y}: ${plural(n, 'mention')}` },
      h('span', { class: 'fill', style: `height:${n ? Math.max(8, (n / max) * 100) : 0}%` }),
      h('span', { class: 'yr' }, `’${String(y).slice(2)}`)));
  }
  return h('section', { class: 'describe' },
    h('p', { class: 'describe-lead' },
      'Recommended by ', h('strong', {}, plural(v.people, 'HN user')),
      ' in ', h('strong', {}, plural(v.years, 'different year')),
      `, from ${fmtDate(v.first)} to ${fmtDate(v.last)}.`),
    h('p', { class: 'muted small' },
      `${plural(v.mentions, 'mention')}: ${plural(v.stories, 'submission')} and ${plural(v.comments, 'comment')}`,
      v.topPoints ? ` · best submission scored ${plural(v.topPoints, 'point')}` : ''),
    h('div', { class: 'years-chart', role: 'img', 'aria-label': `HN mentions per year, ${y0} to ${y1}` }, bars));
}

function renderMentions(box, mentions) {
  let order = 'oldest';
  let limit = 30;
  const list = h('ol', { class: 'mention-list' });
  const moreBtn = h('button', { class: 'btn wide', onclick: () => { limit += 50; draw(); } });
  const select = h('select', { 'aria-label': 'Sort mentions', onchange: (e) => { order = e.target.value; limit = 30; draw(); } },
    h('option', { value: 'oldest' }, 'Oldest first'),
    h('option', { value: 'newest' }, 'Newest first'));

  function draw() {
    const sorted = order === 'oldest' ? mentions : [...mentions].reverse();
    list.replaceChildren(...sorted.slice(0, limit).map(mentionItem));
    const left = mentions.length - limit;
    moreBtn.hidden = left <= 0;
    moreBtn.textContent = `Show ${Math.min(50, left)} more of ${nf.format(left)}`;
  }
  draw();
  box.replaceChildren(
    h('div', { class: 'mentions-head' }, h('h2', {}, plural(mentions.length, 'HN mention')), h('label', { class: 'sort' }, 'Sort ', select)),
    list, moreBtn);
}

function mentionItem(m) {
  const item = `${HN}/item?id=${m.item}`;
  const thread = m.story ? `${HN}/item?id=${m.story}` : null;
  const kind = m.kind === 'story'
    ? h('span', { class: 'tag story' }, `submitted · ${plural(m.points, 'point')} · ${plural(m.comments, 'comment')}`)
    : h('span', { class: 'tag' }, 'comment');
  return h('li', { class: 'mention' },
    avatar(m.author),
    h('div', { class: 'mention-body' },
      h('div', { class: 'mention-meta' },
        h('a', { class: 'author', href: `${HN}/user?id=${encodeURIComponent(m.author)}`, target: '_blank', rel: 'noopener' }, m.author),
        h('a', { class: 'muted', href: item, target: '_blank', rel: 'noopener', title: fmtDate(m.t) }, relTime(m.t)),
        kind),
      m.storyTitle && h('div', { class: 'mention-thread' },
        m.kind === 'story' ? '' : 'in ',
        thread ? h('a', { href: thread, target: '_blank', rel: 'noopener' }, m.storyTitle) : m.storyTitle),
      m.text && h('p', { class: 'mention-text' }, m.text),
      h('a', { class: 'mention-link', href: item, target: '_blank', rel: 'noopener' }, 'View on Hacker News ↗')));
}

function renderUpNext(box, v, relatedIds) {
  const seen = new Set([v.id]);
  const picks = [];
  for (const id of relatedIds) {
    const o = state.byId.get(id);
    if (o && !seen.has(id)) { picks.push(o); seen.add(id); }
  }
  for (const o of state.videos) {
    if (picks.length >= 20) break;
    if (!seen.has(o.id)) { picks.push(o); seen.add(o.id); }
  }
  box.replaceChildren(
    h('h2', { class: 'up-next-title' }, 'Up next'),
    ...picks.map((o) => h('a', { class: 'mini', href: `#/watch/${o.id}` },
      h('span', { class: 'mini-thumb' }, h('img', { src: thumb(o.id), alt: '', loading: 'lazy', width: '168', height: '94' }),
        h('span', { class: 'badge' }, `${o.years} yrs on HN`)),
      h('span', { class: 'mini-text' },
        h('span', { class: 'mini-title' }, o.title),
        h('span', { class: 'muted small' }, o.channel),
        h('span', { class: 'muted small' }, `${plural(o.people, 'HN user')} · ${yearSpan(o)}`)))));
}

// ---------- about ----------
function renderAbout() {
  document.title = 'How videos are picked — HNTube';
  const m = state.meta;
  const unavailable = Object.values(m.unavailable).reduce((a, b) => a + b, 0);
  main.append(h('article', { class: 'about' },
    h('h1', {}, 'How videos are picked'),
    h('p', {}, 'HNTube lists YouTube videos that Hacker News users have recommended again and again over the years. Nothing here is hand-picked: every video is chosen by a fixed rule applied to public HN data, and every recommendation links back to the HN post it came from.'),
    h('h2', {}, 'The rule'),
    h('p', {}, 'A video is listed when ',
      h('strong', {}, `at least ${m.rule.minPeople} different HN users`), ' linked to it, in ',
      h('strong', {}, `at least ${m.rule.minYears} different calendar years`), '.'),
    h('ul', {},
      h('li', {}, 'A mention is a story submission whose link or text points at the video, or a comment that links to it.'),
      h('li', {}, 'Each person counts once, however often they post the same link, so one enthusiast can’t push a video in alone.'),
      h('li', {}, `Links posted inside the video’s own submission thread don’t count. Those comments discuss that submission instead of recommending the video again. ${nf.format(m.ownThreadLinksSkipped)} such links were left out.`),
      h('li', {}, 'Every form of YouTube link counts: youtube.com/watch, youtu.be, m.youtube.com, embed, shorts, live, and youtube-nocookie.')),
    h('h2', {}, 'The numbers'),
    h('dl', { class: 'facts' },
      h('dt', {}, 'HN posts scanned'), h('dd', {}, nf.format(m.hnItemsScanned)),
      h('dt', {}, 'Distinct YouTube videos linked'), h('dd', {}, nf.format(m.distinctVideosLinked)),
      h('dt', {}, 'Videos meeting the rule'), h('dd', {}, nf.format(m.qualifying)),
      h('dt', {}, 'Left out (removed, private or embedding disabled)'), h('dd', {}, nf.format(unavailable)),
      h('dt', {}, 'Listed on HNTube'), h('dd', {}, nf.format(m.playable)),
      h('dt', {}, 'HN data collected'), h('dd', {}, m.crawledAt ? fmtDate(Date.parse(m.crawledAt) / 1000) : 'unknown')),
    h('h2', {}, 'Sources and caveats'),
    h('ul', {},
      h('li', {}, 'HN posts come from the public HN Algolia search API. Video titles and channels come from YouTube’s oEmbed endpoint.'),
      h('li', {}, 'Posts deleted or killed on HN aren’t in the search index, so they aren’t counted.'),
      h('li', {}, 'A link isn’t always praise. Sometimes people link a video to criticise it. Open the HN mentions under any video to read the context.'),
      h('li', {}, 'Years use UTC.'))));
}

// ---------- boot ----------
async function boot() {
  document.getElementById('menu-btn').addEventListener('click', () => {
    const open = document.body.classList.contains('sidebar-closed');
    setSidebar(open);
    if (!isNarrow() && !document.body.classList.contains('on-watch')) sidebarPref = open;
  });
  document.getElementById('theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('hntube-theme', next);
  });
  const input = document.getElementById('search-input');
  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const r = parseRoute();
    location.hash = homeHash({ q: input.value.trim(), channel: r.name === 'home' ? r.channel : '', sort: r.name === 'home' ? r.sort : 'people' });
    input.blur();
  });
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const r = parseRoute();
      if (r.name !== 'home') return;
      history.replaceState(null, '', homeHash({ q: input.value.trim(), channel: r.channel, sort: r.sort }));
      render({ keepScroll: true });
    }, 200);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      input.focus();
    }
  });
  setSidebar(!isNarrow());

  try {
    const [videos, meta] = await Promise.all([
      fetch('data/videos.json').then((r) => r.json()),
      fetch('data/meta.json').then((r) => r.json()),
    ]);
    state.videos = videos;
    state.meta = meta;
    state.byId = new Map(videos.map((v) => [v.id, v]));
    const counts = new Map();
    for (const v of videos) counts.set(v.channel, (counts.get(v.channel) ?? 0) + 1);
    state.channels = [...counts].map(([name, count]) => ({ name, count }))
      .filter((c) => c.count > 1)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    document.getElementById('side-foot').textContent =
      `${plural(videos.length, 'video')} · HN data collected ${meta.crawledAt ? fmtDate(Date.parse(meta.crawledAt) / 1000) : '—'}`;
  } catch {
    main.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Couldn’t load the video index. Try reloading the page.')));
    return;
  }
  window.addEventListener('hashchange', () => render());
  render();
}

boot();
