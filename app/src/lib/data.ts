import { useEffect, useState } from 'react';
import { collection, collectionGroup, doc, limit, onSnapshot, orderBy, query, where, type Query } from 'firebase/firestore';
import { db } from './firebase';

export type SetSummary = {
  id: string; status: 'succeeded' | 'failed' | 'incomplete' | 'unknown'; trigger?: string | null;
  startedAt?: string | null; durationSec?: number | null; docs?: number | null; collections?: number;
  files?: number | null; users?: number | null; bytes: number; objects?: number; steps?: Record<string, string>; errors?: string[];
};
export type BackupSet = SetSummary & { inProject: boolean; inVault: boolean; project: SetSummary | null; vault: SetSummary | null };
export type Health = { level: 'ok' | 'warn' | 'bad'; text: string; goodCount?: number; newestGood?: string; ageHours?: number };
export type Project = {
  projectId: string; label: string; repo: string; kitRef: string; backupBucket: string; keepDays: number; keepMinSets: number;
  maxAgeHours: number; offsiteBucket: string; offsiteKeepDays: number; vaultProject: string; drillProject: string; drillWorkflow: string;
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
