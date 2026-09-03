// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import EcsOverview, { clusterLeaf } from './EcsOverview';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const cluster = (id: string, extra: Record<string, unknown> = {}) => ({
  resource_id: id, region: 'ap-northeast-2', account_id: 'self',
  data: { status: 'ACTIVE', running_tasks_count: 3, pending_tasks_count: 0, active_services_count: 2, ...extra },
});
const service = (name: string, desired: number, running: number) => ({
  resource_id: name, region: 'ap-northeast-2', account_id: 'self',
  data: { service_name: name, status: 'ACTIVE', desired_count: desired, running_count: running, launch_type: 'FARGATE', cluster_arn: `arn:aws:ecs:ap-northeast-2:1:cluster/main` },
});

function stubApis({ clusters = [cluster('c1')], services = [service('svc-a', 2, 2)], run = { status: 'succeeded' } as unknown, taskCount = 7 } = {}) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body =
      url.includes('ecs_cluster') ? { rows: clusters, run } :
      url.includes('ecs_service') ? { rows: services, run } :
      { byType: [{ type: 'ecs_task', count: taskCount }] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  }));
}

describe('clusterLeaf', () => {
  it('extracts the cluster name from an ARN and dashes empties', () => {
    expect(clusterLeaf('arn:aws:ecs:r:1:cluster/prod-main')).toBe('prod-main');
    expect(clusterLeaf(undefined)).toBe('—');
  });
});

describe('EcsOverview (gap L216 — unified one-screen view)', () => {
  it('renders KPI counts, both tables, and the running/desired rollup', async () => {
    stubApis({ services: [service('svc-a', 3, 2), service('svc-b', 1, 1)] });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getByText('svc-a')).toBeTruthy());
    expect(screen.getByText('c1')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy(); // task count from summary
    expect(screen.getByText('3/4 running')).toBeTruthy(); // rollup hint
    // desired>running lag tile shows 1
    expect(screen.getByText('Desired 대비 미달 태스크')).toBeTruthy();
  });

  it('suppresses the rollup on a truncated (>=500) service page and labels the sample', async () => {
    const many = Array.from({ length: 500 }, (_, i) => service(`s${i}`, 2, 1));
    stubApis({ services: many });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getByText('s0')).toBeTruthy());
    expect(screen.queryByText(/running$/)).toBeNull(); // no fleet-total rollup from a sample
    expect(screen.getAllByText(/표본 기준/).length).toBeGreaterThan(0);
  });

  it('a non-succeeded run renders the stale caption; last-good rows stay listed', async () => {
    stubApis({ run: { status: 'failed' } });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getAllByText(/마지막 sync가 성공하지 못했습니다/).length).toBeGreaterThan(0));
    expect(screen.getByText('c1')).toBeTruthy();
  });

  it('pre-sync (no rows, no run) reads 미수집 — never a fabricated empty fleet', async () => {
    stubApis({ clusters: [], services: [], run: null });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getAllByText(/미수집 — sync 후/).length).toBe(2));
  });
});
