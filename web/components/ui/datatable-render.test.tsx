// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DataTable from './DataTable';

afterEach(cleanup);

const cols = [{ key: 'name', label: 'Name' }, { key: 'runtime', label: 'Runtime' }];

describe('DataTable — Lambda EOL runtime badge', () => {
  it('shows an EOL badge for a deprecated runtime', () => {
    render(<DataTable columns={cols} rows={[{ name: 'fn-old', runtime: 'nodejs14.x' }]} />);
    expect(screen.getByText('EOL')).toBeTruthy();
    expect(screen.getByText('nodejs14.x')).toBeTruthy();
  });
  it('does NOT show EOL for a current runtime', () => {
    render(<DataTable columns={cols} rows={[{ name: 'fn-new', runtime: 'nodejs20.x' }]} />);
    expect(screen.queryByText('EOL')).toBeNull();
    expect(screen.getByText('nodejs20.x')).toBeTruthy();
  });
  it('only treats the runtime column as a runtime (not other columns)', () => {
    render(<DataTable columns={[{ key: 'name', label: 'Name' }]} rows={[{ name: 'nodejs14.x' }]} />);
    expect(screen.queryByText('EOL')).toBeNull();
  });
});
