// deadman.switch in the browser: seal and open bundles (the plaintext never
// leaves this page), and turn on push reminders. Same format as src/seal.ts.
(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const ITER = 600000
  const b64 = (bytes) => {
    let s = ''
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(s)
  }
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

  async function keyFor(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  }
  async function seal(bundle, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await keyFor(pass, salt, ITER)
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(bundle))))
    return { v: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) }
  }
  async function open(sealed, pass) {
    const key = await keyFor(pass, unb64(sealed.salt), sealed.iter)
    try {
      return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct))))
    } catch {
      throw new Error('That passphrase does not open it.')
    }
  }
  const sealedJson = () => {
    const el = $('sealed-json')
    return el ? JSON.parse(el.textContent || 'null') : null
  }
  const readFile = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve({ name: file.name, type: file.type || 'application/octet-stream', data: String(r.result).split(',')[1] || '' })
      r.onerror = () => reject(r.error)
      r.readAsDataURL(file)
    })
  const fileLink = (f) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([unb64(f.data)], { type: f.type }))
    a.download = f.name
    a.textContent = `${f.name} (${Math.ceil((f.data.length * 3) / 4 / 1024)} KB)`
    return a
  }

  // ---- the owner's editor --------------------------------------------------------
  const sealer = $('sealer')
  if (sealer) {
    sealer.hidden = false
    const status = $('seal-status')
    const say = (text, bad) => { status.textContent = text; status.className = `small ${bad ? 'bad' : 'ok'}` }
    let kept = [] // files already inside the bundle we unlocked
    const list = $('file-list')
    const drawFiles = () => {
      list.replaceChildren(...kept.map((f, i) => {
        const li = document.createElement('li')
        li.append(fileLink(f), ' ')
        const rm = document.createElement('button')
        rm.type = 'button'; rm.className = 'linkish bad'; rm.textContent = 'remove'
        rm.onclick = () => { kept.splice(i, 1); drawFiles() }
        li.append(rm)
        return li
      }))
    }
    const showEditor = () => { $('unlock').hidden = true; $('editor').hidden = false }
    $('unlock-btn')?.addEventListener('click', async () => {
      say('Unlocking…')
      try {
        const b = await open(sealedJson(), $('unlock-pass').value)
        $('note').value = b.note || ''
        kept = b.files || []
        drawFiles()
        $('pass1').value = $('pass2').value = $('unlock-pass').value
        showEditor()
        say('Unlocked, on this device only.')
      } catch (e) { say(e.message, true) }
    })
    $('start-over')?.addEventListener('click', () => { kept = []; drawFiles(); showEditor(); say('Writing a new bundle. Saving it replaces the old one.') })
    $('seal-btn').addEventListener('click', async () => {
      const p1 = $('pass1').value, p2 = $('pass2').value
      if (p1.length < 8) return say('Use a passphrase of at least 8 characters.', true)
      if (p1 !== p2) return say('The two passphrases are different.', true)
      if (!$('note').value.trim() && !kept.length && !$('files').files.length) return say('Write something first.', true)
      say('Sealing…')
      try {
        const added = await Promise.all([...$('files').files].map(readFile))
        const sealed = await seal({ note: $('note').value, files: kept.concat(added) }, p1)
        const size = JSON.stringify(sealed).length
        if (size > Number(sealer.dataset.max)) return say(`Sealed it is ${Math.ceil(size / 1024)} KB; your plan holds ${Math.floor(Number(sealer.dataset.max) / 1024)} KB.`, true)
        const res = await fetch(`/s/${sealer.dataset.switch}/bundle`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': sealer.dataset.csrf }, body: JSON.stringify({ bundle: sealed, hint: $('hint').value }) })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) return say(body.error || `Not saved (${res.status}).`, true)
        say('Sealed and saved.')
        setTimeout(() => location.assign(`/s/${sealer.dataset.switch}?flash=${encodeURIComponent('Sealed and saved. Remember to give the passphrase to the people who should open it.')}#people`), 600)
      } catch (e) { say(e.message || String(e), true) }
    })
  }

  // ---- what an heir sees -----------------------------------------------------------
  const opener = $('opener')
  if (opener) {
    opener.hidden = false
    const status = $('open-status')
    const go = async () => {
      status.textContent = 'Opening…'
      try {
        const b = await open(sealedJson(), $('open-pass').value)
        $('opened-note').textContent = b.note || ''
        $('opened-files').replaceChildren(...(b.files || []).map((f) => { const li = document.createElement('li'); li.append(fileLink(f)); return li }))
        opener.hidden = true
        $('opened').hidden = false
      } catch (e) { status.textContent = e.message; status.className = 'small bad' }
    }
    $('open-btn').addEventListener('click', go)
    $('open-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go() })
  }

  // ---- push reminders --------------------------------------------------------------
  const pushBtn = $('push-on')
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})
  if (pushBtn) {
    const status = $('push-status')
    if (!('PushManager' in window)) { pushBtn.disabled = true; status.textContent = 'This browser cannot do push. On iPhone, add this site to your home screen first.' }
    const csrf = document.querySelector('input[name=csrf]')?.value || ''
    pushBtn.addEventListener('click', async () => {
      try {
        if ((await Notification.requestPermission()) !== 'granted') { status.textContent = 'Notifications are blocked for this site.'; return }
        const reg = await navigator.serviceWorker.ready
        const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64(pushBtn.dataset.vapid.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (pushBtn.dataset.vapid.length % 4)) % 4)) }))
        const res = await fetch('/push', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf': csrf }, body: JSON.stringify(sub) })
        status.textContent = res.ok ? 'On. Reminders will show up on this device.' : 'Could not save it; reload and try again.'
      } catch (e) { status.textContent = e.message || String(e) }
    })
  }
})()
