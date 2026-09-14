import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareLanMiniProgram } from '../../scripts/prepare-lan-miniprogram.mjs';

test('LAN preview includes only native sources and its own endpoint; original project stays unchanged', t => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'club-lan-build-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  const originalConfig = readFileSync(new URL('../../miniprogram/config.js', import.meta.url), 'utf8');
  const originalProject = readFileSync(new URL('../../miniprogram/project.config.json', import.meta.url), 'utf8');
  const result = prepareLanMiniProgram({ address: '192.168.10.25', outputRoot });
  assert.equal(result.apiBaseUrl, 'http://192.168.10.25:5198/api');
  assert.equal(result.phoneVerified, false);
  assert.equal(readFileSync(new URL('../../miniprogram/config.js', import.meta.url), 'utf8'), originalConfig);
  assert.match(readFileSync(join(result.buildPath, 'config.js'), 'utf8'), /192\.168\.10\.25:5198\/api/);
  const config = JSON.parse(readFileSync(join(result.buildPath, 'project.config.json'), 'utf8'));
  assert.equal(config.appid, JSON.parse(originalProject).appid); assert.equal(config.setting.urlCheck, true);
  assert.equal(readFileSync(new URL('../../miniprogram/project.config.json', import.meta.url), 'utf8'), originalProject);
  const pageConfig = JSON.parse(readFileSync(join(result.buildPath, 'app.json'), 'utf8'));
  for (const page of pageConfig.pages) for (const ext of ['js', 'json', 'wxml', 'wxss']) assert.ok(existsSync(join(result.buildPath, page + '.' + ext)));
  for (const privatePath of ['server', 'work', 'tests', '.env.local', 'README.md', 'node_modules']) assert.equal(existsSync(join(result.buildPath, privatePath)), false);
  assert.ok(readdirSync(result.buildPath).includes('assets'));
});

test('LAN preview rejects public wildcard and loopback hosts before creating a build', t => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'club-lan-reject-'));
  t.after(() => rmSync(outputRoot, { recursive: true, force: true }));
  for (const address of ['0.0.0.0', '127.0.0.1', '8.8.8.8', 'https://192.168.1.1', '192.168.1.1/24'])
    assert.throws(() => prepareLanMiniProgram({ address, outputRoot }), /私有 IPv4/);
  assert.deepEqual(readdirSync(outputRoot), []);
});
