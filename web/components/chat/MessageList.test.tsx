// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import MessageList, { type Msg } from './MessageList';

const doneMsg = (over: Partial<Msg>): Msg => ({ role: 'assistant', content: 'answer', streaming: false, ...over });

afterEach(cleanup);

describe('MessageList switch chips (ADR-038)', () => {
  it('renders switch chips for active ranked alternates (excluding the used gateway)', () => {
    const msgs: Msg[] = [doneMsg({
      gateway: 'network',
      ranked: [
        { key: 'network', score: 0.9, active: true },
        { key: 'security', score: 0.5, active: true },
        { key: 'data', score: 0.4, active: false }, // inactive → no chip
      ],
    })];
    render(<MessageList msgs={msgs} onSwitch={() => {}} />);
    expect(screen.getByRole('button', { name: /Security로 다시/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Network로 다시/ })).toBeNull(); // same as used
    expect(screen.queryByRole('button', { name: /Data로 다시/ })).toBeNull();   // inactive
  });
  it('clicking a chip calls onSwitch with the section key', () => {
    const onSwitch = vi.fn();
    const msgs: Msg[] = [doneMsg({
      gateway: 'network',
      ranked: [{ key: 'network', score: 0.9, active: true }, { key: 'security', score: 0.5, active: true }],
    })];
    render(<MessageList msgs={msgs} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole('button', { name: /Security로 다시/ }));
    expect(onSwitch).toHaveBeenCalledWith('security');
  });
  it('renders no chips while streaming or when ranked is absent', () => {
    render(<MessageList msgs={[doneMsg({ gateway: 'network' }), { role: 'assistant', content: '...', streaming: true, gateway: 'network', ranked: [{ key: 'security', score: 1, active: true }] }]} onSwitch={() => {}} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
  it('renders a combined "통합 분석" badge for a cross-domain synthesis answer (ADR-044)', () => {
    const msgs: Msg[] = [doneMsg({
      gateway: 'network',
      via: 'multi:network+data',
      ranked: [
        { key: 'network', score: 0.9, active: true },
        { key: 'data', score: 0.6, active: true },
        { key: 'security', score: 0.4, active: true },
      ],
    })];
    render(<MessageList msgs={msgs} onSwitch={() => {}} />);
    expect(screen.getByLabelText('통합 분석')).toBeTruthy();
    // chips exclude the domains already merged into the answer (network, data); security remains a secondary aid
    expect(screen.getByRole('button', { name: /Security로 다시/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Data로 다시/ })).toBeNull();
  });
});

describe('MessageList streaming status (UX changes)', () => {
  it('renders analyzing status text when streaming with empty content and analyzing status', () => {
    const msgs: Msg[] = [{
      role: 'assistant',
      content: '',
      streaming: true,
      status: { phase: 'analyzing' }
    }];
    render(<MessageList msgs={msgs} />);
    expect(screen.getByText(/분석 중/)).toBeTruthy();
    expect(screen.queryByText(/초/)).toBeNull();
  });

  it('renders elapsed time status text when streaming with empty content and working status', () => {
    const msgs: Msg[] = [{
      role: 'assistant',
      content: '',
      streaming: true,
      status: { phase: 'working', elapsedMs: 4000 }
    }];
    render(<MessageList msgs={msgs} />);
    expect(screen.getByText(/분석 중… 4초/)).toBeTruthy();
  });

  it('renders content and no status text when content has arrived', () => {
    const msgs: Msg[] = [{
      role: 'assistant',
      content: 'real content',
      streaming: true,
      status: { phase: 'working', elapsedMs: 4000 }
    }];
    render(<MessageList msgs={msgs} />);
    expect(screen.getByText('real content')).toBeTruthy();
    expect(screen.queryByText(/분석 중/)).toBeNull();
  });

  it('renders neither status nor cursor when streaming is false', () => {
    const msgs: Msg[] = [{
      role: 'assistant',
      content: 'finished answer',
      streaming: false,
      status: { phase: 'working', elapsedMs: 4000 }
    }];
    const { container } = render(<MessageList msgs={msgs} />);
    expect(screen.getByText('finished answer')).toBeTruthy();
    expect(screen.queryByText(/분석 중/)).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });
});

