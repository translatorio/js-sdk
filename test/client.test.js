/**
 * The JavaScript client, against a fetch that answers like the API does.
 *
 * The behaviours worth testing are the ones a caller cannot see and would otherwise find
 * out from an invoice: what gets retried, what never does, whether a retry is the same
 * request or a second one, and that nothing which is not an answer is read as one.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'

import Translatorio, {
  AuthenticationError,
  Client,
  InvalidRequest,
  NotFound,
  QuotaExhausted,
  RateLimited,
  ServerError,
  SIGNATURE_HEADER,
  TranslatorioError,
  VERSION,
  verifyWebhook,
  webhookEvent,
} from '../index.js'

const USAGE = {
  usage: {
    characters: 11,
    segments: 1,
    cached: 0,
    corrected: 0,
    anonymized: 1,
    model: { read: true, effort: 'medium', why: null },
    tokens: { input: 420, output: 12 },
  },
  credits: { charged: 3, remaining: 1997 },
  mode: 'live',
  took_ms: 412,
}

const TRANSLATION = {
  id: 'tr_01',
  reference: 'release-42',
  source: { language: 'en', detected: true },
  targets: ['es'],
  translation: 'Añadir a la cesta',
  results: [{ index: 0, translations: { es: 'Añadir a la cesta' }, intact: true }],
  intact: true,
  ...USAGE,
}

/**
 * A client over a fetch that answers from a list.
 *
 * Each response is `[status, body, headers?]`; a body that is a string goes out as it is,
 * anything else as JSON.
 */
function client(responses, options = {}) {
  const calls = []

  const fetch = async (url, init) => {
    const json = typeof init.body === 'string'

    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      redirect: init.redirect,
      rawBody: init.body,
      body: json ? JSON.parse(init.body) : null,
      key: init.headers['Idempotency-Key'] ?? null,
    })

    const [status, payload, headers = {}] = responses.shift()
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))

    return {
      status,
      headers: { get: (name) => lower[name.toLowerCase()] ?? null },
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    }
  }

  const tr = new Translatorio('tr_test_key', {
    baseUrl: 'https://example.test/api',
    fetch,
    sleep: async () => {},
    ...options,
  })

  return { tr, calls }
}

/** A client over a fetch written by the test itself. */
function answering(respond, options = {}) {
  return new Translatorio('tr_test_key', {
    baseUrl: 'https://example.test/api',
    fetch: async (url, init) => respond(url, init),
    sleep: async () => {},
    retries: 0,
    ...options,
  })
}

test('it reads a translation', async () => {
  const { tr, calls } = client([[200, TRANSLATION]])

  const result = await tr.translate('Add to cart', 'es', { reference: 'release-42', formality: 'informal' })

  assert.equal(result.id, 'tr_01')
  assert.equal(result.translation, 'Añadir a la cesta')
  assert.equal(result.translationIn('es'), 'Añadir a la cesta')
  assert.equal(result.translationIn('de'), null)
  assert.equal(result.source, 'en')
  assert.equal(result.detected, true)
  assert.equal(result.intact, true)
  assert.equal(result.anonymized, 1)
  assert.equal(result.charged, 3)
  assert.equal(result.creditsRemaining, 1997)
  assert.equal(result.modelRead, true)
  assert.equal(result.modelWhy, null)
  assert.equal(result.effort, 'medium')
  assert.deepEqual(result.tokens, { input: 420, output: 12 })
  assert.equal(result.test, false)
  assert.equal(result.tookMs, 412)

  assert.equal(calls[0].url, 'https://example.test/api/v1/translate')
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, { text: 'Add to cart', target: 'es', reference: 'release-42', formality: 'informal' })
  assert.equal(calls[0].headers.Authorization, 'Bearer tr_test_key')
  assert.equal(calls[0].headers['User-Agent'], `translatorio-js/${VERSION}`)
  assert.equal(calls[0].redirect, 'manual')
})

