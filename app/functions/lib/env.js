// A project's backup-kit/backup.env: plain KEY=value lines (see the kit's
// templates/backup.env.example). Only reads values; never runs anything.

const KEY = /^[A-Z][A-Z0-9_]*$/;

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[key] = v;
  }
  return out;
}

// The settings the app uses, with the kit's defaults.
export function projectSettings(env) {
  const n = (v, d) => (/^[1-9][0-9]*$/.test(v || '') ? Number(v) : d);
  const id = env.PROJECT_ID || '';
  return {
    projectId: id,
    label: env.PROJECT_LABEL || id,
    repo: env.REPO || '',
    kitRef: env.KIT_REF || '',
    backupBucket: env.BACKUP_BUCKET || (id ? `${id}-backups` : ''),
    keepDays: n(env.BACKUP_KEEP_DAYS, 14),
    keepMinSets: n(env.KEEP_MIN_SETS, 7),
    maxAgeHours: n(env.MAX_AGE_HOURS, 26),
    offsiteBucket: env.OFFSITE_BUCKET || '',
    offsiteKeepDays: n(env.OFFSITE_KEEP_DAYS, 90),
    vaultProject: env.VAULT_PROJECT || '',
    drillProject: env.DRILL_PROJECT || '',
    drillWorkflow: env.DRILL_WORKFLOW || 'rebuild-drill.yml',
  };
}

// setEnvValue(text, key, value): the same file with one value changed (or
// added at the end), comments and order kept.
export function setEnvValue(text, key, value) {
  const lines = String(text).split('\n');
  const re = new RegExp(`^\\s*${key}=`);
  const i = lines.findIndex((l) => re.test(l));
  const line = `${key}=${value}`;
  if (i >= 0) lines[i] = line;
  else {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(line, '');
  }
  return lines.join('\n');
}
