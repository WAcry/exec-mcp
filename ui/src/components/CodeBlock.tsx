import React, { useState } from "react";
import { Copy, Check } from "lucide-react";
import Prism from "prismjs";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-diff";

interface CodeBlockProps {
  code: string;
  language?: string;
  className?: string;
  maxHeight?: string;
}

export function CodeBlock({
  code,
  language = "javascript",
  className = "",
  maxHeight = "max-h-96",
}: CodeBlockProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 2000);
  };

  const highlighted = React.useMemo(() => {
    const grammar = Prism.languages[language];
    if (!grammar) return Prism.util.encode(code) as string;
    return Prism.highlight(code, grammar, language);
  }, [code, language]);

  return (
    <div
      className={`relative group rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-[#0c0d0e] text-zinc-100 ${className}`}
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-[#141517] text-[11px] text-zinc-400">
        <span className="font-mono uppercase font-semibold">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-zinc-300 hover:text-white bg-zinc-800/80 hover:bg-zinc-700 transition-colors cursor-pointer"
          title="复制内容"
        >
          {copyState === "copied" ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400">已复制</span>
            </>
          ) : copyState === "failed" ? (
            <span className="text-rose-400">复制失败</span>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      <div
        className={`overflow-auto p-3 text-xs font-mono leading-relaxed ${maxHeight}`}
      >
        <pre tabIndex={0} className="focus:outline-none">
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
      </div>
    </div>
  );
}
