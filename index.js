/**
 * The Translatorio API, from JavaScript.
 *
 * Runs anywhere there is a `fetch` and a `crypto.subtle`: Node 20+, Deno, Bun, Cloudflare
 * Workers, Vercel Edge.
 * No dependencies: a client for one small API is not worth a dependency tree.
 *
 * **Server side only.** Your API key is a bearer credential for your whole account; in a
 * browser bundle it is public, and anybody who reads it can spend your allowance. Translate
 * from your backend and send the result to the page.
 */

export const VERSION = '1.0.0'

/** The header a webhook delivery carries its signature in. */
export const SIGNATURE_HEADER = 'X-Translatorio-Signature'

/** Anything the API refused. Carries the status, the code and the whole body. */
export class TranslatorioError extends Error {
  /**
   * @param {string} message
   * @param {number} [status] 0 when nothing answered.
   * @param {?string} [code] The API's own code, to branch on.
   * @param {Object} [payload] The whole body, as it came.
   * @param {?number} [retryAfterSeconds] The wait the API asked for, if any: `error.retry_after`, or the `Retry-After` header.
   */
  constructor(message, status = 0, code = null, payload = {}, retryAfterSeconds = null) {
    super(message)
    this.name = 'TranslatorioError'
    this.status = status
    this.code = code
    this.payload = payload
    this.retryAfterSeconds = retryAfterSeconds
    /** Whether asking again could plausibly work. */
    this.retryable = false
  }
}

/** The key was missing, unrecognised or revoked. A wrong key stays wrong. */
export class AuthenticationError extends TranslatorioError {
  constructor(...args) {
    super(...args)
    this.name = 'AuthenticationError'
  }
}

/**
 * The account cannot pay for this call.
 *
 * **Never retried by anything in this library.** 402 means come back with a bigger plan,
 * and a client that retries it hammers forever and never succeeds. Catch it, stop calling,
 * and tell somebody.
 */
export class QuotaExhausted extends TranslatorioError {
  constructor(...args) {
    super(...args)
    this.name = 'QuotaExhausted'
  }

  /** @returns {number} Credits left on the account. */
  get remaining() {
    return this.payload?.credits?.remaining ?? 0
  }

  /** @returns {number} What this call was estimated at. A 402 can arrive with credits still in the account. */
  get required() {
    return this.payload?.credits?.required ?? 0
  }

  /** @returns {?number} Credits set aside by batches still running, when the refusal was a batch's. */
  get queued() {
    return this.payload?.credits?.queued ?? null
  }

  /** @returns {?string} When the monthly allowance comes back, ISO 8601. */
  get renewsAt() {
    return this.payload?.credits?.renews_at ?? null
  }
}

/** Too many requests. Retried automatically; if you see it, the retries ran out. */
export class RateLimited extends TranslatorioError {
  constructor(...args) {
    super(...args)
    this.name = 'RateLimited'
    this.retryable = true
  }

  /** @returns {number} Seconds the service asked us to wait (its `Retry-After`), or 1. */
  get retryAfter() {
    return Math.max(1, this.retryAfterSeconds ?? 1)
  }
}

/** The request was malformed and nothing was done. */
export class InvalidRequest extends TranslatorioError {
  constructor(...args) {
    super(...args)
    this.name = 'InvalidRequest'
  }

  /**
   * The fields it refused, each with its messages, as the API sends them in `error.fields`.
   *
   * A refusal about one field (an unknown field, an unsupported language) arrives in the
   * same shape, so this is the one place to look. Empty when the refusal is about no field.
   *
   * @returns {Object<string, string[]>}
   */
  get fields() {
    const fields = this.payload?.error?.fields

    return fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}
  }
}

/** No such glossary, correction, batch, call or key on this account. */
export class NotFound extends TranslatorioError {
  constructor(...args) {
    super(...args)
    this.name = 'NotFound'
  }
}

/** Our fault, the model provider's, or the network's. Retried automatically. */
export class ServerError extends TranslatorioError {
  constructor(...args) {
    super(...args)
    this.name = 'ServerError'
    this.retryable = true
  }
}

/**
 * The typed error for a refusal.
 *
 * @param {number} status
 * @param {Object} payload
 * @param {?number} header Seconds, from the `Retry-After` header.
 * @returns {TranslatorioError}
 */
function errorFor(status, payload, header) {
  const message = payload?.error?.message ?? payload?.message ?? 'The request failed.'
  const code = payload?.error?.code ?? null
  // The body's own `retry_after` first: it is the API's number, and it survives a proxy that
  // strips headers. The header is plain HTTP and costs nothing to keep as the fallback.
  const body = payload?.error?.retry_after
  const wait = Number.isInteger(body) && body >= 0 ? body : header
  const args = [message, status, code, payload, wait]

  if (status === 401) return new AuthenticationError(...args)
  if (status === 402) return new QuotaExhausted(...args)
  if (status === 404) return new NotFound(...args)
  if (status === 422) return new InvalidRequest(...args)
  if (status === 429) return new RateLimited(...args)
  // A 409 `idempotency_in_flight` is the earlier attempt at this very call still running,
  // so waiting and asking again is exactly right. Any other 409 is a refusal that asking
  // again cannot change.
  if ((status === 409 && code === 'idempotency_in_flight') || status >= 500) return new ServerError(...args)

  return new TranslatorioError(...args)
}

