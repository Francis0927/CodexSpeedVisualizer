const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { installerPayloadHash } = require('../scripts/verify-release.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('NSIS identity permits exactly the known Tauri UNK to NSS marker transformation', () => {
  const source = Buffer.from('code-prefix__TAURI_BUNDLE_TYPE_VAR_UNKcode-suffix');
  const installed = Buffer.from('code-prefix__TAURI_BUNDLE_TYPE_VAR_NSScode-suffix');
  assert.equal(installerPayloadHash(source), hash(installed));
  const changed = Buffer.from(installed); changed[0] ^= 1;
  assert.notEqual(installerPayloadHash(source), hash(changed), 'other bytes remain protected');
  assert.equal(source.toString(), 'code-prefix__TAURI_BUNDLE_TYPE_VAR_UNKcode-suffix', 'verification cannot modify source bytes');
});
test('missing or duplicated bundle markers cannot bypass installer payload verification', () => {
  assert.throws(() => installerPayloadHash(Buffer.from('unknown executable')));
  assert.throws(() => installerPayloadHash(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK__TAURI_BUNDLE_TYPE_VAR_UNK')));
});
