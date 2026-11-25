import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginSettings } from "@getpaseo/plugin/server";
import {
  VIDEO_CHUNK_BYTES,
  type AttachmentCopiesMode,
  type GALLERY_SETTINGS,
  type GalleryImage,
  type listImagesRpc,
  type readChunkRpc,
  type readImageRpc,
  type readThumbnailRpc,
} from "../shared/gallery";
import { dedupeByContent, materializedFrom, normalize, type TimelineItem } from "./dedupe";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const VIDEO_MIME_TYPES: Record<string, string> = {
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
};
const IMAGE_EXT = "png|jpe?g|gif|webp|bmp|svg";
const VIDEO_EXT = "webm|mp4|mov|m4v";
const EXT = `${IMAGE_EXT}|${VIDEO_EXT}`;

type Media = GalleryImage["media"];

/** The media a path or URL claims to be, from its extension (query string ignored). */
function mediaOf(src: string): Media {
  const clean = src.replace(/[?#].*$/, "");
  return new RegExp(String.raw`\.(?:${VIDEO_EXT})$`, "i").test(clean) ? "video" : "image";
}
const PAGE_SIZE = 500;
const MAX_BYTES = 25 * 1024 * 1024;

/** Absolute or ~-prefixed paths, stopping at whitespace, quotes, and markdown/JSON delimiters. */
const PATH_PATTERN = new RegExp(String.raw`(?:~|/)[^\s"'\`<>()\[\]{},;|*]*\.(?:${EXT})\b`, "gi");
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const URL_PATTERN = new RegExp(String.raw`https?://[^\s"'\`<>()\[\]]+?\.(?:${EXT})(?:\?[^\s"'\`<>()\[\]]*)?(?=[\s"'\`<>()\[\]]|$)`, "gi");

/** Paths a scan returned; `gallery.read` and `gallery.thumbnail` serve only these. */
const allowedPaths = new Set<string>();

/** Content hashes keyed by path, reused while the file's size and modification time match. */
const hashCache = new Map<string, { size: number; mtimeMs: number; hash: string }>();

interface Candidate {
  raw: string;
  source: string;
}

function textCandidates(text: string, source: string): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE)) found.push({ raw: match[1], source: "markdown" });
  for (const match of text.matchAll(URL_PATTERN)) found.push({ raw: match[0], source });
  for (const match of text.matchAll(PATH_PATTERN)) found.push({ raw: match[0], source });
  return found;
}

function collect(value: unknown, source: string, out: Candidate[]): void {
  if (typeof value === "string") {
    out.push(...textCandidates(value, source));
  } else if (Array.isArray(value)) {
    for (const entry of value) collect(entry, source, out);
  } else if (value && typeof value === "object") {
    // Skip inline base64 payloads; they are never paths and can be huge.
    for (const [key, entry] of Object.entries(value)) if (key !== "data") collect(entry, source, out);
  }
}

function itemCandidates(item: TimelineItem): Candidate[] {
  const out: Candidate[] = [];
  switch (item.type) {
    case "user_message":
      collect(item.text, "user message", out);
      break;
    case "assistant_message":
      collect(item.text, "assistant", out);
      break;
    case "tool_call": {
      const name = String(item.name ?? "tool");
      const detail = item.detail as { type: string; filePath?: string } | undefined;
      if (detail?.filePath && new RegExp(String.raw`\.(?:${EXT})$`, "i").test(detail.filePath)) {
        out.push({ raw: detail.filePath, source: name });
      }
      collect(detail, name, out);
      break;
    }
    default:
      break;
  }
  return out;
}

/** Content hash of a readable file, or null when it is missing (or an image is too large). */
async function fileHash(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || (mediaOf(path) === "image" && info.size > MAX_BYTES)) return null;
    const cached = hashCache.get(path);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.hash;
    const hasher = createHash("sha1");
    for await (const chunk of createReadStream(path)) hasher.update(chunk);
    const hash = hasher.digest("hex");
    hashCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, hash });
    return hash;
  } catch {
    return null;
  }
}

const HASH_CONCURRENCY = 4;

/** Like Promise.all(items.map(fn)), but runs at most `limit` calls at a time; keeps result order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const URL_FAILURE_TTL_MS = 5 * 60 * 1000;
/** What a web link loaded as (null when it did not load as an image or video): successes are kept, failures are retried after a while. */
const urlCache = new Map<string, { media: Media | null; checkedAt: number }>();

