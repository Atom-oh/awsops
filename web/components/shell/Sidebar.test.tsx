import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// Task 28 — nav contract: the Integrations hub replaces the standalone Datasources + Custom Agents
// entries across all three nav surfaces. A source-level assertion (Sidebar pulls in many providers that
// would make a render test heavy) locks the contract so a regression fails CI.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('nav fold-in to the Integrations hub', () => {
  it('Sidebar FIXED has /integrations and not the standalone /datasources or /customization', () => {
    const src = read('./Sidebar.tsx');
    const fixed = src.slice(src.indexOf('const FIXED'), src.indexOf('];', src.indexOf('const FIXED')));
    expect(fixed).toContain("'/integrations'");
    expect(fixed).not.toContain("'/datasources'");
    expect(fixed).not.toContain("'/customization'");
  });

  it('CommandPalette quick-nav points to /integrations, not /datasources', () => {
    const src = read('./CommandPalette.tsx');
    expect(src).toContain("'/integrations'");
    expect(src).not.toContain("href: '/datasources'");
  });
});
