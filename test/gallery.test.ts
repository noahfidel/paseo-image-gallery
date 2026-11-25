import { createHash } from "node:crypto";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listImages, readChunk, readImage } from "../server/gallery";
import { VIDEO_CHUNK_BYTES } from "../shared/gallery";

const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

function fakeContext(filePath: string, cwd: string) {
  return {
    paseo: {
      agents: {
        list: async () => ({
          entries: [{ agent: { id: "a1", workspaceId: "w", title: "Agent", archivedAt: null, background: false } }],
        }),
        ref: () => ({
          timeline: {
            refetch: async () => ({
              entries: [
                {
                  timestamp: "2026-01-01T00:00:00Z",
                  item: { type: "tool_call", name: "Read", detail: { type: "read", filePath } },
                },
              ],
              hasOlder: false,
              startCursor: null,
              agent: { cwd },
            }),
          },
        }),
      },
    },
  } as never;
}

describe("listImages", () => {
  it("carries a content hash that changes when the file is overwritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gallery-test-"));
    const path = join(dir, "shot.png");
    const context = fakeContext(path, dir);

    const first = Buffer.from("first bytes");
    await writeFile(path, first);
    await utimes(path, new Date(1_000_000), new Date(1_000_000));
    const before = (await listImages({ workspaceId: "w" }, context)).images[0];
    expect(before.hash).toBe(sha1(first));

    const second = Buffer.from("other bytes!");
    await writeFile(path, second);
    await utimes(path, new Date(2_000_000), new Date(2_000_000));
    const after = (await listImages({ workspaceId: "w" }, context)).images[0];
    expect(after.hash).toBe(sha1(second));
    expect(after.hash).not.toBe(before.hash);
  });
});

function textContext(text: string) {
  return {
    paseo: {
      agents: {
        list: async () => ({
          entries: [{ agent: { id: "a1", workspaceId: "w", title: "Agent", archivedAt: null, background: false } }],
        }),
        ref: () => ({
          timeline: {
            refetch: async () => ({
              entries: [{ timestamp: "2026-01-01T00:00:00Z", item: { type: "assistant_message", text } }],
              hasOlder: false,
              startCursor: null,
              agent: { cwd: "/tmp" },
            }),
          },
        }),
      },
    },
  } as never;
}

function response(status: number, contentType: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType }),
    body: { cancel: async () => {} },
  };
}

describe("listImages web links", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps links that load as images and drops the rest", async () => {
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url.endsWith("/ok.png")) return response(200, "image/png");
      if (url.endsWith("/missing.png")) return response(404, "text/html");
      if (url.endsWith("/page.png")) return response(200, "text/html");
      if (url.endsWith("/boom.png")) throw new Error("network down");
      if (url.endsWith("/head405.png")) {
        return init?.method === "HEAD" ? response(405, "text/plain") : response(200, "image/png");
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = [
      "![a](https://x.test/ok.png)",
      "![b](https://x.test/missing.png)",
      "![c](https://x.test/page.png)",
      "![d](https://x.test/boom.png)",
      "![e](https://x.test/head405.png)",
    ].join("\n");
    const { images } = await listImages({ workspaceId: "w" }, textContext(text));
    expect(images.map((image) => image.src).sort()).toEqual([
      "https://x.test/head405.png",
      "https://x.test/ok.png",
    ]);
    const methods = fetchMock.mock.calls.filter(([url]) => url.endsWith("/head405.png")).map(([, init]) => init?.method);
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("probes every link at once instead of a few at a time", async () => {
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (++started === 6) release();
        await allStarted;
        return response(200, "image/png");
      }),
    );
    const text = Array.from({ length: 6 }, (_, i) => `![i](https://x.test/${i}.png)`).join("\n");
    const { images } = await listImages({ workspaceId: "w" }, textContext(text));
    expect(images).toHaveLength(6);
  });
});

function multiContext(entries: unknown[], cwd = "/tmp") {
  return {
    paseo: {
      agents: {
        list: async () => ({
          entries: [{ agent: { id: "a1", workspaceId: "w", title: "Agent", archivedAt: null, background: false } }],
        }),
        ref: () => ({
          timeline: { refetch: async () => ({ entries, hasOlder: false, startCursor: null, agent: { cwd } }) },
        }),
      },
    },
  } as never;
}

