import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GalleryPanel } from "./client/gallery";
import { GallerySettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  // Workspace panels are listed in the Explorer "+" menu.
  client.addWorkspacePanel({
    id: "gallery",
    title: "Image gallery",
    icon: "Images",
    locations: ["explorer"],
    Component: GalleryPanel,
  });
  client.addSettingsScreen({
    id: "gallery",
    title: "Image gallery",
    icon: "Images",
    Component: GallerySettings,
  });
  client.addCommandCenterItem({
    id: "open-gallery",
    title: "Open workspace image gallery",
    icon: "Images",
    keywords: ["image", "gallery", "screenshot", "photo"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("gallery", { location: "explorer" });
    },
  });
  client.addSlashCommand({
    name: "gallery",
    description: "Show this workspace's images",
    argumentHint: "",
    context: "workspace",
    onSubmit({ openPanel }) {
      openPanel("gallery", { location: "explorer" });
    },
  });
  return () => {};
}
