import { expect, it } from 'vitest';
import { effectiveSavedConnection as saved, mergeDatasourceConnection as merge, datasourceConnectionMetadata as metadata } from './datasource-connection';

const row = { id: 7, kind: 'prometheus', endpoint: 'https://metrics.example/tenant', authType: 'bearer' as const, isDefault: true, settings: { timeoutS: 20 } };
const blob = { endpoint: row.endpoint, token: 'private-token' };

it('derives null row fields only from the own-id blob and prunes dormant auth under explicit none', () => {
  const snapshot = { 7: blob, prometheus: { endpoint: 'https://foreign.example', token: 'foreign' } };
  expect(merge(row.kind, {}, saved({ ...row, endpoint: null, authType: null }, snapshot))).toEqual({ ...blob, authType: 'bearer', timeoutS: 20 });
  expect(merge(row.kind, {}, saved({ ...row, authType: 'none' }, snapshot))).not.toHaveProperty('token');
});

it('permits a default mirror with no id entry for matched or SQL-backfilled null endpoints', () => {
  expect(metadata(row, { prometheus: blob })).toMatchObject({ connected: true, configurationStatus: 'mirror_only' });
  const migrated = { ...row, endpoint: null, authType: null };
  expect(merge(row.kind, {}, saved(migrated, { prometheus: blob }))).toEqual({ ...blob, authType: 'bearer', timeoutS: 20 });
  expect(metadata(migrated, { prometheus: blob })).toMatchObject({ endpoint: blob.endpoint, connected: true, configurationStatus: 'mirror_only' });
  for (const [r, snapshot] of [
    [{ ...row, isDefault: false }, { prometheus: blob }],
    [{ ...migrated, isDefault: false }, { prometheus: blob }],
    [migrated, { 7: {}, prometheus: blob }],
    [row, { 7: {}, prometheus: blob }],
    [row, { 7: null, prometheus: blob }],
    [row, { prometheus: { ...blob, endpoint: row.endpoint + '/other' } }],
    [row, { 7: { ...blob, endpoint: 'https://foreign.example' }, prometheus: blob }],
  ] as const) expect(metadata(r, snapshot).connected).toBe(false);
  expect(merge(row.kind, {}, saved(row, { 7: { ...blob, token: 'own' }, prometheus: blob })).token).toBe('own');
});

it('separates missing/unsafe endpoints from missing authentication without exposing unsafe URLs', () => {
  expect(metadata({ ...row, endpoint: null }, {})).toMatchObject({ endpoint: null, connected: false, configurationStatus: 'endpoint_missing' });
  expect(metadata({ ...row, endpoint: 'https://private-token@metrics.example' }, {})).toMatchObject({ endpoint: null, connected: false, configurationStatus: 'endpoint_invalid' });
  expect(metadata(row, {})).toMatchObject({ endpoint: row.endpoint, connected: false, configurationStatus: 'missing' });
});

it.each(['https://metrics.example/other', 'http://metrics.example/tenant', 'https://metrics.example:444/tenant', 'https://other.example/tenant'])(
  'requires new credentials for endpoint change %s', endpoint => {
    const base = saved(row, { 7: blob });
    expect(() => merge(row.kind, { endpoint, creds: {} }, base)).toThrow(/credentials/);
    expect(merge(row.kind, { endpoint, creds: { token: 'replacement' } }, base).token).toBe('replacement');
  });

it('infers legacy auth shapes and rejects ambiguous credentials', () => {
  for (const [creds, authType] of [[{ username: 'u', password: 'p' }, 'basic'], [{ token: 't' }, 'bearer'],
    [{ headerName: 'X-Key', headerValue: 'v' }, 'custom_header'], [{ authType: 'none', token: 'dormant' }, 'none']] as const) {
    expect(saved({ ...row, authType: null }, { 7: { endpoint: row.endpoint, ...creds } }).authType).toBe(authType);
  }
  expect(metadata({ ...row, authType: null }, { 7: { ...blob, username: 'u' } })).toMatchObject({ authType: null, connected: false });
  expect(metadata({ ...row, authType: null }, { 7: { ...blob, token: null } }).connected).toBe(false);
});

it('merges Datadog keys by header identity, including dedicated legacy keys', () => {
  const dd = { ...row, kind: 'datadog', authType: null };
  const base = saved(dd, { 7: { endpoint: row.endpoint, apiKey: 'api', appKey: 'app' } });
  expect(merge(dd.kind, { creds: { headerName: 'DD-APPLICATION-KEY', headerValue: 'new-app' } }, base)).toMatchObject({
    authType: 'custom_header', headerName: 'DD-API-KEY', headerValue: 'api', headerName2: 'DD-APPLICATION-KEY', headerValue2: 'new-app',
  });
});

it('shares strict settings, header and URL validation without including secret values in errors', () => {
  const base = saved(row, { 7: blob });
  for (const input of [{ settings: { timeoutS: 0 } }, { creds: { token: 'private\nvalue' } }, { endpoint: 'http://169.254.169.254' },
    { authType: 'custom_header', creds: { headerName: 'Host', headerValue: 'private-value' } }]) {
    expect(() => merge(row.kind, input, base)).toThrow();
    try { merge(row.kind, input, base); } catch (e) { expect(String(e)).not.toContain('private-value'); }
  }
  expect(metadata(row, { 7: blob })).not.toHaveProperty('token');
});