test('many texts into many languages go up as lists', async () => {
  const { tr, calls } = client([[200, { ...TRANSLATION, translation: undefined }]])

  const result = await tr.translate(['Add to cart', 'Checkout'], ['es', 'de'], { format: 'html' })

  assert.deepEqual(calls[0].body, { texts: ['Add to cart', 'Checkout'], targets: ['es', 'de'], format: 'html' })
  assert.equal(result.translation, null)
})

test('effort is sent only when given', async () => {
  const { tr, calls } = client([[200, TRANSLATION], [200, TRANSLATION]])

  await tr.translate('a', 'es')
  await tr.translate('a', 'es', { effort: 'high' })

  assert.equal('effort' in calls[0].body, false)
  assert.equal(calls[1].body.effort, 'high')
})

test('a test key answer says so', async () => {
  const { tr } = client([[200, { ...TRANSLATION, mode: 'test', usage: { ...USAGE.usage, model: { read: false, name: null, why: 'test_key' } } }]])

  const result = await tr.translate('a', 'es')

  assert.equal(result.test, true)
  assert.equal(result.modelRead, false)
  assert.equal(result.modelWhy, 'test_key')
})

test('credits left is unknown, not zero, when the answer does not carry it', async () => {
  const { tr } = client([[200, { ...TRANSLATION, credits: { charged: 1, remaining: null } }]])

  assert.equal((await tr.translate('a', 'es')).creditsRemaining, null)
})

test('a file as text goes up as content', async () => {
  const { tr, calls } = client([[200, {
    id: 'tr_02',
    format: 'json',
    source: { language: 'en', detected: false },
    strings: 2,
    files: [{ language: 'es', name: 'es.json', content: '{"a":"Hola"}', intact: true }],
    intact: true,
    ...USAGE,
  }]])

  const result = await tr.translateFile('{"a":"Hello"}', ['es'], { filename: 'en.json', source: 'en' })

  assert.deepEqual(calls[0].body, { content: '{"a":"Hello"}', targets: ['es'], filename: 'en.json', source: 'en' })
  assert.equal(calls[0].url, 'https://example.test/api/v1/translate/file')
  assert.equal(result.format, 'json')
  assert.equal(result.strings, 2)
  assert.equal(result.file('es').content, '{"a":"Hola"}')
  assert.equal(result.file('de'), null)
})

/**
 * A multipart body read back the way a server reads it, so the test checks what goes on the
 * wire and not what the client meant to send.
 */
async function readMultipart(call) {
  const request = new Request('https://example.test/', {
    method: 'POST',
    headers: { 'Content-Type': call.headers['Content-Type'] },
    body: call.rawBody,
  })

  return request.formData()
}

test('a file as bytes goes up as a multipart upload, byte for byte', async () => {
  const { tr, calls } = client([[200, { files: [], intact: true, ...USAGE, usage: { ...USAGE.usage, corrected: 2 } }]])
  // UTF-16LE with a BOM, as Xcode writes `.strings`: a text decoder would mangle it.
  const bytes = new Uint8Array([0xff, 0xfe, 0x22, 0x00, 0x61, 0x00, 0x0d, 0x00, 0x0a, 0x00])

  const result = await tr.translateFile(bytes, ['es', 'de'], {
    filename: 'Localizable.strings',
    terms: { es: { cart: 'cesta' } },
    anonymize: false,
    source: 'en',
    effort: 'high',
  })

  assert.ok(calls[0].rawBody instanceof Uint8Array, 'the transport gets bytes, not a FormData')
  assert.match(calls[0].headers['Content-Type'], /^multipart\/form-data; boundary=translatorio-[0-9a-f]+$/)
  assert.ok(calls[0].key)
  assert.equal(result.corrected, 2)

  const form = await readMultipart(calls[0])
  const file = form.get('file')
  assert.equal(file.name, 'Localizable.strings')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes)
  assert.deepEqual(form.getAll('targets[]'), ['es', 'de'])
  assert.equal(form.get('terms[es][cart]'), 'cesta')
  assert.equal(form.get('anonymize'), '0')
  assert.equal(form.get('source'), 'en')
  assert.equal(form.get('effort'), 'high')
  assert.equal(form.get('filename'), null, 'the upload carries its own name')
  assert.equal(form.get('idempotencyKey'), null)
  assert.deepEqual([...form.keys()].sort(), ['anonymize', 'effort', 'file', 'source', 'targets[]', 'targets[]', 'terms[es][cart]'])
})

