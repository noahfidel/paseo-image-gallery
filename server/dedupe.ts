import type { AttachmentCopiesMode, GalleryImage } from "../shared/gallery";

/** True for a file inside one of Paseo's `paseo-attachments-*` temp folders. */
export function isAttachmentCopy(path: string): boolean {
  return path.split(/[\\/]/).slice(0, -1).some((segment) => segment.startsWith("paseo-attachments-"));
}

/**
 * Keeps one entry per content hash, in the order the contents first appear. Candidates are
 * sorted by timestamp; a null hash drops the entry. Paseo keeps a hash-named copy of every image
 * shown in chat under `paseo-attachments-*`, so the earliest entry outside those folders wins,
 * and a copy is kept only when no other path has the same content. Mode "all" drops copies even
 * then.
 */
export function dedupeByContent(
  candidates: GalleryImage[],
  hashes: (string | null)[],
  mode: AttachmentCopiesMode = "duplicates",
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
  return mode === "all" ? images.filter((image) => !isCopy(image)) : images;
}