describe("listImages videos", () => {
  it("lists .webm and .mp4 from Read calls and assistant text as video with a hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gallery-video-"));
    const webm = join(dir, "clip.webm");
    const mp4 = join(dir, "demo.mp4");
    await writeFile(webm, Buffer.from("webm bytes"));
    await writeFile(mp4, Buffer.from("mp4 bytes"));
    const entries = [
      { timestamp: "2026-01-01T00:00:00Z", item: { type: "tool_call", name: "Read", detail: { type: "read", filePath: webm } } },
      { timestamp: "2026-01-02T00:00:00Z", item: { type: "assistant_message", text: `see ${mp4} here` } },
    ];
    const { images } = await listImages({ workspaceId: "w" }, multiContext(entries, dir));
    expect(images.map((i) => [i.src, i.media, i.hash])).toEqual([
      [webm, "video", sha1(Buffer.from("webm bytes"))],
      [mp4, "video", sha1(Buffer.from("mp4 bytes"))],
    ]);
  });

  it("changes a video's hash when it is overwritten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gallery-video-"));
    const path = join(dir, "clip.webm");
    const context = fakeContext(path, dir);
    await writeFile(path, Buffer.from("one"));
    await utimes(path, new Date(1_000_000), new Date(1_000_000));
    const before = (await listImages({ workspaceId: "w" }, context)).images[0];
    await writeFile(path, Buffer.from("two!"));
    await utimes(path, new Date(2_000_000), new Date(2_000_000));
    const after = (await listImages({ workspaceId: "w" }, context)).images[0];
    expect(before.media).toBe("video");
    expect(after.hash).not.toBe(before.hash);
  });

  it("still lists a PNG as image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gallery-video-"));
    const path = join(dir, "a.png");
    await writeFile(path, Buffer.from("png"));
    const { images } = await listImages({ workspaceId: "w" }, fakeContext(path, dir));
    expect(images[0].media).toBe("image");
  });
});

describe("listImages video web links", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a video link by content type and drops html", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/ok.webm")) return response(200, "video/webm");
        if (url.endsWith("/page.mp4")) return response(200, "text/html");
        if (url.endsWith("/odd.png")) return response(200, "video/mp4");
        throw new Error(`unexpected ${url}`);
      }),
    );
    const text = "https://x.test/ok.webm https://x.test/page.mp4 https://x.test/odd.png";
    const { images } = await listImages({ workspaceId: "w" }, textContext(text));
    expect(images.map((i) => [i.src, i.media]).sort()).toEqual([
      ["https://x.test/odd.png", "video"],
      ["https://x.test/ok.webm", "video"],
    ]);
  });
});

describe("readChunk limits", () => {
  it("clamps length to the chunk size and returns empty at offset === size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gallery-chunk-"));
    const video = join(dir, "big.webm");
    const size = VIDEO_CHUNK_BYTES + 1024;
    await writeFile(video, Buffer.alloc(size, 7));
    const entries = [
      { timestamp: "2026-01-01T00:00:00Z", item: { type: "tool_call", name: "Read", detail: { type: "read", filePath: video } } },
    ];
    await listImages({ workspaceId: "w" }, multiContext(entries, dir));
    const big = await readChunk({ path: video, offset: 0, length: size });
    expect(Buffer.from(big.base64, "base64").length).toBe(VIDEO_CHUNK_BYTES);
    expect(big.size).toBe(size);
    const end = await readChunk({ path: video, offset: size, length: 10 });
    expect(end.base64).toBe("");
    expect(end.size).toBe(size);
  });
});

describe("readChunk", () => {
  it("returns the requested slice and whole-file size, and refuses unlisted and image paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gallery-chunk-"));
    const video = join(dir, "clip.mp4");
    const png = join(dir, "a.png");
    const unlisted = join(dir, "other.mp4");
    await writeFile(video, Buffer.from("0123456789"));
    await writeFile(png, Buffer.from("png"));
    await writeFile(unlisted, Buffer.from("zzz"));
    const entries = [video, png].map((filePath, i) => ({
      timestamp: `2026-01-0${i + 1}T00:00:00Z`,
      item: { type: "tool_call", name: "Read", detail: { type: "read", filePath } },
    }));
    await listImages({ workspaceId: "w" }, multiContext(entries, dir));

    const slice = await readChunk({ path: video, offset: 2, length: 4 });
    expect(slice.mimeType).toBe("video/mp4");
    expect(slice.size).toBe(10);
    expect(Buffer.from(slice.base64, "base64").toString()).toBe("2345");
    const tail = await readChunk({ path: video, offset: 8, length: 100 });
    expect(Buffer.from(tail.base64, "base64").toString()).toBe("89");
    const past = await readChunk({ path: video, offset: 50, length: 4 });
    expect(past.base64).toBe("");
    expect(past.size).toBe(10);
    await expect(readChunk({ path: unlisted, offset: 0, length: 1 })).rejects.toThrow();
    await expect(readChunk({ path: png, offset: 0, length: 1 })).rejects.toThrow();
    await expect(readImage({ path: video })).rejects.toThrow("Unsupported image type");
    expect(VIDEO_CHUNK_BYTES).toBe(4 * 1024 * 1024);
  });
});
