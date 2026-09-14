import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Execute the real entrypoint in a VM; only DB/collection IO and console/process sinks are
// replaced. This also checks top-level awaiting and exit behavior, without AWS or a TS loader.
function run(outcome = 'published', failed = false) {
  return JSON.parse(execFileSync('node', ['--experimental-vm-modules', '--input-type=module', '-e', `
    import vm from 'node:vm';
    import fs from 'node:fs';
    import * as url from 'node:url';
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = { code: null, logs: [], errors: [], closed: 0 };
    const processSink = { argv: ['node', input.file], exit: code => { result.code = code; } };
    const context = vm.createContext({ process: processSink, console: {
      log: text => result.logs.push(text), error: text => result.errors.push(text),
    } });
    const counts = { nodes: 0, edges: 0, published: 0, retained: 0, skipped: 0, reasons: [] };
    counts[input.outcome] = 1;
    const rebuild = async () => {
      if (input.failed) throw new Error('credential=secret');
      return counts;
    };
    const module = new vm.SourceTextModule(fs.readFileSync(input.file, 'utf8'), {
      context, initializeImportMeta: meta => { meta.url = url.pathToFileURL(input.file).href; },
    });
    await module.link(specifier => {
      const exports = specifier === 'node:url' ? url
        : specifier.includes('/db.') ? { getPool: () => ({ end: async () => { result.closed++; } }) }
        : specifier.includes('graph-sources') ? { loadGraphSources: async () => ({ sources: [], metricsSources: [] }) }
        : { rebuildGraph: rebuild, rebuildInfraGraph: rebuild, rebuildTraceGraph: async () => ({ nodes: 0, edges: 0 }) };
      return new vm.SyntheticModule(Object.keys(exports), function() {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context });
    });
    try { await module.evaluate(); } catch { result.code = 1; }
    result.code = processSink.exitCode ?? result.code;
    console.log(JSON.stringify(result));
  `], { input: JSON.stringify({ file: resolve('../scripts/v2/graph-rebuild.mjs'), outcome, failed }),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
}

describe('graph rebuild runner outcomes', () => {
  it('reports a confirmed empty publication as success and closes its pool', () => {
    const result = run();
    expect(result.code).toBe(0);
    expect(result.closed).toBe(1);
    expect(result.logs.join('\n')).toContain('"published":1');
  });
  it.each(['retained', 'skipped'])('distinguishes %s from a healthy zero', outcome => {
    const result = run(outcome);
    expect(result.code).toBe(2);
    expect(result.logs.join('\n')).toContain(`"${outcome}":1`);
    expect(result.closed).toBe(1);
  });
  it('reports collection exceptions as failure without raw errors', () => {
    const result = run('published', true);
    expect(result.code).toBe(1);
    expect(result.errors).toEqual(['[graph-rebuild] failed']);
    expect(result.closed).toBe(1);
  });
});
