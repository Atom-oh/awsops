import type { ReactNode } from 'react';

export const metadata = {
  title: 'AWSops v2',
  description: 'AWSops v2 — thin-BFF web tier',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: '#0a0e1a',
          color: '#e2e8f0',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        {children}
      </body>
    </html>
  );
}