/**
 * Seconds from a `Retry-After` header, which may be a number or an HTTP date.
 *
 * @param {?string} value
 * @param {() => number} now
 * @returns {?number}
 */
function parseRetryAfter(value, now = Date.now) {
  if (value === null || value === undefined || value === '') return null

  const trimmed = String(value).trim()

  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)

  const at = Date.parse(trimmed)

  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now()) / 1000))
}

/**
 * What every translating call answers with besides its translations: the id, what it used
 * and what it cost.
 */
export class Answer {
  /** @param {Object} raw The body as the API sent it. */
  constructor(raw) {
    this.raw = raw ?? {}
  }

  /** @returns {?string} `tr_` plus a ULID. Names this call in history. */
  get id() {
    return this.raw.id ?? null
  }

  /** @returns {?string} Your own id for the call, handed back. */
  get reference() {
    return this.raw.reference ?? null
  }

  /** @returns {Object} Characters, segments, memory hits, masked values, the model and its tokens, as sent. */
  get usage() {
    return this.raw.usage ?? {}
  }

  /** @returns {number} Characters sent. */
  get characters() {
    return this.usage.characters ?? 0
  }

  /** @returns {boolean} Whether the model was asked anything at all. */
  get modelRead() {
    return this.usage.model?.read === true
  }

  /** @returns {?string} The model that read it, when one did. */
  get modelName() {
    return typeof this.usage.model?.name === 'string' ? this.usage.model.name : null
  }

  /** @returns {?string} How hard the model was asked to work: `low`, `medium` or `high`. */
  get effort() {
    return typeof this.usage.model?.effort === 'string' ? this.usage.model.effort : null
  }

  /**
   * @returns {?string} Why the model did not read it: `memory` (every string came from
   * your translation memory or your corrections) or `test_key` (a test key never reaches
   * the model, and the answer is a marked copy, not a translation). Null when it read it.
   */
  get modelWhy() {
    return typeof this.usage.model?.why === 'string' ? this.usage.model.why : null
  }

  /** @returns {{input: number, output: number}} Tokens the model used. */
  get tokens() {
    return { input: this.usage.tokens?.input ?? 0, output: this.usage.tokens?.output ?? 0 }
  }

  /** @returns {number} What this call cost, in credits. */
  get charged() {
    return this.raw.credits?.charged ?? 0
  }

  /**
   * @returns {?number} Credits left after this call, or null when the answer does not say.
   * Null rather than 0, which would read as an account with nothing left.
   */
  get creditsRemaining() {
    return this.raw.credits?.remaining ?? null
  }

  /** @returns {?string} `live` or `test`. */
  get mode() {
    return this.raw.mode ?? null
  }

  /** @returns {boolean} Made with a test key: free, and never read by the model. */
  get test() {
    return this.raw.mode === 'test'
  }

  /** @returns {number} How long the call took on our side, in milliseconds. */
  get tookMs() {
    return this.raw.took_ms ?? 0
  }
}

/** The answer to `/v1/translate`: one result per text, each with its languages. */
export class Translation extends Answer {
  /** @returns {?string} The language given, or the one detected. */
  get source() {
    return this.raw.source?.language ?? null
  }

  /** @returns {boolean} Whether the source was detected rather than given. */
  get detected() {
    return this.raw.source?.detected === true
  }

  /** @returns {string[]} The languages translated into, normalised. */
  get targets() {
    return this.raw.targets ?? []
  }

  /**
   * @returns {?string} The translation, when one text went into one language. Null
   * otherwise: that convenience exists only for the commonest call, never instead of
   * `results`.
   */
  get translation() {
    return typeof this.raw.translation === 'string' ? this.raw.translation : null
  }

  /** @returns {{index: number, translations: Object<string, string>, intact: boolean}[]} One per text, in the order sent. */
  get results() {
    return this.raw.results ?? []
  }

  /**
   * One text in one language.
   *
   * @param {string} language A target code as the answer spells it (`es`, `pt-BR`).
   * @param {number} [index] The position the text was sent in.
   * @returns {?string}
   */
  translationIn(language, index = 0) {
    return this.results.find((result) => result.index === index)?.translations?.[language] ?? null
  }

  /**
   * @returns {boolean} False when any placeholder, tag or masked value did not come back.
   * Check those before publishing.
   */
  get intact() {
    return this.raw.intact === true
  }

  /** @returns {number} Text by language pairs. */
  get segments() {
    return this.usage.segments ?? 0
  }

  /** @returns {number} Segments answered from your translation memory. */
  get cached() {
    return this.usage.cached ?? 0
  }

