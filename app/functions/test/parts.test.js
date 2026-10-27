import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectParts, parsePartsSetting, effectiveParts, validHealthPath } from '../lib/parts.js';

test('herbpulse-like: web + api', () => {
  const r = detectParts(['web', 'web/package.json', 'functions/index.js'], '{"hosting":{"public":"web/dist"},"functions":{"source":"functions"}}');
  assert.deepEqual(r.parts, ['data', 'web', 'api']);
});

test('a Dockerfile makes a service; archive/ and test/ are skipped', () => {
  const r = detectParts(['quant/Dockerfile', 'archive/old/Dockerfile', 'test/Dockerfile'], '{"hosting":{}}');
  assert.deepEqual(r.parts, ['data', 'web', 'service']);
  assert.equal(r.why.service, 'quant/Dockerfile');
});

test('mobile: Flutter with ios/, iOS plist; archived Flutter is skipped', () => {
  assert.deepEqual(detectParts(['mobile/pubspec.yaml', 'mobile/ios'], '').parts, ['data', 'mobile']);
  assert.deepEqual(detectParts(['ios/App/GoogleService-Info.plist'], '').parts, ['data', 'mobile']);
  assert.deepEqual(detectParts(['archive/evoting_flutter/pubspec.yaml', 'archive/evoting_flutter/ios'], '{"functions":{}}').parts, ['data', 'api']);
  assert.deepEqual(detectParts(['pubspec.yaml'], '').parts, ['data']);
});

test('data only, and broken firebase.json', () => {
  assert.deepEqual(detectParts([], '').parts, ['data']);
  assert.deepEqual(detectParts(['x'], '{nope').parts, ['data']);
});

test('DRILL_PARTS wins, data always included, bad words refused', () => {
  assert.equal(parsePartsSetting(''), null);
  assert.deepEqual(parsePartsSetting('api, web'), ['data', 'web', 'api']);
  assert.throws(() => parsePartsSetting('web site'), /unknown part\(s\) site/);
  assert.deepEqual(effectiveParts(['data', 'web'], 'api'), { parts: ['data', 'api'], manual: true });
  assert.deepEqual(effectiveParts(['data', 'web'], ''), { parts: ['data', 'web'], manual: false });
  assert.deepEqual(effectiveParts(['data', 'web'], 'bogus'), { parts: ['data', 'web'], manual: false });
});

test('HEALTH_PATH', () => {
  assert.ok(validHealthPath('/api/health'));
  assert.ok(validHealthPath(''));
  assert.ok(!validHealthPath('api/health'));
  assert.ok(!validHealthPath('/a b'));
  assert.ok(!validHealthPath('/x"; rm'));
});
