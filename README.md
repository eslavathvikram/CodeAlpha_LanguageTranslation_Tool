# Glossa

A text translation web app. Pick a source and target language, type or paste text, and get the translation with options to copy it or hear it spoken.

Built for Task 1: Language Translation Tool.

## What it does

| Requirement | Where |
| --- | --- |
| User interface with text input and source and target language selection | `public/index.html`, `public/styles.css` |
| Uses a translation API | `lib/providers.js` (Google Cloud Translation, with MyMemory as a no-key fallback) |
| Sends the text to the API and gets the response | `server.js` (`POST /api/translate`) |
| Displays the translated text clearly | `public/app.js` |
| Optional: copy button and text-to-speech | Copy and Listen buttons (Web Speech API) |

Extras: auto-detect source language, swap languages (the translation becomes the new input), Ctrl/Cmd+Enter to translate, character counter with a 5,000 character limit, recent translations kept on the device, right-to-left text support, and a responsive layout.

## Run it

You need Node.js 18 or newer.

```bash
npm install
cp .env.example .env     # on Windows: copy .env.example .env
npm start
```

Open http://localhost:3000.

With no configuration it uses the free MyMemory API, which needs no key. For Google Cloud Translation, put a key in `.env`:

```
GOOGLE_API_KEY=your-key-here
```

To get a key: create a project in Google Cloud Console, enable **Cloud Translation API**, then create an API key under APIs & Services > Credentials. Restrict the key to the Translation API. The key stays on the server and is never sent to the browser.

`npm run dev` restarts the server when files change. `npm test` runs the text-chunking tests.

## Project layout

```
server.js            Express server, input validation, rate limiting
lib/languages.js     Supported languages
lib/providers.js     Google and MyMemory clients, text chunking
public/              index.html, styles.css, app.js, favicon.svg
test/                Unit tests
```

## API

`GET /api/languages` returns the language list, the active provider and the character limit.

`POST /api/translate`

```json
{ "text": "Hello", "source": "auto", "target": "hi" }
```

Returns `{ "translation": "...", "detected": "en", "provider": "mymemory" }`. Errors come back as `{ "error": "message" }` with a 4xx or 5xx status.

## Notes

- MyMemory accepts about 500 bytes per request, so longer text is split at sentence ends and rejoined.
- MyMemory has a daily free limit. Adding `MYMEMORY_EMAIL` in `.env` raises it.
- Text-to-speech depends on the voices installed on the device. If a language has no voice, the app says so instead of staying silent.
- The rate limiter is in memory (30 translations per minute per IP). Put a shared store behind it if you run several instances.
