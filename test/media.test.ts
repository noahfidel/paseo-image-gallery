import { describe, expect, it, vi } from "vitest";
import { countLabel, decodeBase64, readVideo, videoTooLargeMessage } from "../client/media";
import { MAX_VIDEO_BYTES, VIDEO_CHUNK_BYTES } from "../shared/gallery";

const image = { media: "image" as const };
const video = { media: "video" as const };

describe("countLabel", () => {
  it("counts images only", () => {
    expect(countLabel([])).toBe("0 images");
    expect(countLabel([image])).toBe("1 image");
    expect(countLabel([image, image, image])).toBe("3 images");
  });

  it("counts videos only", () => {
    expect(countLabel([video])).toBe("1 video");
    expect(countLabel([video, video])).toBe("2 videos");
  });

  it("counts both", () => {
    expect(countLabel([image, video, image, image])).toBe("3 images · 1 video");
    expect(countLabel([image, video, video])).toBe("1 image · 2 videos");
  });
});

describe("videoTooLargeMessage", () => {
  it("names the size and the limit", () => {
    expect(videoTooLargeMessage(350 * 1024 * 1024)).toBe(
      "This video is 350 MB; the gallery plays videos up to 200 MB.",
    );
  });

  it("never reads as the limit itself when just over it", () => {
    expect(videoTooLargeMessage(MAX_VIDEO_BYTES + 1)).toBe(
      "This video is 201 MB; the gallery plays videos up to 200 MB.",
    );
  });
});

describe("readVideo", () => {
  const file = Buffer.from(Array.from({ length: 10 }, (_, i) => i));

  /** Serves `bytes` like the daemon does, `chunk` bytes at a time. */
  function fakeReadChunk(bytes: Buffer, chunk: number, size = bytes.length) {
    return vi.fn(async ({ offset, length }: { path: string; offset: number; length: number }) => ({
      mimeType: "video/mp4",
      size,
      base64: bytes.subarray(offset, offset + Math.min(length, chunk)).toString("base64"),
    }));
  }

  it("decodes base64 to bytes", () => {
    expect([...decodeBase64(file.toString("base64"))]).toEqual([...file]);
  });

  it("reads every chunk in order", async () => {
    const readChunk = fakeReadChunk(file, 4);
    const result = await readVideo(readChunk, "/v.mp4", () => false);
    expect(result?.mimeType).toBe("video/mp4");
    expect(Buffer.concat(result?.parts ?? [])).toEqual(file);
    expect(readChunk.mock.calls.map(([input]) => input.offset)).toEqual([0, 4, 8]);
    expect(readChunk.mock.calls[0][0]).toEqual({ path: "/v.mp4", offset: 0, length: VIDEO_CHUNK_BYTES });
  });

  it("refuses a file over the limit after the first chunk", async () => {
    const readChunk = fakeReadChunk(file, 4, MAX_VIDEO_BYTES + 1);
    await expect(readVideo(readChunk, "/v.mp4", () => false)).rejects.toThrow(
      "the gallery plays videos up to 200 MB",
    );
    expect(readChunk).toHaveBeenCalledTimes(1);
  });

  it("stops when cancelled between chunks", async () => {
    let cancelled = false;
    const readChunk = fakeReadChunk(file, 4);
    readChunk.mockImplementationOnce(async () => {
      cancelled = true;
      return { mimeType: "video/mp4", size: file.length, base64: file.subarray(0, 4).toString("base64") };
    });
    expect(await readVideo(readChunk, "/v.mp4", () => cancelled)).toBeNull();
    expect(readChunk).toHaveBeenCalledTimes(1);
  });

  it("stops when the file shrank while loading", async () => {
    const readChunk = fakeReadChunk(file.subarray(0, 4), 4, file.length);
    const result = await readVideo(readChunk, "/v.mp4", () => false);
    expect(Buffer.concat(result?.parts ?? [])).toEqual(file.subarray(0, 4));
    expect(readChunk).toHaveBeenCalledTimes(2);
  });
});
