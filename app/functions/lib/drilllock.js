// One drill at a time in the shared drill project. The app takes drill/lock
// in a transaction before it starts the runner job; the log line's end (or
// LOCK_HOURS, for a job that died without ending it) frees it.
export const LOCK_HOURS = 6;
const DRILL_ACTIONS = new Set(['rebuild drill', 'wipe drill project']);

// The reason a new drill must wait, or null when the drill project is free.
export function lockBlocks(lock, now = new Date()) {
  if (!lock || !lock.until) return null;
  const until = lock.until.toDate ? lock.until.toDate() : new Date(lock.until);
  if (until <= now) return null;
  const at = lock.at && lock.at.toDate ? lock.at.toDate() : new Date(lock.at || now);
  const mins = Math.max(0, Math.round((now - at) / 60000));
  return `The drill project is busy: ${lock.action || 'a drill'} of ${lock.project || '?'}, started by ${lock.by || '?'} ${mins} min ago. Wait for it to finish (the Log shows it).`;
}

// Does this log write end the drill that holds the lock?
export function endsLock(lock, logId, after) {
  return Boolean(lock && lock.log === logId && after && DRILL_ACTIONS.has(after.action)
    && ['succeeded', 'failed', 'cancelled'].includes(after.status));
}
