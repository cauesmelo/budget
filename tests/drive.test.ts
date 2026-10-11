import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyData } from '../src/lib/finance';
import type { FinanceData, Transaction } from '../src/lib/types';

const CLIENT_ID = '123-example.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const NOW = '2026-10-11T20:00:00.000Z';
type AuthorizationOptions = {
  client_id: string;
  scope: string;
  include_granted_scopes: boolean;
  callback: (response: { access_token?: string; expires_in?: number; scope?: string; error?: string }) => void;
  error_callback: (error: { type: string }) => void;
};
let authorize: AuthorizationOptions;
let tokenResponse: { access_token: string; expires_in: number; scope: string } | undefined;
let drive: typeof import('../src/lib/drive');
let stored: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
let revoke: ReturnType<typeof vi.fn>;

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function metadata(id: string, deviceId: string, modifiedTime = NOW) {
  return { id, name: `${id}.json`, mimeType: 'application/json', size: '1000', modifiedTime, appProperties: { app: 'reserva', version: '1', deviceId } };
}
function transaction(id: string, extra: Partial<Transaction> = {}): Transaction {
  return {
    id, fingerprint: id, date: '2026-10-11', month: '2026-10', amountCents: -1200,
    kind: 'expense', source: 'manual', account: 'Conta', originalDescription: id,
    description: id, category: 'Mercado', updatedAt: NOW, ...extra,
  };
}
function data(...entries: Transaction[]): FinanceData {
  const result = createEmptyData(new Date(NOW));
  result.transactions = entries;
  result.settings.googleClientId = CLIENT_ID;
  return result;
}
function uploadedData(): FinanceData {
  const request = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
  expect(request).toBeDefined();
  const multipart = request![1].body as string;
  const payload = multipart.split('Content-Type: application/json; charset=UTF-8\r\n\r\n')[2].split('\r\n--')[0];
  return JSON.parse(payload);
}

