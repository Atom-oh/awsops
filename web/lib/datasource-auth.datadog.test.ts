import { it, expect } from 'vitest';
import { normalizeDatadogHeaderSlots } from './datasource-auth';

it('normalizes a legacy swapped Datadog pair without changing other configuration', () => {
  expect(normalizeDatadogHeaderSlots({
    endpoint: 'https://api.datadoghq.eu',
    headerName: 'DD-APPLICATION-KEY', headerValue: 'old-app',
    headerName2: 'dd-api-key', headerValue2: 'old-api',
  })).toEqual({
    endpoint: 'https://api.datadoghq.eu',
    headerName: 'DD-API-KEY', headerValue: 'old-api',
    headerName2: 'DD-APPLICATION-KEY', headerValue2: 'old-app',
  });
  const custom = { headerName: 'X-Proxy-Key', headerValue: 'proxy' };
  expect(normalizeDatadogHeaderSlots(custom)).toEqual(custom);
});

it.each([
  { headerName: 'DD-APPLICATION-KEY', headerValue: 'new-app' },
  { headerName2: 'DD-APPLICATION-KEY', headerValue2: 'new-app' },
  { appKey: 'new-app' },
])('rotates the application key by identity without changing the API key', update => {
  expect(normalizeDatadogHeaderSlots({
    apiKey: 'api', appKey: 'app', headerName: 'DD-APPLICATION-KEY', headerValue: 'stale-app',
    headerName2: 'DD-API-KEY', headerValue2: 'stale-api',
  }, update)).toEqual({ headerName: 'DD-API-KEY', headerValue: 'api',
    headerName2: 'DD-APPLICATION-KEY', headerValue2: 'new-app' });
});
