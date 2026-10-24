export function bytes(n: number | null | undefined) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
export const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'));

export function runDate(id: string) {
  const m = id.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

export function when(d: Date | null | undefined) {
  if (!d) return '—';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today ${t}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${t}`;
}

export function ago(d: Date | null | undefined) {
  if (!d) return '—';
  const h = Math.floor((Date.now() - d.getTime()) / 3600000);
  if (h < 1) return 'under an hour ago';
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export const tsDate = (t: any): Date | null => (t && typeof t.toDate === 'function' ? t.toDate() : t instanceof Date ? t : null);

// About $0.02/GB/month standard storage (US multi-region is $0.026).
export const monthlyCost = (b: number) => (b / 1e9) * 0.026;
