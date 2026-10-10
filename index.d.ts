/**
 * The official JavaScript client for Translatorio.
 *
 * Server side only: your API key is a bearer credential for the whole account, and in a
 * browser bundle it is public.
 */

export declare const VERSION: string

/** The header a webhook delivery carries its signature in. */
export declare const SIGNATURE_HEADER: 'X-Translatorio-Signature'

/** How hard the model works on a call. Accepted and passed through; see the README. */
/** What a call may ask for: a level, or `default` (the level Translatorio recommends at the time). */
export type Effort = 'default' | 'low' | 'medium' | 'high'

/** The level a call actually ran at, as the answer reports it. */
export type EffortLevel = 'low' | 'medium' | 'high'

export type Format = 'text' | 'html' | 'markdown'
export type Formality = 'default' | 'formal' | 'informal'

/** The file formats `/v1/translate/file` reads. */
export type FileFormat = 'json' | 'po' | 'xliff' | 'csv' | 'android' | 'ios' | 'markdown' | 'html' | 'text'

/**
 * Glossary terms for this call only: `{ Acme: 'Acme' }` for every language, or
 * `{ es: { cart: 'cesta' } }` per language. They win over the stored glossary on the same word.
 */
export type Terms = Record<string, string | Record<string, string>>

/** What the translating calls share. */
export interface CommonOptions {
  /** The source language. Leave it out, or send `auto`, to detect it. */
  source?: string
  formality?: Formality
  /** What the text is and who reads it. 1,000 characters at most. */
  context?: string
  /** The slug of one of your glossaries. */
  glossary?: string
  terms?: Terms
  /** Your own id for the call. Comes back in the answer and in history. */
  reference?: string
  /** How hard the model works. Sent only when given. */
  effort?: Effort
  /** Supply your own, or one is generated per call. Sent as a header, never in the body. */
  idempotencyKey?: string
}

export interface TranslateOptions extends CommonOptions {
  /** Decides what is protected. Default `text`. */
  format?: Format
  /** Default true: personal data is masked before the model sees it. */
  anonymize?: boolean
}

export interface FileOptions extends CommonOptions {
  /** Tells the format by its extension and names the results. */
  filename?: string
  /** Optional when the filename's extension says it. */
  format?: FileFormat
  anonymize?: boolean
}

/** No `format` and no `anonymize`: the image endpoint takes neither. */
export interface ImageOptions extends CommonOptions {}

export interface BatchOptions extends TranslateOptions {}

export interface DetectOptions {
  reference?: string
  idempotencyKey?: string
}

/** What the model did, as the answer reports it. */
export interface ModelUsage {
  read: boolean
  /** How hard the model was asked to work. */
  effort?: Effort
  name: string | null
  /** `memory` or `test_key` when it did not read; null when it did. */
  why: 'memory' | 'test_key' | (string & {}) | null
}

export interface Usage {
  characters?: number
  segments?: number
  cached?: number
  corrected?: number
  anonymized?: number
  blocks?: number
  model?: ModelUsage
  tokens?: { input: number | null; output: number | null }
}

export declare class Answer {
  raw: Record<string, any>
  constructor(raw: Record<string, unknown>)
  readonly id: string | null
  readonly reference: string | null
  readonly usage: Usage
  readonly characters: number
  readonly modelRead: boolean
  readonly modelName: string | null
  /** `usage.model.effort`: how hard the model was asked to work. */
  readonly effort: EffortLevel | null
  readonly modelWhy: 'memory' | 'test_key' | (string & {}) | null
  readonly tokens: { input: number; output: number }
  readonly charged: number
  /** Null where the answer carries no balance, never 0. */
  readonly creditsRemaining: number | null
  readonly mode: 'live' | 'test' | null
  /** Made with a test key: free, never read by the model, a marked copy rather than a translation. */
  readonly test: boolean
  readonly tookMs: number
}

export interface TextResult {
  index: number
  /** Language code to translated text. */
  translations: Record<string, string>
  intact: boolean
}

export declare class Translation extends Answer {
  readonly source: string | null
  readonly detected: boolean
  readonly targets: string[]
  /** Only for one text into one language. */
  readonly translation: string | null
  readonly results: TextResult[]
  translationIn(language: string, index?: number): string | null
  /** False when a placeholder, tag or masked value did not come back. Check before publishing. */
  readonly intact: boolean
  readonly segments: number
  readonly cached: number
  readonly corrected: number
  readonly anonymized: number
}

