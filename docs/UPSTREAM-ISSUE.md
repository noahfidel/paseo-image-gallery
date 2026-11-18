# Upstream issue draft

For github.com/mordol/paseo-image-gallery. Not filed; paste when ready.

---

**Title:** Hash-named copies from paseo-attachments duplicate or replace the real image

## What happens

The gallery shows images named only by a hash, such as `9e342c7f335f915b66245dc7940c0ad68eb02293a1dfbd4ac7ba6c4fe62cb3de.png`, mixed in with the real images. Often the hash-named tile appears instead of the real file (for example `1-AFTER-groups-table.png`), so the caption says nothing useful. These tiles cannot be removed.

## Cause

When an image is put into an agent's chat, the Paseo daemon writes a copy of it to a shared temp folder, `paseo-attachments-*/<sha256-of-content>.<ext>`. That copy's path then shows up in the chat's timeline (for example in Markdown), and the scanner treats it like any other image.

The content dedupe in `listImages` then keeps the earliest appearance of each hash. The attachments copy is often earlier in the timeline than the path to the real file, so the real file is the one dropped.

## Steps to reproduce

1. In a workspace, have an agent write an image to a normal path, e.g. `shots/1-AFTER-screen.png`.
2. Get that image into the agent's chat (e.g. the agent reads the image), and mention its real path in a later message.
3. Open the image gallery: the tile is captioned with the hash-named `paseo-attachments-*` path, not `1-AFTER-screen.png`.

## When the real file changes later

Content dedupe only works while the real file still matches the copy. If the agent edits the real file in place after reading it (for example adding a BEFORE/AFTER banner), its hash changes. The stale hash-named copy then no longer matches anything, so it stays in the gallery next to the edited file.

## Asks

1. **Prefer the real path.** When several paths have the same content, keep the one outside `paseo-attachments-*`, and fall back to the attachments copy only when it is the only one.
2. **A setting for attachment copies.** Let users hide images under `paseo-attachments-*`: either only when a copy of the same content exists elsewhere (suggested default, because sometimes the attachments copy is the only one left and hiding it would lose the image), or always.
3. **Tie a copy to its source.** The daemon emits the copy's image right after the tool call that read the real file, so link the copy to the file read by the tool call right before it and drop the copy while that file is shown. Better, have the daemon record the source path (for example in the alt text or item metadata) so plugins do not need to infer it.
4. **Optional:** a per-tile Hide, so one stray image can be dismissed.

A fork implements 1 to 3 (a pure `dedupeByContent` helper that prefers non-attachments paths, a host setting `attachmentCopies` with `duplicates` (default) and `all`, and vitest tests); happy to open a PR if useful.
