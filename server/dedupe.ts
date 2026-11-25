import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttachmentCopiesMode, GalleryImage } from "../shared/gallery";

/** True for a file inside one of Paseo's `paseo-attachments-*` temp folders. */
export function isAttachmentCopy(path: string): boolean {
  return path.split(/[\\/]/).slice(0, -1).some((segment) => segment.startsWith("paseo-attachments-"));
}

// The timeline item type lives in @getpaseo/protocol; match its shape loosely here.
export type TimelineItem = { type: string; [key: string]: unknown };

const MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|webm|mp4|mov|m4v)$/i;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function normalize(raw: string, cwd: string, home: string): Pick<GalleryImage, "src" | "kind"> | null {
  const trimmed = raw.replace(/[.:]+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return { src: trimmed, kind: "url" };
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return { src: fileURLToPath(trimmed), kind: "file" };
    } catch {
      return null;
    }
  }
  if (/^[a-z]+:/i.test(trimmed)) return null; // data: and other schemes
  if (trimmed.startsWith("~/")) return { src: resolve(home, trimmed.slice(2)), kind: "file" };
  return { src: isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed), kind: "file" };
}

/** Attachments copies a message shows as Markdown images, normalized to paths. */
function copiesIn(item: TimelineItem, cwd: string, home: string): string[] {
  if (item.type !== "assistant_message" || typeof item.text !== "string") return [];
  const found: string[] = [];
  for (const match of item.text.matchAll(MARKDOWN_IMAGE)) {
    const n = normalize(match[1], cwd, home);
    if (n?.kind === "file" && isAttachmentCopy(n.src)) found.push(n.src);
  }
  return found;
}

/**
 * Links each attachments copy to the real image files the agent read just before it. The daemon
 * pushes the tool_call, then one assistant_message per image it copied. For the message that
 * first mentions a copy, the run of tool_call entries before it (skipping other copy messages
 * of the same batch) is scanned for image reads; the copy is linked to all of them.
 */
export function materializedFrom(
  entries: { item: TimelineItem }[],
  cwd: string,
  home: string,
): Map<string, string[]> {
  const links = new Map<string, string[]>();
  entries.forEach(({ item }, index) => {
    const copies = copiesIn(item, cwd, home).filter((copy) => !links.has(copy));
    if (copies.length === 0) return;
    let i = index - 1;
    while (i >= 0 && copiesIn(entries[i].item, cwd, home).length > 0) i--;
    const sources: string[] = [];
    for (; i >= 0 && entries[i].item.type === "tool_call"; i--) {
      const detail = entries[i].item.detail as { type?: string; filePath?: string } | undefined;
      if (detail?.type !== "read" || !detail.filePath || !MEDIA_EXT.test(detail.filePath)) continue;
      const n = normalize(detail.filePath, cwd, home);
      if (n?.kind === "file" && !isAttachmentCopy(n.src) && !sources.includes(n.src)) sources.unshift(n.src);
    }
    if (sources.length > 0) for (const copy of copies) links.set(copy, sources);
  });
  return links;
}

/**
 * Keeps one entry per content hash, in the order the contents first appear. Candidates are
 * sorted by timestamp; a null hash drops the entry. Paseo keeps a hash-named copy of every image
 * shown in chat under `paseo-attachments-*`, so the earliest entry outside those folders wins,
 * and a copy is kept only when no other path has the same content. Mode "all" drops copies even
 * then. In mode "duplicates" a copy is also dropped when `copyOf` links it to a real file that is
 * shown, because editing that file changes its hash and leaves the copy as a stale twin.
 */
export function dedupeByContent(
  candidates: GalleryImage[],
  hashes: (string | null)[],
  mode: AttachmentCopiesMode = "duplicates",
  copyOf?: ReadonlyMap<string, readonly string[]>,
): GalleryImage[] {
  const isCopy = (image: GalleryImage) => image.kind === "file" && isAttachmentCopy(image.src);
  const kept = new Map<string, GalleryImage>();
  candidates.forEach((image, index) => {
    const hash = hashes[index];
    if (hash === null) return;
    const current = kept.get(hash);
    if (!current || (isCopy(current) && !isCopy(image))) kept.set(hash, image);
  });
  const images = [...kept.values()];
  if (mode === "all") return images.filter((image) => !isCopy(image));
  if (!copyOf) return images;
  const shown = new Set(images.filter((image) => !isCopy(image)).map((image) => image.src));
  return images.filter((image) => !(isCopy(image) && copyOf.get(image.src)?.some((src) => shown.has(src))));
}
