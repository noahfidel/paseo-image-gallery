import { type GalleryImage, MAX_VIDEO_BYTES, VIDEO_CHUNK_BYTES } from "../shared/gallery";

// Pure helpers for the gallery client, kept free of React Native so tests can import them.

const MB = 1024 * 1024;

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Header text, e.g. "3 images", "1 video" or "3 images · 1 video". */
export function countLabel(items: readonly Pick<GalleryImage, "media">[]) {
  const videos = items.filter((item) => item.media === "video").length;
  const images = items.length - videos;
  if (videos === 0) return plural(images, "image");
  if (images === 0) return plural(videos, "video");
  return `${plural(images, "image")} · ${plural(videos, "video")}`;
}

/** Why a video is not played; rounds up so a file just over the limit never reads as 200 MB. */
export function videoTooLargeMessage(size: number) {
  return `This video is ${Math.ceil(size / MB)} MB; the gallery plays videos up to ${MAX_VIDEO_BYTES / MB} MB.`;
}

export function decodeBase64(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type ReadChunk = (input: { path: string; offset: number; length: number }) => Promise<{
  mimeType: string;
  size: number;
  base64: string;
}>;

/**
 * Reads a whole video file in chunks. Throws the size message when the file is over the limit.
 * Returns null when `cancelled` turns true between chunks, so a stale load stops early.
 */
export async function readVideo(
  readChunk: ReadChunk,
  path: string,
  cancelled: () => boolean,
): Promise<{ mimeType: string; parts: Uint8Array<ArrayBuffer>[] } | null> {
  const first = await readChunk({ path, offset: 0, length: VIDEO_CHUNK_BYTES });
  if (cancelled()) return null;
  if (first.size > MAX_VIDEO_BYTES) throw new Error(videoTooLargeMessage(first.size));
  const parts = [decodeBase64(first.base64)];
  let offset = parts[0].length;
  while (offset < first.size) {
    const chunk = await readChunk({ path, offset, length: VIDEO_CHUNK_BYTES });
    if (cancelled()) return null;
    const bytes = decodeBase64(chunk.base64);
    // The file shrank while loading; stop rather than ask for the same offset forever.
    if (bytes.length === 0) break;
    parts.push(bytes);
    offset += bytes.length;
  }
  return { mimeType: first.mimeType, parts };
}
