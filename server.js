'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { LANGUAGES, isSupported } = require('./lib/languages');
const { translate, providerInfo, ProviderError } = require('./lib/providers');

const PORT = process.env.PORT || 3000;
const MAX_LENGTH = 5000;
const RATE_LIMIT = 30; // translations per minute per IP

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- tiny in-memory rate limiter ---------- */

const hits = new Map();

function rateLimit(req, res, next) {
  const now = Date.now();
  let entry = hits.get(req.ip);
  if (!entry || entry.reset < now) {
    entry = { count: 0, reset: now + 60_000 };
    hits.set(req.ip, entry);
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT) {
    res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (entry.reset < now) hits.delete(ip);
}, 60_000).unref();

/* ---------- routes ---------- */

app.get('/api/languages', (req, res) => {
  res.json({ languages: LANGUAGES, provider: providerInfo(), maxLength: MAX_LENGTH });
});

app.post('/api/translate', rateLimit, async (req, res) => {
  const { text, source = 'auto', target } = req.body || {};

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Enter some text to translate.' });
  }
  if (text.length > MAX_LENGTH) {
    return res.status(400).json({ error: `Text is limited to ${MAX_LENGTH} characters.` });
  }
  if (!isSupported(target)) {
    return res.status(400).json({ error: 'Choose a language to translate into.' });
  }
  if (source !== 'auto' && !isSupported(source)) {
    return res.status(400).json({ error: 'The source language is not supported.' });
  }
  if (source === target) {
    return res.status(400).json({ error: 'Pick two different languages.' });
  }

  try {
    res.json(await translate(text, source, target));
  } catch (err) {
    if (err instanceof ProviderError) {
      return res.status(err.status === 429 ? 429 : 502).json({ error: err.message });
    }
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return res.status(504).json({ error: 'The translation service took too long to answer. Try again.' });
    }
    console.error('[translate]', err);
    res.status(502).json({ error: 'Could not reach the translation service. Check your connection and try again.' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Malformed JSON bodies and anything else unexpected
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request could not be read.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That request is too large.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Glossa running at http://localhost:${PORT} using ${providerInfo().name}`);
  });
}

module.exports = app;
