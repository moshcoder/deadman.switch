import { describe, expect, test } from 'bun:test'
import { checkSealed, open, seal } from '../src/seal.ts'

describe('seal', () => {
  test('round trip, with a file', async () => {
    const bundle = { note: 'Ledger in the safe. Seed: bank box + Mom.', files: [{ name: 'card.png', type: 'image/png', data: Buffer.from('png bytes').toString('base64') }] }
    const sealed = await seal(bundle, 'correct horse battery', 100_000)
    expect(sealed.ct).not.toContain('Ledger')
    expect(await open(sealed, 'correct horse battery')).toEqual(bundle)
  })
  test('a wrong passphrase says so', async () => {
    const sealed = await seal({ note: 'x', files: [] }, 'right passphrase', 100_000)
    await expect(open(sealed, 'wrong passphrase')).rejects.toThrow('wrong passphrase')
  })
  test('short passphrases are refused', async () => {
    await expect(seal({ note: 'x', files: [] }, 'short')).rejects.toThrow()
  })
  test('the server accepts only the sealed shape, within the size limit', async () => {
    const sealed = await seal({ note: 'x', files: [] }, 'right passphrase', 100_000)
    expect(checkSealed({ ...sealed, extra: 'dropped' }, 64_000).sealed).toEqual(sealed)
    expect(() => checkSealed({ note: 'plaintext' }, 64_000)).toThrow('not a sealed bundle')
    expect(() => checkSealed({ ...sealed, iter: 10 }, 64_000)).toThrow()
    expect(() => checkSealed(sealed, 10)).toThrow('your plan holds')
  })
})
