import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { createElement, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { type GalleryImage, readChunkRpc } from "../shared/gallery";
import { readVideo } from "./media";

type Theme = PluginWorkspacePanelProps["theme"];

const web = Platform.OS === "web";

// The browser's Blob takes binary parts; React Native's global typings only list strings and blobs.
const BinaryBlob = Blob as unknown as new (parts: Uint8Array[], options: { type: string }) => Blob;

/**
 * Resolves a video to a URL the browser can play. Remote videos play from their URL; local files
 * are read from the daemon in chunks into a Blob, because panels have no HTTP route to stream
 * from. Kept out of the query cache so a closed video does not hold its bytes. Web only.
 */
export function useVideoUrl(video: GalleryImage) {
  const readChunk = useRpc(readChunkRpc);
  const readChunkRef = useRef(readChunk);
  readChunkRef.current = readChunk;
  // Tagged with the file it belongs to, so a render after `src` or `hash` changes never shows the
  // previous video (whose object URL the cleanup has already revoked).
  const key = `${video.src}\n${video.hash ?? ""}`;
  const [state, setState] = useState<{ key: string; url: string | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!web || video.kind !== "file") return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setState(null);
    readVideo(readChunkRef.current, video.src, () => cancelled).then(
      (result) => {
        if (!result || cancelled) return;
        objectUrl = URL.createObjectURL(new BinaryBlob(result.parts, { type: result.mimeType }));
        setState({ key, url: objectUrl, error: null });
      },
      (error: unknown) => {
        if (!cancelled) setState({ key, url: null, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [video.kind, video.src, key]);

  if (!web) return { url: null, error: null, loading: false };
  if (video.kind === "url") return { url: video.src, error: null, loading: false };
  const current = state?.key === key ? state : null;
  return { url: current?.url ?? null, error: current?.error ?? null, loading: current === null };
}

/** Plays one video with the browser's own controls; on native, says where it plays instead. */
export function VideoPlayer({ video, theme, label }: { video: GalleryImage; theme: Theme; label: string }) {
  const { url, error, loading } = useVideoUrl(video);
  // The URL that failed to play; a new URL gets a fresh try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = url !== null && failedUrl === url;

  const center = { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, gap: 6, padding: 16 };
  if (!web) {
    return (
      <View style={center}>
        <Text style={{ color: theme.colors.foreground }}>Videos play in the desktop and web app</Text>
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {video.src}
        </Text>
      </View>
    );
  }
  if (error || failed) {
    return (
      <View style={center}>
        <Text style={{ color: theme.colors.statusDanger }}>{error ?? "Couldn't play this video"}</Text>
      </View>
    );
  }
  if (loading || !url) {
    return (
      <View style={center}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      </View>
    );
  }
  // react-native-web renders through react-dom, so a DOM video element works on web and desktop.
  return createElement("video", {
    key: url,
    src: url,
    controls: true,
    playsInline: true,
    preload: "metadata",
    "aria-label": label,
    onError: () => setFailedUrl(url),
    style: {
      width: "100%",
      height: "100%",
      objectFit: "contain",
      backgroundColor: theme.colors.surface0,
      display: "block",
    },
  });
}
