// dsh-input-history - static client half (browser behavior plugin).
//
// Claude Code-style input history for the DSH web composer:
//   ArrowUp   - recall the most recent sent message (empty draft only),
//               then walk older entries; non-empty drafts keep caret motion.
//   ArrowDown - walk back newer; past the newest restores the pre-browse draft.
//   Escape    - exit browse and restore the pre-browse draft.
//
// How it hooks (v0.1.5-rc.1): the composer is a Lexical editor
// (ui-conversation/input/). Its keymap registers KEY_ARROW_UP/DOWN_COMMAND at
// COMMAND_PRIORITY_CRITICAL; with no menu open those handlers answer "pass",
// do NOT preventDefault, and let the browser move the caret. That pass is
// our seam: this plugin listens on document (bubble phase - after Lexical's
// root listener) and only acts when e.defaultPrevented is still false, so
// slash-command / popup menu navigation is never disturbed. IME safety
// mirrors the keymap guard (isComposing, keyCode 229, Safari's late keydown
// after compositionend via a 10ms hold) - during IME composition the arrow
// keys belong to candidate selection and are never intercepted.
//
// History capture: every Enter (non-shift, non-IME) on the composer and any
// pointerdown on a button while the composer has text arms a "pending"
// record; the composer being the resident div of InputBar, a MutationObserver
// (plus a timer fallback) confirms the send when the composer goes empty.
// Entries dedupe consecutive repeats and live in localStorage
// (dsh-input-history:v1, newest last, capped).
//
// Text write-back goes through DSH's own paste pipeline (a synthesized
// ClipboardEvent consumed by the keymap PASTE handler -> pasteText
// sanitization), with selectAll + execCommand('insertText'/'delete') as the
// fallback. No slots, no React, no host route: the model never sees this.
//
// Inside the module factory, `require` resolves only platform specifiers;
// this file requires nothing.

// Per-conversation history: each session's messages live under their own key
// (v0.3.0 - the old global v1 list leaked other conversations' messages into
// recall). The conversation title is the key; djb2 hash keeps it collision-
// safe, the readable prefix keeps localStorage inspectable.
const STORAGE_PREFIX = 'dsh-input-history:v2:'
function sessionKey() {
  const t = (typeof document !== 'undefined' && document.title) || 'untitled'
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0
  return STORAGE_PREFIX + (h >>> 0).toString(36) + '-' + encodeURIComponent(t).slice(0, 60)
}
const MAX_ENTRIES = 100
const PENDING_CONFIRM_MS = 600
const COMPOSER_SELECTOR = '[data-composer-input]'
const ATTACH_RETRY_MS = 1000
const ATTACH_RETRY_MAX = 60
const COMPOSING_HOLD_MS = 10 // Safari delivers a closing keydown after compositionend

// ---------------------------------------------------------------- storage --

function loadHistory() {
  try {
    const raw = localStorage.getItem(sessionKey())
    const list = raw ? JSON.parse(raw) : []
    if (!Array.isArray(list)) return []
    return list.filter(function (e) { return e && typeof e.t === 'string' && e.t.length > 0 })
      .slice(-MAX_ENTRIES)
      .map(function (e) { return { t: e.t, ts: typeof e.ts === 'number' ? e.ts : 0 } })
  } catch (_err) { return [] }
}

function saveHistory(list) {
  try { localStorage.setItem(sessionKey(), JSON.stringify(list.slice(-MAX_ENTRIES))) } catch (err) { console.warn('[dsh-input-history] save failed:', err) }
}

// ------------------------------------------------------------- composer io --

function composerText(el) {
  // innerText keeps authored newlines for contenteditable; trailing blank
  // lines from the Lexical trailing paragraph are noise.
  return ((el && el.innerText) || '').replace(/[\s\u00a0]+$/, '')
}

function isImeEvent(e) {
  // keyCode 229 is the legacy IME-composition signal engines emit without
  // isComposing (same duck-type as the DSH keymap guard).
  return e.isComposing || e.keyCode === 229
}

function selectAllIn(el) {
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  sel.removeAllRanges()
  sel.addRange(range)
}

// Replace the whole draft with `text` ('' empties it). Both channels are
// Asynchronous by one tick: the DOM select-all must be re-published as
// selectionchange before Lexical syncs its internal selection, otherwise the
// paste lands at the old caret (appending) instead of over the selection.
// Rapid calls coalesce: the last write wins.
let writeTimer = null
let writeText = null
let writeEl = null

