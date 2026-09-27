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
// per-session key (dsh-input-history:v3:<session id>, newest last, capped).
//
// Text write-back goes through DSH's own paste pipeline (a synthesized
// ClipboardEvent consumed by the keymap PASTE handler -> pasteText
// sanitization), with selectAll + execCommand('insertText'/'delete') as the
// fallback. No slots, no React, no host route: the model never sees this.
//
// Inside the module factory, `require` resolves only platform specifiers;
// this file requires nothing.

// Per-conversation history: the bucket key is the host session id, read from
// the conversation root's data-conversation-session attribute - the same id
// DSH's own gesture code resolves via closest() (v0.4.0). This replaces the
// title-keyed v2 scheme, which split one conversation across buckets on every
// title change (DSH auto-retitles after the first prompt), shared one bucket
// for the no-session state, and mis-bucketed a message sent right after a
// session switch (document.title lags the switch). The id is stable across
// renames and unique per conversation. Legacy v1/v2 keys are purged on
// activation, without migration by design (the old buckets are cross-
// contaminated; the messages themselves live in the conversations).
const STORAGE_PREFIX = 'dsh-input-history:v3:'
const SESSION_ATTR = 'data-conversation-session'

function sessionOf(el) {
  const root = (el && el.closest && el.closest('[' + SESSION_ATTR + ']')) ||
    (typeof document !== 'undefined' ? document.querySelector('[' + SESSION_ATTR + ']') : null)
  const id = root && typeof root.getAttribute === 'function' ? root.getAttribute(SESSION_ATTR) : null
  return typeof id === 'string' && id ? id : null
}

function purgeLegacyKeys() {
  try {
    const dead = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k.lastIndexOf('dsh-input-history:v1', 0) === 0 || k.lastIndexOf('dsh-input-history:v2:', 0) === 0)) dead.push(k)
    }
    for (let i = 0; i < dead.length; i++) localStorage.removeItem(dead[i])
    if (dead.length > 0) console.info('[dsh-input-history] purged', dead.length, 'legacy v1/v2 key(s); not migrated by design')
  } catch (_err) { /* storage unavailable: nothing to purge */ }
}
const MAX_ENTRIES = 100
const PENDING_CONFIRM_MS = 600
const COMPOSER_SELECTOR = '[data-composer-input]'
const ATTACH_RETRY_MS = 1000
const ATTACH_RETRY_MAX = 60
const COMPOSING_HOLD_MS = 10 // Safari delivers a closing keydown after compositionend

// ---------------------------------------------------------------- storage --

function loadHistory(id) {
  if (!id) return []
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + id)
    const list = raw ? JSON.parse(raw) : []
    if (!Array.isArray(list)) return []
    return list.filter(function (e) { return e && typeof e.t === 'string' && e.t.length > 0 })
      .slice(-MAX_ENTRIES)
      .map(function (e) { return { t: e.t, ts: typeof e.ts === 'number' ? e.ts : 0 } })
  } catch (_err) { return [] }
}

function saveHistory(list, id) {
  if (!id) return
  try { localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(list.slice(-MAX_ENTRIES))) } catch (err) { console.warn('[dsh-input-history] save failed:', err) }
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

let sessionId = null // bucket owner: last session id seen
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


function commit(text, id) {
  const trimmed = text.trim()
  if (trimmed.length === 0 || !id) return
  if (id !== sessionId) { sessionId = id; hist = loadHistory(id) }
  const last = hist[hist.length - 1]
  const ts = Date.now()
  if (last && last.t === trimmed) {
    last.ts = ts // consecutive repeat: refresh timestamp only
  } else {
    hist.push({ t: trimmed, ts: ts })
    if (hist.length > MAX_ENTRIES) hist = hist.slice(-MAX_ENTRIES)
  }
  saveHistory(hist, id)
  browsing = false
  idx = -1
  draftBackup = null
}

function settlePending() {
  if (!pending) return
  const p = pending
  pending = null
  if (p.timer) clearTimeout(p.timer)
  if (!p.el || composerText(p.el) !== '') return // not cleared = not submitted
  const id = sessionOf(p.el)
  // Re-resolve the bucket at confirm time: the first message of a brand-new
  // conversation commits into the session its send just created
  // (p.session === null), while a session switched mid-flight drops the
  // record instead of writing into the wrong conversation.
  if (id && (id === p.session || p.session === null)) commit(p.text, id)
}

function armPending(el, text) {
  if (pending && pending.timer) clearTimeout(pending.timer)
  pending = {
    text: text,
    el: el,
    session: sessionOf(el),
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
  purgeLegacyKeys()

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

      // Session sync before any recall: the composer is a resident div and
      // conversation switches swap its content under the same element. The
      // id change IS the switch signal - exit browse and swap the history
      // list so recall never serves a foreign conversation (v0.4.0; replaces
      // the v0.3.0 document.title observer). Without a session id (no
      // conversation root) there is nothing to recall from.
      const sid = sessionOf(el)
      if (!sid) return
      if (sid !== sessionId) {
        sessionId = sid
        browsing = false
        idx = -1
        draftBackup = null
        hist = loadHistory(sid)
      }

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
      attachedEl = null
      if (pending && pending.timer) clearTimeout(pending.timer)
      pending = null
    }
  }, 'dsh-input-history: listeners')
}

module.exports = { inject: [], apply }