  /** @returns {number} Segments answered with your own corrections. */
  get corrected() {
    return this.usage.corrected ?? 0
  }

  /** @returns {number} Personal data items masked before the model saw them. */
  get anonymized() {
    return this.usage.anonymized ?? 0
  }
}

/** The answer to `/v1/translate/file`: one file per language, in the shape it was sent. */
export class FileTranslation extends Answer {
  /** @returns {?string} The format it was read as: `json`, `po`, `xliff`, `csv`, `android`, `ios`... */
  get format() {
    return this.raw.format ?? null
  }

  /** @returns {?string} The language given, or the one detected. */
  get source() {
    return this.raw.source?.language ?? null
  }

  /** @returns {boolean} Whether the source was detected rather than given. */
  get detected() {
    return this.raw.source?.detected === true
  }

  /** @returns {number} How many strings the file held. */
  get strings() {
    return this.raw.strings ?? 0
  }

  /** @returns {{language: string, name: string, content: string, intact: boolean}[]} One per target. */
  get files() {
    return this.raw.files ?? []
  }

  /**
   * The file for one language.
   *
   * @param {string} language
   * @returns {?{language: string, name: string, content: string, intact: boolean}}
   */
  file(language) {
    return this.files.find((file) => file.language === language) ?? null
  }

  /** @returns {boolean} False when any file lost a placeholder, tag or masked value. */
  get intact() {
    return this.raw.intact === true
  }

  /** @returns {number} String by language pairs. */
  get segments() {
    return this.usage.segments ?? 0
  }

  /** @returns {number} Segments answered from your translation memory. */
  get cached() {
    return this.usage.cached ?? 0
  }

  /** @returns {number} Segments answered with your own corrections. */
  get corrected() {
    return this.usage.corrected ?? 0
  }

  /** @returns {number} Personal data items masked before the model saw them. */
  get anonymized() {
    return this.usage.anonymized ?? 0
  }
}

/** The answer to `/v1/translate/image`: every block of text, translated, with its box. */
export class ImageTranslation extends Answer {
  /** @returns {?string} The language the picture was in, given or read. */
  get source() {
    return this.raw.source?.language ?? null
  }

  /** @returns {string[]} The languages translated into. */
  get targets() {
    return this.raw.targets ?? []
  }

  /**
   * @returns {{text: string, box: {x: number, y: number, width: number, height: number}, translations: Object<string, string>}[]}
   * Boxes are fractions of the image, top-left corner first.
   */
  get blocks() {
    return this.raw.blocks ?? []
  }
}

/** The answer to `/v1/detect`. */
export class Detection extends Answer {
  /** @returns {?{code: string, name: string, native: string, rtl: boolean}} Null when it could not tell. */
  get language() {
    return this.raw.language ?? null
  }

  /** @returns {?string} The language's code, or null. */
  get code() {
    return this.raw.language?.code ?? null
  }

  /** @returns {?number} 0 to 1. */
  get confidence() {
    return this.raw.confidence ?? null
  }

  /** @returns {?string} How it was decided: `script` (free), `model` or `test_key`. */
  get by() {
    return this.raw.by ?? null
  }
}

/**
 * A batch: its summary, and one page of its results when it was read back with
 * `batchStatus()`.
 *
 * Read back, it is also a page in the shape every paged method returns: `items` (this page's
 * result rows) and `next` (the cursor for the following page, null after the last).
 */
export class Batch {
  /** @param {Object} raw The body as the API sent it. */
  constructor(raw) {
    this.raw = raw ?? {}
  }

  /** @returns {string} `bat_` plus a ULID. */
  get id() {
    return this.raw.id
  }

  /** @returns {?string} Your own id for the batch. */
  get reference() {
    return this.raw.reference ?? null
  }

  /** @returns {string} `queued`, `running`, `completed` or `failed`. */
  get status() {
    return this.raw.status
  }

  /** @returns {boolean} Nothing more will happen to it. */
  get finished() {
    return this.raw.status === 'completed' || this.raw.status === 'failed'
  }

  /** @returns {?string} The source language, or null to detect it. */
  get source() {
    return this.raw.source ?? null
  }

  /** @returns {string[]} */
  get targets() {
    return this.raw.targets ?? []
  }

  /** @returns {number} Texts sent. */
  get total() {
    return this.raw.total ?? 0
  }

  /** @returns {number} Texts translated so far. */
  get done() {
    return this.raw.done ?? 0
  }

  /** @returns {number} Texts that failed. */
  get failed() {
    return this.raw.failed ?? 0
  }

  /** @returns {number} Set aside when it was accepted. */
  get creditsEstimated() {
    return this.raw.credits?.estimated ?? 0
  }

  /** @returns {number} Charged so far. */
  get creditsCharged() {
    return this.raw.credits?.charged ?? 0
  }

  /** @returns {?string} */
  get createdAt() {
    return this.raw.created_at ?? null
  }

  /** @returns {?string} */
  get finishedAt() {
    return this.raw.finished_at ?? null
  }

