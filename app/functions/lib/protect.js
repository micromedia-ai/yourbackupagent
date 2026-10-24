// "Protect a repository": the files a project needs for YourBackupAgent,
// filled in from its .firebaserc, plus the one-time commands to run.
import { setEnvValue } from './env.js';

const KIT_REPO = 'dagangilat/yourbackupagent';

// firebaseProject(.firebaserc text) -> the prod (or default) project id.
export function firebaseProject(rcText) {
  try {
    const rc = JSON.parse(rcText);
    const p = rc.projects || {};
    return p.prod || p.production || p.default || Object.values(p)[0] || '';
  } catch {
    return '';
  }
}

// The deploy key secret the project's own deploy workflow uses.
export function pickDeploySecret(names) {
  return names.find((n) => /^FIREBASE_SERVICE_ACCOUNT/.test(n)) || names.find((n) => /SERVICE_ACCOUNT|GCP_SA|GOOGLE_CREDENTIALS/.test(n)) || '';
}

export function shortName(projectId) {
  return projectId.replace(/-(app|prod|web)$/, '').replace(/-[a-z0-9]{4,6}$/, (m) => (/\d/.test(m) ? '' : m));
}

// kitFiles({repo, projectId, label, secret, kitRef, templates}) -> [{path, content, executable}]
export function kitFiles({ repo, projectId, label, secret, kitRef, templates }) {
  let env = templates.env;
  const set = (k, v) => { env = setEnvValue(env, k, v); };
  set('KIT_REF', kitRef);
  set('PROJECT_ID', projectId);
  set('PROJECT_LABEL', `"${label.replace(/"/g, '')}"`);
  set('REPO', repo);
  set('BACKUP_BUCKET', `${projectId}-backups`);
  set('OFFSITE_BUCKET', `yourbackupagent-${shortName(projectId)}`);
  set('VAULT_ACCOUNT', 'dagan.gilat@gmail.com');
  set('VAULT_PROJECT', 'yourbackupagent');
  set('ARCHIVE_BUCKET', 'yourbackupagent-archive');
  set('DRILL_PROJECT', 'yourbackupagent-drill');
  env = env.replace(/^# Backup settings for one Firebase project\. Copy to backup-kit\/backup\.env and fill in\.$/m,
    `# Backup settings for ${label} (Firebase project ${projectId}).`);
  const workflow = templates.workflow
    .replace(/DEPLOY_KEY_SECRET_NAME/g, secret || 'FIREBASE_SERVICE_ACCOUNT')
    .replace(/dagangilat\/yourbackupagent@v[0-9.]+/g, `${KIT_REPO}@${kitRef}`)
    .replace(/^# Copy to \.github\/workflows\/backup\.yml and set the deploy key secret name\.\n/m, '');
  return [
    { path: 'backup-kit/backup.sh', content: templates.wrapper, executable: true },
    { path: 'backup-kit/backup.env', content: env },
    { path: '.github/workflows/backup.yml', content: workflow },
  ];
}

export function setupCommands(projectId) {
  return [
    { what: 'Log in to both accounts (once per Mac)', cmd: 'gcloud auth login dagan.gilat@gmail.com\ngcloud auth login <owner of ' + projectId + '>' },
    { what: 'Backup bucket and GitHub roles (lists CI_SA candidates the first time)', cmd: 'backup-kit/backup.sh setup' },
    { what: 'Point-in-time recovery, delete protection, managed backups, lien', cmd: 'backup-kit/backup.sh protect' },
    { what: 'Off-site bucket in the vault', cmd: 'backup-kit/backup.sh offsite' },
    { what: 'First backup', cmd: 'backup-kit/backup.sh run' },
    { what: 'Let the manager app read and prune it', cmd: '~/yourbackupagent/app/setup.sh grant ' + projectId + '   # from this repository; needs a checkout of dagangilat/yourbackupagent' },
    { what: 'Prove it: rebuild drill (from the app, or here)', cmd: 'backup-kit/backup.sh rebuild' },
  ];
}

export const TEMPLATE_PATHS = {
  wrapper: 'templates/backup-kit-wrapper.sh',
  env: 'templates/backup.env.example',
  workflow: 'templates/backup.yml',
};
export { KIT_REPO };
