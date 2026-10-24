# shellcheck shell=bash
# shellcheck disable=SC2034 # variables here are read by backup.sh
# Helpers for backup-kit/backup.sh. Sourced, not run. bash 3.2 compatible
# (macOS default bash). The same file ships in every project that uses the kit.

DRY_RUN="${DRY_RUN:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
if [ "${CI:-}" = "1" ] || [ "${CI:-}" = "true" ]; then
  ASSUME_YES=1
fi

info() { printf '==> %s\n' "$*"; }
say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Print a command, then run it unless --dry-run.
run() {
  printf '  + %s\n' "$*" >&2
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  "$@"
}

# confirm "<question>": returns 0 on yes. --yes / CI=1 answers yes.
confirm() {
  local answer
  if [ "$ASSUME_YES" = "1" ]; then
    say "$1 [y/N] y (--yes)"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "$1 [y/N] (dry run: not asking)"
    return 0
  fi
  if [ ! -t 0 ]; then
    die "No terminal to ask \"$1\". Re-run with --yes to answer yes."
  fi
  printf '%s [y/N] ' "$1"
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# type_to_confirm "<what>" "<word>": the person types the word (never skipped by --yes
# unless I_UNDERSTAND=<word> is set). For steps that cannot be undone.
type_to_confirm() {
  local typed
  if [ "${I_UNDERSTAND:-}" = "$2" ]; then
    say "$1: confirmed by I_UNDERSTAND=$2"
    return 0
  fi
  [ -t 0 ] || die "$1 needs you to type '$2' in a terminal (or set I_UNDERSTAND=$2)"
  printf '%s\nType %s to continue: ' "$1" "$2"
  read -r typed || typed=""
  [ "$typed" = "$2" ]
}

# Tool checks: need_tool <name> "<how to install>" ...; then check_tools.
MISSING_TOOLS=""
need_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    MISSING_TOOLS="${MISSING_TOOLS}  - $1: $2
"
  fi
}
check_tools() {
  if [ -n "$MISSING_TOOLS" ]; then
    printf 'ERROR: missing tools:\n%s' "$MISSING_TOOLS" >&2
    exit 1
  fi
}

# retry <command...>: up to $RETRIES attempts with 2s, 4s, 8s… between them.
# Only for steps that are safe to repeat (reads, enables, IAM bindings, updates).
retry() {
  local n=1 wait=2
  while :; do
    if "$@"; then return 0; fi
    if [ "$n" -ge "${RETRIES:-4}" ]; then
      warn "gave up after $n attempts: $*"
      return 1
    fi
    warn "attempt $n failed, retrying in ${wait}s: $*"
    sleep "$wait"
    n=$((n + 1)); wait=$((wait * 2))
  done
}

# rrun: run (printed, skipped in --dry-run) with retries. Repeat-safe steps only.
rrun() { retry run "$@"; }

valid_project() { [[ "$1" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; }
valid_bucket()  { [[ "$1" =~ ^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$ ]]; }
valid_run_id()  { [[ "$1" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; }
valid_email()   { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]]; }

# Firestore database id -> folder name in a backup ("(default)" -> "default").
db_dir() { if [ "$1" = "(default)" ]; then printf 'default'; else printf '%s' "$1"; fi; }
# And back.
dir_db() { if [ "$1" = "default" ]; then printf '(default)'; else printf '%s' "$1"; fi; }

# Bucket location for a Firestore export: the export bucket must be in the
# database's location (a multi-region database exports to its multi-region).
bucket_location_for_db() {
  case "$1" in
    nam5|nam7) printf 'US' ;;
    eur3) printf 'EU' ;;
    *) printf '%s' "$1" ;;
  esac
}

# Multi-region that contains a database location, for off-site buckets.
multi_region_for() {
  case "$1" in
    nam5|nam7|us-*|northamerica-*|US) printf 'US' ;;
    eur3|europe-*|EU) printf 'EU' ;;
    asia-*|ASIA) printf 'ASIA' ;;
    *) printf 'US' ;;
  esac
}

# Mask everything after the first character of each part of an email (logs of
# public repositories must not print addresses).
mask_email() { printf '%s' "$1" | sed -E 's/^(.)[^@]*@(.)[^.]*\./\1***@\2***./'; }
