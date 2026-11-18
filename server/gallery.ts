import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginSettings } from "@getpaseo/plugin/server";
import type { AttachmentCopiesMode, GALLERY_SETTINGS, GalleryImage, listImagesRpc, readImageRpc, readThumbnailRpc } from "../shared/gallery";
import { dedupeByContent } from "./dedupe";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const EXT = "png|jpe?g|gif|webp|bmp|svg";
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

// The timeline item type lives in @getpaseo/protocol; match its shape loosely here.
type TimelineItem = { type: string; [key: string]: unknown };

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

/** Content hash of a readable image file, or null when it is missing or too large. */
async function fileHash(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const cached = hashCache.get(path);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.hash;
    const hash = createHash("sha1").update(await readFile(path)).digest("hex");
    hashCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, hash });
    return hash;
  } catch {
    return null;
  }
}

function normalize(raw: string, cwd: string, home: string): Pick<GalleryImage, "src" | "kind"> | null {
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
          source: candidate.source,
          timestamp: entry.timestamp,
          agentId: agent.id,
          agentTitle: agent.title,
        });
      }
    }
  }
  return [...seen.values()];
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
        return [];
      }),
    ),
  );
  const candidates = perAgent.flat().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const hashes = await Promise.all(
    candidates.map((image) => (image.kind === "url" ? image.src : fileHash(image.src))),
  );
  // The same image can appear under several paths and agents (Paseo also copies images shown
  // in chat into paseo-attachments-*); show it once, preferring the real file.
  const images = dedupeByContent(candidates, hashes, await attachmentCopiesMode(settings));
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
