'use strict';

const TIMEOUT_MS = 12000;
const MYMEMORY_MAX_BYTES = 450; // the API rejects queries over 500 bytes

// Minimum match quality score from MyMemory (0-1). Anything below this
// is treated as unreliable and we try to pick a better match from the
// matches[] array instead.
const MIN_MATCH_SCORE = 0.35;

// Well-known garbage responses MyMemory returns for short / ambiguous inputs.
const JUNK_RESULTS = new Set(['send', 'submit', 'ok', 'go', 'yes', 'no', 'translate', 'translating']);

class ProviderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/* ---------- helpers ---------- */

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

function decodeEntities(s) {
  return s
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function hardSplit(s, max) {
  const out = [];
  let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > max) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// Splits text into pieces no larger than `max` bytes, breaking after sentence
// ends or line breaks where possible so each piece translates on its own.
function chunkText(text, max = MYMEMORY_MAX_BYTES) {
  const pieces = text.split(/(?<=[.!?。！？\n])/);
  const chunks = [];
  let cur = '';
  for (const piece of pieces) {
    const parts = Buffer.byteLength(piece) > max ? hardSplit(piece, max) : [piece];
    for (const part of parts) {
      if (Buffer.byteLength(cur + part) > max) {
        if (cur) chunks.push(cur);
        cur = part;
      } else {
        cur += part;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* ---------- Google Cloud Translation (v2) ---------- */

async function googleTranslate(text, source, target) {
  const body = { q: text, target, format: 'text' };
  if (source !== 'auto') body.source = source;

  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(process.env.GOOGLE_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error && data.error.message;
    if (res.status === 400 || res.status === 403) {
      throw new ProviderError(`Google rejected the request: ${msg || 'check GOOGLE_API_KEY and that the Translation API is enabled.'}`);
    }
    throw new ProviderError(msg || 'Google Translate returned an error.');
  }

  const first = data.data && data.data.translations && data.data.translations[0];
  if (!first) throw new ProviderError('Google Translate returned an empty response.');

  return {
    translation: first.translatedText,
    detected: first.detectedSourceLanguage || null,
  };
}

/* ---------- MyMemory (free, no key) ---------- */

/**
 * Pick the best translation string from a MyMemory response.
 * - Rejects known junk UI strings ("Send", "OK", …)
 * - Rejects results whose match score is below MIN_MATCH_SCORE
 * - Falls back to the best-scored entry in the matches[] array
 * - Last resort: returns the raw primary result so the caller always gets something
 */
function pickBestTranslation(rd, matches) {
  const primary = decodeEntities(String(rd.translatedText || ''));
  const primaryScore = Number(rd.match) || 0;

  const isJunk = (t) => !t || JUNK_RESULTS.has(t.trim().toLowerCase());

  if (!isJunk(primary) && primaryScore >= MIN_MATCH_SCORE) {
    return primary;
  }

  // Try to find a better result from the matches array.
  if (Array.isArray(matches) && matches.length > 0) {
    const sorted = [...matches]
      .filter((m) => m && m.translation && !isJunk(m.translation.trim()))
      .sort((a, b) => (Number(b.quality) || 0) - (Number(a.quality) || 0));

    if (sorted.length > 0) {
      return decodeEntities(String(sorted[0].translation));
    }
  }

  // Fall back to primary even if it's low quality (better than nothing).
  return primary;
}

async function myMemoryTranslate(text, source, target) {
  const out = [];
  let detected = null;

  for (const chunk of chunkText(text)) {
    const core = chunk.trim();
    if (!core) {
      out.push(chunk);
      continue;
    }
    const lead = chunk.match(/^\s*/)[0];
    const trail = chunk.match(/\s*$/)[0];

    const url = new URL('https://api.mymemory.translated.net/get');
    url.searchParams.set('q', core);
    url.searchParams.set('langpair', `${source === 'auto' ? 'Autodetect' : source}|${target}`);
    if (process.env.MYMEMORY_EMAIL) url.searchParams.set('de', process.env.MYMEMORY_EMAIL);

    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new ProviderError('The translation service is not responding. Try again shortly.');

    const data = await res.json().catch(() => null);
    if (!data) throw new ProviderError('The translation service sent an unreadable response.');

    const status = Number(data.responseStatus);
    if (status === 429) {
      throw new ProviderError('The free daily limit for MyMemory has been reached. Try again tomorrow or add a Google API key.', 429);
    }
    if (status !== 200) {
      throw new ProviderError(`Translation failed: ${data.responseDetails || 'unknown error'}`);
    }

    const rd = data.responseData || {};
    if (!detected && rd.detectedLanguage) detected = String(rd.detectedLanguage);

    const best = pickBestTranslation(rd, data.matches);
    out.push(lead + best + trail);
  }

  return { translation: out.join(''), detected };
}

/* ---------- public API ---------- */

function providerInfo() {
  return process.env.GOOGLE_API_KEY
    ? { id: 'google', name: 'Google Cloud Translation' }
    : { id: 'mymemory', name: 'MyMemory' };
}

async function translate(text, source, target) {
  const info = providerInfo();
  const result =
    info.id === 'google'
      ? await googleTranslate(text, source, target)
      : await myMemoryTranslate(text, source, target);
  return { ...result, provider: info.id };
}

module.exports = { translate, providerInfo, ProviderError, chunkText, decodeEntities };
