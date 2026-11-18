import { describe, expect, it } from "vitest";
import { dedupeByContent, isAttachmentCopy } from "../server/dedupe";
import type { GalleryImage } from "../shared/gallery";

function image(src: string, timestamp: string, kind: GalleryImage["kind"] = "file"): GalleryImage {
  return { src, kind, source: "Read", timestamp, agentId: "a", agentTitle: "Agent" };
}

const COPY = "/var/folders/xx/T/paseo-attachments-abc123/9e342c7f.png";
const REAL = "/work/1-AFTER-groups-table.png";

describe("isAttachmentCopy", () => {
  it("matches a directory segment starting with paseo-attachments-", () => {
    expect(isAttachmentCopy("/tmp/paseo-attachments-x/abc.png")).toBe(true);
    expect(isAttachmentCopy("/tmp/paseo-attachments-x/sub/abc.png")).toBe(true);
  });
  it("ignores substrings, file names and other paths", () => {
    expect(isAttachmentCopy("/home/u/my-paseo-attachments-notes/a.png")).toBe(false);
    expect(isAttachmentCopy("/home/u/paseo-attachments-x.png")).toBe(false);
    expect(isAttachmentCopy("/home/u/shots/a.png")).toBe(false);
  });
});

describe("dedupeByContent", () => {
  it("prefers the real path when the attachments copy appears first", () => {
    const images = [image(COPY, "1"), image(REAL, "2")];
    expect(dedupeByContent(images, ["h", "h"], "duplicates")).toEqual([images[1]]);
  });
  it("keeps the real path when it appears first", () => {
    const images = [image(REAL, "1"), image(COPY, "2")];
    expect(dedupeByContent(images, ["h", "h"], "duplicates")).toEqual([images[0]]);
  });
  it("keeps an attachments-only image in duplicates mode", () => {
    const images = [image(COPY, "1")];
    expect(dedupeByContent(images, ["h"], "duplicates")).toEqual(images);
  });
  it("drops an attachments-only image in all mode", () => {
    const images = [image(COPY, "1"), image(REAL, "2")];
    expect(dedupeByContent(images, ["h", "g"], "all")).toEqual([images[1]]);
  });
  it("defaults to duplicates mode", () => {
    const images = [image(COPY, "1")];
    expect(dedupeByContent(images, ["h"])).toEqual(images);
  });
  it("keeps the earliest of several real copies", () => {
    const images = [image(COPY, "1"), image("/a/x.png", "2"), image("/b/y.png", "3")];
    expect(dedupeByContent(images, ["h", "h", "h"], "duplicates")).toEqual([images[1]]);
  });
  it("orders output by each group's first appearance", () => {
    const images = [image(COPY, "1"), image("/a/other.png", "2"), image(REAL, "3")];
    expect(dedupeByContent(images, ["h", "g", "h"], "duplicates")).toEqual([images[2], images[1]]);
  });
  it("drops null hashes and keeps unrelated images", () => {
    const images = [image("/a.png", "1"), image("/b.png", "2"), image("https://x/y.png", "3", "url")];
    expect(dedupeByContent(images, ["a", null, "https://x/y.png"], "duplicates")).toEqual([images[0], images[2]]);
  });
  it("never treats a url as an attachment copy", () => {
    const images = [image("https://x/paseo-attachments-a/y.png", "1", "url")];
    expect(dedupeByContent(images, ["u"], "all")).toEqual(images);
  });
});
