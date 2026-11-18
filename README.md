# Image gallery for Paseo

A [Paseo](https://paseo.sh) plugin that collects every image from a workspace's agent sessions into a gallery in the right-side Explorer panel.

![Gallery in the Explorer panel](assets/screenshot-grid.png)

![Full-screen viewer](assets/screenshot-viewer.png)

## Features

- Open **Image gallery** from the Explorer **+** menu, from the Command Center ("Open workspace image gallery"), or with `/gallery` in the composer.
- Finds images the agents read or wrote, image paths in commands, outputs, and messages, uploaded image files, and Markdown images. Identical images are shown once, preferring the real file over the hash-named copy Paseo keeps in its `paseo-attachments-*` temp folder.
- **Settings > Image gallery > Paseo attachment copies** chooses whether those copies are hidden only when the original is also shown (default) or always.
- Full-screen viewer with hover controls, previous and next buttons, left and right arrow keys, zoom to fit for small images, and actual size with drag panning for large images.

## Install

Requires Paseo 0.16.0 or later with plugins enabled.

```bash
paseo plugin add git:mordol/paseo-image-gallery
```

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin reload paseo-image-gallery
```

## How it works

The daemon side reads each agent's timeline through the Paseo SDK, extracts image references, keeps files that exist on the daemon machine, and removes duplicates by content hash, cached by file size and modification time. Of several paths with the same content it keeps the earliest one outside `paseo-attachments-*` folders; a copy there is kept only when it is the only one, unless the setting hides them always. A copy is also dropped when the agent read a real image file right before the copy was shown and that file is still listed, so editing the file in place does not leave a stale copy. On macOS, large grid thumbnails are resized with the built-in `sips` tool to a 640px short side and cached in the system temp directory. The app requests image bytes only for paths returned by a scan. Images pasted directly into the composer are not recorded in the timeline, so they do not appear.

## License

MIT