  /** @returns {?string} When the results are deleted. Read them before then. */
  get expiresAt() {
    return this.raw.expires_at ?? null
  }

  /**
   * @returns {Map<number, {translations: Object<string, string>, intact: boolean}>} By the
   * position each text was sent in. Empty until read back with `batchStatus()`.
   */
  get results() {
    const results = new Map()

    for (const row of this.raw.results ?? []) {
      if (!row.error) results.set(row.index, { translations: row.translations ?? {}, intact: row.intact === true })
    }

    return results
  }

  /** @returns {Map<number, {code: string, message?: string}>} A text that failed is a text, not a batch. */
  get failures() {
    const failures = new Map()

    for (const row of this.raw.results ?? []) {
      if (row.error) failures.set(row.index, row.error)
    }

    return failures
  }

  /**
   * @returns {Object[]} This page's result rows as sent: `{index, translations, intact}`, or
   * `{index, error}` for a text that failed. Empty until read back with `batchStatus()`.
   */
  get items() {
    return Array.isArray(this.raw.results) ? this.raw.results : []
  }

  /** @returns {?string} Pass it back as `cursor` for the next page of results; null after the last. */
  get next() {
    const after = this.raw.next_after

    return after === null || after === undefined ? null : String(after)
  }
}

/**
 * One page of a paged listing.
 *
 * `next` is opaque: pass it back as the same method's `cursor` for the following page. Null
 * means this was the last one.
 *
 * @param {Object[]} items
 * @param {*} next
 * @returns {{items: Object[], next: ?string}}
 */
function page(items, next) {
  return { items, next: typeof next === 'string' && next !== '' ? next : null }
}

/**
 * Bytes as base64.
 *
 * `btoa` is the only encoder present in every runtime this package supports, and it takes a
 * string of char codes rather than bytes. The chunking is not decoration: spreading a whole
 * image into `String.fromCharCode(...)` blows the argument limit and throws a range error on
 * exactly the large files this path exists for.
 *
 * A string is assumed to be encoded already, because a JavaScript string holds UTF-16 code
 * units and is not where binary lives here.
 *
 * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView|Blob} data
 * @returns {Promise<string>}
 */
async function toBase64(data) {
  if (typeof data === 'string') return data

  const bytes = await toBytes(data)

  let binary = ''
  const chunk = 0x8000

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }

  return btoa(binary)
}

/**
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|Blob} data
 * @returns {Promise<Uint8Array>}
 */
async function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

  throw new TypeError('Expected bytes (Uint8Array, ArrayBuffer, Blob or Buffer) or a string.')
}

/**
 * Fields as form pairs, the way Laravel reads nested ones: `targets[]`, `terms[es][cart]`,
 * booleans as `1` and `0` (what `$request->boolean()` reads).
 *
 * @param {string} name
 * @param {*} value
 * @param {Array<[string, string]>} [pairs]
 * @returns {Array<[string, string]>}
 */
function formPairs(name, value, pairs = []) {
  if (value === undefined || value === null) return pairs

  if (Array.isArray(value)) {
    for (const item of value) formPairs(`${name}[]`, item, pairs)
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) formPairs(`${name}[${key}]`, item, pairs)
  } else if (typeof value === 'boolean') {
    pairs.push([name, value ? '1' : '0'])
  } else {
    pairs.push([name, String(value)])
  }

  return pairs
}

/**
 * A name inside a `Content-Disposition` header, escaped as browsers do it: a quote or a line
 * break would otherwise end the header and let a filename write the next part.
 *
 * @param {string} value
 * @returns {string}
 */
