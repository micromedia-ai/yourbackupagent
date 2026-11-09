import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firebaseProject, pickDeploySecret, kitFiles, shortName } from '../lib/protect.js';
import { parseEnv } from '../lib/env.js';
import { pickNewestTag } from '../index.js';

const t = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

test('project id and deploy secret are found', () => {
  assert.equal(firebaseProject('{"projects":{"prod":"foundation-next-app"}}'), 'foundation-next-app');
  assert.equal(firebaseProject('{"projects":{"default":"yourcontentcreator-f7ef5"}}'), 'yourcontentcreator-f7ef5');
  assert.equal(firebaseProject('nope'), '');
  assert.equal(pickDeploySecret(['X', 'FIREBASE_SERVICE_ACCOUNT_YCC']), 'FIREBASE_SERVICE_ACCOUNT_YCC');
  assert.equal(shortName('foundation-next-app'), 'foundation-next');
  assert.equal(shortName('yourcontentcreator-f7ef5'), 'yourcontentcreator');
  assert.equal(shortName('limorgilat-com'), 'limorgilat-com');
});

test('kit files are filled in from the templates', () => {
  const files = kitFiles({ repo: 'dagangilat/your-content-creator', projectId: 'yourcontentcreator-f7ef5', label: 'Your Content Creator', secret: 'FIREBASE_SERVICE_ACCOUNT_YCC', kitRef: 'v1.1',
    templates: { wrapper: t('templates/backup-kit-wrapper.sh'), env: t('templates/backup.env.example'), workflow: t('templates/backup.yml') } });
  const env = parseEnv(files.find((f) => f.path === 'backup-kit/backup.env').content);
  assert.deepEqual([env.KIT_REF, env.PROJECT_ID, env.PROJECT_LABEL, env.REPO, env.BACKUP_BUCKET, env.OFFSITE_BUCKET, env.DRILL_PROJECT],
    ['v1.1', 'yourcontentcreator-f7ef5', 'Your Content Creator', 'dagangilat/your-content-creator', 'yourcontentcreator-f7ef5-backups', 'yourbackupagent-yourcontentcreator', 'yourbackupagent-drill']);
  const wf = files.find((f) => f.path === '.github/workflows/backup.yml').content;
  assert.match(wf, /secrets\.FIREBASE_SERVICE_ACCOUNT_YCC/);
  assert.match(wf, /micromedia-ai\/yourbackupagent@v1\.1\n/); assert.doesNotMatch(wf, /@v1\n/);
  assert.ok(files.find((f) => f.path === 'backup-kit/backup.sh').executable);
});

test('newest kit tag', () => {
  assert.equal(pickNewestTag(['v1', 'v1.0.1', 'v1.1', 'latest', 'v0.9']), 'v1.1');
  assert.equal(pickNewestTag([]), '');
});
