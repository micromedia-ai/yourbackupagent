// The site part of a rebuild drill: a .github/workflows/rebuild-drill.yml made
// for one repository from its own firebase.json, so no project needs a
// hand-written one. YourBackupAgent's rebuild restores a set into the drill
// project, makes CI_SA owner there and starts this workflow, which builds the
// site from main, deploys what firebase.json deploys into the drill project
// (string params empty, secrets placeholders, scheduled jobs paused), checks
// the site and its backend answer, and sets the drill-site label.

// siteFacts(firebaseJsonText, {base, packageDirs}) -> what the workflow needs.
//   base: '' or 'app/' (where firebase.json is); packageDirs: folders (relative
//   to the repo) that have a package.json, mapped to its parsed scripts.
export function siteFacts(fbText, { base = '', packages = {} } = {}) {
  let fb;
  try { fb = JSON.parse(fbText); } catch { throw new Error('firebase.json is not JSON'); }
  const join = (d) => (base + d).split('/').filter((x) => x && x !== '.').join('/') || '.';
  const hostings = fb.hosting ? (Array.isArray(fb.hosting) ? fb.hosting : [fb.hosting]) : [];
  const hosting = hostings.find((h) => h.target) || hostings[0] || null;
  // The web build lives in the folder above hosting.public with a build script.
  let web = null;
  if (hosting?.public) {
    const parts = hosting.public.replace(/\/+$/, '').split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const dir = join(parts.slice(0, i).join('/'));
      if (packages[dir]?.scripts?.build) { web = dir; break; }
    }
  }
  const fns = fb.functions ? (Array.isArray(fb.functions) ? fb.functions : [fb.functions]) : [];
  const functions = fns.map((f) => join(f.source || 'functions')).filter((d, i, a) => a.indexOf(d) === i);
  // The first rewrite to a function with a plain path proves the backend answers through Hosting.
  const rewrite = (hosting?.rewrites || []).find((r) => (r.function || r.run) && /^\/[\w./-]+$/.test(r.source || ''));
  const only = [
    hosting && (hosting.target ? `hosting:${hosting.target}` : 'hosting'),
    functions.length && 'functions',
    fb.firestore && 'firestore',
    fb.storage && 'storage',
  ].filter(Boolean);
  return {
    dir: join('.'),
    web,
    hostingTarget: hosting?.target || '',
    functions,
    only,
    apiPath: rewrite ? rewrite.source : '',
  };
}

