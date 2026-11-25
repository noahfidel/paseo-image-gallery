import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type GalleryImage, readImageRpc, readThumbnailRpc } from "../shared/gallery";

/**
 * Resolves an image to a URI the Image component can show. Local files come from the daemon,
 * as a small copy when `thumbnail` is set. Videos never resolve here; they play through `useVideoUrl`.
 */
export function useImageUri(image: GalleryImage, { thumbnail = false } = {}) {
  const readImage = useRpc(thumbnail ? readThumbnailRpc : readImageRpc);
  const query = useQuery({
    queryKey: [thumbnail ? "gallery-thumbnail" : "gallery-image", image.src, image.hash],
    queryFn: () => readImage({ path: image.src }),
    enabled: image.kind === "file" && image.media !== "video",
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (image.media === "video") return { uri: null, error: null, loading: false };
  if (image.kind === "url") return { uri: image.src, error: null, loading: false };
  return {
    uri: query.data ? `data:${query.data.mimeType};base64,${query.data.base64}` : null,
    error: query.error,
    loading: query.isPending,
  };
}

export function fileName(src: string) {
  return src.split(/[\\/]/).pop()?.split("?")[0] || src;
}
