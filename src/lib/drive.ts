import type { FinanceData } from './types';
import { mergeFinanceData } from './finance';
import { serializeBackup, validateBackup } from './storage';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DEVICE_STORAGE_KEY = 'reserva.drive.deviceId';
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
      reject(new Error('A conexão com o Google Drive precisa de um navegador.'));
      return;
    }
    const scriptId = 'reserva-google-identity';
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
        reject(error ?? new Error('Não foi possível iniciar a conexão com o Google.'));
      } else resolve(oauth);
    };
    const onLoad = () => finish();
    const onError = () => finish(new Error('Não foi possível carregar o Google. Verifique sua internet e tente novamente.'));
    const timer = setTimeout(() => finish(new Error('O Google demorou para carregar. Verifique sua conexão e tente novamente.')), 15_000);
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
    throw new Error('Informe o Client ID OAuth da aplicação Web, terminado em .apps.googleusercontent.com.');
  }
  if (connection) {
    if (connection.clientId === cleanId) return connection.promise;
    throw new Error('Já existe uma autorização em andamento. Aguarde ou desconecte antes de trocar o Client ID.');
  }
  if (isDriveConnected() && session?.clientId === cleanId) return;
  if (session) disconnectDrive();
  const generation = ++authGeneration;
  const promise = (async () => {
    const oauth = await loadGoogle();
    if (generation !== authGeneration) throw new Error('A conexão com o Google foi cancelada.');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelAuthorization = undefined;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('A autorização do Google expirou. Clique em conectar e conclua a janela de autorização.')), 60_000);
      cancelAuthorization = () => finish(new Error('A conexão com o Google foi cancelada.'));
      try {
        const tokenClient = oauth.initTokenClient({
          client_id: cleanId,
          scope: DRIVE_SCOPE,
          include_granted_scopes: false,
          callback: response => {
            if (settled || generation !== authGeneration) return;
            if (response.error) {
              finish(new Error(response.error === 'access_denied'
                ? 'Você não autorizou o acesso à pasta do aplicativo no Drive.'
                : 'O Google recusou a autorização. Confira o Client ID e as origens cadastradas no Google Cloud.'));
              return;
            }
            const lifetime = Number(response.expires_in) * 1000;
            if (!response.access_token || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 86_400_000) {
              finish(new Error('O Google não retornou uma autorização válida. Tente conectar novamente.'));
              return;
            }
            if (!oauth.hasGrantedAllScopes(response, DRIVE_SCOPE)) {
              finish(new Error('Autorize a pasta própria do aplicativo para sincronizar com o Drive.'));
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
            ? 'A janela do Google foi fechada antes de concluir a conexão.'
            : 'A janela do Google não abriu. Permita pop-ups para este aplicativo e clique em conectar novamente.')),
        });
        tokenClient.requestAccessToken({ prompt: '' });
      } catch {
        finish(new Error('Não foi possível abrir a autorização do Google. Tente conectar novamente.'));
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
    throw new Error('A autorização do Google expirou ou está desconectada. Clique em conectar novamente; seus dados locais estão salvos.');
  }
  return session;
}

async function readText(response: Response): Promise<string> {
  const length = Number(response.headers.get('Content-Length'));
  if (length > MAX_SNAPSHOT_BYTES) throw new Error('O backup no Drive supera o limite de 25 MB por arquivo.');
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
        throw new Error('O backup no Drive supera o limite de 25 MB por arquivo.');
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
    if (session !== authorized) throw new Error('A conexão com o Drive foi encerrada.');
    if (!response.ok) {
      if (response.status === 401) {
        session = undefined;
        throw new Error('O Google encerrou a autorização. Conecte novamente para sincronizar.');
      }
      let reason = '';
      try { reason = JSON.parse(body)?.error?.errors?.[0]?.reason ?? ''; } catch { /* No response text is exposed. */ }
      if (response.status === 429 || /rateLimit|quota|dailyLimit/i.test(reason)) {
        throw new Error('O Drive atingiu um limite temporário de uso. Aguarde alguns minutos e sincronize novamente.');
      }
      if (response.status === 403) throw new Error('O Drive recusou o acesso. Confira se a API está habilitada e se a pasta do aplicativo foi autorizada.');
      if (response.status === 404) throw new Error('Um backup não foi encontrado no Drive. Ele pode ter sido removido; sincronize novamente.');
      throw new Error(`Não foi possível sincronizar com o Drive (HTTP ${response.status}). Seus dados locais permanecem salvos.`);
    }
    return body;
  } catch (error) {
    if (timedOut) throw new Error('O Drive demorou para responder. Seus dados locais estão salvos; tente sincronizar novamente.');
    if (controller.signal.aborted) throw new Error('A sincronização com o Drive foi cancelada.');
    if (error instanceof TypeError) throw new Error('Não foi possível acessar o Drive. Verifique sua internet e tente novamente.');
    throw error;
  } finally {
    clearTimeout(timer);
    pendingRequests.delete(controller);
  }
}

