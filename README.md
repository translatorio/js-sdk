![Translatorio JavaScript SDK](https://raw.githubusercontent.com/translatorio/js-sdk/main/art/banner.png)

# Translatorio JavaScript SDK

[![tests](https://github.com/translatorio/js-sdk/actions/workflows/tests.yml/badge.svg)](https://github.com/translatorio/js-sdk/actions/workflows/tests.yml) [![npm version](https://img.shields.io/npm/v/translatorio-sdk.svg)](https://www.npmjs.com/package/translatorio-sdk) [![npm downloads](https://img.shields.io/npm/dm/translatorio-sdk.svg)](https://www.npmjs.com/package/translatorio-sdk) [![license](https://img.shields.io/npm/l/translatorio-sdk.svg)](https://github.com/translatorio/js-sdk/blob/main/LICENSE) [![bundle size](https://img.shields.io/bundlephobia/minzip/translatorio-sdk)](https://bundlephobia.com/package/translatorio-sdk)

The official JavaScript client for [Translatorio](https://translatorio.com), the AI translation API.

```bash
npm install translatorio-sdk
```

```js
import { Client } from 'translatorio-sdk'

const tr = new Client(process.env.TRANSLATORIO_KEY)

const result = await tr.translate('Add to cart', 'es', { reference: 'release-42' })

result.translation   // 'Añadir a la cesta'
result.intact        // false when a placeholder, tag or masked value did not come back
```

`Client` and the default export are the same class, `Translatorio`.

> **Server side only.** Your API key (`tr_live_...`, or `tr_test_...` for a test key) is a
> bearer credential for the whole account. In a browser bundle it is public and anybody who
> reads it can spend your allowance. Translate on your backend and send the result to the page.

## Translating text

One text or up to a hundred, into one language or up to twenty:

```js
const result = await tr.translate(
  ['Add to cart', '<b>Free</b> returns within {days} days'],
  ['es', 'de', 'ja'],
  {
    source: 'en',             // leave it out to detect it
    format: 'html',           // text, html or markdown: decides what is protected
    formality: 'informal',    // default, formal or informal
    context: 'Buttons of a shop',
    glossary: 'shop',         // one of your glossaries, by slug
    terms: { es: { cart: 'cesta' } },
    anonymize: true,          // the default: personal data is masked before the model sees it
    reference: 'release-42',
  },
)

result.results                  // [{ index, translations: { es, de, ja }, intact }, ...]
result.translationIn('de', 1)   // the second text, in German
result.translation              // only for one text into one language, otherwise null
result.source                   // 'en'
result.detected                 // whether the source was detected
```

Check `intact` before publishing: it is false when any placeholder, tag or masked value did
not survive the trip.

## Choosing how hard the model works

`effort` (`default`, `low`, `medium` or `high`) is accepted on `translate`, `translateFile`,
`translateImage` and `batch`, and passed through when you give it. Leaving it out is the same as `default`: the level Translatorio recommends at the time (medium today), which moves as the models do. Name a level to keep it fixed. The answer says which level the call ran at:

```js
const result = await tr.translate(text, 'es', { effort: 'low' })
result.effort   // 'low'
```

## What it used and what it cost

Every translating call answers with its usage and its price:

```js
result.id                 // 'tr_...', the call's name in your history
result.charged            // credits this call cost
result.creditsRemaining   // credits left, or null when the answer does not say
result.cached             // segments answered from your translation memory
result.corrected          // segments answered with your own corrections
result.anonymized         // personal data items masked before the model saw them
result.modelRead          // whether the model was asked anything at all
result.modelWhy           // 'memory' or 'test_key' when it was not, otherwise null
result.effort             // 'low', 'medium' or 'high': how hard the model was asked to work
result.tokens             // { input, output }
result.test               // made with a test key: a marked copy, not a translation
result.usage              // the whole usage block as the API sent it
```

## Files

JSON, PO, XLIFF, CSV, Android XML, iOS `.strings`, Markdown, HTML and plain text, back in
the same shape with only the texts translated.

```js
// The file's text, with a name that tells the format and names the results.
const out = await tr.translateFile(json, ['es', 'de'], { filename: 'en.json' })

out.file('es').content   // the Spanish file
out.file('es').name      // 'es.json'
out.strings              // how many strings it held

// Or the bytes, uploaded as they are. Use this for anything not in UTF-8.
import { readFile } from 'node:fs/promises'
await tr.translateFile(await readFile('Localizable.strings'), 'fr', { filename: 'Localizable.strings' })

out.corrected            // strings answered with your own corrections
```

A string is the file's text and goes up as JSON. Bytes (a `Uint8Array`, a `Buffer`, an
`ArrayBuffer` or a `Blob`) go up as a `multipart/form-data` upload, byte for byte, so a
UTF-16 `.strings` file arrives exactly as it left (it comes back translated as UTF-8). A `File` keeps its own name unless you
pass `filename`. `format` is optional when the filename's extension says it.

## Images

Every block of text in a picture, translated, with its box as fractions of the image:

```js
const image = await tr.translateImage('https://cdn.example.com/sign.png', ['en', 'es'])
await tr.translateImage(bytes, 'en')           // Uint8Array, ArrayBuffer, Blob or Buffer
await tr.translateImage(base64OrDataUri, 'en')

for (const block of image.blocks) {
  block.text                // as written in the picture
  block.box                 // { x, y, width, height }, 0 to 1
  block.translations.en
}
```

An http or https address is fetched by the model provider; anything else is the picture
itself and goes out as `data`.

## Detecting a language

```js
const found = await tr.detect('Obrigado pela ajuda')

found.code         // 'pt'
found.language     // { code, name, native, rtl }, or null
found.confidence   // 0.97
found.by           // 'script' (free), 'model' or 'test_key'
```

You rarely need it: leaving `source` out of `translate` detects it in the same call.

## Batches

Up to ten thousand texts, translated in the background. The answer comes at once with the
batch queued.

```js
const batch = await tr.batch(texts, ['es', 'de'], { glossary: 'shop', reference: 'catalogue' })

// Read it back a page at a time: pass `next` back as `cursor`. Null means the last page.
let page = await tr.batchStatus(batch.id)

while (true) {
  page.results.forEach(({ translations, intact }, index) => { /* ... */ })
  page.failures.forEach((error, index) => { /* a text that failed is a text, not a batch */ })
  page.items     // the same page as the rows the API sent

  if (page.next === null) break
  page = await tr.batchStatus(batch.id, { cursor: page.next })
}

page.finished   // completed or failed
await tr.batches({ limit: 10 })   // the recent ones, without their results
```

Results are deleted some days after the batch finishes (`expiresAt`). Or wait for the
`batch.completed` webhook instead of polling.

## Paged lists

Every paged method answers with one page, `{ items, next }`: `next` is opaque, you pass it
back as that method's `cursor`, and `null` means there is nothing after this page. That is
`corrections()`, `translations()`, and `batchStatus()`, whose batch is also a page of its
results. `batches()`, `languages()`, `glossaries()` and `keys()` are plain lists.

```js
let cursor = null

do {
  const page = await tr.translations({ kind: 'text', limit: 100, cursor })
  page.items.forEach((record) => { /* ... */ })
  cursor = page.next
} while (cursor !== null)
```

## Glossaries

Terms that are always translated the same way. All free.

```js
await tr.createGlossary({ name: 'Shop', source: 'en', target: 'es', entries: { cart: 'cesta' } })
await tr.glossaries()                    // the list, with entry counts
const shop = await tr.glossary('shop')   // one, with its entries
await tr.updateGlossary('shop', { entries: shop.entries })   // entries REPLACES the list
await tr.deleteGlossary('shop')
```

`entries` may be `{ term: translation }` or the list a read returns, so a glossary can be
read, edited and sent back as it is.

## Corrections

Your own translation of one exact text into one language. From then on it wins, and the
model is never asked again for it.

```js
await tr.correct('Add to cart', 'es', 'Añadir a la cesta')   // saving again replaces it
const { items, next } = await tr.corrections({ target: 'es' })
await tr.corrections({ target: 'es', cursor: next })
await tr.deleteCorrection(42)
```

## The account

```js
await tr.languages()                     // [{ code, name, native, rtl }, ...]
await tr.usage()                         // credits, the renewal date, prices, the last 30 days
const history = await tr.translations({ kind: 'text', limit: 50 })   // { items, next }
await tr.translationRecord('tr_...')     // one call's record. Never the text: it is not kept
await tr.keys()                          // prefixes, modes, last use. Never a secret
await tr.revokeKey(7)                    // including the one you are calling with. There is no create
await tr.ping()                          // is the key good, is the service up
```

## Errors

Every refusal is a class you can branch on, carrying the status, the API's `code` and the
whole body in `payload`:

| Class | Status | Carries |
|---|---|---|
| `AuthenticationError` | 401 | |
| `QuotaExhausted` | 402 | `remaining`, `required`, `renewsAt`, and `queued` for a batch |
| `NotFound` | 404 | |
| `InvalidRequest` | 422 | `fields` (`{ field: [messages] }`), empty when no field is at fault |
| `RateLimited` | 429 | `retryAfter`, in seconds |
| `ServerError` | 5xx, timeouts, unreachable (status 0), anything that is not an answer | |

All extend `TranslatorioError`. `retryable` says whether asking again could work.

```js
import { QuotaExhausted, InvalidRequest } from 'translatorio-sdk'

try {
  await tr.translate(text, 'es')
} catch (error) {
  if (error instanceof QuotaExhausted) notify(`out of credits: ${error.remaining} left, ${error.required} needed`)
  if (error instanceof InvalidRequest) console.error(error.code, error.fields)
}
```

A field an endpoint does not take is refused with `unknown_field` rather than ignored.

## Retries and idempotency

**It retries the right failures and never the wrong one.** A 429, a 5xx, a timeout or a
connection that failed is asked again, twice by default, with a growing wait, or exactly the
wait the service asked for (`error.retry_after` in the body, else the `Retry-After` header),
never more than `maxWait`. A 402 is never
retried, nor is any other 4xx: asking again cannot change them.

**Every retry is the same request.** Each call that changes something (POST, PUT, DELETE)
carries an `Idempotency-Key`, generated once per call and reused by its retries, so a call
that timed out and is asked again is done once and billed once. Two calls never share one.
Pass your own as `idempotencyKey` when you retry at a level above this client.

**Nothing that is not an answer is read as one.** Only a `2xx` carrying a JSON object is a
success. A redirect (it is never followed), a proxy's HTML page, an empty body or a body cut
off halfway throws a retryable `ServerError`. The timeout (120 seconds by default) covers the
body as well as the headers.

```js
const tr = new Client(key, {
  timeout: 120_000,  // ms, the request and its body together
  retries: 2,
  maxWait: 30_000,   // the longest a single wait can be, in ms
  baseUrl: 'https://translatorio.com/api',
})
```

## Webhooks

Your endpoint URL is public. Verify before you act:

```js
import { webhookEvent, SIGNATURE_HEADER } from 'translatorio-sdk'

const body = await request.text()   // the RAW body

const event = await webhookEvent(body, request.headers.get(SIGNATURE_HEADER), process.env.TRANSLATORIO_WEBHOOK_SECRET)

if (!event) return new Response('', { status: 400 })

if (event.event === 'batch.completed') { /* event.data is the batch summary */ }
```

Events: `batch.completed`, `credits.low` and `quota.exhausted`. The signature is an
HMAC-SHA256 of `timestamp.body`, refused when older than five minutes, compared in constant
time. `verifyWebhook()` answers just true or false. Both are async because they use
WebCrypto, the only HMAC present in every runtime this package supports.

## Testing with a custom transport

The transport is one function with `fetch`'s signature. Pass your own to route calls
through your framework, or to test without a network:

```js
const tr = new Client('tr_test_x', {
  fetch: async (url, init) => ({
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({ results: [], intact: true }),
  }),
})
```

A test key (`tr_test_...`) costs nothing and never reaches the model: the answer is a
marked copy, and `result.test` is true.

## Notes

Node 20+, Deno, Bun, Cloudflare Workers and Vercel Edge: anywhere with `fetch` and
`crypto.subtle`. No dependencies. Types included.

## How this is tested

`npm test` drives the client through a stub transport, with no network: what is retried,
what never is, that a retry reuses its idempotency key while two calls do not, that a
redirect, an HTML page or an empty body is never read as an answer, the timeout, file and
image encoding, and the webhook signature. `npm run typecheck` compiles a file that uses the
whole typed surface, so the declarations cannot fall behind the client.

## Author

Created by [Edu Lazaro](https://edulazaro.com) for [Translatorio](https://translatorio.com),
the translation API this client speaks to.

## License

The Translatorio JavaScript SDK is open-sourced software licensed under the [MIT license](LICENSE).
