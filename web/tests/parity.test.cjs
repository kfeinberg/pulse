const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(name, extra = {}, imports = {}) {
  const filename = path.join(__dirname, '../src', name);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports, URL, console, Date, Set,
    require: (id) => {
      if (id in imports) return imports[id];
      throw new Error(`Unexpected runtime import: ${id}`);
    },
    ...extra,
  }, { filename });
  return exports;
}
const utils = load('utils.ts');
for (const [name, serialized, fallback, expected] of [
  ['normal links', '["https://example.com/event","http://example.org/"]', '', ['https://example.com/event', 'http://example.org/']],
  ['deduplication', '["https://example.com/","https://example.com/"]', '', ['https://example.com/']],
  ['object query', '{}', 'https://example.com/', ['https://example.com/']],
  ['null query', 'null', '', []],
  ['number query', '42', '', []],
  ['string query', '"not-an-array"', '', []],
  ['malformed query', '[bad', 'https://example.com/', ['https://example.com/']],
  ['unsafe protocols', '["javascript:alert(1)","data:text/html,bad","file:///tmp/example"]', '', []],
  ['mixed types', '[null,2,{},"https://example.com/"]', '', ['https://example.com/']],
  ['unsafe fallback', '', 'javascript:alert(1)', []],
]) {
  test(`source URLs: ${name}`, () => {
    assert.deepEqual(Array.from(utils.getSourceUrls(serialized, fallback)), expected);
  });
}
test('distance is zero for identical coordinates', () => assert.equal(utils.getDistance(40.7, -74, 40.7, -74), 0));
test('distance is symmetric and measured in miles', () => {
  const miles = utils.getDistance(40.7128, -74.006, 40.758, -73.9855);
  assert.ok(miles > 3 && miles < 4);
  assert.equal(miles, utils.getDistance(40.758, -73.9855, 40.7128, -74.006));
});
test('category list preserves every configured category', () => {
  const { CATEGORIES, CATEGORY_LIST } = load('categories.ts');
  assert.deepEqual(Array.from(CATEGORY_LIST), Object.keys(CATEGORIES));
});
test('router back uses fallback for a direct URL', () => {
  const calls = [];
  const router = load('router.ts', {
    window: { history: { pushState: (_, __, url) => calls.push(url), back: () => calls.push('back') }, dispatchEvent: () => {} },
    PopStateEvent: class {},
  });
  router.goBack();
  assert.deepEqual(calls, ['/']);
});
test('router back uses browser history after app navigation', () => {
  const calls = [];
  const router = load('router.ts', {
    window: { history: { pushState: (_, __, url) => calls.push(url), back: () => calls.push('back') }, dispatchEvent: () => {} },
    PopStateEvent: class {},
  });
  router.navigate('/sign-in');
  router.goBack();
  assert.deepEqual(calls, ['/sign-in', 'back']);
});

function authHarness(getProfile) {
  const state = [];
  let callback, cleanup;
  const react = {
    createContext: () => ({ Provider: 'provider' }),
    useContext: () => {},
    useState: (initial) => {
      const index = state.length;
      state.push(initial);
      return [initial, (value) => { state[index] = value; }];
    },
    useEffect: (effect) => { cleanup = effect(); },
  };
  const { AuthProvider } = load('contexts/AuthContext.tsx', { console: { warn() {} } }, {
    react,
    'react/jsx-runtime': { jsx: () => null },
    '../firebase': { onAuthChange: (cb) => { callback = cb; return () => {}; }, getUserProfile: getProfile },
  });
  AuthProvider({ children: null });
  return { state, change: (user) => callback(user), cleanup: () => cleanup() };
}
test('auth resets profile requirement when switching to an existing user', async () => {
  const auth = authHarness(async (uid) => uid === 'new' ? null : { displayName: 'Existing' });
  await auth.change({ uid: 'new' });
  assert.equal(auth.state[3], true);
  await auth.change({ uid: 'existing' });
  assert.equal(auth.state[1], 'Existing');
  assert.equal(auth.state[3], false);
  assert.equal(auth.state[2], false);
});
test('auth ignores an old profile response after sign-out', async () => {
  let resolve;
  const auth = authHarness(() => new Promise((done) => { resolve = done; }));
  const pending = auth.change({ uid: 'old' });
  await auth.change(null);
  resolve({ displayName: 'Old' });
  await pending;
  assert.equal(auth.state[0], null);
  assert.equal(auth.state[1], null);
  assert.equal(auth.state[3], false);
  assert.equal(auth.state[2], false);
});
test('auth profile failure releases loading without inventing a missing profile', async () => {
  const auth = authHarness(async () => { throw new Error('offline'); });
  await auth.change({ uid: 'user' });
  assert.equal(auth.state[1], null);
  assert.equal(auth.state[2], false);
  assert.equal(auth.state[3], false);
});
test('auth does not publish a profile response after unmount', async () => {
  let resolve;
  const auth = authHarness(() => new Promise((done) => { resolve = done; }));
  const pending = auth.change({ uid: 'user' });
  auth.cleanup();
  resolve({ displayName: 'Late' });
  await pending;
  assert.equal(auth.state[1], null);
});
