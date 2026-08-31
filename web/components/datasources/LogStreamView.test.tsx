// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import LogStreamView, { parseLokiLabels } from './LogStreamView';

afterEach(cleanup);

describe('parseLokiLabels', () => {
  it('parses {k="v"} pairs', () => {
    expect(parseLokiLabels('{job="varlogs", app="web"}')).toEqual([
      { key: 'job', value: 'varlogs' }, { key: 'app', value: 'web' },
    ]);
  });
  it('keeps commas inside quoted values', () => {
    expect(parseLokiLabels('{msg="a, b", job="x"}')).toEqual([
      { key: 'msg', value: 'a, b' }, { key: 'job', value: 'x' },
    ]);
  });
  it('returns [] for malformed/empty input', () => {
    expect(parseLokiLabels('')).toEqual([]);
    expect(parseLokiLabels('not labels')).toEqual([]);
  });
});

describe('LogStreamView', () => {
  const rows = [
    { timestamp: '2026-08-31T00:00:00.000Z', line: 'error: boom', labels: '{job="varlogs", app="web", ns="prod", extra="x"}' },
    { timestamp: '2026-08-31T00:00:01.000Z', line: 'ok', labels: '{job="varlogs"}' },
  ];

  it('renders a line-count header and every log line', () => {
    render(<LogStreamView rows={rows} />);
    expect(screen.getByText('로그 2줄')).toBeTruthy(); // line count header
    expect(screen.getByText('error: boom')).toBeTruthy();
    expect(screen.getByText('ok')).toBeTruthy();
  });

  it('caps label badges at 3 with an overflow badge', () => {
    render(<LogStreamView rows={[rows[0]]} />);
    expect(screen.getByText('job=varlogs')).toBeTruthy();
    expect(screen.getByText('app=web')).toBeTruthy();
    expect(screen.getByText('ns=prod')).toBeTruthy();
    expect(screen.queryByText('extra=x')).toBeNull();
    expect(screen.getByText('+1')).toBeTruthy();
  });

  it('renders nothing for empty rows', () => {
    const { container } = render(<LogStreamView rows={[]} />);
    expect(container.textContent).toBe('');
  });
});
