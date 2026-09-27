// dsh-input-history smoke test - DOM-stubbed sandbox over src/client.js.
// Run: node test/smoke.cjs  (exit code 1 on any failure)
const fs = require('fs'), vm = require('vm');
const SRC = require('path').join(__dirname, '..', 'src', 'client.js');
const src = fs.readFileSync(SRC, 'utf8');
const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
  get length() { return store.size; },
  key(i) { return Array.from(store.keys())[i] || null; },
};
const observers = [];
class MutationObserver { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} }
function fireMutations() { sandbox.__fireMO(); }
function makeRoot(id) { return { __session: true, getAttribute: a => (a === 'data-conversation-session' ? id : null) }; }
function makeComposer() {
  return {
    __composer: true, __parent: null, _text: '', _lastWrite: undefined,
    closest(sel) { let n = this; while (n) { if (sel === '[data-composer-input]' && n.__composer) return n; if (sel === '[data-conversation-session]' && n.__session) return n; n = n.__parent; } return null; },
    focus() {},
    get innerText() { return this._text; },
    set innerText(v) { this._text = v; },
    dispatchEvent(ev) { if (ev && ev.__payload !== undefined) this._lastWrite = ev.__payload; return true; },
  };
}
let composer = makeComposer();
let sessionRoot = null;
const listeners = {};
const doc = {
  addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener() {},
  contains: () => true,
  querySelector(sel) { if (sel === '[data-composer-input]') return composer; if (String(sel).indexOf('data-conversation-session') >= 0) return sessionRoot; return null; },
  createRange: () => ({ selectNodeContents() {} }),
  execCommand: () => true,
};
const sandbox = {
  document: doc,
  window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
  localStorage, MutationObserver,
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  DataTransfer: class { setData(t, v) { this.__v = v; } },
  ClipboardEvent: class { constructor(t, init) { this.clipboardData = init && init.clipboardData; this.__payload = init && init.clipboardData ? init.clipboardData.__v : undefined; } },
  KeyboardEvent: class {},
};
vm.createContext(sandbox);
vm.runInContext('var module = { exports: {} }; var exports = module.exports;\n' + src + '\nmodule.exports = { inject: [], apply };\nglobalThis.__dbg = function () { return { pending: !!pending, armSession: pending && pending.session, session: sessionId, histLen: hist.length, browsing: browsing, obsLen: observers.length, attached: !!attachedEl }; };\nglobalThis.__fireMO = function () { for (const o of observers) o.cb(); };', sandbox, { filename: 'client.js' });
const dbg = tag => console.error('DBG[' + tag + ']', 'store=' + JSON.stringify(Array.from(store.keys())), 'vm=' + JSON.stringify(sandbox.__dbg()));
const results = [];
function fire(type, ev) { for (const f of listeners[type] || []) f(ev); return ev; }
function keyEV(key) { return { key, target: composer, isComposing: false, keyCode: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; }
function sent(id) { const r = store.get('dsh-input-history:v3:' + id); return r ? JSON.parse(r) : null; }
function check(name, cond) { results.push((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) process.exitCode = 1; }

// T1 purge - keys must be set BEFORE apply... apply already ran, so emulate:
store.set('dsh-input-history:v2:aaa', '[]');
sandbox.module.exports.apply({ effect(fn) { return fn(); } });
check('T1 purge removes v2 keys on re-apply', !store.has('dsh-input-history:v2:aaa'));
dbg('T1');

// T2 first message
composer._text = 'first msg';
fire('keydown', keyEV('Enter'));
dbg('T2 armed');
sessionRoot = makeRoot('session-1'); composer.__parent = sessionRoot; composer._text = '';
fireMutations();
dbg('T2 settled');
const h1 = sent('session-1');
check('T2 first msg lands in v3:session-1', !!h1 && h1.length === 1 && h1[0].t === 'first msg');
dbg('T2 checked');

// T3 recall
const ev3 = fire('keydown', keyEV('ArrowUp'));
dbg('T3 arrowup');
setTimeout(() => {
  check('T3 ArrowUp prevented', ev3.defaultPrevented === true);
  check('T3 recall wrote history text', composer._lastWrite === 'first msg');
  dbg('T3 written');

  // T4 dedupe
  composer._text = 'first msg'; fire('keydown', keyEV('Enter')); composer._text = ''; fireMutations();
  dbg('T4 deduped');
  check('T4 dedupe keeps 1 entry', (sent('session-1') || []).length === 1);

  // T5 isolation
  sessionRoot = makeRoot('session-2'); composer.__parent = sessionRoot; composer._text = ''; composer._lastWrite = undefined;
  const ev5 = fire('keydown', keyEV('ArrowUp'));
  dbg('T5 foreign');
  check('T5 foreign session: no recall', !ev5.defaultPrevented && composer._lastWrite === undefined);

  // T6 pending drop on mid-flight switch
  composer._text = 'msg B'; fire('keydown', keyEV('Enter'));
  sessionRoot = makeRoot('session-3'); composer.__parent = sessionRoot; composer._text = '';
  fireMutations();
  dbg('T6 dropped?');
  check('T6 mid-flight switch drops record', !sent('session-2') && !sent('session-3'));

  // T7 cap
  for (let i = 0; i < 110; i++) { composer._text = 'm' + i; fire('keydown', keyEV('Enter')); composer._text = ''; fireMutations(); }
  dbg('T7 capped');
  const h3 = sent('session-3');
  check('T7 cap 100 + newest last', !!h3 && h3.length === 100 && h3[99].t === 'm109');

  // T8 escape
  composer._text = ''; fire('keydown', keyEV('ArrowUp'));
  const ev8 = fire('keydown', keyEV('Escape'));
  check('T8 Escape handled', ev8.defaultPrevented === true);

  // T9 no session
  sessionRoot = null; composer.__parent = null; composer._text = ''; composer._lastWrite = 'SENTINEL';
  const ev9 = fire('keydown', keyEV('ArrowUp'));
  dbg('T9 nosession');
  check('T9 no session: no recall', !ev9.defaultPrevented && composer._lastWrite === 'SENTINEL');

  fs.writeFileSync('/tmp/smoke_result.json', JSON.stringify({ results, fail: results.filter(r => r.slice(5).startsWith('FAIL')).length }, null, 2));
  console.log(results.join('\n'));
  console.log(results.every(function (r) { return r.slice(5).indexOf('FAIL') !== 0; }) ? 'ALL ' + results.length + ' CHECKS PASSED' : 'SOME CHECKS FAILED');
  console.log('SMOKE DONE');
}, 120);
