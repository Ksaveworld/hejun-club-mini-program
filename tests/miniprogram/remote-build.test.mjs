import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { prepareRemoteMiniProgram, remoteApiBaseUrl } from '../../scripts/prepare-remote-miniprogram.mjs';

test('remote build uses reviewed HTTPS with domain checks on and no private server files or LAN changes', t => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'club-remote-build-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const original = readFileSync('miniprogram/config.js', 'utf8');
  const result = prepareRemoteMiniProgram({ outputRoot });
  const require = createRequire(import.meta.url);
  assert.equal(require(join(result.buildPath, 'config.js')).apiBaseUrl, remoteApiBaseUrl);
  for (const name of ['project.config.json', 'project.private.config.json'])
    assert.equal(JSON.parse(readFileSync(join(result.buildPath, name), 'utf8')).setting.urlCheck, true);
  for (const name of ['server', 'work', 'node_modules', '.env.local', 'remote.example.json'])
    assert.equal(existsSync(join(result.buildPath, name)), false);
  assert.equal(readFileSync('miniprogram/config.js', 'utf8'), original);
  assert.equal(result.phoneVerified, false); assert.equal(result.domainConfigured, false);
  assert.equal(result.loginVerified, false);
});

test('unreviewed, insecure or credential-bearing remote targets are rejected before writing a build', () => {
  for (const apiBaseUrl of ['http://example.com/hejun-club-trial/api', 'https://untrusted.example/api',
    remoteApiBaseUrl + '?secret=not-real', 'https://user:pass@example.com/hejun-club-trial/api',
    'http://127.0.0.1:5187/api']) assert.throws(() => prepareRemoteMiniProgram({ apiBaseUrl }), /已核验/);
});