export interface TranslatedFile {
  language: string
  name: string
  content: string
  intact: boolean
}

export declare class FileTranslation extends Answer {
  readonly format: FileFormat | null
  readonly source: string | null
  readonly detected: boolean
  readonly strings: number
  readonly files: TranslatedFile[]
  file(language: string): TranslatedFile | null
  readonly intact: boolean
  readonly segments: number
  readonly cached: number
  /** Segments answered with your own corrections. */
  readonly corrected: number
  readonly anonymized: number
}

export interface ImageBlock {
  text: string
  /** Fractions of the image, 0 to 1, top-left corner first. */
  box: { x: number; y: number; width: number; height: number }
  translations: Record<string, string>
}

export declare class ImageTranslation extends Answer {
  readonly source: string | null
  readonly targets: string[]
  readonly blocks: ImageBlock[]
}

export interface Language {
  code: string
  name: string
  native: string
  rtl: boolean
}

export declare class Detection extends Answer {
  readonly language: Language | null
  readonly code: string | null
  readonly confidence: number | null
  readonly by: 'script' | 'model' | 'test_key' | (string & {}) | null
}

export interface BatchFailure {
  code: string
  message?: string
}

/**
 * One page of a paged listing. `next` is opaque: pass it back as the same method's `cursor`.
 * Null means this was the last page.
 */
export interface Page<T> {
  items: T[]
  next: string | null
}

/** One row of a batch's results: translated, or failed with its error. */
export type BatchResultRow =
  | { index: number; translations: Record<string, string>; intact: boolean; error?: undefined }
  | { index: number; error: BatchFailure }

/** Read back with `batchStatus()`, a batch is also a page of its results. */
export declare class Batch implements Page<BatchResultRow> {
  raw: Record<string, any>
  constructor(raw: Record<string, unknown>)
  readonly id: string
  readonly reference: string | null
  readonly status: 'queued' | 'running' | 'completed' | 'failed'
  readonly finished: boolean
  readonly source: string | null
  readonly targets: string[]
  readonly total: number
  readonly done: number
  readonly failed: number
  readonly creditsEstimated: number
  readonly creditsCharged: number
  readonly createdAt: string | null
  readonly finishedAt: string | null
  /** When the results are deleted. */
  readonly expiresAt: string | null
  /** By the position each text was sent in. Empty until read back with `batchStatus()`. */
  readonly results: Map<number, { translations: Record<string, string>; intact: boolean }>
  readonly failures: Map<number, BatchFailure>
  /** This page's result rows, as sent. Empty until read back with `batchStatus()`. */
  readonly items: BatchResultRow[]
  /** Pass it back as `cursor` for the next page of results; null after the last. */
  readonly next: string | null
}

export interface GlossarySummary {
  slug: string
  name: string
  source: string | null
  target: string | null
  /** How many entries it holds. */
  entries: number
  updated_at: string | null
}

export interface Glossary {
  slug: string
  name: string
  source: string | null
  target: string | null
  entries: { term: string; translation: string }[]
  updated_at: string | null
}

export interface GlossaryFields {
  name?: string
  source?: string | null
  target?: string | null
  /** `{ term: translation }`, or the list a read returns. Replaces the list when sent to an update. */
  entries?: Record<string, string> | { term: string; translation: string }[]
}

export interface Correction {
  id: number
  text: string
  target: string
  translation: string
  updated_at: string | null
}

export interface TranslationRecord {
  id: string
  reference: string | null
  kind: 'text' | 'file' | 'image' | 'detect' | (string & {})
  channel: string
  source: string | null
  targets: string[]
  format: string | null
  characters: number
  segments: number
  cached: number
  anonymized: number
  model: string | null
  credits: number
  took_ms: number | null
  created_at: string | null
}

export interface ApiKeyInfo {
  id: number
  name: string
  mode: 'live' | 'test'
  prefix: string
  last_used_at: string | null
  created_at: string | null
}