// The repo's sign-in step for Google: the keyless Workload Identity of its
// backup.yml when it has one, else the deploy key secret.
export function signIn(backupYml, secret) {
  const wip = /workload_identity_provider:\s*(\S+)/.exec(backupYml || '');
  const sa = /service_account:\s*(\S+)/.exec(backupYml || '');
  if (wip && sa) return { lines: [`workload_identity_provider: ${wip[1]}`, `service_account: ${sa[1]}`], keyless: true };
  return { lines: [`credentials_json: \${{ secrets.${secret || 'YOURBACKUPAGENT_SA_KEY'} }}`], keyless: false };
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// drillWorkflow({projectId, label, facts, signIn}) -> workflow text.
export function drillWorkflow({ projectId, label, facts, signIn: si }) {
  const { dir, web, hostingTarget, functions, only, apiPath } = facts;
  const wd = (d) => (d && d !== '.' ? `\n        working-directory: ${d}` : '');
  const fnDirs = functions.join(' ');
  const steps = [];
  steps.push(`      - name: Check the target is a drill project
        run: |
          [[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo "::error::'$PROJECT' is not a project id"; exit 1; }
          case "$PROJECT" in
            "$PRODUCTION") echo "::error::$PROJECT is production"; exit 1 ;;
            *drill*) ;;
            *) echo "::error::$PROJECT must contain drill"; exit 1 ;;
          esac

      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node 22 (+ GitHub Packages for private @plantagoai packages)
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://npm.pkg.github.com'
          scope: '@plantagoai'

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          # YourBackupAgent's account (CI_SA in backup-kit/backup.env): the
          # rebuild drill made it owner of the drill project for this drill.
${si.lines.map((l) => `          ${l}`).join('\n')}

      - name: Set up gcloud
        uses: google-github-actions/setup-gcloud@v2

      - name: Drill project was restored for this repository
        run: |
          set -euo pipefail
          labels=$(gcloud projects describe "$PROJECT" --format=json 2>/dev/null | jq -c '.labels // {}') || {
            echo "::error::The backup service account cannot see $PROJECT. Start a rebuild drill from YourBackupAgent first (Restore… on a backup set)."; exit 1; }
          [ "$(jq -r '.["drill-of"] // ""' <<<"$labels")" = "$PRODUCTION" ] || { echo "::error::$PROJECT holds a restore of $(jq -r '.["drill-of"] // "nothing"' <<<"$labels"), not $PRODUCTION"; exit 1; }
          [ "$(jq -r '.["drill-data"] // ""' <<<"$labels")" = "passed" ] || { echo "::error::The data restore in $PROJECT did not pass"; exit 1; }
          echo "restored backup: $(jq -r '.["drill-run"] // "-"' <<<"$labels")"
          gcloud services enable cloudfunctions.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \\
            run.googleapis.com eventarc.googleapis.com pubsub.googleapis.com cloudscheduler.googleapis.com \\
            cloudtasks.googleapis.com secretmanager.googleapis.com firebasehosting.googleapis.com \\
            firebaserules.googleapis.com firebasestorage.googleapis.com --project "$PROJECT"

      - name: Web app config of the drill project${wd(dir)}
        run: |
          set -euo pipefail
          fb() { npx --yes firebase-tools@latest "$@" --project "$PROJECT" --non-interactive; }
          app_id=$(fb apps:list WEB --json | jq -r '.result[0].appId // empty')
          [ -n "$app_id" ] || app_id=$(fb apps:create WEB "rebuild drill" --json | jq -r '.result.appId')
          cfg=$(fb apps:sdkconfig WEB "$app_id" --json | jq -c '.result.sdkConfig')
          # The usual names a web build reads its Firebase config from.
          for pre in VITE_FIREBASE_ REACT_APP_FIREBASE_ NEXT_PUBLIC_FIREBASE_; do
            {
              echo "\${pre}API_KEY=$(jq -r .apiKey <<<"$cfg")"
              echo "\${pre}AUTH_DOMAIN=$PROJECT.firebaseapp.com"
              echo "\${pre}PROJECT_ID=$PROJECT"
              echo "\${pre}STORAGE_BUCKET=$(jq -r '.storageBucket // empty' <<<"$cfg")"
              echo "\${pre}MESSAGING_SENDER_ID=$(jq -r .messagingSenderId <<<"$cfg")"
              echo "\${pre}APP_ID=$(jq -r .appId <<<"$cfg")"
            } >> "$GITHUB_ENV"
          done
          echo "FIREBASE_WEBAPP_CONFIG=$cfg" >> "$GITHUB_ENV"
          echo "DRILL_API_KEY=$(jq -r .apiKey <<<"$cfg")" >> "$GITHUB_ENV"
          # The default Hosting site carries the project id.
          fb hosting:sites:list --json | jq -e --arg p "$PROJECT" '.result.sites[]? | select(.name | endswith("/sites/" + $p))' >/dev/null \\
            || fb hosting:sites:create "$PROJECT"${hostingTarget ? `
          # This repo deploys hosting:${hostingTarget}; in the drill it is the default site.
          npx --yes firebase-tools@latest target:apply hosting ${hostingTarget} "$PROJECT" --project "$PROJECT"` : ''}
          echo "web app $app_id"`);
  if (web) {
    steps.push(`      - name: Build the site${wd(web)}
        env:
          NODE_AUTH_TOKEN: \${{ secrets.PLANTAGOAI_PACKAGES_TOKEN || secrets.NPM_AUTH_TOKEN_PLANTAGOAI || secrets.GITHUB_TOKEN }}
        run: |
          if [ -f package-lock.json ]; then npm ci; else npm install; fi
          npm run build`);
  }
  if (functions.length) {
    steps.push(`      - name: Functions dependencies, params and secrets
        env:
          NODE_AUTH_TOKEN: \${{ secrets.PLANTAGOAI_PACKAGES_TOKEN || secrets.NPM_AUTH_TOKEN_PLANTAGOAI || secrets.GITHUB_TOKEN }}
          DRILL_PARAM_EXCLUDE: '(^|/)(node_modules|lib|dist|test|tests)/|\\.test\\.'
        run: |
          set -euo pipefail
          for d in ${fnDirs}; do
            ( cd "$d" && if [ -f package-lock.json ]; then npm ci; else npm install; fi )
            src=$(cd "$d" && git ls-files '*.js' '*.mjs' '*.cjs' '*.ts' | grep -Ev "$DRILL_PARAM_EXCLUDE" || true)
            f="$d/.env.$PROJECT"
            # String params: keys, secrets and URLs are empty in the copy (so
            # AI, payments and email stay off), and so is any param with no
            # default (non-interactive deploys need a value); the rest keep
            # their defaults.
            (cd "$d" && cat $src 2>/dev/null) \\
              | perl -0ne 'while (/defineString\\(\\s*[\\x27"]([A-Z0-9_]+)[\\x27"]\\s*(,\\s*\\{([^}]*)\\})?/g) { my ($n, $o) = ($1, $3 // ""); print $n, ($o =~ /\\bdefault\\s*:/ ? " d" : " -"), "\\n" }' \\
              | sort -u | awk '$2 == "-" || $1 ~ /(KEY|SECRET|TOKEN|PASSWORD|CLIENT_ID|_URL)$/ { print $1 "=" }' > "$f"
            # URLs a function builds links from point at the drill site.
            sed -i -E "s#^((APP|SITE|PUBLIC|BASE)_URL)=.*#\\1=https://$PROJECT.web.app#" "$f"
            echo "$d: $(grep -c = "$f") params"
            # Every secret the code binds must exist: placeholders, unless the
            # rebuild already copied a real one (CHAIN_SECRETS).
            for name in $( (cd "$d" && cat $src 2>/dev/null) | grep -oE "defineSecret\\(['\\"][A-Z0-9_]+['\\"]" | sed -E "s/.*\\(['\\"]//; s/['\\"]$//" | sort -u); do
              if ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
                gcloud secrets create "$name" --replication-policy=automatic --labels=drill=copy --project "$PROJECT" --quiet >/dev/null
                printf 'drill-placeholder' | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT" --quiet >/dev/null
                echo "placeholder secret $name"
              fi
            done
          done`);
  }
  steps.push(`      - name: Deploy into the drill project (scheduled jobs paused as they appear)${wd(dir)}
        run: |
          set -uo pipefail
          REGIONS="us-central1 us-east1 europe-west1"
          # The copy holds production's data: keep every scheduled job paused
          # from the moment the deploy makes it.
          ( while :; do
              for loc in $REGIONS; do
                for j in $(gcloud scheduler jobs list --location "$loc" --project "$PROJECT" --filter='state=ENABLED' --format='value(name)' 2>/dev/null); do
                  gcloud scheduler jobs pause "\${j##*/}" --location "$loc" --project "$PROJECT" --quiet >/dev/null 2>&1 && echo "paused \${j##*/}"
                done
              done
              sleep 20
            done ) &
          PAUSER=$!
          rc=1
          # The first deploy into a fresh project races Google's own setup
          # (source bucket, Cloud Run); a rerun only finishes what is missing.
          for attempt in 1 2 3; do
            if npx --yes firebase-tools@latest deploy --only ${only.join(',')} --project "$PROJECT" --non-interactive --force; then
              rc=0; break
            fi
            [ "$attempt" = "3" ] && break
            echo "::warning::deploy attempt $attempt failed; retrying in 60s (new project setup)"
            sleep 60
          done
          sleep 30; kill "$PAUSER" 2>/dev/null || true
          left=0
          for loc in $REGIONS; do
            left=$((left + $(gcloud scheduler jobs list --location "$loc" --project "$PROJECT" --filter='state=ENABLED' --format='value(name)' 2>/dev/null | wc -l)))
          done
          echo "scheduled jobs still enabled: $left"
          [ "$left" = "0" ] || { echo "::error::$left scheduled jobs are enabled in the copy"; rc=1; }
          exit $rc

      - name: Check the rebuilt site
        id: check
        env:
          API_PATH: ${q(apiPath)}
        run: |
          set -uo pipefail
          URL="https://$PROJECT.web.app"
          fail=0
          # What to check: DRILL_PARTS and HEALTH_PATH in backup-kit/backup.env
          # (empty DRILL_PARTS: everything this workflow deployed).
          val() { sed -n "s/^$1=//p" backup-kit/backup.env 2>/dev/null | tail -1 | tr -d \\"\\'; }
          PARTS=$(val DRILL_PARTS); HEALTH=$(val HEALTH_PATH)
          part() { [ -z "$PARTS" ] || [[ " $PARTS " == *" $1 "* ]]; }
          echo "parts: \${PARTS:-all deployed}\${HEALTH:+, health $HEALTH}"
          if part web; then
            code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/")
            [ "$code" = "200" ] && echo "web: home page ok" || { echo "::error::$URL/ answered HTTP $code"; fail=1; }
          fi
          got=0; want=0
          if part api; then
            if [ -n "$HEALTH" ]; then
              # A health path must really answer (2xx).
              if [[ "$HEALTH" =~ ^/[A-Za-z0-9._/-]*$ ]]; then
                code=$(curl -s -o /dev/null -w '%{http_code}' "$URL$HEALTH")
                [[ "$code" =~ ^2 ]] && echo "api: $HEALTH ok (HTTP $code)" || { echo "::error::$URL$HEALTH answered HTTP $code"; fail=1; }
              else echo "::error::HEALTH_PATH must be a path such as /api/health"; fail=1; fi
            elif [ -n "$API_PATH" ]; then
              # The backend through Hosting: any answer but 404 or a 5xx means the function runs.
              code=$(curl -s -o /dev/null -w '%{http_code}' "$URL$API_PATH")
              if [ "$code" != "404" ] && [ "$code" -lt 500 ]; then echo "api: $API_PATH ok (HTTP $code)"; else echo "::error::$URL$API_PATH answered HTTP $code"; fail=1; fi
            fi
            # The same functions as production, every one active.
            names() { sed 's#.*/##' | sort -u | grep . || true; }
            all=$(gcloud functions list --project "$PROJECT" --format='value(name)' 2>/dev/null | names)
            active=$(gcloud functions list --project "$PROJECT" --format='value(name,state,status)' 2>/dev/null | grep -w ACTIVE | awk '{print $1}' | names)
            want=$(echo "$all" | grep -c . || true); got=$(echo "$active" | grep -c . || true)
            echo "functions active: $got of $want"
            [ "$got" = "$want" ] || { echo "::error::only $got of $want functions are active: $(comm -23 <(echo "$all") <(echo "$active") | tr '\\n' ' ')"; fail=1; }
            if prod=$(gcloud functions list --project "$PRODUCTION" --format='value(name)' 2>/dev/null); then
              # Firebase Extensions (ext-*) are installed, not deployed from this repo.
              prod=$(echo "$prod" | names | grep -v '^ext-' || true)
              missing=$(comm -23 <(echo "$prod") <(echo "$active") | grep . || true)
              echo "functions in production: $(echo "$prod" | grep -c . || true), missing or not active in the drill: $(echo "$missing" | grep -c . || true)"
              [ -z "$missing" ] || { echo "::error::not running in the drill: $(echo "$missing" | tr '\\n' ' ')"; fail=1; }
            else
              echo "::warning::cannot list production's functions (needs cloudfunctions.viewer on $PRODUCTION); compared the drill with itself only"
            fi
          fi
          TOKEN=$(gcloud auth print-access-token)
          base="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/(default)/documents"
          cols=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$base:listCollectionIds" -d '{"pageSize":300}' | jq -r '.collectionIds[]?')
          {
            echo "### Rebuild drill: $URL (backup \${{ inputs.run }})"
            echo ""
            echo "functions active: $got of $want"
            echo ""
            echo "| collection | documents |"
            echo "|---|---:|"
            for c in $cols; do
              echo "| $c | $(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$base:runAggregationQuery" \\
                -d "{\\"structuredAggregationQuery\\":{\\"structuredQuery\\":{\\"from\\":[{\\"collectionId\\":\\"$c\\"}]},\\"aggregations\\":[{\\"alias\\":\\"n\\",\\"count\\":{}}]}}" \\
                | jq -r '.[0].result.aggregateFields.n.integerValue // "?"') |"
            done
          } >> "$GITHUB_STEP_SUMMARY"
          echo "restored collections: $(echo "$cols" | grep -c . || true)"
          [ "$fail" = "0" ] && echo "REBUILD DRILL PASSED: $URL" || echo "::error::REBUILD DRILL FAILED"
          exit "$fail"

      - name: Tell YourBackupAgent how the site part ended
        if: always()
        env:
          RESULT: \${{ steps.check.outcome == 'success' && 'passed' || 'failed' }}
        run: |
          TOKEN=$(gcloud auth print-access-token 2>/dev/null) || exit 0
          u="https://cloudresourcemanager.googleapis.com/v3/projects/$PROJECT"
          cur=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$u") || { echo "::warning::could not read $PROJECT's labels"; exit 0; }
          [ -n "$(jq -r '.labels["drill-of"] // empty' <<<"$cur")" ] || exit 0
          # Through the API: gcloud sets project labels only in alpha.
          l=$(jq -c --arg v "$RESULT" '{labels: ((.labels // {}) + {"drill-site": $v})}' <<<"$cur")
          curl -fsS -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$u?updateMask=labels" -d "$l" >/dev/null \\
            && echo "drill-site=$RESULT" || echo "::warning::could not set drill-site=$RESULT on $PROJECT"`);

  return `name: Rebuild drill

# Made by YourBackupAgent from this repository's firebase.json (${label}).
# YourBackupAgent's rebuild drill ("Restore…" on a backup set in the manager
# app) restores the set into its shared drill project, makes this repository's
# backup service account owner there for the drill, and starts this workflow.
# It builds the site from main and deploys ${only.join(', ')} into the drill
# project: string params are empty and secrets are placeholders, so AI,
# payments and email stay off; scheduled jobs are paused. Then it checks the
# site${apiPath ? ` and ${apiPath}` : ''} answer. Never touches ${projectId}.
# Prints names, counts and statuses only. Edit freely: the app never
# overwrites this file.
on:
  workflow_dispatch:
    inputs:
      project:
        description: 'Drill project id (must contain drill; YourBackupAgent passes it)'
        required: true
      run:
        description: 'Backup id that was restored (for the record)'
        required: false

permissions:
  contents: read
  packages: read${si.keyless ? '\n  id-token: write   # signing in to Google with Workload Identity (no stored key)' : ''}

concurrency:
  group: rebuild-drill
  cancel-in-progress: false

jobs:
  rebuild:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      PROJECT: \${{ inputs.project }}
      PRODUCTION: ${projectId}
    steps:
${steps.join('\n\n')}
`;
}

// readSiteFacts(fileText, ref) -> siteFacts for a repository, reading
// firebase.json (at the root or in app/) and the package.json files that
// could build its hosting folder. fileText(path, ref) -> {text} | null.
export async function readSiteFacts(fileText, ref) {
  let base = '';
  let fb = await fileText('firebase.json', ref);
  if (!fb) { fb = await fileText('app/firebase.json', ref); base = 'app/'; }
  if (!fb) return null;
  let parsed = {};
  try { parsed = JSON.parse(fb.text); } catch { return null; }
  const hostings = parsed.hosting ? (Array.isArray(parsed.hosting) ? parsed.hosting : [parsed.hosting]) : [];
  const h = hostings.find((x) => x.target) || hostings[0];
  const dirs = new Set();
  if (h?.public) {
    const parts = h.public.replace(/\/+$/, '').split('/');
    for (let i = parts.length - 1; i >= 0; i--) dirs.add((base + parts.slice(0, i).join('/')).replace(/\/+$/, '') || '.');
  }
  const packages = {};
  for (const d of dirs) {
    const f = await fileText(d === '.' ? 'package.json' : `${d}/package.json`, ref);
    if (f) { try { packages[d] = JSON.parse(f.text); } catch { /* not JSON: no build there */ } }
  }
  return siteFacts(fb.text, { base, packages });
}
