import { Fragment, type ReactNode } from "react";

const INLINE =
  /(\*\*[^*\n]+\*\*|`[^`\n]+`|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    if (index % 2 === 0) return <Fragment key={index}>{part}</Fragment>;
    if (part.startsWith("**"))
      return (
        <strong key={index} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    if (part.startsWith("`"))
      return (
        <code
          key={index}
          className="rounded bg-hover px-1 py-px text-[0.92em] text-ink"
        >
          {part.slice(1, -1)}
        </code>
      );
    return (
      <a
        key={index}
        href={part}
        target="_blank"
        rel="noreferrer noopener"
        className="underline decoration-line-strong underline-offset-2 hover:decoration-ink"
      >
        {part}
      </a>
    );
  });
}

/** Agents write light Markdown; render bold, code and links without interpreting HTML. */
export function MessageText({ text }: { text: string }) {
  const blocks = text.split(/```[^\n]*\n?/);
  return (
    <>
      {blocks.map((block, index) =>
        index % 2 === 1 ? (
          <pre
            key={index}
            className="my-2 overflow-x-auto rounded-lg border border-line bg-sunken px-3 py-2 text-xs leading-[18px] whitespace-pre text-ink scroll-thin"
          >
            {block.replace(/\n$/, "")}
          </pre>
        ) : (
          <span
            key={index}
            className="whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {inline(block.replace(/^\n/, "").replace(/\n$/, ""))}
          </span>
        ),
      )}
    </>
  );
}
