// web/lib/ssrf-guard.test.ts
import { describe, it, expect } from 'vitest';
import { isBlockedHost, assertEgressEndpointAllowed } from './ssrf-guard';

describe('isBlockedHost (ADR-011 blocklist)', () => {
  it('blocks private/link-local/loopback/metadata IPv4', () => {
    for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '127.0.0.1']) {
      expect(isBlockedHost(ip)).toBe(true);
    }
  });
  it('allows public IPv4 and the just-outside-range edges', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.0.1', '169.253.0.1']) {
      expect(isBlockedHost(ip)).toBe(false);
    }
  });
  it('blocks IPv6 loopback / ULA / link-local (incl. bracketed)', () => {
    expect(isBlockedHost('::1')).toBe(true);
    expect(isBlockedHost('[::1]')).toBe(true);
    expect(isBlockedHost('fc00::1')).toBe(true);
    expect(isBlockedHost('fd12:3456::1')).toBe(true);
    expect(isBlockedHost('fe80::1')).toBe(true);
    expect(isBlockedHost('::ffff:169.254.169.254')).toBe(true); // IPv4-mapped
  });
  it('treats non-literal hostnames as not-blocked (DNS resolution is connection-time)', () => {
    expect(isBlockedHost('grafana.example.com')).toBe(false);
    expect(isBlockedHost('api.datadoghq.com')).toBe(false);
  });
});

describe('assertEgressEndpointAllowed', () => {
  it('throws on non-https', () => {
    expect(() => assertEgressEndpointAllowed('http://grafana.example.com')).toThrow(/https/);
  });
  it('throws on an invalid URL', () => {
    expect(() => assertEgressEndpointAllowed('not a url')).toThrow(/valid URL/);
  });
  it('throws on a private/metadata literal host unless allowPrivate', () => {
    expect(() => assertEgressEndpointAllowed('https://169.254.169.254/latest/meta-data')).toThrow(/private\/metadata/);
    expect(() => assertEgressEndpointAllowed('https://10.0.0.5:3000')).toThrow(/private/);
    // opt-in permits it (the legitimate private-datasource case)
    expect(() => assertEgressEndpointAllowed('https://10.0.0.5:3000', { allowPrivate: true })).not.toThrow();
  });
  it('allows a public https endpoint', () => {
    expect(() => assertEgressEndpointAllowed('https://api.datadoghq.com/api/v1')).not.toThrow();
  });
});