async function probeUrl(url: string): Promise<Media | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const options = { redirect: "follow", signal: controller.signal } as const;
    let res = await fetch(url, { method: "HEAD", ...options });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: "GET", ...options });
      await res.body?.cancel();
    }
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    // The content type wins over the extension when they disagree.
    if (type.startsWith("image/")) return "image";
    if (type.startsWith("video/")) return "video";
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeMedia(url: string): Promise<Media | null> {
  const cached = urlCache.get(url);
  if (cached && (cached.media || Date.now() - cached.checkedAt < URL_FAILURE_TTL_MS)) return cached.media;
  const media = await probeUrl(url);
  urlCache.set(url, { media, checkedAt: Date.now() });
  return media;
}

interface WorkspaceAgent {
  id: string;
  title: string;
}

async function workspaceAgents(paseo: PluginHandlerContext["paseo"], workspaceId: string) {
  const { entries } = await paseo.agents.list({ page: { limit: 200 } });
  return entries
    .map((entry) => entry.agent)
    .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt && !agent.background)
    .map((agent): WorkspaceAgent => ({ id: agent.id, title: agent.title ?? agent.id.slice(0, 7) }));
}

/** Every image reference in one agent's timeline, first occurrence per path, unchecked on disk. */
async function agentCandidates(paseo: PluginHandlerContext["paseo"], agent: WorkspaceAgent) {
  const timeline = paseo.agents.ref(agent.id).timeline;
  const pages = [];
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_SIZE, projection: "canonical" });
  pages.unshift(page);
  while (page.hasOlder && page.startCursor) {
    page = await timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      limit: PAGE_SIZE,
      projection: "canonical",
    });
    pages.unshift(page);
  }

  const cwd = pages.at(-1)?.agent?.cwd ?? process.cwd();
  const home = process.env.HOME ?? "/";
  const seen = new Map<string, GalleryImage>();
  for (const { entries } of pages) {
    for (const entry of entries) {
      for (const candidate of itemCandidates(entry.item as TimelineItem)) {
        const normalized = normalize(candidate.raw, cwd, home);
        if (!normalized || seen.has(normalized.src)) continue;
        seen.set(normalized.src, {
          ...normalized,
          media: mediaOf(normalized.src),
          source: candidate.source,
          timestamp: entry.timestamp,
          agentId: agent.id,
          agentTitle: agent.title,
        });
      }
    }
  }
  const copyOf = materializedFrom(
    pages.flatMap(({ entries }) => entries as { item: TimelineItem }[]),
    cwd,
    home,
  );
  return { images: [...seen.values()], copyOf };
}

/** The saved setting, or "duplicates" when it is missing, invalid or unreadable. */
async function attachmentCopiesMode(
  settings?: PluginSettings<typeof GALLERY_SETTINGS.schema>,
): Promise<AttachmentCopiesMode> {
  try {
    const state = await settings?.read();
    return state?.status === "ready" ? state.values.attachmentCopies : "duplicates";
  } catch {
    return "duplicates";
  }
}

export async function listImages(
  { workspaceId }: RpcInput<typeof listImagesRpc>,
  { paseo }: PluginHandlerContext,
  settings?: PluginSettings<typeof GALLERY_SETTINGS.schema>,
): Promise<{ images: GalleryImage[] }> {
  const agents = await workspaceAgents(paseo, workspaceId);
  const perAgent = await Promise.all(
    agents.map((agent) =>
      agentCandidates(paseo, agent).catch((error) => {
        console.error(`Skipping agent ${agent.id}:`, error);
        return { images: [] as GalleryImage[], copyOf: new Map<string, string[]>() };
      }),
    ),
  );
  const copyOf = new Map<string, string[]>();
  for (const agent of perAgent) {
    for (const [copy, sources] of agent.copyOf) copyOf.set(copy, [...new Set([...(copyOf.get(copy) ?? []), ...sources])]);
  }
  const candidates = perAgent.flatMap((agent) => agent.images).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  // Only local hashing is limited; web-link probes wait on the network, so they all run at once.
  const fileIndexes = candidates.flatMap((image, index) => (image.kind === "url" ? [] : [index]));
  const [fileHashes, urlHashes] = await Promise.all([
    mapLimit(fileIndexes, HASH_CONCURRENCY, (index) => fileHash(candidates[index].src)),
    Promise.all(
      candidates.map(async (image) => {
        if (image.kind !== "url") return null;
        const media = await probeMedia(image.src);
        if (!media) return null;
        image.media = media;
        return image.src;
      }),
    ),
  ]);
  const hashes = urlHashes;
  fileIndexes.forEach((index, i) => (hashes[index] = fileHashes[i]));
  // The same image can appear under several paths and agents (Paseo also copies images shown
  // in chat into paseo-attachments-*); show it once, preferring the real file.
  const deduped = dedupeByContent(candidates, hashes, await attachmentCopiesMode(settings), copyOf);
  const hashBySrc = new Map(candidates.map((image, index) => [image.src, hashes[index]]));
  const images = deduped.map((image): GalleryImage => {
    const hash = hashBySrc.get(image.src);
    return image.kind === "file" && typeof hash === "string" ? { ...image, hash } : image;
  });
  for (const image of images) if (image.kind === "file") allowedPaths.add(image.src);
  return { images };
}

