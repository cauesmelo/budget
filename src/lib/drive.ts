import type { FinanceData } from './types';
import { mergeFinanceData } from './finance';
import { serializeBackup, validateBackup } from './storage';
import { APP_ID, LEGACY_APP_ID, DEVICE_STORAGE_KEY, LEGACY_DEVICE_STORAGE_KEY } from './identity';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API_ROOT = 'https://www.googleapis.com/drive/v3';
const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
}
interface GoogleOauth {
  initTokenClient(options: {
    client_id: string;
    scope: string;
    include_granted_scopes: boolean;
    callback: (response: TokenResponse) => void;
    error_callback: (error: { type?: string }) => void;
  }): { requestAccessToken(options?: { prompt?: string }): void };
  hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
  revoke(token: string, callback: () => void): void;
}
interface DriveSession { token: string; expiresAt: number; clientId: string }
interface SnapshotFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime: string;
  appProperties: { app: string; version: string; deviceId: string };
}

let session: DriveSession | undefined;
let authGeneration = 0;
let googleLoader: Promise<GoogleOauth> | undefined;
let connection: { clientId: string; promise: Promise<void> } | undefined;
let cancelAuthorization: (() => void) | undefined;
let syncing = false;
const pendingRequests = new Set<AbortController>();

function googleOauth(): GoogleOauth | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { google?: { accounts?: { oauth2?: GoogleOauth } } }).google?.accounts?.oauth2;
}

function loadGoogle(): Promise<GoogleOauth> {
  const loaded = googleOauth();
  if (loaded) return Promise.resolve(loaded);
  if (googleLoader) return googleLoader;
  googleLoader = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('Connecting to Google Drive requires a browser.'));
      return;
    }
    const scriptId = `${APP_ID}-google-identity`;
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      const oauth = googleOauth();
      if (error || !oauth) {
        // A later button click can try loading the library again.
        if (!existing) script.remove();
        reject(error ?? new Error('Could not initialize the Google connection.'));
      } else resolve(oauth);
    };
    const onLoad = () => finish();
    const onError = () => finish(new Error('Could not load Google. Check your internet connection and try again.'));
    const timer = setTimeout(() => finish(new Error('Google took too long to load. Check your connection and try again.')), 15_000);
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
    if (!existing) {
      script.id = scriptId;
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.referrerPolicy = 'no-referrer-when-downgrade';
      document.head.appendChild(script);
    }
  });
  googleLoader.catch(() => { googleLoader = undefined; });
  return googleLoader;
}

export function isDriveConnected(): boolean {
  return !!session && Date.now() < session.expiresAt;
}

/** Authorizes only this app's hidden Drive folder. Tokens never leave memory. */
export async function connectDrive(clientId: string): Promise<void> {
  const cleanId = clientId.trim();
  if (!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(cleanId)) {
    throw new Error('Enter the OAuth Client ID for the Web application, ending in .apps.googleusercontent.com.');
  }
  if (connection) {
    if (connection.clientId === cleanId) return connection.promise;
    throw new Error('Authorization is already in progress. Wait or disconnect before changing the Client ID.');
  }
  if (isDriveConnected() && session?.clientId === cleanId) return;
  if (session) disconnectDrive();
  const generation = ++authGeneration;
  const promise = (async () => {
    const oauth = await loadGoogle();
    if (generation !== authGeneration) throw new Error('The Google connection was canceled.');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelAuthorization = undefined;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Google authorization timed out. Click connect and complete the authorization window.')), 60_000);
      cancelAuthorization = () => finish(new Error('The Google connection was canceled.'));
      try {
        const tokenClient = oauth.initTokenClient({
          client_id: cleanId,
          scope: DRIVE_SCOPE,
          include_granted_scopes: false,
          callback: response => {
            if (settled || generation !== authGeneration) return;
            if (response.error) {
              finish(new Error(response.error === 'access_denied'
                ? 'Access to the app folder in Drive was not authorized.'
                : 'Google denied authorization. Check the Client ID and origins configured in Google Cloud.'));
              return;
            }
            const lifetime = Number(response.expires_in) * 1000;
            if (!response.access_token || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 86_400_000) {
              finish(new Error('Google did not return a valid authorization. Try connecting again.'));
              return;
            }
            if (!oauth.hasGrantedAllScopes(response, DRIVE_SCOPE)) {
              finish(new Error('Authorize the app folder to sync with Drive.'));
              return;
            }
            session = {
              token: response.access_token,
              clientId: cleanId,
              // Stop a little before the provider expiry to avoid starting expired requests.
              expiresAt: Date.now() + lifetime - Math.min(10_000, lifetime / 10),
            };
            finish();
          },
          error_callback: error => finish(new Error(error.type === 'popup_closed'
            ? 'The Google window was closed before the connection was completed.'
            : 'The Google window did not open. Allow pop-ups for this app and click connect again.')),
        });
        tokenClient.requestAccessToken({ prompt: '' });
      } catch {
        finish(new Error('Could not open Google authorization. Try connecting again.'));
      }
    });
  })();
  connection = { clientId: cleanId, promise };
  try { await promise; } finally {
    if (connection?.promise === promise) connection = undefined;
  }
}

