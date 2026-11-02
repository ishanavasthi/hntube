// Pulls YouTube video IDs out of HN comment/story HTML.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

const ID = '([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])';
// Host must be youtube.com / youtube-nocookie.com (any subdomain) or youtu.be,
// not preceded by a letter/digit/hyphen (rules out notyoutube.com) and
// followed directly by a path (rules out youtube.com.evil.example).
const YT_HOST = '(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*youtube(?:-nocookie)?\\.com';
const PATTERNS = [
  // /watch?…&v=ID, /watch#!v=ID, /#!/watch?v=ID
  new RegExp(`${YT_HOST}/(?:#!/)?watch/?(?:\\?(?:[^\\s"'<>#]*&)?|#!)v=${ID}`, 'gi'),
  // /embed/ID, /v/ID, /shorts/ID, /live/ID, /watch/ID, /e/ID
  new RegExp(`${YT_HOST}/(?:embed|v|e|shorts|live|watch)/${ID}`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9-])youtu\\.be/${ID}`, 'gi'),
];

export function extractVideoIds(html) {
  const text = decodeEntities(html);
  const found = [];
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) found.push([m.index, m[1]]);
  }
  found.sort((a, b) => a[0] - b[0]);
  return [...new Set(found.map(([, id]) => id))];
}
