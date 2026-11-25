import { createHash } from "node:crypto";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listImages } from "../server/gallery";

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
});
