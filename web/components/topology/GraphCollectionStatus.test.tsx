// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import GraphCollectionStatus from './GraphCollectionStatus';

afterEach(cleanup);

describe('GraphCollectionStatus', () => {
  it.each([undefined, null, {}, { status: 'unknown' }])('keeps absent or unknown metadata neutral: %j', collection => {
    render(<GraphCollectionStatus collection={collection} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('수집 상태 미확인');
    expect(screen.getByRole('status').className).not.toContain('amber');
  });

  it.each([
    { status: 'partial', stale: false, sources: [{ sourceId: 'tempo:fixture', status: 'error', reasons: ['timeout'] }] },
    { status: 'ok', stale: true },
    { status: 'ok', stale: false, retainedPrevious: true },
    { status: 'error', stale: false },
  ])('preserves a provided collection warning: %j', collection => {
    render(<GraphCollectionStatus collection={collection} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    if ('sources' in collection) {
      expect(screen.getByRole('alert').textContent).toContain('tempo:fixture');
      expect(screen.getByRole('alert').textContent).toContain('timeout');
    }
  });
});
