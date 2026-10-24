// Firebase for the manager app. The config comes from Firebase Hosting's
// reserved /__/firebase/init.json, so nothing project-specific is in the code.
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, signInWithCredential, signInWithPopup, reauthenticateWithPopup, signOut, type User } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

let app: FirebaseApp | null = null;
// Only the offline end-to-end test builds with VITE_USE_EMULATORS=true.
export const EMULATORS = import.meta.env.VITE_USE_EMULATORS === 'true';

export async function initFirebase() {
  if (app) return app;
  const res = await fetch('/__/firebase/init.json');
  if (!res.ok) throw new Error('Firebase config not found (open the app from its Firebase Hosting address).');
  const config = await res.json();
  // The emulators' demo project has no API key; any value works there.
  if (EMULATORS && !config.apiKey) Object.assign(config, { apiKey: 'demo-key', authDomain: `${config.projectId}.firebaseapp.com` });
  app = initializeApp(config);
  if (EMULATORS) {
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(getFirestore(app), '127.0.0.1', 8086);
    connectFunctionsEmulator(getFunctions(app, 'us-central1'), '127.0.0.1', 5001);
    // The test browser cannot load Google's popup script: sign in with an
    // unsigned emulator token instead.
    (window as any).__testSignIn = (email: string) =>
      signInWithCredential(getAuth(app!), GoogleAuthProvider.credential(JSON.stringify({ sub: email, email, email_verified: true })));
  }
  return app;
}

export const auth = () => getAuth(app!);
export const db = () => getFirestore(app!);

export function call<T = any>(name: string, data?: unknown): Promise<T> {
  return httpsCallable(getFunctions(app!, 'us-central1'), name, { timeout: 540000 })(data).then((r) => r.data as T);
}

export function signIn() {
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth(), p);
}
export const logOut = () => signOut(auth());

// A short-lived Google token with Cloud Storage access, for deleting vault
// copies as yourself (the app's own account may not delete in the vault).
export async function storageToken(user: User): Promise<string> {
  if (EMULATORS) return 'owner'; // the Storage emulator's admin token
  const p = new GoogleAuthProvider();
  p.addScope('https://www.googleapis.com/auth/devstorage.read_write');
  p.setCustomParameters({ login_hint: user.email || '' });
  const r = await reauthenticateWithPopup(user, p);
  const token = GoogleAuthProvider.credentialFromResult(r)?.accessToken;
  if (!token) throw new Error('Google did not hand over a storage token.');
  return token;
}
