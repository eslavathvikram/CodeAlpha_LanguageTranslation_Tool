'use strict';
const assert = require('node:assert/strict');
const { chunkText, decodeEntities } = require('../lib/providers');

// short text stays in one piece
assert.deepEqual(chunkText('Hello world.'), ['Hello world.']);

// long text splits on sentence ends and nothing is lost
const long = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i}.`).join(' ');
const chunks = chunkText(long);
assert.ok(chunks.length > 1);
assert.equal(chunks.join(''), long);
for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 450);

// text with no punctuation is hard split by bytes, multi-byte characters stay whole
const telugu = 'తెలుగు '.repeat(120);
const tc = chunkText(telugu);
assert.equal(tc.join(''), telugu);
for (const c of tc) assert.ok(Buffer.byteLength(c) <= 450);

// entity decoding
assert.equal(decodeEntities('It&#39;s &quot;fine&quot; &amp; done'), 'It\'s "fine" & done');

console.log('providers: all tests passed');
