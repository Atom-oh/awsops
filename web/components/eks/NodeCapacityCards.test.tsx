// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import NodeCapacityCards from './NodeCapacityCards';

afterEach(cleanup);

const props = {
  cpuCapacity: 4, cpuAllocatable: 3.5, cpuRequest: 1.75,
  memCapacityMiB: 8192, memAllocatableMiB: 7168, memRequestMiB: 2048,
  podCount: 1, podRunning: 1, podPending: 0, podFailed: 0,
};

describe('NodeCapacityCards usage', () => {
  it('shows measured usage even when the pods read fails', () => {
    render(<NodeCapacityCards {...props} cpuRequest={null} memRequestMiB={null}
      cpuUsage={0.7} memUsageMiB={3584} />);
    expect(screen.getByText('0.70 / 3.50 vCPU (20%)')).toBeTruthy();
    expect(screen.getByText('3.5 GiB / 7.0 GiB (50%)')).toBeTruthy();
    expect(screen.queryByRole('meter', { name: 'CPU Allocated' })).toBeNull();
    expect(screen.queryByRole('meter', { name: 'Memory Allocated' })).toBeNull();
  });

  it('does not fabricate zero or a full usage bar for absent or invalid metrics', () => {
    render(<NodeCapacityCards {...props} cpuUsage={NaN} memUsageMiB={-1} />);
    expect(screen.getAllByText('미수집')).toHaveLength(2);
  });

  it('shows usage above allocatable honestly while keeping the bar bounded', () => {
    render(<NodeCapacityCards {...props} cpuUsage={4.2} memUsageMiB={0} />);
    expect(screen.getByText('4.20 / 3.50 vCPU (120%)')).toBeTruthy();
    const bar = screen.getByRole('meter', { name: 'CPU Usage' });
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('aria-valuetext')).toContain('120%');
  });
});
