import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install } from '../src/install.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'iwsdk-upgrade-'));
  writeFileSync(join(root, 'package.json'), '{"name":"upgrade-test"}\n');
  return root;
}
const script = root => join(root, 'scripts', 'agents.mjs');
const manifest = root => join(root, '.iwsdk-agent-kit.manifest.json');

test('fresh install writes a content-hash manifest and is idempotent', () => {
  const root = fixture();
  const preview = install(root, { dryRun: true });
  assert.ok(preview.some(x => x.path === manifest(root) && x.action === 'create'));
  assert.equal(existsSync(manifest(root)), false);
  install(root);
  const data = JSON.parse(readFileSync(manifest(root), 'utf8'));
  assert.equal(data.version, 1);
  assert.equal(data.managed['scripts/agents.mjs'], hash(readFileSync(script(root), 'utf8')));
  const before = readFileSync(manifest(root), 'utf8');
  const actions = install(root);
  assert.ok(actions.some(x => x.path === script(root) && x.action === 'unchanged'));
  assert.equal(readFileSync(manifest(root), 'utf8'), before);
});

test('locally modified script is never overwritten by a routine upgrade or dry run', () => {
  const root = fixture();
  install(root);
  const custom = '// customized sandbox policy\n';
  writeFileSync(script(root), custom);
  const beforeManifest = readFileSync(manifest(root), 'utf8');
  for (const options of [{ dryRun: true }, {}]) {
    const actions = install(root, options);
    assert.ok(actions.some(x => x.path === script(root) && x.action === 'conflict'));
    assert.equal(readFileSync(script(root), 'utf8'), custom);
    assert.equal(readFileSync(manifest(root), 'utf8'), beforeManifest);
  }
  const forcePreview = install(root, { dryRun: true, forceManaged: true });
  assert.ok(forcePreview.some(x => x.path === script(root) && x.action === 'backup'));
  assert.equal(readFileSync(script(root), 'utf8'), custom);
  const forced = install(root, { forceManaged: true });
  const backup = forced.find(x => x.path === script(root) && x.action === 'backup')?.backup;
  assert.ok(backup && existsSync(backup));
  assert.equal(readFileSync(backup, 'utf8'), custom);
  assert.notEqual(readFileSync(script(root), 'utf8'), custom);
});

test('legacy installs without manifest preserve scripts until explicit backed-up migration', () => {
  const root = fixture();
  install(root);
  rmSync(manifest(root));
  const legacy = '// older project runner with local fixes\n';
  writeFileSync(script(root), legacy);
  const result = install(root);
  assert.ok(result.some(x => x.path === script(root) && x.action === 'conflict'));
  assert.equal(readFileSync(script(root), 'utf8'), legacy);
  assert.equal(existsSync(manifest(root)), false, 'no partial manifest written on conflict');
  const forced = install(root, { forceManaged: true });
  assert.ok(forced.some(x => x.path === script(root) && x.action === 'backup'));
  assert.notEqual(readFileSync(script(root), 'utf8'), legacy);
});

test('clean manifest-tracked older runner upgrades without force', () => {
  const root = fixture();
  install(root);
  const old = '// known previous toolkit generated runner\n';
  writeFileSync(script(root), old);
  const data = JSON.parse(readFileSync(manifest(root), 'utf8'));
  data.managed['scripts/agents.mjs'] = hash(old);
  writeFileSync(manifest(root), JSON.stringify(data, null, 2) + '\n');
  const result = install(root);
  assert.ok(result.some(x => x.path === script(root) && x.action === 'backup'));
  assert.ok(result.some(x => x.path === script(root) && x.action === 'update'));
  assert.equal(JSON.parse(readFileSync(manifest(root), 'utf8')).managed['scripts/agents.mjs'],
    hash(readFileSync(script(root), 'utf8')));
});

test('symlinked runner and manifest are not followed', () => {
  const root = fixture();
  install(root);
  const external = join(root, 'outside.txt');
  writeFileSync(external, 'do not overwrite\n');
  rmSync(script(root));
  symlinkSync(external, script(root));
  const result = install(root);
  assert.ok(result.some(x => x.path === script(root) && x.action === 'conflict'));
  assert.equal(readFileSync(external, 'utf8'), 'do not overwrite\n');
  rmSync(manifest(root));
  symlinkSync(external, manifest(root));
  assert.throws(() => install(root), /non-regular installer manifest/);
});

test('one customized script prevents a partial upgrade of other clean scripts', () => {
  const root = fixture();
  install(root);
  const second = join(root, 'scripts', 'backends.mjs');
  const old = '// old but manifest-tracked backends\n';
  writeFileSync(second, old);
  const data = JSON.parse(readFileSync(manifest(root), 'utf8'));
  data.managed['scripts/backends.mjs'] = hash(old);
  writeFileSync(manifest(root), JSON.stringify(data, null, 2) + '\n');
  const previousManifest = readFileSync(manifest(root), 'utf8');
  writeFileSync(script(root), '// custom runner\n');
  const result = install(root);
  assert.ok(result.some(x => x.path === script(root) && x.action === 'conflict'));
  assert.equal(readFileSync(second, 'utf8'), old, 'otherwise-safe script must not update alone');
  assert.equal(readFileSync(manifest(root), 'utf8'), previousManifest);
  assert.equal(readFileSync(script(root), 'utf8'), '// custom runner\n');
});
