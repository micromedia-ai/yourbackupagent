import { useEffect, useState } from 'react';
import { collection, collectionGroup, doc, limit, onSnapshot, orderBy, query, where, type Query } from 'firebase/firestore';
import { db } from './firebase';

export type SetSummary = {
  id: string; status: 'succeeded' | 'failed' | 'incomplete' | 'unknown'; trigger?: string | null;
  startedAt?: string | null; durationSec?: number | null; docs?: number | null; collections?: number;
  files?: number | null; users?: number | null; bytes: number; objects?: number; steps?: Record<string, string>; errors?: string[];
};
export type BackupSet = SetSummary & { inProject: boolean; inVault: boolean; project: SetSummary | null; vault: SetSummary | null };
export type Health = { level: 'ok' | 'warn' | 'bad'; text: string; notes?: string[]; goodCount?: number; newestGood?: string; ageHours?: number };
export type Project = {
  projectId: string; label: string; repo: string; kitRef: string; backupBucket: string; keepDays: number; keepMinSets: number; storageMode?: 'full' | 'changed';
  maxAgeHours: number; offsiteBucket: string; offsiteKeepDays: number; vaultProject: string; drillProject: string; drillWorkflow: string; siteDrill?: boolean;
  envLabel?: string; labelInApp?: boolean; parts?: string[]; partsManual?: boolean; detectedParts?: string[] | null; partsWhy?: Record<string, string> | null; drillParts?: string; healthPath?: string;
  health: Health; errors: string[]; refreshedAt?: any; totals?: { sets: number; inProject: number; inVault: number; bytes: number };
  prunePreview?: { id: string; status: string; why: string }[];
};
export type LogLine = {
  id: string; at: any; by: string; action: string; status: string; project?: string; repo?: string; runIds?: string[];
  where?: string; detail?: string; link?: string; source?: string; endedAt?: any;
};

function useQuery<T>(make: () => Query | null, deps: unknown[]) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState<string>('');
  useEffect(() => {
    const q = make();
    if (!q) return;
    return onSnapshot(q, (s) => setRows(s.docs.map((d) => ({ id: d.id, ...d.data() }) as T)), (e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { rows, error };
}

export const useProjects = () => useQuery<Project>(() => collection(db(), 'projects'), []);
export const useSets = (projectId: string) =>
  useQuery<BackupSet>(() => (projectId ? query(collection(db(), 'projects', projectId, 'sets'), orderBy('id', 'desc')) : null), [projectId]);
export const useLog = (n = 100, project = '') =>
  useQuery<LogLine>(() => query(collection(db(), 'log'), ...(project ? [where('project', '==', project)] : []), orderBy('at', 'desc'), limit(n)), [n, project]);

export function useDoc<T>(path: string) {
  const [data, setData] = useState<T | null | undefined>(undefined);
  useEffect(() => onSnapshot(doc(db(), path), (s) => setData(s.exists() ? (s.data() as T) : null), () => setData(null)), [path]);
  return data;
}

// Every project's sets (for the overview and reports), with their project id.
export function useAllSets() {
  const [rows, setRows] = useState<(BackupSet & { projectId: string })[] | null>(null);
  useEffect(() => onSnapshot(collectionGroup(db(), 'sets'), (s) =>
    setRows(s.docs.map((d) => ({ ...(d.data() as BackupSet), projectId: d.ref.parent.parent!.id }))), () => setRows([])), []);
  return rows;
}

// Per-day series for the last `days` days: bytes per project, and whether a run failed.
export function daily(sets: (BackupSet & { projectId: string })[], projects: string[], days = 30, pick: (s: BackupSet) => number = (s) => s.bytes) {
  const labels: string[] = [];
  const keys: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    keys.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    labels.push(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }));
  }
  const values = projects.map((p) => keys.map((k) => sets.filter((s) => s.projectId === p && s.id.startsWith(k) && s.status === 'succeeded').reduce((a, s) => a + pick(s), 0)));
  const failed = keys.map((k) => sets.some((s) => s.id.startsWith(k) && s.status === 'failed'));
  return { labels, values, failed };
}

// The last `days` UTC days: keys like 20261024 and short labels.
export function dayKeys(days: number) {
  const keys: string[] = [], labels: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    keys.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
    labels.push(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }));
  }
  return { keys, labels };
}

// Per day, the result of that day's newest run in the project bucket.
export function statusCells(sets: (BackupSet & { projectId: string })[], projectId: string, keys: string[]) {
  return keys.map((k) => {
    const day = sets.filter((s) => s.projectId === projectId && s.inProject && s.id.startsWith(k));
    if (!day.length) return 'none';
    return day.reduce((a, b) => (b.id > a.id ? b : a)).status as string;
  });
}

// Headline numbers over the last `days` days.
export function analytics(projects: Project[], sets: (BackupSet & { projectId: string })[], log: LogLine[], days = 30) {
  const since = Date.now() - days * 86400000;
  const t = (id: string) => {
    const m = id.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
  };
  const recent = sets.filter((s) => s.inProject && t(s.id) >= since);
  const good = recent.filter((s) => s.status === 'succeeded');
  const drills = log.filter((l) => /^(rebuild|restore) drill/.test(l.action) && ['succeeded', 'failed'].includes(l.status) && (l.at?.toDate?.()?.getTime?.() || 0) >= since);
  const ages = projects.map((p) => (p.health?.newestGood ? (Date.now() - t(p.health.newestGood)) / 3600000 : null)).filter((a): a is number => a != null);
  return {
    projects: projects.length,
    healthy: projects.filter((p) => p.health?.level === 'ok').length,
    runs: recent.length,
    good: good.length,
    rate: recent.length ? Math.round((100 * good.length) / recent.length) : null,
    oldestNewestGoodHours: ages.length ? Math.max(...ages) : null,
    bytes: projects.reduce((a, p) => a + (p.totals?.bytes || 0), 0),
    sets: projects.reduce((a, p) => a + (p.totals?.sets || 0), 0),
    drillsPassed: drills.filter((d) => d.status === 'succeeded').length,
    drillsFailed: drills.filter((d) => d.status === 'failed').length,
  };
}

export type AccessRequest = { id: string; email: string; name?: string; note?: string; status: string; at?: any };
export const useRequests = () => useQuery<AccessRequest>(() => query(collection(db(), 'requests'), where('status', '==', 'pending')), []);
