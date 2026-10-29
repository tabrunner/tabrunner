import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

/**
 * Component map for assistant-message markdown, matched to the chat bubble's
 * type scale. Two deliberate constraints:
 * - Links force a new tab — a plain anchor would navigate the side panel itself.
 * - Images are dropped — model output is influenced by untrusted page content,
 *   and a remote <img> in the panel is a request the page author chose.
 */
const COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-brand-600 underline dark:text-brand-400"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5 last:mb-0">{children}</li>,
  h1: ({ children }) => <h1 className="mt-2 mb-1 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-2 mb-1 text-[15px] font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-semibold">{children}</h4>,
  code: ({ children }) => (
    <code className="rounded bg-neutral-200 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-700">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-neutral-900 p-2.5 text-xs text-neutral-100 last:mb-0 dark:bg-neutral-950 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-neutral-300 pl-3 text-neutral-600 last:mb-0 dark:border-neutral-600 dark:text-neutral-400">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-neutral-200 dark:border-neutral-700" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-neutral-300 px-2 py-1 text-left font-semibold dark:border-neutral-600">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-neutral-300 px-2 py-1 dark:border-neutral-600">{children}</td>
  ),
  img: () => null,
};

/**
 * Safe markdown for model output. react-markdown renders a React tree — raw
 * HTML in the text is escaped, never injected. That matters here: page content
 * flows through the model, so assistant text is not trusted input.
 *
 * Memoized: a re-parse is a full markdown AST walk, and the message list
 * re-renders on every streamed token — without this, each tick would re-parse
 * EVERY assistant bubble in the transcript, not just the one streaming.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
});
