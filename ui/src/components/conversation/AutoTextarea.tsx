import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes,
} from "react";

type Props = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange" | "value" | "onSubmit"
> & {
  value: string;
  onChange(value: string): void;
  /** Enter submits (Shift+Enter adds a line); ⌘/Ctrl+Enter always submits. */
  onSubmit?: () => void;
  enterSubmits?: boolean;
  maxRows?: number;
};

/** Grows with its content up to maxRows, then scrolls. */
export const AutoTextarea = forwardRef<HTMLTextAreaElement, Props>(
  function AutoTextarea(
    {
      value,
      onChange,
      onSubmit,
      enterSubmits = false,
      maxRows = 8,
      className,
      onKeyDown,
      ...props
    },
    ref,
  ) {
    const element = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => element.current!, []);
    useLayoutEffect(() => {
      const node = element.current;
      if (!node) return;
      const style = window.getComputedStyle(node);
      const line = parseFloat(style.lineHeight) || 20;
      const chrome =
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom) +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.borderBottomWidth);
      node.style.height = "auto";
      node.style.height = `${Math.min(node.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth), line * maxRows + chrome)}px`;
    }, [value, maxRows]);
    return (
      <textarea
        ref={element}
        rows={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || event.key !== "Enter") return;
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          const modified = event.metaKey || event.ctrlKey;
          if (modified || (enterSubmits && !event.shiftKey && !event.altKey)) {
            event.preventDefault();
            onSubmit?.();
          }
        }}
        className={`resize-none scroll-thin ${className ?? ""}`}
        {...props}
      />
    );
  },
);