function checkAllowed(path: string) {
  if (!allowedPaths.has(path)) {
    throw new Error("This path is not an image from a session. Refresh the gallery.");
  }
  const mimeType = MIME_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`Unsupported image type: ${path}`);
  return mimeType;
}

/** Listed video files only; gallery.read and gallery.thumbnail never serve these. */
function checkVideo(path: string) {
  if (!allowedPaths.has(path)) {
    throw new Error("This path is not a video from a session. Refresh the gallery.");
  }
  const mimeType = VIDEO_MIME_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`Unsupported video type: ${path}`);
  return mimeType;
}

/** One slice of a listed video, at most VIDEO_CHUNK_BYTES; empty when the offset is past the end. */
export async function readChunk({ path, offset, length }: RpcInput<typeof readChunkRpc>) {
  const mimeType = checkVideo(path);
  // O_NONBLOCK keeps opening a FIFO that replaced the file from waiting for a writer.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Not a regular file: ${path}`);
    const { size } = info;
    const wanted = Math.min(length, VIDEO_CHUNK_BYTES, Math.max(0, size - offset));
    if (wanted === 0) return { mimeType, size, base64: "" };
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
    return { mimeType, size, base64: buffer.subarray(0, bytesRead).toString("base64") };
  } finally {
    await handle.close();
  }
}

export async function readImage({ path }: RpcInput<typeof readImageRpc>) {
  const mimeType = checkAllowed(path);
  const bytes = await readFile(path);
  return { mimeType, base64: bytes.toString("base64") };
}

/** Grid tiles crop images to squares, so the short side decides how sharp a thumbnail looks. */
const THUMBNAIL_SHORT_SIDE = 640;
/** Keeps very wide or tall images from producing large thumbnails. */
const THUMBNAIL_MAX_LONG_SIDE = 1600;
const THUMBNAIL_DIR = join(tmpdir(), "paseo-image-gallery-thumbnails");
const run = promisify(execFile);
/** Formats macOS `sips` converts reliably. SVG and others are served at full size. */
const RESIZABLE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

async function imageSize(path: string) {
  const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * A copy whose short side is THUMBNAIL_SHORT_SIDE pixels (long side at most
 * THUMBNAIL_MAX_LONG_SIDE), made with the `sips` tool built into macOS and cached in the temp
 * directory by content hash. Other platforms, formats `sips` cannot convert, and images that
 * would not shrink get the original file.
 */
export async function readThumbnail({ path }: RpcInput<typeof readThumbnailRpc>) {
  const mimeType = checkAllowed(path);
  const original = async () => ({ mimeType, base64: (await readFile(path)).toString("base64") });
  if (process.platform !== "darwin" || !RESIZABLE.has(extname(path).toLowerCase())) return original();
  const hash = await fileHash(path);
  if (!hash) return original();
  const key = `${hash}-s${THUMBNAIL_SHORT_SIDE}-l${THUMBNAIL_MAX_LONG_SIDE}`;
  const out = join(THUMBNAIL_DIR, `${key}.png`);
  try {
    const cached = await readFile(out);
    if (cached.length >= (await stat(path)).size) return original();
    return { mimeType: "image/png", base64: cached.toString("base64") };
  } catch {
    // Not cached yet.
  }
  try {
    const size = await imageSize(path);
    if (!size) return original();
    const long = Math.max(size.width, size.height);
    const short = Math.min(size.width, size.height);
    const target = Math.min(Math.round((long * THUMBNAIL_SHORT_SIDE) / short), THUMBNAIL_MAX_LONG_SIDE);
    if (target >= long) return original();
    await mkdir(THUMBNAIL_DIR, { recursive: true });
    await run("sips", ["-Z", String(target), "-s", "format", "png", path, "--out", out]);
    const bytes = await readFile(out);
    // Re-encoding can grow already compact images; then the original is the better thumbnail.
    if (bytes.length >= (await stat(path)).size) return original();
    return { mimeType: "image/png", base64: bytes.toString("base64") };
  } catch (error) {
    console.error(`Thumbnail failed for ${path}:`, error);
    return original();
  }
}
