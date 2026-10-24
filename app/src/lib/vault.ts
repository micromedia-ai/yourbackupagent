// Delete vault copies with the signed-in person's own Google token.
import { EMULATORS } from './firebase';

const API = EMULATORS ? 'http://127.0.0.1:9199/storage/v1' : 'https://storage.googleapis.com/storage/v1';

async function gcs(token: string, method: string, url: string) {
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`${res.status} ${body?.error?.message || res.statusText}`);
  }
  return res.status === 204 || method === 'DELETE' ? null : res.json();
}

export async function deleteVaultSet(token: string, bucket: string, id: string, onProgress?: (n: number) => void) {
  if (!/^[0-9]{8}T[0-9]{6}Z$/.test(id)) throw new Error(`not a backup id: ${id}`);
  let pageToken = '';
  let n = 0;
  do {
    const list = await gcs(token, 'GET', `${API}/b/${bucket}/o?prefix=${encodeURIComponent(`runs/${id}/`)}&fields=items(name),nextPageToken&maxResults=1000${pageToken ? `&pageToken=${pageToken}` : ''}`);
    const items: { name: string }[] = (list && list.items) || [];
    // manifest.json last would mean "complete" to the kit; delete it first.
    items.sort((a, b) => (a.name.endsWith('/manifest.json') ? -1 : b.name.endsWith('/manifest.json') ? 1 : 0));
    for (const it of items) {
      await gcs(token, 'DELETE', `${API}/b/${bucket}/o/${encodeURIComponent(it.name)}`);
      n += 1;
      if (onProgress && n % 25 === 0) onProgress(n);
    }
    pageToken = (list && list.nextPageToken) || '';
  } while (pageToken);
  return n;
}
