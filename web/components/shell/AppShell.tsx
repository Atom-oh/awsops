import type { ReactNode } from 'react';
import Sidebar from './Sidebar';

/**
 * AppShell — flex layout: fixed 256px Sidebar + fluid scrolling main pane.
 * The main pane replays a subtle 200ms fade-in on mount.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto animate-fade-in">{children}</main>
    </div>
  );
}
