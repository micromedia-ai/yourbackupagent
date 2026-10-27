// What a rebuild drill brings up and checks for one repository ("parts"),
// detected from its file list and firebase.json, or set by hand with
// DRILL_PARTS in backup-kit/backup.env (which wins).
//   data     restore and compare counts (always)
//   web      a Hosting site: deploy it, the page answers
//   api      Cloud Functions: the same functions as production are deployed
//            and active, HEALTH_PATH (if set) answers
//   service  a container (Dockerfile): Cloud Run in the drill project
//   mobile   an iOS or Android app on this backend: its smoke test

export const PARTS = ['data', 'web', 'api', 'service', 'mobile'];

// Folders that are not the live product.
const SKIP = /(^|\/)(archive|archived|examples?|tests?|__tests__|node_modules|vendor|third_party|\.github)\//;

// detectParts(paths, firebaseJsonText) -> {parts, why}
//   paths: every file and folder path in the repo (git tree, recursive).
export function detectParts(paths, fbText) {
  const live = (paths || []).filter((p) => !SKIP.test(`${p}/`));
  const has = (re) => live.filter((p) => re.test(p));
  const why = { data: 'restore counts' };
  let fb = {};
  try { fb = fbText ? JSON.parse(fbText) : {}; } catch { fb = {}; }
  if (fb.hosting) why.web = 'firebase.json has hosting';
  if (fb.functions) why.api = 'firebase.json has functions';
  const docker = has(/(^|\/)Dockerfile$/);
  if (docker.length) why.service = docker.slice(0, 3).join(', ');
  const ios = has(/(^|\/)(GoogleService-Info\.plist|[^/]+\.xcodeproj)$/);
  const android = has(/(^|\/)google-services\.json$/);
  const flutter = has(/(^|\/)pubspec\.yaml$/).filter((f) => {
    const dir = f.replace(/pubspec\.yaml$/, '');
    return live.includes(`${dir}ios`) || live.includes(`${dir}android`);
  });
  const mobile = [...ios, ...android, ...flutter];
  if (mobile.length) why.mobile = mobile.slice(0, 3).join(', ');
  return { parts: PARTS.filter((p) => why[p]), why };
}

// parsePartsSetting('web api') -> ['data', 'web', 'api'] (data always), or
// null when unset. Unknown words are an error.
export function parsePartsSetting(text) {
  const words = String(text || '').split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  const bad = words.filter((w) => !PARTS.includes(w));
  if (bad.length) throw new Error(`DRILL_PARTS: unknown part(s) ${bad.join(', ')}; use ${PARTS.join(', ')}`);
  return PARTS.filter((p) => p === 'data' || words.includes(p));
}

// The parts a drill uses: the hand-set ones, else the detected ones.
export function effectiveParts(detected, setting) {
  let manual = null;
  try { manual = parsePartsSetting(setting); } catch { manual = null; }
  return { parts: manual || (detected || ['data']), manual: Boolean(manual) };
}

// HEALTH_PATH: a path on the site such as /api/health, or empty.
export function validHealthPath(v) {
  return v === '' || /^\/[\w./-]{0,100}$/.test(v);
}
