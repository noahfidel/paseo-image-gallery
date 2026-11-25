import { createHash } from "node:crypto";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
