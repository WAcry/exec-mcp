import { ImageOff } from "lucide-react";
import { useState } from "react";
import { useLocale } from "../../context/LocaleContext";
import { formatBytes } from "../../lib/format";
import type { MediaBlock } from "../../lib/results";

function Chip({ item, note }: { item: MediaBlock; note?: string }) {
  const { locale } = useLocale();
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-hover px-1.5 py-0.5 text-2xs text-ink-3">
      {note && <ImageOff className="h-3 w-3 shrink-0" />}
      <span className="shrink-0">{item.type}</span>·
      <span className="min-w-0 truncate font-mono">{item.label}</span>
      {item.bytes !== undefined && (
        <span className="shrink-0 tabular">
          · {formatBytes(item.bytes, locale)}
        </span>
      )}
      {note && <span className="shrink-0">· {note}</span>}
    </span>
  );
}

function Picture({ item, id }: { item: MediaBlock; id: string }) {
  const { t, locale } = useLocale();
  const [size, setSize] = useState<[number, number]>();
  const [gone, setGone] = useState(false);
  if (gone) return <Chip item={item} note={t("media.gone")} />;
  const src = `/api/media/${id}`;
  return (
    <figure className="flex max-w-full min-w-0 flex-col gap-1">
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        title={t("media.open")}
        className="checker block w-fit max-w-full overflow-hidden rounded-lg border border-line transition-[border-color] hover:border-line-strong"
      >
        <img
          src={src}
          alt={item.label}
          loading="lazy"
          decoding="async"
          onLoad={(event) =>
            setSize([
              event.currentTarget.naturalWidth,
              event.currentTarget.naturalHeight,
            ])
          }
          onError={() => setGone(true)}
          className="block max-h-80 max-w-full object-contain"
        />
      </a>
      <figcaption className="text-2xs tabular text-ink-3">
        <span className="font-mono">{item.label}</span>
        {item.bytes !== undefined && ` · ${formatBytes(item.bytes, locale)}`}
        {size && ` · ${size[0]} × ${size[1]}`}
      </figcaption>
    </figure>
  );
}

/** Images a tool returned, as the model received them; other media as labeled chips. */
export function MediaPreview({ items }: { items: MediaBlock[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      {items.map((item, index) =>
        item.type === "image" && item.media ? (
          <Picture key={`${item.media}-${index}`} item={item} id={item.media} />
        ) : (
          <Chip key={index} item={item} />
        ),
      )}
    </div>
  );
}
