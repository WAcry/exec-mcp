import { brandMarkSvg } from "../../../src/brand-mark";

let current = "";

export function updateTabState(options: {
  attention: "question" | "message" | null;
  count: number;
  title: string;
}): void {
  const key = options.attention ?? "none";
  if (key !== current) {
    current = key;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    // Questions wait on the operator; messages only ask to be read.
    const badge =
      options.attention === "question"
        ? "#f2a93b"
        : options.attention === "message"
          ? "#5b8cff"
          : undefined;
    link.type = "image/svg+xml";
    link.href = `data:image/svg+xml,${encodeURIComponent(brandMarkSvg(badge ? { badge } : {}))}`;
  }
  document.title = options.count
    ? `(${options.count}) ${options.title}`
    : options.title;
}