function dispositionName(value) {
  return value.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/**
 * A `multipart/form-data` body, built here rather than by a `FormData`.
 *
 * Built as bytes so the transport stays one function that knows nothing about multipart, a
 * retry resends exactly the same body, and the file goes up byte for byte: a `.strings` in
 * UTF-16 never passes through a text decoder.
 *
 * @param {Array<[string, string]>} fields
 * @param {{name: string, filename: string, bytes: Uint8Array}} file
 * @returns {{contentType: string, data: Uint8Array}}
 */
function multipart(fields, file) {
  const boundary = `translatorio-${randomId().replace(/-/g, '')}`
  const encoder = new TextEncoder()
  const chunks = []

  for (const [name, value] of fields) {
    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${dispositionName(name)}"\r\n\r\n${value}\r\n`))
  }

  chunks.push(encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${dispositionName(file.name)}"; filename="${dispositionName(file.filename)}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  ))
  chunks.push(file.bytes)
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`))

  const data = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0

  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }

  return { contentType: `multipart/form-data; boundary=${boundary}`, data }
}

/**
 * One language or several, as the field the API takes for each.
 *
 * @param {string|string[]} targets
 * @returns {Object}
 */
function targetFields(targets) {
  return Array.isArray(targets) ? { targets } : { target: targets }
}

/** Whether a string is an address the API fetches rather than the picture itself. */
function isWebAddress(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

/**
 * The client.
 *
 * **It retries the right failures and never the wrong one.** A 429 and a 5xx are asked
 * again with a growing wait, or the wait the service asked for; a 402 is not, ever.
 *
 * **Every retry is the same request.** Each call that changes something carries an
 * `Idempotency-Key`, generated here when you do not supply one, so a call that timed out and
 * is asked again is done once and billed once.
 */
export class Translatorio {
  /**
   * @param {string} apiKey `tr_live_...` or `tr_test_...`.
   * @param {Object} [options] `baseUrl`, `timeout` (ms), `retries`, `maxWait` (ms), `fetch`, `sleep`.
   */
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey
    this.baseUrl = (options.baseUrl ?? 'https://translatorio.com/api').replace(/\/+$/, '')
    this.retries = options.retries ?? 2
    this.timeout = options.timeout ?? 10_000
    // The longest this will ever sleep between attempts, whatever the service asks for.
    // Honouring `Retry-After` is the point; honouring it without a ceiling lets a number on
    // the wire decide how long your own request hangs.
    this.maxWait = options.maxWait ?? 30_000
    // The transport: one function, `fetch`'s own signature. Pass your own to route calls
    // through a framework's client or to test without a network.
    this.fetch = options.fetch ?? globalThis.fetch?.bind(globalThis)
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

    if (!this.fetch) {
      throw new Error('No fetch available. Pass one as options.fetch, or use Node 20 or newer.')
    }
  }

  /**
   * Text, HTML or Markdown into one language or several.
   *
   * @param {string|string[]} text One text, or up to a hundred.
   * @param {string|string[]} targets One language, or several.
   * @param {Object} [options] `source`, `format`, `formality`, `context`, `glossary`, `terms`,
   *   `anonymize`, `reference`, `effort`, `idempotencyKey`.
   * @returns {Promise<Translation>}
   */
  async translate(text, targets, options = {}) {
    const texts = Array.isArray(text) ? { texts: text } : { text }
    const body = await this.#post('/v1/translate', { ...texts, ...targetFields(targets), ...options })

    return new Translation(this.#expect(body, 'results'))
  }

  /**
   * A whole translation file, back in the same shape, one per language.
   *
   * A string is the file's text and goes up as JSON `content`, with `options.filename` to
   * tell the format and name the results. Bytes or a Blob go up as a multipart upload, the
   * part named `file` carrying the filename and every other option a form field, byte for
   * byte: a `.strings` file in UTF-16 is not something to push through a text decoder.
   *
   * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView|Blob} file
   * @param {string|string[]} targets
   * @param {Object} [options] `filename`, `format`, `source`, `formality`, `context`,
   *   `glossary`, `terms`, `anonymize`, `reference`, `effort`, `idempotencyKey`.
   * @returns {Promise<FileTranslation>}
   */
  async translateFile(file, targets, options = {}) {
    if (typeof file === 'string') {
      const body = await this.#post('/v1/translate/file', { content: file, ...targetFields(targets), ...options })

      return new FileTranslation(this.#expect(body, 'files'))
    }

    const { filename, idempotencyKey, ...rest } = options
    const name = filename ?? (typeof file?.name === 'string' && file.name !== '' ? file.name : 'file')
    const fields = []

    for (const [field, value] of Object.entries({ ...targetFields(targets), ...rest })) {
      formPairs(field, value, fields)
    }

    const encoded = multipart(fields, { name: 'file', filename: name, bytes: await toBytes(file) })
    const body = await this.#send('POST', '/v1/translate/file', {}, encoded, idempotencyKey ?? `js-${randomId()}`)

    return new FileTranslation(this.#expect(body, 'files'))
  }

  /**
   * Every block of text in a picture, translated, with its box.
   *
   * An http or https address is fetched by the model provider. Anything else is the picture
   * itself and goes out as `data`: not a guess, since `url` accepts those two schemes and
   * nothing else.
   *
   * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView|Blob} image An address, base64, a data URI or bytes.
   * @param {string|string[]} targets
   * @param {Object} [options] `source`, `formality`, `context`, `glossary`, `terms`,
   *   `reference`, `effort`, `idempotencyKey`.
   * @returns {Promise<ImageTranslation>}
   */
  async translateImage(image, targets, options = {}) {
    const picture = isWebAddress(image) ? { url: image } : { data: await toBase64(image) }
    const body = await this.#post('/v1/translate/image', { ...picture, ...targetFields(targets), ...options })

    return new ImageTranslation(this.#expect(body, 'blocks'))
  }

  /**
   * Which language a text is in.
   *
   * @param {string} text
   * @param {Object} [options] `reference`, `idempotencyKey`.
   * @returns {Promise<Detection>}
   */
  async detect(text, options = {}) {
    const body = await this.#post('/v1/detect', { text, ...options })

    return new Detection(this.#expect(body, 'language'))
  }

  /**
   * Up to ten thousand texts, translated in the background. Answers at once with the
   * batch queued; read it back with `batchStatus()` or wait for `batch.completed`.
   *
   * @param {string[]} texts
   * @param {string|string[]} targets
   * @param {Object} [options] `source`, `format`, `formality`, `context`, `glossary`,
   *   `terms`, `anonymize`, `reference`, `effort`, `idempotencyKey`.
   * @returns {Promise<Batch>}
   */
  async batch(texts, targets, options = {}) {
    const body = await this.#post('/v1/batches', { texts, ...targetFields(targets), ...options })

    return new Batch(this.#expect(body, 'id'))
  }

  /**
   * The most recent batches, newest first, without their results.
   *
   * @param {Object} [query] `limit`, 1 to 100.
   * @returns {Promise<Batch[]>}
   */
  async batches(query = {}) {
    const body = await this.#get('/v1/batches', query)

    return (Array.isArray(body.data) ? body.data : []).map((row) => new Batch(row))
  }

  /**
   * One batch with a page of its results: pass the batch's `next` back as `cursor`.
   *
   * @param {string} id
   * @param {Object} [query] `cursor` (a previous page's `next`) and `limit` (1 to 500).
   * @returns {Promise<Batch>}
   */
  async batchStatus(id, query = {}) {
    const { cursor, limit } = query

    return new Batch(await this.#get(`/v1/batches/${encodeURIComponent(id)}`, { after: cursor, limit }))
  }

  /**
   * The account's glossaries, with their entry counts.
   *
   * @returns {Promise<Object[]>}
   */
  async glossaries() {
    return this.#list(await this.#get('/v1/glossaries'))
  }

  /**
   * A glossary: terms that are always translated the same way.
   *
   * @param {Object} fields `name`, and optionally `source`, `target` and `entries`
   *   (`{term: translation}` or the list a read returns).
   * @param {Object} [options] `idempotencyKey`.
   * @returns {Promise<Object>}
   */
  async createGlossary(fields, options = {}) {
    return this.#write('POST', '/v1/glossaries', { ...fields, ...options })
  }

  /**
   * One glossary, with its entries.
   *
   * @param {string} slug
   * @returns {Promise<Object>}
   */
  async glossary(slug) {
    return this.#get(`/v1/glossaries/${encodeURIComponent(slug)}`)
  }

  /**
   * Change any field of a glossary. `entries`, when sent, REPLACES the list.
   *
   * @param {string} slug
   * @param {Object} fields `name`, `source`, `target`, `entries`.
   * @param {Object} [options] `idempotencyKey`.
   * @returns {Promise<Object>}
   */
  async updateGlossary(slug, fields, options = {}) {
    return this.#write('PUT', `/v1/glossaries/${encodeURIComponent(slug)}`, { ...fields, ...options })
  }

  /**
   * Delete a glossary and its entries.
   *
   * @param {string} slug
   * @returns {Promise<{deleted: boolean}>}
   */
  async deleteGlossary(slug) {
    return this.#write('DELETE', `/v1/glossaries/${encodeURIComponent(slug)}`, {})
  }

  /**
   * Your own translations, newest first, one page at a time.
   *
   * @param {Object} [query] `target`, `limit` (1 to 200) and `cursor` (a previous page's `next`).
   * @returns {Promise<{items: Object[], next: ?string}>}
   */
  async corrections(query = {}) {
    const body = await this.#get('/v1/corrections', query)

    return page(this.#list(body), body.next_cursor)
  }

  /**
   * Your own translation of one exact text into one language, which wins from then on.
   * Saving the same text and language again replaces it.
   *
   * @param {string} text
   * @param {string} target
   * @param {string} translation
   * @param {Object} [options] `idempotencyKey`.
   * @returns {Promise<Object>}
   */
  async correct(text, target, translation, options = {}) {
    return this.#write('PUT', '/v1/corrections', { text, target, translation, ...options })
  }

  /**
   * @param {number|string} id
   * @returns {Promise<{deleted: boolean}>}
   */
  async deleteCorrection(id) {
    return this.#write('DELETE', `/v1/corrections/${encodeURIComponent(id)}`, {})
  }

  /**
   * Every language and its code.
   *
   * @returns {Promise<{code: string, name: string, native: string, rtl: boolean}[]>}
   */
  async languages() {
    return this.#list(await this.#get('/v1/languages'))
  }

  /**
   * Credits left, prices and the last 30 days. Free, and it answers at zero credits.
   *
   * @returns {Promise<Object>}
   */
  async usage() {
    return this.#get('/v1/usage')
  }

  /**
   * The record of every call, newest first, one page at a time. Never the text: it is not kept.
   *
   * @param {Object} [query] `kind`, `reference`, `limit` (1 to 100) and `cursor` (a previous page's `next`).
   * @returns {Promise<{items: Object[], next: ?string}>}
   */
  async translations(query = {}) {
    const body = await this.#get('/v1/translations', query)

    return page(this.#list(body), body.next_cursor)
  }

  /**
   * One call's record.
   *
   * @param {string} id
   * @returns {Promise<Object>}
   */
  async translationRecord(id) {
    return this.#get(`/v1/translations/${encodeURIComponent(id)}`)
  }

  /**
   * The organization's live keys: prefixes, modes, last use. Never a secret.
   *
   * @returns {Promise<Object[]>}
   */
  async keys() {
    return this.#list(await this.#get('/v1/keys'))
  }

  /**
   * Revoke a key, including the one you are calling with. There is no create.
   *
   * @param {number|string} id
   * @returns {Promise<{revoked: boolean}>}
   */
  async revokeKey(id) {
    return this.#write('DELETE', `/v1/keys/${encodeURIComponent(id)}`, {})
  }

  /**
   * Is the key good, is the service up. Costs nothing.
   *
   * @returns {Promise<{ok: boolean, mode: string, key: string}>}
   */
  async ping() {
    return this.#get('/v1/ping')
  }

  /**
   * A success that lacks what the call is for is not a success.
   *
   * A 2xx JSON object with no `results` is something that is not this API answering; read as
   * an empty translation, it would publish nothing in place of the text. Retryable, like any
   * other answer that should not have happened.
   *
   * @param {Object} body
   * @param {string} field
   * @returns {Object}
   */
  #expect(body, field) {
    const value = body[field]
    const present = field === 'language' ? field in body : field === 'id' ? typeof value === 'string' : Array.isArray(value)

    if (!present) {
      throw new ServerError(`Translatorio answered without \`${field}\`. Nothing can be read from it.`, 200, 'malformed_response', body)
    }

    return body
  }

  /**
   * The `data` list of a listing, or an empty list.
   *
   * @param {Object} body
   * @returns {Object[]}
   */
  #list(body) {
    return Array.isArray(body.data) ? body.data : []
  }

  /**
   * @param {string} path
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async #post(path, payload) {
    return this.#write('POST', path, payload)
  }

  /**
   * A call that changes something, with its idempotency key.
   *
   * One key per call, reused by every retry of that call. That is what makes the retrying
   * safe: the same key means the same request, and the API answers it once however many
   * times the network makes us ask.
   *
   * @param {string} method
   * @param {string} path
   * @param {Object} payload
   * @returns {Promise<Object>}
   */
  async #write(method, path, payload) {
    const body = { ...payload }
    const key = body.idempotencyKey ?? `js-${randomId()}`
    delete body.idempotencyKey

    return this.#send(method, path, {}, method === 'DELETE' && Object.keys(body).length === 0 ? null : body, key)
  }

  /**
   * @param {string} path
   * @param {Object} [query]
   * @returns {Promise<Object>}
   */
  async #get(path, query = {}) {
    return this.#send('GET', path, query, null, null)
  }

  /**
   * The request, its retries, and the reading of the answer.
   *
   * @param {string} method
   * @param {string} path
   * @param {Object} query
   * @param {Object|{contentType: string, data: Uint8Array}|null} payload A JSON body, or one already encoded.
   * @param {?string} idempotencyKey
   * @returns {Promise<Object>}
   */
  async #send(method, path, query, payload, idempotencyKey) {
    const params = new URLSearchParams()

    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) params.set(name, String(value))
    }

    const url = this.baseUrl + path + (params.size ? `?${params}` : '')

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': `translatorio-js/${VERSION}`,
    }

    const encoded = payload !== null && payload.data instanceof Uint8Array && typeof payload.contentType === 'string'

    if (payload !== null) headers['Content-Type'] = encoded ? payload.contentType : 'application/json'
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

    // Built once, outside the loop: every retry sends these very bytes.
    const body = payload === null ? undefined : encoded ? payload.data : JSON.stringify(payload)

    for (let attempt = 0; ; attempt++) {
      let error

      try {
        const { status, text, location, retryAfter } = await this.#once(method, url, headers, body)

        // Only a 2xx carrying a JSON object is an answer. A redirect (an `http://` baseUrl),
        // a proxy's HTML page or a body cut off halfway is not, and reading any of them as
        // `{}` would hand back an empty translation as if it were one.
        if (status >= 200 && status < 300) {
          const decoded = parseObject(text)

          if (decoded) return decoded

          throw new ServerError(
            `Translatorio answered ${status} with a body that is not a JSON object${text === '' ? ' (it was empty)' : ''}.`,
            status,
            'malformed_response',
          )
        }

        if (status < 400) {
          throw new ServerError(
            `Translatorio answered with a redirect (${status})${location ? ` to ${location}` : ''}, which is never an answer. ` +
              'Check the baseUrl: it should be https://translatorio.com/api.',
            status,
            'redirected',
          )
        }

        error = errorFor(status, parseObject(text) ?? {}, retryAfter)
      } catch (e) {
        if (e instanceof TranslatorioError) {
          error = e
        } else {
          // A connection that never arrived is reported as a server error, because the
          // caller does the same thing about either: ask again.
          error = new ServerError(`Could not reach Translatorio: ${e?.message ?? e}`)
        }
      }

      if (!error.retryable || attempt >= this.retries) throw error

      // The service knows when its own window turns over, so a `Retry-After` beats guessing.
      // Bounded all the same, so a wrong or hostile number cannot hold a request open for as
      // long as it likes.
      const seconds = error instanceof RateLimited ? error.retryAfter : error.retryAfterSeconds ?? 2 ** (attempt + 1)
      await this.sleep(Math.min(this.maxWait, seconds * 1000))
    }
  }

  /**
   * One attempt: the request AND its body, under one timeout.
   *
   * The body is read inside the timed section, so a server that sends its headers and then
   * stalls ends in the same timeout as one that never answers. The read is also raced
   * against the abort itself, because not every `fetch` a caller may pass in rejects a body
   * read when its signal fires.
   *
   * @param {string} method
   * @param {string} url
   * @param {Object} headers
   * @param {string|Uint8Array|undefined} body
   * @returns {Promise<{status: number, text: string, location: ?string, retryAfter: ?number}>}
   */
  async #once(method, url, headers, body) {
    const controller = new AbortController()
    let timer

    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new ServerError(`Translatorio did not answer within ${this.timeout} ms.`, 0, 'timeout')
        controller.abort(error)
        reject(error)
      }, this.timeout)
    })

    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' })
          const location = response.headers?.get?.('location') ?? null
          const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after') ?? null)

          let text

          try {
            text = await response.text()
          } catch (e) {
            if (e instanceof TranslatorioError) throw e
            // A refusal whose body could not be read is still a refusal, typed by its status.
            if (response.status >= 400) return { status: response.status, text: '', location, retryAfter }

            throw new ServerError(`Translatorio's answer was cut off: ${e?.message ?? e}`, response.status, 'body_unreadable')
          }

          return { status: response.status, text, location, retryAfter }
        })(),
        expired,
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The body as a JSON object, or null when it is not one.
 *
 * Null rather than `{}`, so that "not an answer" can never be mistaken for an empty one.
 *
 * @param {string} text
 * @returns {?Object}
 */
