// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import DetailPanel from './DetailPanel';

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
});