export declare class TranslatorioError extends Error {
  status: number
  code: string | null
  payload: Record<string, any>
  /** The wait the API asked for, in seconds: `error.retry_after`, else the `Retry-After` header. */
  retryAfterSeconds: number | null
  /** Whether asking again could plausibly work. */
  retryable: boolean
}

export declare class AuthenticationError extends TranslatorioError {}

/** Never retried by this library: 402 means come back with a bigger plan. */
export declare class QuotaExhausted extends TranslatorioError {
  readonly remaining: number
  readonly required: number
  readonly queued: number | null
  readonly renewsAt: string | null
}

export declare class RateLimited extends TranslatorioError {
  readonly retryAfter: number
}

export declare class InvalidRequest extends TranslatorioError {
  /** `error.fields`: every field at fault with its messages. Empty when the refusal is about no field. */
  readonly fields: Record<string, string[]>
}

export declare class NotFound extends TranslatorioError {}
export declare class ServerError extends TranslatorioError {}

export interface ClientOptions {
  /** Default `https://translatorio.com/api`. */
  baseUrl?: string
  /** How many times to ask again when it is worth asking again. Default 2. */
  retries?: number
  /** Milliseconds, for the request and its body together. Default 10000. */
  timeout?: number
  /** The longest this will ever sleep between attempts, in milliseconds. Default 30000. */
  maxWait?: number
  /** The transport: anything with `fetch`'s signature. */
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export type Bytes = Uint8Array | ArrayBuffer | ArrayBufferView | Blob

export declare class Translatorio {
  constructor(apiKey: string, options?: ClientOptions)
  translate(text: string | string[], targets: string | string[], options?: TranslateOptions): Promise<Translation>
  /** A string is the file's text, sent as JSON `content`; bytes or a Blob go up as a multipart upload, byte for byte. */
  translateFile(file: string | Bytes, targets: string | string[], options?: FileOptions): Promise<FileTranslation>
  /** An http or https address, base64, a data URI, or the bytes. */
  translateImage(image: string | Bytes, targets: string | string[], options?: ImageOptions): Promise<ImageTranslation>
  detect(text: string, options?: DetectOptions): Promise<Detection>
  batch(texts: string[], targets: string | string[], options?: BatchOptions): Promise<Batch>
  batches(query?: { limit?: number }): Promise<Batch[]>
  batchStatus(id: string, query?: { cursor?: string | null; limit?: number }): Promise<Batch>
  glossaries(): Promise<GlossarySummary[]>
  createGlossary(fields: GlossaryFields & { name: string }, options?: { idempotencyKey?: string }): Promise<Glossary>
  glossary(slug: string): Promise<Glossary>
  updateGlossary(slug: string, fields: GlossaryFields, options?: { idempotencyKey?: string }): Promise<Glossary>
  deleteGlossary(slug: string): Promise<{ deleted: boolean }>
  corrections(query?: { target?: string; limit?: number; cursor?: string | null }): Promise<Page<Correction>>
  correct(text: string, target: string, translation: string, options?: { idempotencyKey?: string }): Promise<Correction>
  deleteCorrection(id: number | string): Promise<{ deleted: boolean }>
  languages(): Promise<Language[]>
  usage(): Promise<Record<string, any>>
  translations(query?: { kind?: string; reference?: string; limit?: number; cursor?: string | null }): Promise<Page<TranslationRecord>>
  translationRecord(id: string): Promise<TranslationRecord>
  keys(): Promise<ApiKeyInfo[]>
  revokeKey(id: number | string): Promise<{ revoked: boolean }>
  ping(): Promise<{ ok: boolean; mode: 'live' | 'test'; key: string }>
}

export { Translatorio as Client }

/**
 * Whether a delivery is ours. Pass the RAW body: re-encoding a parsed one changes the bytes
 * the signature was over.
 */
export declare function verifyWebhook(
  payload: string | Uint8Array,
  header: string,
  secret: string,
  options?: { tolerance?: number; now?: () => number },
): Promise<boolean>

export declare function webhookEvent(
  payload: string | Uint8Array,
  header: string,
  secret: string,
  options?: { tolerance?: number; now?: () => number },
): Promise<{ id: string; event: 'batch.completed' | 'credits.low' | 'quota.exhausted' | (string & {}); created_at: string; data: Record<string, unknown> } | null>

export default Translatorio
