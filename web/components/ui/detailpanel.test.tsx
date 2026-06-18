// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import DetailPanel from './DetailPanel';
import { INVENTORY_TYPES } from '@/lib/inventory-types';

afterEach(cleanup);

const MOCK = {
  resource_id: 'i-0abc123',
  region: 'ap-northeast-2',
  monitoring: true,
  tags: { Name: 'web', env: 'prod' },
  description: '',
};

describe('DetailPanel', () => {
  it('returns null when data is null (renders nothing)', () => {
    const { container } = render(<DetailPanel title="x" data={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the title and the key/value rows for every field', () => {
    render(<DetailPanel title="i-0abc123" data={MOCK} onClose={() => {}} />);
    // title (header h2)
    expect(screen.getByRole('heading', { name: 'i-0abc123' })).toBeTruthy();
    // string key + value
    expect(screen.getByText('region')).toBeTruthy();
    expect(screen.getByText('ap-northeast-2')).toBeTruthy();
  });

  it('renders a boolean value as a Badge', () => {
    const { container } = render(<DetailPanel data={MOCK} onClose={() => {}} />);
    expect(screen.getByText('monitoring')).toBeTruthy();
    // Badge renders true with positive soft styling
    const badge = screen.getByText('true');
    expect(badge.className).toContain('bg-emerald-50');
    // empty string renders the muted em-dash
    expect(container.textContent).toContain('—');
  });

  it('renders a nested object as pretty JSON in a <pre>', () => {
    const { container } = render(<DetailPanel data={MOCK} onClose={() => {}} />);
    const pre = container.querySelector('pre');
    expect(pre).toBeTruthy();
    expect(pre!.textContent).toContain('"Name"');
    expect(pre!.textContent).toContain('"prod"');
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<DetailPanel title="i-0abc123" data={MOCK} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('닫기'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders grouped sections with friendly labels when a spec is passed', () => {
    const row = { resource_id: 'i-1', region: 'ap-northeast-2', name: 'web', instance_type: 't3.micro', instance_state: 'running', vpc_id: 'vpc-1' };
    render(<DetailPanel title="i-1" data={row} spec={INVENTORY_TYPES.ec2} onClose={() => {}} />);
    // section headers from the ec2 spec (Identity always present; Network present because vpc_id is)
    expect(screen.getByText('Identity')).toBeTruthy();
    expect(screen.getByText('Network')).toBeTruthy();
    // friendly column label ('Type' for instance_type), not the raw key
    expect(screen.getByText('Type')).toBeTruthy();
    expect(screen.queryByText('instance_type')).toBeNull();
    // state key rendered as a StatePill (the value text is present)
    expect(screen.getByText('running')).toBeTruthy();
  });
});

describe('DetailPanel — RDS live metrics (v1 parity)', () => {
  const METRICS = {
    cpu: 42, connections: 5, freeableMemory: 1_000_000_000, freeStorage: 5_000_000_000,
    readIops: 10, writeIops: 3, netIn: 2048, netOut: 4096,
  };
  let fetchMock: ReturnType<typeof vi.fn>;
  const setFetch = (impl: (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> }) => {
    fetchMock = vi.fn(async (url: string) => impl(url));
    global.fetch = fetchMock as unknown as typeof fetch;
  };
  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches and renders the 8-metric CloudWatch table for an rds row', async () => {
    setFetch(() => ({ ok: true, status: 200, json: async () => ({ instance: METRICS }) }));
    render(<DetailPanel title="db-1" data={{ resource_id: 'db-1', engine: 'postgres' }} resourceType="rds" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('인스턴스 메트릭 (CloudWatch)')).toBeTruthy());
    expect(screen.getByText('42%')).toBeTruthy();       // CPU
    expect(screen.getByText('5.0 GB')).toBeTruthy();    // freeStorage 5e9
    expect(fetchMock).toHaveBeenCalledWith('/api/inventory/rds/metrics?id=db-1');
  });

  it('renders neither the metrics section nor a fetch for a non-rds row', () => {
    setFetch(() => ({ ok: true, status: 200, json: async () => ({}) }));
    render(<DetailPanel title="i-1" data={{ resource_id: 'i-1' }} resourceType="ec2" onClose={() => {}} />);
    expect(screen.queryByText('인스턴스 메트릭 (CloudWatch)')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows "메트릭 불가" when the metrics fetch fails (graceful degrade)', async () => {
    setFetch(() => ({ ok: false, status: 403, json: async () => ({}) }));
    render(<DetailPanel title="db-1" data={{ resource_id: 'db-1' }} resourceType="rds" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('메트릭 불가')).toBeTruthy());
  });
});
