import { describe, expect, it } from "vitest";
import { dedupeByContent, isAttachmentCopy, materializedFrom } from "../server/dedupe";
import type { GalleryImage } from "../shared/gallery";

function image(src: string, timestamp: string, kind: GalleryImage["kind"] = "file"): GalleryImage {
  return { src, kind, media: "image", source: "Read", timestamp, agentId: "a", agentTitle: "Agent" };
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

describe("dedupeByContent with copyOf links", () => {
  const links = new Map([[COPY, [REAL]]]);
  it("drops a linked copy when its real file is shown, even with a new hash", () => {
    const images = [image(COPY, "1"), image(REAL, "2")];
    expect(dedupeByContent(images, ["old", "new"], "duplicates", links)).toEqual([images[1]]);
  });
  it("keeps the copy when the real file is gone", () => {
    const images = [image(COPY, "1"), image(REAL, "2")];
    expect(dedupeByContent(images, ["old", null], "duplicates", links)).toEqual([images[0]]);
  });
  it("keeps the copy when its linked file is not a candidate", () => {
    const images = [image(COPY, "1")];
    expect(dedupeByContent(images, ["old"], "duplicates", links)).toEqual(images);
  });
});

describe("materializedFrom", () => {
  const copy = (name: string, ext = "png") => `file:///tmp/paseo-attachments-x/${name}.${ext}`;
  const msg = (name: string, ext = "png") => ({
    item: { type: "assistant_message", text: `\n\n![Image](${copy(name, ext)})\n\n` },
  });
  const read = (filePath: string) => ({ item: { type: "tool_call", name: "Read", detail: { type: "read", filePath } } });
  const run = (entries: { item: { type: string; [k: string]: unknown } }[]) =>
    materializedFrom(entries, "/work", "/home/u");

  it("links a copy to the image read right before it", () => {
    const links = run([read("/work/a.png"), msg("abc")]);
    expect(links.get("/tmp/paseo-attachments-x/abc.png")).toEqual(["/work/a.png"]);
  });
  it("links every copy to every read in the run", () => {
    const links = run([read("/work/a.png"), read("b.png"), msg("c1"), msg("c2")]);
    expect(links.get("/tmp/paseo-attachments-x/c1.png")).toEqual(["/work/a.png", "/work/b.png"]);
    expect(links.get("/tmp/paseo-attachments-x/c2.png")).toEqual(["/work/a.png", "/work/b.png"]);
  });
  it("does not link after a non-tool_call entry", () => {
    const entries = [read("/work/a.png"), { item: { type: "user_message", text: "hi" } }, msg("abc")];
    expect(run(entries).size).toBe(0);
  });
  it("links a paseo-attachments video copy to the video read before it", () => {
    const links = run([read("/work/clip.webm"), msg("vid", "mp4")]);
    expect(links.get("/tmp/paseo-attachments-x/vid.mp4")).toEqual(["/work/clip.webm"]);
  });
  it("ignores non-image reads, non-read tool calls and attachment copies as sources", () => {
    const shell = { item: { type: "tool_call", name: "Bash", detail: { type: "shell", filePath: "/work/a.png" } } };
    expect(run([read("/work/notes.txt"), msg("a")]).size).toBe(0);
    expect(run([shell, msg("b")]).size).toBe(0);
    expect(run([read("/tmp/paseo-attachments-y/z.png"), msg("c")]).size).toBe(0);
  });
});
