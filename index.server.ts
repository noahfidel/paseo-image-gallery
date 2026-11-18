import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listImages, readImage, readThumbnail } from "./server/gallery";
import { GALLERY_SETTINGS, listImagesRpc, readImageRpc, readThumbnailRpc } from "./shared/gallery";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(GALLERY_SETTINGS);
  server.handle(listImagesRpc, (input, ctx) => listImages(input, ctx, settings));
  server.handle(readImageRpc, readImage);
  server.handle(readThumbnailRpc, readThumbnail);
  return () => {};
}