function parseDriveJson(text: string): unknown {
  try { return JSON.parse(text); } catch {
    throw new Error('O Drive retornou uma resposta inválida. Seus dados locais estão preservados; tente novamente.');
  }
}

function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing && /^[a-zA-Z0-9_-]{1,100}$/.test(existing)) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(DEVICE_STORAGE_KEY, created);
    return created;
  } catch {
    throw new Error('O navegador bloqueou o armazenamento local. Libere-o para identificar este computador na sincronização.');
  }
}

function snapshotFile(value: unknown): SnapshotFile {
  const file = value as Partial<SnapshotFile> | null;
  if (!file || typeof file.id !== 'string' || !file.id || typeof file.name !== 'string'
      || file.mimeType !== 'application/json' || typeof file.modifiedTime !== 'string'
      || !Number.isFinite(Date.parse(file.modifiedTime)) || file.appProperties?.app !== 'reserva'
      || typeof file.appProperties.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(file.appProperties.deviceId)) {
    throw new Error('Um backup do aplicativo no Drive tem metadados inválidos. Nenhum dado novo foi enviado.');
  }
  if (file.appProperties.version !== '1') {
    throw new Error('Um backup do Drive usa outra versão do aplicativo. Atualize o programa antes de sincronizar.');
  }
  if (file.size !== undefined && (!/^\d+$/.test(file.size) || Number(file.size) > MAX_SNAPSHOT_BYTES)) {
    throw new Error('Um backup no Drive tem tamanho inválido ou supera 25 MB. Nenhum dado novo foi enviado.');
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
      q: "trashed = false and appProperties has { key='app' and value='reserva' }",
      fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,appProperties)',
      pageSize: '1000',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const page = parseDriveJson(await driveRequest(`${API_ROOT}/files?${query}`));
    if (!page || typeof page !== 'object' || !Array.isArray((page as { files?: unknown }).files)) {
      throw new Error('O Drive retornou uma lista de backups inválida. Nenhum dado novo foi enviado.');
    }
    const parsed = page as { files: unknown[]; nextPageToken?: unknown; incompleteSearch?: boolean };
    if (parsed.incompleteSearch) throw new Error('O Drive não conseguiu listar todos os backups. Tente novamente antes de enviar seus dados.');
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
      throw new Error('O Drive retornou uma paginação inválida. Nenhum dado novo foi enviado.');
    }
    pageToken = parsed.nextPageToken as string | undefined;
    if (pageToken && visitedTokens.has(pageToken)) throw new Error('O Drive repetiu uma página de backups. Tente sincronizar novamente.');
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
      throw new Error('O último backup de um computador no Drive está inválido. Nenhum dado novo foi enviado; seus dados locais estão preservados.');
    }
  }));
  let merged = validateBackup(data);
  // mergeFinanceData preserves the local public Client ID, which is not cloud data.
  for (const remote of remoteData) merged = mergeFinanceData(merged, remote);
  const payload = serializeBackup(merged);
  if (new Blob([payload]).size > MAX_SNAPSHOT_BYTES) throw new Error('Os dados superam 25 MB. Exporte um backup e reduza o histórico antes de sincronizar.');
  const boundary = `reserva_${crypto.randomUUID().replaceAll('-', '')}`;
  const metadata = {
    name: `reserva-${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}.json`,
    mimeType: 'application/json',
    parents: ['appDataFolder'],
    appProperties: { app: 'reserva', version: '1', deviceId: ownDeviceId },
  };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
  // Every sync creates a fresh file. Never update or delete a remote snapshot.
  const created = parseDriveJson(await driveRequest(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  }));
  if (!created || typeof created !== 'object' || typeof (created as { id?: unknown }).id !== 'string') {
    throw new Error('O Drive não confirmou o novo backup. Tente sincronizar novamente; os backups anteriores foram preservados.');
  }
  const modifiedTime = (created as { modifiedTime?: unknown }).modifiedTime;
  return { data: merged, syncedAt: typeof modifiedTime === 'string' && Number.isFinite(Date.parse(modifiedTime)) ? modifiedTime : new Date().toISOString() };
}

/** Merges the latest snapshot of every device, then appends one complete snapshot. */
export async function syncDrive(data: FinanceData): Promise<{ data: FinanceData; syncedAt: string }> {
  if (syncing) throw new Error('Uma sincronização já está em andamento. Aguarde a conclusão.');
  const authorized = requireSession();
  const sync = () => {
    if (session !== authorized) throw new Error('A sincronização foi cancelada porque a conexão com o Google mudou.');
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
        return await navigator.locks.request('reserva.drive.sync', { signal: controller.signal }, () => {
          clearTimeout(timer);
          return sync();
        });
      } catch (error) {
        if (lockTimedOut) throw new Error('Outra aba está sincronizando há algum tempo. Feche-a ou aguarde a conclusão antes de tentar novamente.');
        if (controller.signal.aborted) throw new Error('A sincronização com o Drive foi cancelada.');
        throw error;
      } finally {
        clearTimeout(timer);
        pendingRequests.delete(controller);
      }
    }
    return await sync();
  } finally { syncing = false; }
}