export function disconnectDrive(): void {
  const oldSession = session;
  session = undefined;
  authGeneration += 1;
  cancelAuthorization?.();
  for (const controller of pendingRequests) controller.abort();
  if (oldSession) {
    try { googleOauth()?.revoke(oldSession.token, () => {}); } catch { /* Locally disconnected regardless of network. */ }
  }
}

function requireSession(): DriveSession {
  if (!isDriveConnected() || !session) {
    session = undefined;
    throw new Error('Google authorization expired or is disconnected. Click connect again; your local data is saved.');
  }
  return session;
}

async function readText(response: Response): Promise<string> {
  const length = Number(response.headers.get('Content-Length'));
  if (length > MAX_SNAPSHOT_BYTES) throw new Error('The Drive backup exceeds the 25 MB limit per file.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SNAPSHOT_BYTES) {
        await reader.cancel();
        throw new Error('The Drive backup exceeds the 25 MB limit per file.');
      }
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { reader.releaseLock(); }
}

async function driveRequest(url: string, options: RequestInit = {}): Promise<string> {
  const authorized = requireSession();
  const controller = new AbortController();
  pendingRequests.add(controller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  try {
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${authorized.token}`);
    const response = await fetch(url, { ...options, headers, signal: controller.signal, cache: 'no-store' });
    const body = await readText(response);
    if (session !== authorized) throw new Error('The Drive connection was closed.');
    if (!response.ok) {
      if (response.status === 401) {
        session = undefined;
        throw new Error('Google ended the authorization. Reconnect to sync.');
      }
      let reason = '';
      try { reason = JSON.parse(body)?.error?.errors?.[0]?.reason ?? ''; } catch { /* No response text is exposed. */ }
      if (response.status === 429 || /rateLimit|quota|dailyLimit/i.test(reason)) {
        throw new Error('Drive reached a temporary usage limit. Wait a few minutes and sync again.');
      }
      if (response.status === 403) throw new Error('Drive denied access. Check that the API is enabled and the app folder is authorized.');
      if (response.status === 404) throw new Error('A backup was not found in Drive. It may have been removed; sync again.');
      throw new Error(`Could not sync with Drive (HTTP ${response.status}). Your local data is still saved.`);
    }
    return body;
  } catch (error) {
    if (timedOut) throw new Error('Drive took too long to respond. Your local data is saved; try syncing again.');
    if (controller.signal.aborted) throw new Error('Drive synchronization was canceled.');
    if (error instanceof TypeError) throw new Error('Could not access Drive. Check your internet connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    pendingRequests.delete(controller);
  }
}

function parseDriveJson(text: string): unknown {
  try { return JSON.parse(text); } catch {
    throw new Error('Drive returned an invalid response. Your local data is preserved; try again.');
  }
}

function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing && /^[a-zA-Z0-9_-]{1,100}$/.test(existing)) return existing;
    const legacy = localStorage.getItem(LEGACY_DEVICE_STORAGE_KEY);
    if (legacy && /^[a-zA-Z0-9_-]{1,100}$/.test(legacy)) {
      localStorage.setItem(DEVICE_STORAGE_KEY, legacy);
      return legacy;
    }
    const created = crypto.randomUUID();
    localStorage.setItem(DEVICE_STORAGE_KEY, created);
    return created;
  } catch {
    throw new Error('The browser blocked local storage. Enable it to identify this computer during synchronization.');
  }
}

function snapshotFile(value: unknown): SnapshotFile {
  const file = value as Partial<SnapshotFile> | null;
  if (!file || typeof file.id !== 'string' || !file.id || typeof file.name !== 'string'
      || file.mimeType !== 'application/json' || typeof file.modifiedTime !== 'string'
      || !Number.isFinite(Date.parse(file.modifiedTime)) || !file.appProperties || ![APP_ID, LEGACY_APP_ID].includes(file.appProperties.app)
      || typeof file.appProperties.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(file.appProperties.deviceId)) {
    throw new Error('An app backup in Drive has invalid metadata. No new data was uploaded.');
  }
  if (file.appProperties.version !== '1') {
    throw new Error('A Drive backup uses another app version. Update the app before syncing.');
  }
  if (file.size !== undefined && (!/^\d+$/.test(file.size) || Number(file.size) > MAX_SNAPSHOT_BYTES)) {
    throw new Error('A Drive backup has an invalid size or exceeds 25 MB. No new data was uploaded.');
  }
  return file as SnapshotFile;
}

async function latestSnapshots(): Promise<SnapshotFile[]> {
  const latest = new Map<string, SnapshotFile>();
  const visitedTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `trashed = false and (appProperties has { key='app' and value='${APP_ID}' } or appProperties has { key='app' and value='${LEGACY_APP_ID}' })`,
      fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,appProperties)',
      pageSize: '1000',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const page = parseDriveJson(await driveRequest(`${API_ROOT}/files?${query}`));
    if (!page || typeof page !== 'object' || !Array.isArray((page as { files?: unknown }).files)) {
      throw new Error('Drive returned an invalid backup list. No new data was uploaded.');
    }
    const parsed = page as { files: unknown[]; nextPageToken?: unknown; incompleteSearch?: boolean };
    if (parsed.incompleteSearch) throw new Error('Drive could not list every backup. Try again before uploading your data.');
    for (const entry of parsed.files) {
      const file = snapshotFile(entry);
      const previous = latest.get(file.appProperties.deviceId);
      const time = Date.parse(file.modifiedTime);
      const previousTime = previous ? Date.parse(previous.modifiedTime) : 0;
      if (!previous || time > previousTime || (time === previousTime && file.id > previous.id)) {
        latest.set(file.appProperties.deviceId, file);
      }
    }
    if (parsed.nextPageToken !== undefined && (typeof parsed.nextPageToken !== 'string' || !parsed.nextPageToken)) {
      throw new Error('Drive returned invalid pagination. No new data was uploaded.');
    }
    pageToken = parsed.nextPageToken as string | undefined;
    if (pageToken && visitedTokens.has(pageToken)) throw new Error('Drive repeated a page of backups. Try syncing again.');
    if (pageToken) visitedTokens.add(pageToken);
  } while (pageToken);
  return [...latest.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, file]) => file);
}

async function syncSnapshots(data: FinanceData): Promise<{ data: FinanceData; syncedAt: string }> {
  requireSession();
  const ownDeviceId = deviceId();
  const files = await latestSnapshots();
  const remoteData = await Promise.all(files.map(async file => {
    const content = await driveRequest(`${API_ROOT}/files/${encodeURIComponent(file.id)}?alt=media`);
    try { return validateBackup(JSON.parse(content)); } catch {
      throw new Error('The latest Drive backup from a computer is invalid. No new data was uploaded; your local data is preserved.');
    }
  }));
  let merged = validateBackup(data);
  // mergeFinanceData preserves the local public Client ID, which is not cloud data.
  for (const remote of remoteData) merged = mergeFinanceData(merged, remote);
  const payload = serializeBackup(merged);
  if (new Blob([payload]).size > MAX_SNAPSHOT_BYTES) throw new Error('The data exceeds 25 MB. Export a backup and reduce the history before syncing.');
  const boundary = `${APP_ID}_${crypto.randomUUID().replaceAll('-', '')}`;
  const metadata = {
    name: `${APP_ID}-${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}.json`,
    mimeType: 'application/json',
    parents: ['appDataFolder'],
    appProperties: { app: APP_ID, version: '1', deviceId: ownDeviceId },
  };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
  // Every sync creates a fresh file. Never update or delete a remote snapshot.
  const created = parseDriveJson(await driveRequest(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  }));
  if (!created || typeof created !== 'object' || typeof (created as { id?: unknown }).id !== 'string') {
    throw new Error('Drive did not confirm the new backup. Try syncing again; previous backups were preserved.');
  }
  const modifiedTime = (created as { modifiedTime?: unknown }).modifiedTime;
  return { data: merged, syncedAt: typeof modifiedTime === 'string' && Number.isFinite(Date.parse(modifiedTime)) ? modifiedTime : new Date().toISOString() };
}

/** Merges the latest snapshot of every device, then appends one complete snapshot. */
export async function syncDrive(data: FinanceData): Promise<{ data: FinanceData; syncedAt: string }> {
  if (syncing) throw new Error('Synchronization is already in progress. Wait for it to finish.');
  const authorized = requireSession();
  const sync = () => {
    if (session !== authorized) throw new Error('Synchronization was canceled because the Google connection changed.');
    return syncSnapshots(data);
  };
  syncing = true;
  try {
    // Tabs of one browser share a device ID. A cross-tab lock makes each tab see
    // the preceding snapshot before creating its own, when Web Locks is supported.
    if (typeof navigator !== 'undefined' && navigator.locks) {
      const controller = new AbortController();
      pendingRequests.add(controller);
      let lockTimedOut = false;
      const timer = setTimeout(() => { lockTimedOut = true; controller.abort(); }, 30_000);
      try {
        return await navigator.locks.request(`${APP_ID}.drive.sync`, { signal: controller.signal }, () => {
          clearTimeout(timer);
          return sync();
        });
      } catch (error) {
        if (lockTimedOut) throw new Error('Another tab has been syncing for some time. Close it or wait for it to finish before trying again.');
        if (controller.signal.aborted) throw new Error('Drive synchronization was canceled.');
        throw error;
      } finally {
        clearTimeout(timer);
        pendingRequests.delete(controller);
      }
    }
    return await sync();
  } finally { syncing = false; }
}
