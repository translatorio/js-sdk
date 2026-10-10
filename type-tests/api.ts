/**
 * What a TypeScript consumer sees, checked by the compiler rather than by reading.
 *
 * `index.d.ts` is written by hand, so the way it fails is by falling behind the client.
 * Nothing here runs, and it lives outside `test/` for that reason: `tsc --noEmit` compiling
 * it IS the test.
 */

import Translatorio, {
  Client,
  QuotaExhausted,
  RateLimited,
  InvalidRequest,
  verifyWebhook,
  webhookEvent,
  type Batch,
  type Detection,
  type FileTranslation,
  type ImageTranslation,
  type Page,
  type Correction,
  type Translation,
} from '../index.js'

const tr = new Translatorio('tr_live_x', { baseUrl: 'https://translatorio.test/api', timeout: 5000, maxWait: 10_000 })
const same: Translatorio = new Client('tr_test_x')

async function everyEndpoint(): Promise<void> {
  const one: Translation = await tr.translate('Add to cart', 'es', { formality: 'informal', effort: 'low', terms: { es: { cart: 'cesta' } } })
  const text: string | null = one.translation
  const inGerman: string | null = one.translationIn('de', 1)
  const intact: boolean = one.intact
  const remaining: number | null = one.creditsRemaining
  const effort: 'low' | 'medium' | 'high' | null = one.effort

  await tr.translate(['a', 'b'], ['es', 'de'], { format: 'html', anonymize: false, reference: 'r', glossary: 'shop', context: 'buttons' })

  const file: FileTranslation = await tr.translateFile('{"a":"b"}', ['es'], { filename: 'en.json' })
  const content: string | undefined = file.file('es')?.content
  const corrected: number = file.corrected
  await tr.translateFile(new Uint8Array([1]), 'es', { format: 'ios' })

  const image: ImageTranslation = await tr.translateImage('https://cdn.test/a.png', 'en', { effort: 'high' })
  const width: number | undefined = image.blocks[0]?.box.width
  await tr.translateImage(new Uint8Array([1]), ['en'])

  const detected: Detection = await tr.detect('hola')
  const code: string | null = detected.code

  const batch: Batch = await tr.batch(['a'], 'es', { effort: 'medium' })
  const page: Batch = await tr.batchStatus(batch.id, { cursor: batch.next })
  const rows: Page<unknown> = page
  const failed: string | undefined = page.items[0]?.error?.code
  const recent: Batch[] = await tr.batches({ limit: 5 })

  const glossary = await tr.createGlossary({ name: 'Shop', entries: { cart: 'cesta' } })
  await tr.updateGlossary(glossary.slug, { entries: glossary.entries })
  await tr.glossary('shop')
  await tr.glossaries()
  await tr.deleteGlossary('shop')

  const corrections: Page<Correction> = await tr.corrections({ target: 'es' })
  await tr.corrections({ cursor: corrections.next })
  await tr.correct('Add to cart', 'es', 'Añadir a la cesta')
  await tr.deleteCorrection(corrections.items[0]?.id ?? 0)

  await tr.languages()
  await tr.usage()
  const history = await tr.translations({ limit: 10, cursor: 'x' })
  await tr.translationRecord(history.items[0]?.id ?? '')
  const keys = await tr.keys()
  await tr.revokeKey(keys[0]?.id ?? 0)
  await tr.ping()

  void [same, text, inGerman, intact, remaining, effort, content, corrected, width, code, page, rows, failed, recent]
}

async function errorsAreClasses(): Promise<void> {
  try {
    await tr.translate('a', 'es')
  } catch (error) {
    if (error instanceof QuotaExhausted) void [error.remaining, error.required, error.renewsAt]
    if (error instanceof RateLimited) void error.retryAfter
    if (error instanceof InvalidRequest) void error.fields
  }
}

async function webhooks(body: string, header: string): Promise<void> {
  const valid: boolean = await verifyWebhook(body, header, 'whsec_x')
  const event = await webhookEvent(body, header, 'whsec_x')
  void [valid, event?.event, event?.data]
}

void [everyEndpoint, errorsAreClasses, webhooks]
