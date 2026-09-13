import { buildAuthHeaders, normalizeDatadogHeaderSlots, type AuthType } from './datasource-auth';
import { assertDatasourceEndpointAllowed } from './ssrf-guard';

export interface DsSettings { timeoutS?: number; database?: string }
export function sanitizeDsSettings(input: unknown): DsSettings {
  const o = object(input) ? input : {};
  const out: DsSettings = {};
  if (typeof o.timeoutS === 'number' && Number.isInteger(o.timeoutS) && o.timeoutS >= 1 && o.timeoutS <= 60) out.timeoutS = o.timeoutS;
  if (typeof o.database === 'string' && o.database.length <= 128 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(o.database)
    && !['system', 'information_schema'].includes(o.database.toLowerCase())) out.database = o.database;
  return out;
}
const AUTH_KEYS: Record<AuthType, string[]> = {
  none: [], basic: ['username', 'password'], bearer: ['token'],
  custom_header: ['headerName', 'headerValue', 'headerName2', 'headerValue2'],
};
const CRED_KEYS = [...Object.values(AUTH_KEYS).flat(), 'org_id', 'apiKey', 'appKey'];
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const auth = (v: unknown): v is AuthType => typeof v === 'string' && Object.hasOwn(AUTH_KEYS, v);
export class ConnectionInputError extends Error {}
interface Row {
  id: number; kind: string; endpoint: string | null; authType: AuthType | null;
  isDefault: boolean; settings?: DsSettings;
}
interface Saved {
  endpoint: string; authType: AuthType | undefined; creds: Record<string, unknown>;
  settings: DsSettings; source: 'id' | 'mirror' | 'none';
}
function inferAuth(blob: Record<string, unknown>): AuthType | undefined {
  if (blob.authType != null) return auth(blob.authType) ? blob.authType : undefined;
  const methods = (['basic', 'bearer', 'custom_header'] as const)
    .filter(method => AUTH_KEYS[method].some(key => Object.hasOwn(blob, key))
      || (method === 'custom_header' && ['apiKey', 'appKey'].some(key => Object.hasOwn(blob, key))));
  return methods.length === 1 ? methods[0] : methods.length === 0 ? 'none' : undefined;
}

/** Row fields win. Only an own-id blob can supply a missing endpoint. A mirror requires
 * default membership, no id entry at all, and an explicit exact row endpoint match. */
export function effectiveSavedConnection(row: Row, snapshot: Record<string, unknown>): Saved {
  const own = Object.hasOwn(snapshot, String(row.id));
  const mirror = snapshot[row.kind];
  const source = own ? 'id' : row.isDefault && !!row.endpoint && object(mirror)
    && mirror.endpoint === row.endpoint ? 'mirror' : 'none';
  const selected = source === 'id' ? snapshot[String(row.id)] : source === 'mirror' ? mirror : {};
  const raw = object(selected) ? selected : {};
  const endpoint = row.endpoint ?? (source === 'id' && typeof raw.endpoint === 'string' ? raw.endpoint : '');
  const bound = !Object.hasOwn(raw, 'endpoint') || raw.endpoint === endpoint;
  const creds = bound ? (row.kind === 'datadog' ? normalizeDatadogHeaderSlots(raw) : raw) : {};
  const authType = row.authType ?? (source !== 'none' && object(selected) && bound ? inferAuth(creds) : undefined);
  const keys = [...(authType ? AUTH_KEYS[authType] : []), 'org_id'];
  return { endpoint, authType, creds: Object.fromEntries(keys.filter(k => Object.hasOwn(creds, k)).map(k => [k, creds[k]])),
    source, settings: sanitizeDsSettings(row.settings) };
}

/** Identical Test/Save validation and merge. Invalid input errors are fixed messages, never secrets. */
export function mergeDatasourceConnection(kind: string, input: Record<string, unknown>, saved?: Saved) {
  const fail = (message: string): never => { throw new ConnectionInputError(message); };
  const endpoint = input.endpoint === undefined ? saved?.endpoint ?? '' : typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  try { assertDatasourceEndpointAllowed(endpoint); }
  catch { fail('Use a valid HTTP(S) API base URL without credentials, query parameters or fragments.'); }
  const authType = input.authType === undefined ? saved ? saved.authType : 'none' : input.authType;
  if (!auth(authType)) return fail('Select a valid authentication method.');
  if (input.creds !== undefined && !object(input.creds)) return fail('creds must be an object');
  if (input.settings !== undefined && !object(input.settings)) return fail('settings must be an object');
  const settings = sanitizeDsSettings(input.settings ?? saved?.settings);
  if (kind !== 'clickhouse') delete settings.database;
  const requestedSettings = input.settings;
  if (object(requestedSettings) && Object.keys(requestedSettings).some(key => settings[key as keyof DsSettings] !== requestedSettings[key])) {
    return fail('Invalid settings: timeoutS must be 1–60; database must be a non-system ClickHouse identifier.');
  }
  const incoming = object(input.creds) ? input.creds : {};
  const base = saved?.endpoint === endpoint ? saved.creds : {};
  const merged = kind === 'datadog' ? normalizeDatadogHeaderSlots(base, incoming) : { ...base, ...incoming };
  const creds: Record<string, string> = {};
  for (const key of CRED_KEYS) {
    if (!AUTH_KEYS[authType].includes(key) && !(key === 'org_id' && ['loki', 'tempo', 'mimir'].includes(kind))) continue;
    const value = merged[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return fail('Invalid credential value.');
    creds[key] = value;
  }
  if ((authType === 'bearer' && !creds.token?.trim()) || (authType === 'basic' && !creds.username?.trim())
    || (authType === 'custom_header' && (!creds.headerName || !creds.headerValue || Boolean(creds.headerName2) !== Boolean(creds.headerValue2)))) {
    return fail('Enter the required credentials. Stored credentials are only reused for the unchanged endpoint.');
  }
  try { buildAuthHeaders(authType, creds); } catch { return fail('Invalid authentication headers.'); }
  return { endpoint, authType, ...creds, ...settings };
}

/** Secret-free projection, from the same snapshot and resolution rules as Test/Save. */
export function datasourceConnectionMetadata(row: Row, snapshot: Record<string, unknown>) {
  const saved = effectiveSavedConnection(row, snapshot);
  let endpoint: string | null = null;
  try { assertDatasourceEndpointAllowed(saved.endpoint); endpoint = saved.endpoint; } catch { /* never expose URL-embedded secrets */ }
  let connected = false;
  try { mergeDatasourceConnection(row.kind, {}, saved); connected = true; } catch { /* incomplete configuration */ }
  return { endpoint, authType: saved.authType ?? null, connected,
    configurationStatus: connected ? saved.source === 'mirror' ? 'mirror_only' : 'stored' : 'missing' };
}