test('one target is a plain field, true is 1, and a Blob keeps its own name', async () => {
  const { tr, calls } = client([[200, { files: [], intact: true, ...USAGE }]])

  await tr.translateFile(new File([new Uint8Array([0x7b, 0x7d])], 'en.json'), 'es', { anonymize: true })

  const form = await readMultipart(calls[0])
  assert.equal(form.get('target'), 'es')
  assert.equal(form.get('anonymize'), '1')
  assert.equal(form.get('file').name, 'en.json')
})

test('a filename cannot break out of its header', async () => {
  const { tr, calls } = client([[200, { files: [], intact: true, ...USAGE }]])

  await tr.translateFile(new Uint8Array([1]), 'es', { filename: 'a"\r\nX-Evil: 1.json' })

  const head = new TextDecoder().decode(calls[0].rawBody)
  assert.match(head, /filename="a%22%0D%0AX-Evil: 1\.json"/)
  assert.doesNotMatch(head, /\r\nX-Evil/)
})

test('a retried upload sends the same bytes under the same key', async () => {
  const { tr, calls } = client([[503, {}], [200, { files: [], intact: true, ...USAGE }]])

  await tr.translateFile(new Uint8Array([0xff, 0xfe, 0x00]), 'es', { filename: 'a.strings' })

  assert.equal(calls.length, 2)
  assert.equal(calls[0].key, calls[1].key)
  assert.equal(calls[0].headers['Content-Type'], calls[1].headers['Content-Type'])
  assert.deepEqual(calls[0].rawBody, calls[1].rawBody)
})

test('a picture by address goes up as url', async () => {
  const { tr, calls } = client([[200, {
    id: 'tr_03',
    source: { language: 'ja' },
    targets: ['en'],
    blocks: [{ text: '出口', box: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 }, translations: { en: 'Exit' } }],
    ...USAGE,
  }]])

  const result = await tr.translateImage('https://cdn.example.test/sign.png', 'en')

  assert.deepEqual(calls[0].body, { url: 'https://cdn.example.test/sign.png', target: 'en' })
  assert.equal(result.blocks[0].translations.en, 'Exit')
  assert.equal(result.source, 'ja')
})

test('a picture as bytes goes up as base64 data, never as url', async () => {
  const { tr, calls } = client([[200, { blocks: [] }], [200, { blocks: [] }]])

  await tr.translateImage(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'en')
  await tr.translateImage('data:image/png;base64,iVBORw0KGgo=', 'en')

  assert.equal(calls[0].body.data, 'iVBORw0KGgo=')
  assert.equal('url' in calls[0].body, false)
  assert.equal(calls[1].body.data, 'data:image/png;base64,iVBORw0KGgo=')
})

test('large pictures do not blow the argument limit', async () => {
  const { tr, calls } = client([[200, { blocks: [] }]])

  await tr.translateImage(new Uint8Array(200_000).fill(65), 'en')

  assert.equal(calls[0].body.data.length, Math.ceil(200_000 / 3) * 4)
})

test('it detects a language', async () => {
  const { tr, calls } = client([[200, {
    id: 'tr_04',
    language: { code: 'pt', name: 'Portuguese', native: 'Português', rtl: false },
    confidence: 0.97,
    by: 'model',
    ...USAGE,
  }], [200, { id: 'tr_05', language: null, confidence: null, by: 'test_key' }]])

  const found = await tr.detect('Obrigado pela ajuda')
  assert.equal(found.code, 'pt')
  assert.equal(found.confidence, 0.97)
  assert.equal(found.by, 'model')
  assert.deepEqual(calls[0].body, { text: 'Obrigado pela ajuda' })

  const unknown = await tr.detect('Hello')
  assert.equal(unknown.language, null)
  assert.equal(unknown.code, null)
})

