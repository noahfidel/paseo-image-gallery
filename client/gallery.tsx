import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { type GalleryImage, listImagesRpc } from "../shared/gallery";
import { fileName, useImageUri } from "./image";
import { countLabel } from "./media";
import { Viewer } from "./viewer";

type Theme = PluginWorkspacePanelProps["theme"];

function Thumbnail({
  image,
  size,
  theme,
  onPress,
}: {
  image: GalleryImage;
  size: number;
  theme: Theme;
  onPress: () => void;
}) {
  const { uri, error, loading } = useImageUri(image, { thumbnail: true });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${fileName(image.src)}`}
      onPress={onPress}
      style={{ width: size, gap: 4 }}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {image.media === "video" ? (
          // No poster frame: that would mean loading every video just to draw the grid.
          <Icon name="Film" size={28} color={theme.colors.foregroundMuted} />
        ) : uri ? (
          <Image source={{ uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
        ) : loading ? (
          <ActivityIndicator color={theme.colors.foregroundMuted} />
        ) : (
          <Icon name="ImageOff" size={20} color={error ? theme.colors.statusDanger : theme.colors.foregroundMuted} />
        )}
      </View>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {fileName(image.src)}
      </Text>
    </Pressable>
  );
}

/** Every image and video from the agents of one workspace, opened from the Explorer "+" menu, /gallery, or ⌘K. */
export function GalleryPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const status = useWorkspace(workspaceId, (workspace) => workspace.status);
  const listImages = useRpc(listImagesRpc);
  // Rescan whenever the workspace changes status, e.g. when an agent finishes a turn.
  const gallery = useQuery({
    queryKey: ["gallery", workspaceId, status],
    queryFn: () => listImages({ workspaceId }),
    placeholderData: (previous) => previous,
  });
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  const padding = layout.compact ? 12 : 20;
  const gap = layout.compact ? 8 : 12;
  const target = layout.compact ? 110 : 160;
  const inner = Math.max(0, width - padding * 2);
  const columns = Math.max(1, Math.floor((inner + gap) / (target + gap)));
  const size = columns > 0 && inner > 0 ? Math.floor((inner - gap * (columns - 1)) / columns) : 0;
  // Newest first.
  const images = useMemo(() => [...(gallery.data?.images ?? [])].reverse(), [gallery.data]);
  // Track the open image by path so a rescan that adds images does not change what is shown.
  const selectedIndex = selected === null ? -1 : images.findIndex((image) => image.src === selected);

  const styles = useMemo(
    () => ({
      root: { flex: 1, backgroundColor: theme.colors.surface0 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: padding,
        paddingVertical: layout.compact ? 8 : 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap, padding },
      empty: { padding, gap: 6 },
    }),
    [theme, layout.compact, padding, gap],
  );

  return (
    <View style={styles.root} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <View style={styles.header}>
        <Text style={styles.title}>
          {gallery.data ? countLabel(images) : "Images"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh gallery"
          onPress={() => void gallery.refetch()}
          disabled={gallery.isFetching}
        >
          {gallery.isFetching ? (
            <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
          ) : (
            <Icon name="RefreshCw" size={16} color={theme.colors.foregroundMuted} />
          )}
        </Pressable>
      </View>
      {gallery.error ? (
        <View style={styles.empty}>
          <Text style={{ color: theme.colors.statusDanger }}>{gallery.error.message}</Text>
        </View>
      ) : gallery.data && images.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.title}>No images or videos in this workspace yet</Text>
          <Text style={styles.muted}>
            Images and videos appear here when an agent reads, writes, or links an image or video
            file, or when you upload one.
          </Text>
        </View>
      ) : (
        <ScrollView>
          <View style={styles.grid}>
            {size > 0 &&
              images.map((image) => (
                <Thumbnail
                  key={image.src}
                  image={image}
                  size={size}
                  theme={theme}
                  onPress={() => setSelected(image.src)}
                />
              ))}
          </View>
        </ScrollView>
      )}
      {selectedIndex >= 0 && (
        <Viewer
          images={images}
          index={selectedIndex}
          theme={theme}
          layout={layout}
          onIndexChange={(index) => setSelected(images[index].src)}
          onClose={() => setSelected(null)}
        />
      )}
    </View>
  );
}