function setComposerText(el, text) {
  el.focus()
  selectAllIn(el)
  writeText = text
  writeEl = el
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(function () {
    writeTimer = null
    const target = writeEl
    const payload = writeText
    writeText = null
    writeEl = null
    if (!target) return
    if (payload === '') {
      // A synthesized Backspace over the select-all empties the draft through
      // Lexical's own delete pipeline (keymap has no Backspace claim).
      try {
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace', code: 'Backspace', bubbles: true, cancelable: true,
        }))
        return
      } catch (_err) { /* fall through */ }
      selectAllIn(target)
      document.execCommand('delete')
      return
    }
    // Primary channel: a synthesized paste, consumed by the composer keymap's
    // PASTE_COMMAND handler -> paste(text) = "insert over the current editor
    // selection" (facade.ts). Files are absent so the text branch takes it.
    try {
      const dt = new DataTransfer()
      dt.setData('text/plain', payload)
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      target.dispatchEvent(ev)
      return
    } catch (_err) { /* ClipboardEvent/DataTransfer unavailable: fall through */ }
    // Fallback: select-all + insertText rides Lexical's plain-text beforeinput.
    selectAllIn(target)
    document.execCommand('insertText', false, payload)
  }, 50)
}

// ------------------------------------------------------------------ state --

let hist = []
let browsing = false
let idx = -1            // hist index currently shown while browsing
let draftBackup = null  // composer text when browsing started (null = not browsing)
let pending = null      // { text, el, timer } awaiting composer-empty confirmation
let composing = false
let composingUntil = 0
let attachedEl = null
const observers = []
let attachRetries = 0
let disposed = false

function recentlyComposing() {
  return composing || Date.now() < composingUntil
}

function exitBrowse(el, restore) {
  const back = draftBackup
  browsing = false
  idx = -1
  draftBackup = null
  if (restore && el && back !== null) setComposerText(el, back)
}


function commit(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  const last = hist[hist.length - 1]
  const ts = Date.now()
  if (last && last.t === trimmed) {
    last.ts = ts // consecutive repeat: refresh timestamp only
  } else {
    hist.push({ t: trimmed, ts: ts })
    if (hist.length > MAX_ENTRIES) hist = hist.slice(-MAX_ENTRIES)
  }
  saveHistory(hist)
  browsing = false
  idx = -1
  draftBackup = null
}

function settlePending() {
  if (!pending) return
  const p = pending
  pending = null
  if (p.timer) clearTimeout(p.timer)
  if (p.el && composerText(p.el) === '') commit(p.text) // cleared = really submitted
}

function armPending(el, text) {
  if (pending && pending.timer) clearTimeout(pending.timer)
  pending = {
    text: text,
    el: el,
    timer: setTimeout(function () { settlePending() }, PENDING_CONFIRM_MS),
  }
}

// ------------------------------------------------------------- composer io --

function attachObserver(el) {
  if (attachedEl === el) return true
  while (observers.length) { try { observers.pop().disconnect() } catch (_e) { } }
  if (!el) return false
  try {
    const mo = new MutationObserver(function () { if (pending) settlePending() })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    observers.push(mo)
    attachedEl = el
    return true
  } catch (_err) { return false }
}

function ensureAttached() {
  if (attachedEl && document.contains(attachedEl)) return true
  attachedEl = null
  const el = document.querySelector(COMPOSER_SELECTOR)
  return attachObserver(el)
}

// ------------------------------------------------------------------ apply --