test('a batch is queued and read back by page', async () => {
  const summary = {
    id: 'bat_01', reference: null, status: 'queued', source: null, targets: ['es'],
    total: 3, done: 0, failed: 0, credits: { estimated: 12, charged: 0 },
    created_at: '2026-10-07T10:00:00+00:00', finished_at: null, expires_at: null,
  }

  const { tr, calls } = client([
    [202, summary],
    [200, {
      ...summary,
      status: 'completed',
      done: 2,
      failed: 1,
      credits: { estimated: 12, charged: 7 },
      results: [
        { index: 0, translations: { es: 'Uno' }, intact: true },
        { index: 1, error: { code: 'translation_failed', message: 'x' } },
      ],
      next_after: 1,
    }],
    [200, { data: [summary] }],
    [200, { ...summary, status: 'completed', results: [], next_after: null }],
  ])

  const batch = await tr.batch(['one', 'two', 'three'], 'es', { effort: 'low', glossary: 'shop' })
  assert.equal(batch.status, 'queued')
  assert.equal(batch.finished, false)
  assert.equal(batch.creditsEstimated, 12)
  assert.deepEqual(calls[0].body, { texts: ['one', 'two', 'three'], target: 'es', effort: 'low', glossary: 'shop' })
  assert.equal(calls[0].url, 'https://example.test/api/v1/batches')

  const page = await tr.batchStatus('bat_01', { cursor: '-1', limit: 2 })
  assert.equal(calls[1].url, 'https://example.test/api/v1/batches/bat_01?after=-1&limit=2')
  assert.equal(page.finished, true)
  assert.equal(page.results.get(0).translations.es, 'Uno')
  assert.equal(page.failures.get(1).code, 'translation_failed')
  assert.equal(page.results.has(1), false)
  assert.equal(page.next, '1')
  assert.equal(page.items.length, 2)
  assert.equal(page.items[1].error.code, 'translation_failed')
  assert.equal(page.creditsCharged, 7)
  assert.equal(batch.next, null)
  assert.deepEqual(batch.items, [])

  const recent = await tr.batches({ limit: 5 })
  assert.equal(recent[0].id, 'bat_01')
  assert.equal(calls[2].key, null)

  const last = await tr.batchStatus('bat_01', { cursor: page.next })
  assert.equal(calls[3].url, 'https://example.test/api/v1/batches/bat_01?after=1')
  assert.equal(last.next, null)
})

