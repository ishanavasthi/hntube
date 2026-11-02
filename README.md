<img src="assets/icon.svg" width="64" height="64" alt="">

# hntube

A YouTube-style site that only lists videos Hacker News users have recommended
again and again over the years.

## The rule

A video is listed when **at least 5 different HN users** linked to it in
**at least 5 different calendar years** (UTC).

- A mention is a story submission whose URL or text links the video, or a comment that links it.
- Each person counts once, however often they post the same link.
- Comments that link a video inside that video's own submission thread don't count.
  They discuss the submission instead of recommending the video again.
- Videos YouTube reports as removed, private or not embeddable are left out.

Every video page lists each HN mention with a link back to the original post, so anyone can check the rule was applied correctly.

## Layout

| Path | What |
| --- | --- |
| `scripts/crawl.mjs` | Pages through every HN comment and story that mentions `youtube.com` / `youtu.be` via the HN Algolia API → `data/raw/*.jsonl` (gitignored, ~300 MB). Resumable. |
| `scripts/lib/extract.mjs` | Extracts 11-character video IDs from HN's HTML-escaped text. Tested in `extract.test.mjs`. |
| `scripts/build.mjs` | Applies the rule, looks up titles and channels via YouTube oEmbed (cached in `data/cache/`), and writes `site/data/`. |
| `site/` | The static site: plain HTML, CSS and JS with hash routing and no build step. |

## Commands

```sh
npm test                 # extractor tests
npm run crawl            # fetch HN data (~6 min); delete data/raw/*.done to refresh
npm run stats            # how many videos each threshold would admit
npm run build            # write site/data (optionally --min-people N --min-years N)
npm run serve            # http://127.0.0.1:8080
```

`site/` deploys as-is to any static host.

## Deployment

Live at https://ishanavasthi.github.io/hntube/. Every push to `main` that touches `site/` publishes it to GitHub Pages
(`.github/workflows/pages.yml`). There's no backend: the data is built ahead of time, so refreshing it means
`npm run crawl && npm run build`, then commit and push `site/data`.