beforeEach(async () => {
  vi.resetModules();
  stored = new Map();
  tokenResponse = { access_token: 'in-memory-token', expires_in: 3600, scope: SCOPE };
  revoke = vi.fn();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('window', {
    google: { accounts: { oauth2: {
      initTokenClient: (options: AuthorizationOptions) => {
        authorize = options;
        return { requestAccessToken: () => { if (tokenResponse) options.callback(tokenResponse); } };
      },
      hasGrantedAllScopes: (value: { scope?: string }, scope: string) => value.scope?.split(' ').includes(scope),
      revoke,
    } } },
  });
  drive = await import('../src/lib/drive');
});
afterEach(() => {
  drive.disconnectDrive();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('autorização Google Drive', () => {
  it('pede apenas appdata, não persiste tokens e revoga ao desconectar', async () => {
    await drive.connectDrive(CLIENT_ID);
    expect(authorize.scope).toBe(SCOPE);
    expect(authorize.include_granted_scopes).toBe(false);
    expect(drive.isDriveConnected()).toBe(true);
    expect(stored.size).toBe(0);
    drive.disconnectDrive();
    expect(drive.isDriveConnected()).toBe(false);
    expect(revoke).toHaveBeenCalledWith('in-memory-token', expect.any(Function));
  });

  it('expira a sessão e não inicia requests com token expirado', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    await drive.connectDrive(CLIENT_ID);
    vi.advanceTimersByTime(3_590_000);
    expect(drive.isDriveConnected()).toBe(false);
    await expect(drive.syncDrive(data())).rejects.toThrow('expirou');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('informa fechamento e timeout sem deixar uma sessão pendente', async () => {
    tokenResponse = undefined;
    const closed = drive.connectDrive(CLIENT_ID);
    await Promise.resolve();
    authorize.error_callback({ type: 'popup_closed' });
    await expect(closed).rejects.toThrow('fechada');
    vi.useFakeTimers();
    const waiting = drive.connectDrive(CLIENT_ID);
    const rejected = expect(waiting).rejects.toThrow('expirou');
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(drive.isDriveConnected()).toBe(false);
  });

  it('recusa uma autorização sem o escopo solicitado', async () => {
    tokenResponse = { access_token: 'other-token', expires_in: 3600, scope: 'openid' };
    await expect(drive.connectDrive(CLIENT_ID)).rejects.toThrow('pasta própria');
    expect(drive.isDriveConnected()).toBe(false);
  });
});

describe('snapshots append-only', () => {
  it('pagina, escolhe o último de cada dispositivo e reúne dados antes de criar um arquivo', async () => {
    await drive.connectDrive(CLIENT_ID);
    stored.set('reserva.drive.deviceId', 'local-device');
    const local = data(transaction('local'), transaction('shared'));
    const remoteA = data(transaction('device-a'), transaction('shared', { category: 'Apagado', deletedAt: '2026-10-12T20:00:00.000Z' }));
    const remoteB = data(transaction('device-b'));
    const downloaded: string[] = [];
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      const request = new URL(url);
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer in-memory-token');
      if (request.pathname === '/drive/v3/files') {
        expect(request.searchParams.get('spaces')).toBe('appDataFolder');
        expect(request.searchParams.get('q')).toContain("value='reserva'");
        if (!request.searchParams.has('pageToken')) return response({ files: [metadata('old-a', 'a', '2026-10-10T20:00:00.000Z'), metadata('new-a', 'a')], nextPageToken: 'page-2' });
        return response({ files: [metadata('aaa-b', 'b'), metadata('zzz-b', 'b')] });
      }
      if (request.searchParams.get('alt') === 'media') {
        downloaded.push(request.pathname);
        return response(request.pathname.endsWith('/new-a') ? remoteA : remoteB);
      }
      expect(options?.method).toBe('POST');
      const body = String(options?.body);
      expect(body).toContain('"parents":["appDataFolder"]');
      expect(body).toContain('"deviceId":"local-device"');
      return response({ id: 'created', modifiedTime: NOW });
    });
    const result = await drive.syncDrive(local);
    expect(downloaded.sort()).toEqual(['/drive/v3/files/new-a', '/drive/v3/files/zzz-b']);
    expect(result.data.transactions.map(entry => entry.id)).toEqual(['device-a', 'device-b', 'local', 'shared']);
    expect(result.data.transactions.find(entry => entry.id === 'shared')?.deletedAt).toBe('2026-10-12T20:00:00.000Z');
    expect(result.data.settings.googleClientId).toBe(CLIENT_ID);
    expect(uploadedData().settings.googleClientId).toBe('');
    expect(JSON.stringify(uploadedData())).not.toContain('in-memory-token');
    expect(result.syncedAt).toBe(NOW);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([, options]) => ['PATCH', 'DELETE', 'PUT'].includes(options?.method ?? ''))).toBe(false);
  });

  it('não envia dados quando o último backup de qualquer dispositivo está inválido', async () => {
    await drive.connectDrive(CLIENT_ID);
    fetchMock.mockResolvedValueOnce(response({ files: [metadata('corrupt', 'other-device')] })).mockResolvedValueOnce(response({ version: 1, transactions: 'invalid' }));
    const local = data(transaction('preserved'));
    await expect(drive.syncDrive(local)).rejects.toThrow('Nenhum dado novo foi enviado');
    expect(local.transactions[0].id).toBe('preserved');
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('cria nomes únicos e conserva o ID do dispositivo entre sincronizações', async () => {
    await drive.connectDrive(CLIENT_ID);
    fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => options?.method === 'POST'
      ? response({ id: crypto.randomUUID(), modifiedTime: NOW }) : response({ files: [] }));
    await drive.syncDrive(data());
    const id = stored.get('reserva.drive.deviceId');
    await drive.syncDrive(data());
    expect(stored.get('reserva.drive.deviceId')).toBe(id);
    const uploads = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    const extractMetadata = (body: string) => JSON.parse(body.split('Content-Type: application/json; charset=UTF-8\r\n\r\n')[1].split('\r\n--')[0]);
    const first = extractMetadata(uploads[0][1].body);
    const second = extractMetadata(uploads[1][1].body);
    expect(first.name).not.toBe(second.name);
    expect(first.appProperties.deviceId).toBe(second.appProperties.deviceId);
    expect([...stored.values()]).not.toContain('in-memory-token');
  });

  it('não continua uma sync enfileirada se a conexão mudou enquanto aguardava outra aba', async () => {
    await drive.connectDrive(CLIENT_ID);
    let release: (() => Promise<{ data: FinanceData; syncedAt: string }>) | undefined;
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: { signal: AbortSignal }, callback: () => Promise<{ data: FinanceData; syncedAt: string }>) => new Promise((resolve, reject) => { release = async () => { try { const result = await callback(); resolve(result); return result; } catch (error) { reject(error); throw error; } }; }) } });
    const pending = drive.syncDrive(data());
    drive.disconnectDrive();
    await drive.connectDrive(CLIENT_ID);
    const rejected = expect(pending).rejects.toThrow('cancelada');
    await expect(release!()).rejects.toThrow('conexão com o Google mudou');
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('informa falhas HTTP e invalida uma sessão recusada pelo Google', async () => {
    await drive.connectDrive(CLIENT_ID);
    fetchMock.mockResolvedValueOnce(response({ error: { message: 'never shown' } }, 401));
    await expect(drive.syncDrive(data())).rejects.toThrow('Conecte novamente');
    expect(drive.isDriveConnected()).toBe(false);
    await drive.connectDrive(CLIENT_ID);
    fetchMock.mockResolvedValueOnce(response({}, 429));
    await expect(drive.syncDrive(data())).rejects.toThrow('limite temporário');
  });

  it('permite cancelar a espera por outra aba sem iniciar requests', async () => {
    await drive.connectDrive(CLIENT_ID);
    vi.stubGlobal('navigator', { locks: { request: (_name: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }) } });
    const pending = drive.syncDrive(data());
    const rejected = expect(pending).rejects.toThrow('cancelada');
    drive.disconnectDrive();
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('traduz resposta JSON inválida e não publica um backup nessa situação', async () => {
    await drive.connectDrive(CLIENT_ID);
    fetchMock.mockResolvedValueOnce(new Response('not JSON'));
    await expect(drive.syncDrive(data())).rejects.toThrow('resposta inválida');
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });
});