test('glossaries are listed, created, read, replaced and deleted', async () => {
  const glossary = { slug: 'shop', name: 'Shop', source: 'en', target: 'es', entries: [{ term: 'cart', translation: 'cesta' }], updated_at: null }

  const { tr, calls } = client([
    [200, { data: [{ ...glossary, entries: 1 }] }],
    [201, glossary],
    [200, glossary],
    [200, glossary],
    [200, { deleted: true }],
  ])

  assert.equal((await tr.glossaries())[0].entries, 1)
  await tr.createGlossary({ name: 'Shop', source: 'en', target: 'es', entries: { cart: 'cesta' } })
  assert.equal((await tr.glossary('shop')).entries[0].translation, 'cesta')
  await tr.updateGlossary('shop', { entries: { cart: 'carrito' } })
  assert.deepEqual(await tr.deleteGlossary('shop'), { deleted: true })

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace('https://example.test/api', '')}`), [
    'GET /v1/glossaries',
    'POST /v1/glossaries',
    'GET /v1/glossaries/shop',
    'PUT /v1/glossaries/shop',
    'DELETE /v1/glossaries/shop',
  ])
  assert.deepEqual(calls[1].body, { name: 'Shop', source: 'en', target: 'es', entries: { cart: 'cesta' } })
  assert.deepEqual(calls[3].body, { entries: { cart: 'carrito' } })
  assert.equal(calls[4].rawBody, undefined)
  assert.ok(calls[4].key, 'a DELETE carries a key too')
  assert.equal(calls[0].key, null)
})

test('corrections are listed by cursor, saved and deleted', async () => {
  const correction = { id: 42, text: 'Add to cart', target: 'es', translation: 'Añadir a la cesta', updated_at: null }
  const { tr, calls } = client([
    [200, { data: [correction], next_cursor: 'eyJpZCI6NDJ9' }],
    [201, correction],
    [200, { deleted: true }],
  ])

  const page = await tr.corrections({ target: 'es', cursor: 'abc' })
  assert.equal(page.items[0].id, 42)
  assert.equal(page.next, 'eyJpZCI6NDJ9')
  assert.equal(calls[0].url, 'https://example.test/api/v1/corrections?target=es&cursor=abc')

  await tr.correct('Add to cart', 'es', 'Añadir a la cesta')
  assert.equal(calls[1].method, 'PUT')
  assert.deepEqual(calls[1].body, { text: 'Add to cart', target: 'es', translation: 'Añadir a la cesta' })

  await tr.deleteCorrection(42)
  assert.equal(calls[2].method, 'DELETE')
  assert.equal(calls[2].url, 'https://example.test/api/v1/corrections/42')
})

test('the account endpoints', async () => {
  const { tr, calls } = client([
    [200, { data: [{ code: 'es', name: 'Spanish', native: 'Español', rtl: false }] }],
    [200, { plan: 'free', credits: { remaining: 2000, renews_at: null } }],
    [200, { data: [{ id: 'tr_01', kind: 'text' }], next_cursor: null }],
    [200, { id: 'tr_01', kind: 'text' }],
    [200, { data: [{ id: 7, prefix: 'tr_live_ab' }] }],
    [200, { revoked: true }],
    [200, { ok: true, mode: 'test', key: 'tr_test_ab' }],
  ])

  assert.equal((await tr.languages())[0].code, 'es')
  assert.equal((await tr.usage()).plan, 'free')
  const history = await tr.translations({ kind: 'text', limit: 10 })
  assert.equal(history.items[0].id, 'tr_01')
  assert.equal(history.next, null)
  assert.equal((await tr.translationRecord('tr_01')).kind, 'text')
  assert.equal((await tr.keys())[0].id, 7)
  assert.deepEqual(await tr.revokeKey(7), { revoked: true })
  assert.equal((await tr.ping()).ok, true)

  assert.equal(calls[2].url, 'https://example.test/api/v1/translations?kind=text&limit=10')
  assert.equal(calls[5].method, 'DELETE')
  assert.equal(calls[5].url, 'https://example.test/api/v1/keys/7')
})

test('the default base url is the api', async () => {
  const urls = []
  const tr = new Translatorio('tr_live_x', { fetch: async (url) => { urls.push(url); return { status: 200, text: async () => '{"ok":true}' } } })

  await tr.ping()

  assert.equal(urls[0], 'https://translatorio.com/api/v1/ping')
  assert.equal(Client, Translatorio)
})

test('it retries a rate limit and a server error', async () => {
  const { tr, calls } = client([
    [429, { error: { code: 'rate_limited' } }],
    [503, { error: { code: 'translation_unavailable', message: 'down' } }],
    [200, TRANSLATION],
  ])

  await tr.translate('hello', 'es')

  assert.equal(calls.length, 3)
})

test('a retry is the same request, two calls are two keys', async () => {
  const { tr, calls } = client([[500, {}], [200, TRANSLATION], [200, TRANSLATION]])

  await tr.translate('one', 'es')
  await tr.translate('two', 'es')

  assert.equal(calls[0].key, calls[1].key)
  assert.ok(calls[0].key.startsWith('js-'))
  assert.notEqual(calls[1].key, calls[2].key)
})

test('a key you supply is used and never sent in the body', async () => {
  const { tr, calls } = client([[200, TRANSLATION]])

  await tr.translate('one', 'es', { idempotencyKey: 'mine-1' })

  assert.equal(calls[0].key, 'mine-1')
  assert.equal('idempotencyKey' in calls[0].body, false)
})

test('it never retries a quota', async () => {
  const { tr, calls } = client([
    [402, { error: { code: 'quota_exhausted', message: 'no' }, credits: { remaining: 20, required: 40, renews_at: '2026-11-01T00:00:00+00:00' } }],
    [200, TRANSLATION],
  ])

  await assert.rejects(
    () => tr.translate('hello', 'es'),
    (error) => {
      assert.ok(error instanceof QuotaExhausted)
      assert.equal(error.remaining, 20)
      assert.equal(error.required, 40)
      assert.equal(error.renewsAt, '2026-11-01T00:00:00+00:00')
      assert.equal(error.queued, null)
      assert.equal(error.retryable, false)
      return true
    },
  )

  assert.equal(calls.length, 1)
})

test('a batch refused for credits says what is set aside', async () => {
  const { tr } = client([[402, { error: { code: 'quota_exhausted' }, credits: { remaining: 5, required: 30, queued: 12 } }]])

  await assert.rejects(() => tr.batch(['a'], 'es'), (error) => error instanceof QuotaExhausted && error.queued === 12)
})

test('no other 4xx is retried', async () => {
  for (const [status, type] of [[401, AuthenticationError], [404, NotFound], [422, InvalidRequest], [409, TranslatorioError]]) {
    const { tr, calls } = client([[status, { error: { code: 'x' } }], [200, TRANSLATION]])

    await assert.rejects(() => tr.translate('a', 'es'), type)
    assert.equal(calls.length, 1, `${status} was retried`)
  }
})

test('an idempotency key still in flight is waited for', async () => {
  const waited = []
  const { tr, calls } = client(
    [[409, { error: { code: 'idempotency_in_flight' } }, { 'Retry-After': '1' }], [200, TRANSLATION]],
    { sleep: async (ms) => waited.push(ms) },
  )

  await tr.translate('a', 'es')

  assert.equal(calls.length, 2)
  assert.equal(calls[0].key, calls[1].key)
  assert.deepEqual(waited, [1000])
})

test('it gives up eventually', async () => {
  const { tr, calls } = client([[500, {}], [500, {}], [500, {}]], { retries: 2 })

  await assert.rejects(() => tr.translate('a', 'es'), ServerError)
  assert.equal(calls.length, 3)
})

test('a rate limit that never clears is raised with its wait', async () => {
  const { tr } = client([[429, {}, { 'Retry-After': '7' }], [429, {}, { 'Retry-After': '7' }]], { retries: 1 })

  await assert.rejects(() => tr.translate('a', 'es'), (error) => error instanceof RateLimited && error.retryAfter === 7)
})

test('the wait in the body comes first, the header second', async () => {
  const waited = []
  const { tr } = client(
    [
      [429, { error: { code: 'rate_limited', retry_after: 3 } }, { 'Retry-After': '9' }],
      [409, { error: { code: 'idempotency_in_flight', retry_after: 1 } }],
      [200, TRANSLATION],
    ],
    { sleep: async (ms) => waited.push(ms) },
  )

  await tr.translate('a', 'es')

  assert.deepEqual(waited, [3000, 1000])
})

test('a rate limit raised carries the body\'s wait', async () => {
  const { tr } = client([[429, { error: { code: 'rate_limited', retry_after: 12 } }]], { retries: 0 })

  await assert.rejects(() => tr.translate('a', 'es'), (error) => error instanceof RateLimited && error.retryAfter === 12)
})

test('it waits as long as Retry-After says, bounded', async () => {
  const waited = []
  const { tr } = client(
    [[429, {}, { 'Retry-After': '7' }], [429, {}, { 'Retry-After': '86400' }], [200, TRANSLATION]],
    { sleep: async (ms) => waited.push(ms) },
  )

  await tr.translate('a', 'es')

  assert.deepEqual(waited, [7000, 30_000])
})

test('a server error with no Retry-After doubles its wait', async () => {
  const waited = []
  const { tr } = client([[500, {}], [502, {}], [200, TRANSLATION]], { sleep: async (ms) => waited.push(ms) })

  await tr.translate('a', 'es')

  assert.deepEqual(waited, [2000, 4000])
})

test('a validation failure carries its fields', async () => {
  const { tr } = client([
    [422, { error: { code: 'invalid_request', message: 'The texts field is required.', fields: { texts: ['The texts field is required.'] } } }],
  ])

  await assert.rejects(() => tr.batch([], 'es'), (error) => {
    assert.ok(error instanceof InvalidRequest)
    assert.equal(error.code, 'invalid_request')
    assert.deepEqual(error.fields, { texts: ['The texts field is required.'] })
    return true
  })
})

test('a refusal about one field arrives in the same fields', async () => {
  const message = '`targetz` is not a field of this endpoint.'
  const { tr } = client([[422, { error: { code: 'unknown_field', message, fields: { targetz: [message] } } }]])

  await assert.rejects(() => tr.translate('a', 'es', { targetz: ['de'] }), (error) => {
    assert.equal(error.code, 'unknown_field')
    assert.deepEqual(error.fields, { targetz: [message] })
    assert.equal('field' in error, false)
    return true
  })
})

test('a refusal about no field has no fields', async () => {
  const { tr } = client([[422, { error: { code: 'too_long', message: 'Split it.' } }]])

  await assert.rejects(() => tr.translate('a', 'es'), (error) => error instanceof InvalidRequest && Object.keys(error.fields).length === 0)
})

test('a redirect is not an answer', async () => {
  const { tr, calls } = client([[301, '', { Location: 'https://translatorio.com/api/v1/translate' }]], { retries: 0 })

  await assert.rejects(() => tr.translate('a', 'es'), (error) => {
    assert.ok(error instanceof ServerError)
    assert.equal(error.code, 'redirected')
    assert.match(error.message, /https:\/\/translatorio\.com\/api\/v1\/translate/)
    return true
  })
  assert.equal(calls.length, 1)
})

test('a proxy page with a 200 is not an answer', async () => {
  const { tr } = client([[200, '<html><body>Welcome</body></html>']], { retries: 0 })

  await assert.rejects(() => tr.translate('a', 'es'), (error) => error instanceof ServerError && error.code === 'malformed_response')
})

test('an empty body, an array or null is not an answer', async () => {
  for (const body of ['', '[]', 'null']) {
    const { tr } = client([[200, body]], { retries: 0 })

    await assert.rejects(() => tr.ping(), ServerError, `"${body}" was read as an answer`)
  }
})

test('a json object without the translations is not a translation', async () => {
  for (const [call, body] of [
    [(tr) => tr.translate('a', 'es'), { id: 'tr_1' }],
    [(tr) => tr.translateFile('{}', 'es', { format: 'json' }), { id: 'tr_1' }],
    [(tr) => tr.translateImage('https://x.test/a.png', 'es'), { id: 'tr_1' }],
    [(tr) => tr.detect('hola'), { id: 'tr_1' }],
    [(tr) => tr.batch(['a'], 'es'), { status: 'queued' }],
  ]) {
    const { tr } = client([[200, body]], { retries: 0 })

    await assert.rejects(() => call(tr), (error) => error instanceof ServerError && error.code === 'malformed_response')
  }
})

test('a malformed success is retried like any server failure', async () => {
  const { tr, calls } = client([[200, '<html>'], [200, TRANSLATION]])

  const result = await tr.translate('a', 'es')

  assert.equal(result.id, 'tr_01')
  assert.equal(calls[0].key, calls[1].key)
})

test('a refusal whose body is not json is still typed by its status', async () => {
  const { tr } = client([[401, '<html>Unauthorized</html>']])

  await assert.rejects(() => tr.ping(), AuthenticationError)
})

test('a connection that fails is a retryable server error', async () => {
  let attempts = 0
  const tr = answering(() => {
    attempts++
    throw new TypeError('fetch failed')
  }, { retries: 1 })

  await assert.rejects(() => tr.ping(), (error) => error instanceof ServerError && error.status === 0)
  assert.equal(attempts, 2)
})

test('a body cut off halfway is not an answer', async () => {
  const tr = answering(() => ({ status: 200, text: async () => { throw new Error('socket hang up') } }))

  await assert.rejects(() => tr.ping(), (error) => error instanceof ServerError && error.code === 'body_unreadable')
})

test('the timeout covers a server that never answers', async () => {
  const tr = answering(() => new Promise(() => {}), { timeout: 20 })

  await assert.rejects(() => tr.ping(), (error) => error instanceof ServerError && error.code === 'timeout' && error.retryable)
})

test('the timeout covers the body, not just the headers', async () => {
  // Headers arrive, then nothing: a body that stalls must end in the same timeout a silent
  // server does, or a worker waits for ever.
  const tr = answering(() => ({ status: 200, text: () => new Promise(() => {}) }), { timeout: 20 })

  let guard
  const outcome = await Promise.race([
    tr.translate('a', 'es').then(() => 'resolved', (error) => error),
    new Promise((resolve) => {
      guard = setTimeout(() => resolve('hung'), 1000)
    }),
  ])
  clearTimeout(guard)

  assert.ok(outcome instanceof ServerError, `expected a ServerError, got ${outcome}`)
  assert.equal(outcome.code, 'timeout')
})

test('the timeout aborts the request', async () => {
  let signal
  const tr = answering((url, init) => {
    signal = init.signal
    return new Promise(() => {})
  }, { timeout: 20 })

  await assert.rejects(() => tr.ping(), ServerError)
  assert.equal(signal.aborted, true)
})

test('there is no fetch, and it says so', () => {
  const original = globalThis.fetch
  globalThis.fetch = undefined

  try {
    assert.throws(() => new Translatorio('tr_live_x'), /fetch/)
  } finally {
    globalThis.fetch = original
  }
})

const BODY = '{"id":"evt_01","event":"batch.completed","created_at":"2026-10-07T10:00:00+00:00","data":{"id":"bat_01"}}'
const SECRET = `whsec_${'a'.repeat(40)}`

function signature(at = Math.floor(Date.now() / 1000), body = BODY, secret = SECRET) {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`
}

