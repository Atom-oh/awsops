import './globals.css';
import TopNav from '@/components/shell/TopNav';
import ChatDrawer from '@/components/chat/ChatDrawer';

export const metadata = { title: 'AWSops v2' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-paper text-ink-800 font-sans antialiased">
        <TopNav />
        {children}
        <ChatDrawer />
      </body>
    </html>
  );
}