function parseObject(text) {
  try {
    const value = JSON.parse(text)

    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** @returns {string} A random id for an idempotency key. */
function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
}

/**
 * Whether a webhook delivery is ours.
 *
 * Your webhook URL is public: anybody who learns it can POST to it. The same check the
 * service documents: `t=…,v1=…`, an HMAC-SHA256 of `timestamp.body` with the endpoint's
 * secret, refused when older than five minutes so a captured delivery cannot be replayed.
 *
 * Async because it uses WebCrypto, which is the only HMAC that exists in every runtime this
 * package supports. Pass the RAW body: re-encoding what a framework parsed can reorder a key
 * or escape a slash differently, and then the signature is over a different string.
 *
 * @param {string|Uint8Array} payload The raw body.
 * @param {string} header The `X-Translatorio-Signature` header.
 * @param {string} secret The endpoint's signing secret.
 * @param {Object} [options] `tolerance` in seconds (300), `now` returning milliseconds.
 * @returns {Promise<boolean>}
 */
export async function verifyWebhook(payload, header, secret, { tolerance = 300, now = Date.now } = {}) {
  const parts = Object.fromEntries(
    String(header ?? '')
      .split(',')
      .map((piece) => {
        const [name, ...rest] = piece.trim().split('=')
        return [name, rest.join('=')]
      }),
  )

  const timestamp = Number.parseInt(parts.t ?? '0', 10)
  const signature = parts.v1 ?? ''

  // Exactly a SHA-256 in lowercase hex, which is what the service writes and the only thing
  // its own check (`hash_equals` on the hex string) accepts. Checked before decoding:
  // `parseInt` reads `+a` as a hex byte, so a string that is not hex could otherwise decode
  // to the right bytes.
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !/^[0-9a-f]{64}$/.test(signature)) return false

  if (Math.abs(Math.floor(now() / 1000) - timestamp) > tolerance) return false

  const encoder = new TextEncoder()
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload

  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  const signed = new Uint8Array(32)

  for (let i = 0; i < signed.length; i++) {
    signed[i] = Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16)
  }

  const prefix = encoder.encode(`${timestamp}.`)
  const data = new Uint8Array(prefix.length + bytes.length)
  data.set(prefix)
  data.set(bytes, prefix.length)

  // `subtle.verify` compares in constant time: a comparison that returns early tells an
  // attacker how much of their guess was right.
  return globalThis.crypto.subtle.verify('HMAC', key, signed, data)
}

/**
 * The verified event, or null.
 *
 * @param {string|Uint8Array} payload
 * @param {string} header
 * @param {string} secret
 * @param {Object} [options]
 * @returns {Promise<?{id: string, event: string, created_at: string, data: Object}>}
 */
export async function webhookEvent(payload, header, secret, options = {}) {
  if (!(await verifyWebhook(payload, header, secret, options))) return null

  try {
    return JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload))
  } catch {
    return null
  }
}

export { Translatorio as Client }

export default Translatorio