test('it accepts a delivery of ours', async () => {
  assert.equal(SIGNATURE_HEADER, 'X-Translatorio-Signature')
  assert.equal(await verifyWebhook(BODY, signature(), SECRET), true)
  assert.equal(await verifyWebhook(new TextEncoder().encode(BODY), signature(), SECRET), true)

  const event = await webhookEvent(BODY, signature(), SECRET)
  assert.equal(event.event, 'batch.completed')
  assert.equal(event.data.id, 'bat_01')
})

test('it refuses a wrong secret, a changed body and a stale timestamp', async () => {
  const now = Math.floor(Date.now() / 1000)

  assert.equal(await verifyWebhook(BODY, signature(now, BODY, 'whsec_other'), SECRET), false)
  assert.equal(await verifyWebhook(`${BODY} `, signature(), SECRET), false)
  assert.equal(await verifyWebhook(BODY, signature(now - 301), SECRET), false)
  assert.equal(await verifyWebhook(BODY, signature(now + 301), SECRET), false)
  assert.equal(await verifyWebhook(BODY, signature(now - 299), SECRET), true)
  assert.equal(await verifyWebhook(BODY, 'nonsense', SECRET), false)
  assert.equal(await verifyWebhook(BODY, '', SECRET), false)
  assert.equal(await webhookEvent(BODY, 'nonsense', SECRET), null)
})

test('the tolerance and the clock are yours to set', async () => {
  const at = 1_759_480_000

  assert.equal(await verifyWebhook(BODY, signature(at), SECRET, { now: () => (at + 600) * 1000 }), false)
  assert.equal(await verifyWebhook(BODY, signature(at), SECRET, { now: () => (at + 600) * 1000, tolerance: 900 }), true)
})

test('a v1 the service would not accept is refused', async () => {
  const valid = signature()
  const [t, v1] = valid.split(',')

  // The service compares lowercase hex with hash_equals, so uppercase is not the same string.
  assert.equal(await verifyWebhook(BODY, `${t},${v1.toUpperCase().replace('V1=', 'v1=')}`, SECRET), false)
  assert.equal(await verifyWebhook(BODY, `${t},v1=${'+a'.repeat(32)}`, SECRET), false)
  assert.equal(await verifyWebhook(BODY, `${t},v1=${v1.slice(3, 40)}`, SECRET), false)
  assert.equal(await verifyWebhook(BODY, `t=0,${v1}`, SECRET), false)
})