function apply(ctx) {
  if (typeof document === 'undefined') return
  hist = loadHistory()

  ctx.effect(function () {
    // ------- composition watch (document-level; composition events bubble) --
    const onCompStart = function () { composing = true }
    const onCompEnd = function () {
      composing = false
      composingUntil = Date.now() + COMPOSING_HOLD_MS
    }

    // ------------------------------------------------------------- keydown --
    // Enter capture runs on the CAPTURE phase - the earliest point of the
    // event, BEFORE Lexical's root listener synchronously submits and clears
    // the composer. By the time a bubble-phase listener runs, the draft is
    // already gone (measured: composerText === '' there).
    const onKeydownCapture = function (e) {
      if (disposed) return
      if (e.key !== 'Enter') return
      if (isImeEvent(e) || recentlyComposing()) return
      const el = e.target && e.target.closest ? e.target.closest(COMPOSER_SELECTOR) : null
      if (!el) return
      if (e.shiftKey) return
      const text = composerText(el)
      if (text.length > 0) armPending(el, text)
    }

    const onKeydown = function (e) {
      if (disposed) return
      const key = e.key
      if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Escape') return
      if (isImeEvent(e) || recentlyComposing()) return
      const el = e.target && e.target.closest ? e.target.closest(COMPOSER_SELECTOR) : null
      if (!el) return

      if (key === 'Escape') {
        if (browsing && !e.defaultPrevented) {
          exitBrowse(el, true)
          e.preventDefault()
        }
        return
      }

      // Arrows: only the keymap's "pass" reaches us (menu navigation already
      // preventDefault'ed). Modifier chords stay with the browser/app.
      if (e.defaultPrevented) return
      if (e.altKey || e.ctrlKey || e.metaKey) return
      ensureAttached()

      if (key === 'ArrowUp') {
        if (!browsing) {
          if (composerText(el).length > 0) return // caret motion, not history
          if (hist.length === 0) return
          browsing = true
          draftBackup = ''
          idx = hist.length - 1
          setComposerText(el, hist[idx].t)
          e.preventDefault()
        } else if (idx > 0) {
          idx -= 1
          setComposerText(el, hist[idx].t)
          e.preventDefault()
        } else {
          e.preventDefault() // at the oldest entry: stay
        }
      } else { // ArrowDown
        if (!browsing) return
        if (idx < hist.length - 1) {
          idx += 1
          setComposerText(el, hist[idx].t)
        } else {
          exitBrowse(el, true) // past the newest: restore the draft
        }
        e.preventDefault()
      }
    }

    // ---------------------------------- send-button fallback (pointerdown) --
    // The primary send button keeps focus on the composer (keepFocus) and
    // submits without any keydown. Any button press while the composer has
    // text arms the same pending confirm; a button that does not clear the
    // composer simply fails confirmation and drops.
    const onPointerdown = function (e) {
      if (disposed || pending) return
      if (!e.target || !e.target.closest || !e.target.closest('button')) return
      const el = document.querySelector(COMPOSER_SELECTOR)
      if (!el) return
      const text = composerText(el)
      if (text.length > 0) armPending(el, text)
    }

    // ------------------------------------------------ session switch guard --
    // Switching conversations swaps the draft under the resident composer but
    // a browse in progress would keep its cursor (idx) - ArrowUp then looks
    // dead ("at the oldest entry, stay"). Exit the browse on session switch:
    // the per-conversation title is the switch signal.
    let lastTitle = document.title
    const titleEl = document.querySelector('title')
    let titleObserver = null
    try {
      titleObserver = new MutationObserver(function () {
        if (disposed) return
        if (document.title !== lastTitle) {
          lastTitle = document.title
          if (browsing) { browsing = false; idx = -1; draftBackup = null }
          if (pending) { if (pending.timer) clearTimeout(pending.timer); pending = null }
          hist = loadHistory() // per-conversation history list
        }
      })
      titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true })
    } catch (_err) { /* title element absent: browse-state persistence is the old behavior */ }

    // --------------------------------------------------- composer attach ----
    // The composer is a resident div (session switches do not swap the tree),
    // but it may not exist yet at plugin activation: retry until it shows up.
    attachRetries = 0
    const retryTimer = setInterval(function () {
      if (disposed || ensureAttached() || ++attachRetries > ATTACH_RETRY_MAX) clearInterval(retryTimer)
    }, ATTACH_RETRY_MS)
    ensureAttached()

    document.addEventListener('compositionstart', onCompStart, true)
    document.addEventListener('compositionend', onCompEnd, true)
    document.addEventListener('keydown', onKeydownCapture, true)
    document.addEventListener('keydown', onKeydown, false)
    document.addEventListener('pointerdown', onPointerdown, true)

    return function () {
      disposed = true
      clearInterval(retryTimer)
      document.removeEventListener('compositionstart', onCompStart, true)
      document.removeEventListener('compositionend', onCompEnd, true)
      document.removeEventListener('keydown', onKeydownCapture, true)
      document.removeEventListener('keydown', onKeydown, false)
      document.removeEventListener('pointerdown', onPointerdown, true)
      while (observers.length) { try { observers.pop().disconnect() } catch (_e) { } }
      if (titleObserver) { try { titleObserver.disconnect() } catch (_e) { } }
      attachedEl = null
      if (pending && pending.timer) clearTimeout(pending.timer)
      pending = null
    }
  }, 'dsh-input-history: listeners')
}

module.exports = { inject: [], apply }