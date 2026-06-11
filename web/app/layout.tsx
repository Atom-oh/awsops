import './globals.css';
import AppShell from '@/components/shell/AppShell';
import CommandPalette from '@/components/shell/CommandPalette';
import ChatDrawer from '@/components/chat/ChatDrawer';
import { LanguageProvider } from '@/components/shell/LanguageProvider';

export const metadata = { title: 'AWSops' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen bg-paper text-ink-800 font-sans antialiased">
        <LanguageProvider>
          <AppShell>{children}</AppShell>
          <CommandPalette />
          <ChatDrawer />
        </LanguageProvider>
      </body>
    </html>
  );
}
