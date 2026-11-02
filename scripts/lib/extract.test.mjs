import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVideoIds, decodeEntities, htmlToText } from './extract.mjs';

const ids = (s) => extractVideoIds(s);

test('decodes HN entity escapes', () => {
  assert.equal(decodeEntities('https:&#x2F;&#x2F;a.b&#x2F;?x=1&amp;y=&quot;2&quot; it&#x27;s &#39;&lt;&gt;'), 'https://a.b/?x=1&y="2" it\'s \'<>');
});

test('HN-escaped youtu.be href with tracking params', () => {
  const html = 'Obligatory clip:<p><a href="https:&#x2F;&#x2F;youtu.be&#x2F;HwAO5IET0xw?si=sPeOpu8p9tTtRMVo" rel="nofollow">https:&#x2F;&#x2F;youtu.be&#x2F;HwAO5IET0xw?si=sPeOpu8p9tTtRMVo</a>';
  assert.deepEqual(ids(html), ['HwAO5IET0xw']);
});

test('watch?v= with extra params before and after v', () => {
  assert.deepEqual(ids('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), ['dQw4w9WgXcQ']);
  assert.deepEqual(ids('https:&#x2F;&#x2F;www.youtube.com&#x2F;watch?feature=player_embedded&amp;v=dQw4w9WgXcQ'), ['dQw4w9WgXcQ']);
  assert.deepEqual(ids('http://youtube.com/watch?app=desktop&v=a-B_c1D2e3F'), ['a-B_c1D2e3F']);
});

test('subdomains and path forms', () => {
  assert.deepEqual(ids('https://m.youtube.com/watch?v=AAAAAAAAAA1'), ['AAAAAAAAAA1']);
  assert.deepEqual(ids('https://music.youtube.com/watch?v=AAAAAAAAAA2'), ['AAAAAAAAAA2']);
  assert.deepEqual(ids('https://www.youtube.com/embed/AAAAAAAAAA3?start=4'), ['AAAAAAAAAA3']);
  assert.deepEqual(ids('https://www.youtube-nocookie.com/embed/AAAAAAAAAA4'), ['AAAAAAAAAA4']);
  assert.deepEqual(ids('https://www.youtube.com/v/AAAAAAAAAA5'), ['AAAAAAAAAA5']);
  assert.deepEqual(ids('https://youtube.com/shorts/AAAAAAAAAA6'), ['AAAAAAAAAA6']);
  assert.deepEqual(ids('https://www.youtube.com/live/AAAAAAAAAA7?si=x'), ['AAAAAAAAAA7']);
  assert.deepEqual(ids('www.youtube.com/watch/AAAAAAAAAA8'), ['AAAAAAAAAA8']);
});

test('old hash-bang URLs', () => {
  assert.deepEqual(ids('http://www.youtube.com/#!/watch?v=AAAAAAAAAA9'), ['AAAAAAAAAA9']);
  assert.deepEqual(ids('http://www.youtube.com/watch#!v=AAAAAAAAAB0&feature=related'), ['AAAAAAAAAB0']);
});

test('HN-truncated link text does not yield a partial ID', () => {
  const html = '<a href="https:&#x2F;&#x2F;www.youtube.com&#x2F;watch?list=PLx&amp;v=dQw4w9WgXcQ" rel="nofollow">https:&#x2F;&#x2F;www.youtube.com&#x2F;watch?list=PLx&amp;v=dQw4...</a>';
  assert.deepEqual(ids(html), ['dQw4w9WgXcQ']);
});

test('dedupes repeated links and keeps first-seen order', () => {
  const html = 'a youtu.be/BBBBBBBBBB1 b https://youtube.com/watch?v=BBBBBBBBBB2 c youtu.be/BBBBBBBBBB1';
  assert.deepEqual(ids(html), ['BBBBBBBBBB1', 'BBBBBBBBBB2']);
});

test('ignores non-video YouTube URLs', () => {
  assert.deepEqual(ids('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'), []);
  assert.deepEqual(ids('https://www.youtube.com/channel/UCYO_jab_esuFRV4b17AJtAw'), []);
  assert.deepEqual(ids('https://www.youtube.com/@3blue1brown/videos'), []);
  assert.deepEqual(ids('https://www.youtube.com/user/Computerphile'), []);
  assert.deepEqual(ids('https://www.youtube.com/results?search_query=hello+world'), []);
});

test('rejects wrong-length IDs and lookalike domains', () => {
  assert.deepEqual(ids('https://www.youtube.com/watch?v=tooShort'), []);
  assert.deepEqual(ids('https://www.youtube.com/watch?v=dQw4w9WgXcQextra'), []);
  assert.deepEqual(ids('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), []);
  assert.deepEqual(ids('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), []);
  assert.deepEqual(ids('https://www.youtube.com/watch?xv=dQw4w9WgXcQ'), []);
});

test('ID followed by punctuation in prose', () => {
  assert.deepEqual(ids('(see https://youtu.be/CCCCCCCCCC1).'), ['CCCCCCCCCC1']);
  assert.deepEqual(ids('watch this: youtube.com/watch?v=CCCCCCCCCC2, it is great'), ['CCCCCCCCCC2']);
});

test('htmlToText turns paragraphs into line breaks and strips tags', () => {
  assert.equal(htmlToText('Hi <i>there</i><p>Next &amp; <a href="x">link</a>'), 'Hi there\n\nNext & link');
});

test('host matching is case-insensitive, ID case is preserved', () => {
  assert.deepEqual(ids('HTTPS://WWW.YouTube.com/watch?v=aBcDeFgHiJk'), ['aBcDeFgHiJk']);
});
