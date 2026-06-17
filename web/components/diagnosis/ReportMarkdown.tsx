'use client';
import Markdown from '@/components/chat/Markdown';

/**
 * Diagnosis report renderer. Reuses the themed chat Markdown component (react-markdown +
 * remark-gfm, paper/ink + brand (teal) tokens, XSS-safe — no rehype-raw) added by the chat
 * redesign, so reports read consistently with the rest of the app. No new markdown dep needed.
 */
export default function ReportMarkdown({ markdown }: { markdown: string }) {
  return (
    <article className="max-w-none">
      <Markdown>{markdown}</Markdown>
    </article>
  );
}
