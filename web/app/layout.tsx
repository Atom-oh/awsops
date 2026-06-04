import TopNav from '@/components/shell/TopNav';
import ChatDrawer from '@/components/chat/ChatDrawer';

export const metadata = { title: 'AWSops v2' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ margin: 0, background: '#0a0e1a', color: '#e6eefb', fontFamily: 'system-ui, sans-serif' }}>
        <TopNav />
        {children}
        <ChatDrawer />
      </body>
    </html>
  );
}
