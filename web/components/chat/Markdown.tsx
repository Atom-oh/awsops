'use client';
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Themed markdown renderer for assistant messages.
 *
 * - remark-gfm → tables, strikethrough, task lists, autolinks.
 * - NO rehype-raw → raw HTML in the stream is NOT rendered (XSS-safe by default).
 *   Content is our own Bedrock agent output, but we keep the defensive default.
 * - Element styling maps onto the app's paper/ink + Claude-orange tokens so the
 *   chat reads identically inside the drawer and the /assistant page.
 * - Tolerates partial markdown mid-stream (react-markdown never throws on incomplete input).
 */
function MarkdownImpl({ children }: { children: string }) {
  return (
    <div className="text-[13px] leading-relaxed text-ink-700 [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-[16px] font-semibold text-ink-800 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-3 text-[15px] font-semibold text-ink-800 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-[14px] font-semibold text-ink-800 first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="mb-1.5 mt-2.5 text-[13px] font-semibold text-ink-800 first:mt-0">{children}</h4>,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-claude-700 underline decoration-claude-200 underline-offset-2 hover:text-claude-600">{children}</a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-ink-800">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="marker:text-ink-300">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-claude-200 bg-claude-50/50 py-1 pl-3 text-ink-600">{children}</blockquote>
          ),
          hr: () => <hr className="my-3 border-ink-100" />,
          code: ({ children }) => (
            <code className="rounded-[4px] border border-ink-100 bg-paper-muted px-1 py-px font-mono text-[12px] text-claude-700">{children}</code>
          ),
          // Block code: <pre> wraps a <code>; neutralize the inline code chrome inside it.
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md border border-ink-100 bg-paper-muted p-3 font-mono text-[12px] leading-relaxed text-ink-700 [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-ink-700">{children}</pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-md border border-ink-100">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-paper-muted">{children}</thead>,
          th: ({ children }) => <th className="border-b border-ink-100 px-2.5 py-1.5 text-left font-semibold text-ink-800">{children}</th>,
          td: ({ children }) => <td className="border-b border-ink-100 px-2.5 py-1.5 align-top text-ink-600">{children}</td>,
          img: ({ src, alt }) => <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} className="my-2 max-w-full rounded-md border border-ink-100" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const Markdown = memo(MarkdownImpl);
export default Markdown;
