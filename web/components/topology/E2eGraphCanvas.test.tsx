// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import E2eGraphCanvas from './E2eGraphCanvas';
import type { E2eGraph } from '@/lib/e2e-topology-types';

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => { vi.stubGlobal('ResizeObserver', ResizeObserverStub); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const graph: E2eGraph = {
  nodes: [
    { id: 's1', kind: 'service', label: 'checkout', layer: 'service', meta: {} },
    { id: 'p1', kind: 'endpoint', label: 'shop/pod-a', layer: 'network', meta: {} },
    { id: 'p2', kind: 'endpoint', label: 'shop/pod-b', layer: 'network', meta: {} },
    { id: 'f1', kind: 'connection', label: 'checkout-flow', layer: 'network', meta: {
      metric: 'DATA_TRANSFERRED', unit: 'Bytes', monitor: 'nfm-eks-demo', rangeSec: 900,
      category: 'INTER_AZ', startTime: '2026-09-11T11:45:00Z', endTime: '2026-09-11T12:00:00Z',
      flow: { local: { ip: '10.0.1.1' }, remote: { ip: '10.0.2.1' },
        value: 8192, unit: 'Bytes', category: 'INTER_AZ', targetPort: 443,
        snatIp: '192.0.2.1', traversed: ['NAT'], traversedIds: ['NAT:nat-demo'] },
    } },
  ],
  edges: [
    { id: 'i1', source: 's1', target: 'p1', evidence: 'identity', relation: 'identity', directed: false },
    { id: 'n1', source: 'p1', target: 'f1', evidence: 'network', relation: 'network', directed: false },
    { id: 'n2', source: 'f1', target: 'p2', evidence: 'network', relation: 'network', directed: false },
  ],
  summary: { configuredNodes: 0, serviceNodes: 1, networkFlows: 1, correlatedEndpoints: 1,
    unmatchedEndpoints: 1, ambiguousEndpoints: 0, observationsUnsupported: false },
};

describe('E2eGraphCanvas', () => {
  it('clears details when the selected layer is hidden and excludes it from search', async () => {
    render(<E2eGraphCanvas graph={graph} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout-flow' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: checkout-flow' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '네트워크 관측' }));
    expect(screen.queryByRole('region', { name: '선택한 노드 상세' })).toBeNull();
    expect(screen.queryByText('표시할 관계 데이터가 없습니다.')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout-flow' } });
    expect(screen.queryByRole('button', { name: '선택: checkout-flow' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '네트워크 관측' }));
    expect(screen.queryByRole('region', { name: '선택한 노드 상세' })).toBeNull();
  });

  it('filters the selected node’s evidence details along with the graph', async () => {
    render(<E2eGraphCanvas graph={graph} />);
    fireEvent.click(screen.getByRole('checkbox', { name: '식별자 연결' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: checkout' }));
    expect(within(screen.getByRole('region', { name: '선택한 노드 상세' })).queryByText('식별자 연결')).toBeNull();
  });

  it('searches cyclic metadata safely with the same value matching as graph filtering', async () => {
    const meta: Record<string, unknown> = { pod: 'unique-pod' };
    meta.self = meta;
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [{ ...graph.nodes[0], meta }] }} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unique-pod' } });
    expect(await screen.findByRole('button', { name: '선택: checkout' })).toBeTruthy();
  });

  it.each([undefined, 'NAT:broken', [null, { id: 'bad' }, 'NAT:valid']])(
    'tolerates malformed traversed IDs in network details: %j', async traversedIds => {
      const connection = graph.nodes[3];
      render(<E2eGraphCanvas graph={{ ...graph, nodes: [{
        ...connection, meta: { ...connection.meta, flow: { ...(connection.meta.flow as object), traversedIds } },
      }] }} />);
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout-flow' } });
      fireEvent.click(await screen.findByRole('button', { name: '선택: checkout-flow' }));
      expect(within(screen.getByRole('region', { name: '선택한 노드 상세' })).getByText('8 KB')).toBeTruthy();
    },
  );

  it.each([NaN, Infinity, -1])('does not render invalid metrics as measurements: %s', async value => {
    const connection = graph.nodes[3];
    render(<E2eGraphCanvas graph={{ ...graph, nodes: graph.nodes.map(node => node.id === connection.id ? {
      ...connection, meta: { ...connection.meta, flow: { ...(connection.meta.flow as object), value } },
    } : node) }} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'checkout-flow' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: checkout-flow' }));
    expect(within(screen.getByRole('region', { name: '선택한 노드 상세' })).getByText('—')).toBeTruthy();
    expect(screen.queryByText(/NaN|Infinity|-1 B/)).toBeNull();
  });

  it('provides an honest empty state instead of a blank canvas', () => {
    render(<E2eGraphCanvas graph={{ ...graph, nodes: [], edges: [] }} />);
    expect(screen.getByText('표시할 관계 데이터가 없습니다.')).toBeTruthy();
  });

  it('lets a searched network connection expose its metric, window and NAT evidence', async () => {
    render(<E2eGraphCanvas graph={graph} />);
    fireEvent.change(screen.getByRole('searchbox', { name: '서비스 또는 리소스 검색' }), { target: { value: 'checkout-flow' } });
    fireEvent.click(await screen.findByRole('button', { name: '선택: checkout-flow' }));
    const detail = screen.getByRole('region', { name: '선택한 노드 상세' });
    expect(within(detail).getByText('8 KB')).toBeTruthy();
    expect(within(detail).getByText('192.0.2.1')).toBeTruthy();
    expect(within(detail).getByText('NAT:nat-demo')).toBeTruthy();
    expect(within(detail).getByText(/순서를 보장하지 않습니다/)).toBeTruthy();
  });

  it('filters network relations without changing the underlying observation graph', async () => {
    render(<E2eGraphCanvas graph={graph} />);
    await waitFor(() => expect(screen.getByTestId('e2e-network-edge-count').textContent).toBe('2'));
    fireEvent.click(screen.getByRole('checkbox', { name: '네트워크 관측' }));
    expect(screen.getByTestId('e2e-network-edge-count').textContent).toBe('0');
    expect(graph.edges).toHaveLength(3);
  });
});
