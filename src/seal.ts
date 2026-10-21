/**
 * Sealing: how a bundle is locked before it leaves the owner's machine.
 *
 * A passphrase the owner gives their heir (out of band: in a will, on paper,
 * in person) is stretched with PBKDF2-SHA256 into an AES-256-GCM key. The
 * server stores only the result, so it can hand the box over but never open
 * it, and the heir has the key but not the box until the switch fires.
 *
 * public/app.js does the same thing in the browser with the same format, so a
 * bundle sealed on the web opens in the CLI and the other way round. Keep the
 * two in step.
 */
export type Sealed = { v: 1; alg: 'AES-256-GCM'; kdf: 'PBKDF2-SHA256'; iter: number; salt: string; iv: string; ct: string }
export type BundleFile = { name: string; type: string; data: string }
export type Bundle = { note: string; files: BundleFile[] }

export const ITERATIONS = 600_000

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const unb64 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, 'base64'))

async function keyFor(passphrase: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function seal(bundle: Bundle, passphrase: string, iter = ITERATIONS): Promise<Sealed> {
  if (passphrase.length < 8) throw new Error('use a passphrase of at least 8 characters')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await keyFor(passphrase, salt, iter)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(bundle))))
  return { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter, salt: b64(salt), iv: b64(iv), ct: b64(ct) }
}

export async function open(sealed: Sealed, passphrase: string): Promise<Bundle> {
  const key = await keyFor(passphrase, unb64(sealed.salt), sealed.iter)
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct))
  } catch {
    throw new Error('wrong passphrase')
  }
  return JSON.parse(new TextDecoder().decode(plain)) as Bundle
}

/** A sealed bundle as the server accepts it: the right shape and nothing else. Returns its size in bytes. */
export function checkSealed(value: unknown, maxBytes: number): { sealed: Sealed; bytes: number } {
  const s = value as Sealed
  const ok =
    s && typeof s === 'object' && s.v === 1 && s.alg === 'AES-256-GCM' && s.kdf === 'PBKDF2-SHA256' &&
    Number.isInteger(s.iter) && s.iter >= 100_000 && s.iter <= 10_000_000 &&
    [s.salt, s.iv, s.ct].every((x) => typeof x === 'string' && /^[A-Za-z0-9+/]+=*$/.test(x))
  if (!ok) throw new Error('that is not a sealed bundle')
  const clean: Sealed = { v: 1, alg: s.alg, kdf: s.kdf, iter: s.iter, salt: s.salt, iv: s.iv, ct: s.ct }
  const bytes = JSON.stringify(clean).length
  if (bytes > maxBytes) throw new Error(`the sealed bundle is ${Math.ceil(bytes / 1024)} KB; your plan holds ${Math.floor(maxBytes / 1024)} KB`)
  return { sealed: clean, bytes }
}
