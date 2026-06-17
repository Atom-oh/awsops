import { describe, it, expect, vi, beforeEach } from 'vitest';
const send = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = (...a: unknown[]) => send(...a); },
  InvokeCommand: class { input: unknown; constructor(i: unknown) { this.input = i; } },
}));
import { invokeConnectorTool } from './connector-invoke';

beforeEach(() => send.mockReset());

describe('invokeConnectorTool', () => {
  it('invokes the right function with {tool_name,arguments} and parses {statusCode,body}', async () => {
    send.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ metrics: ['up'], labels: ['job'] }) })) });
    const out = await invokeConnectorTool('prometheus', 'prometheus_schema', {});
    expect(out).toEqual({ metrics: ['up'], labels: ['job'] });
    const cmd: any = send.mock.calls[0][0];
    expect(cmd.input.FunctionName).toBe('awsops-v2-agent-prometheus-mcp');
    expect(JSON.parse(Buffer.from(cmd.input.Payload).toString())).toEqual({ tool_name: 'prometheus_schema', arguments: {} });
  });
  it('rejects an unknown slug with no invoke', async () => {
    await expect(invokeConnectorTool('evil', 'x')).rejects.toThrow(/slug/i);
    expect(send).not.toHaveBeenCalled();
  });
  it('throws on a connector error body', async () => {
    send.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'not connected' }) })) });
    await expect(invokeConnectorTool('loki', 'loki_schema')).rejects.toThrow(/not connected/);
  });
  it('throws on FunctionError', async () => {
    send.mockResolvedValue({ FunctionError: 'Unhandled', Payload: Buffer.from('{}') });
    await expect(invokeConnectorTool('tempo', 'tempo_schema')).rejects.toThrow(/invoke failed/);
  });
});
