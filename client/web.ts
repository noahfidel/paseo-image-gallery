import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface KeyEvent {
  key: string;
  target: { tagName?: string } | null;
  preventDefault(): void;
}
declare const navigator: { userAgent: string };
declare const window: {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
};

/**
 * Calls `handler` for each key press on web and desktop. Return true to consume the key.
 * `inVideo` is true when a video player has focus, so the handler can leave its keys alone.
 * Native platforms have no hardware keyboard events here, so this is a no-op there.
 */
export function onKeyDown(handler: (key: string, context: { inVideo: boolean }) => boolean): () => void {
  if (Platform.OS !== "web") return () => {};
  const listener = (event: KeyEvent) => {
    const inVideo = event.target?.tagName === "VIDEO";
    if (handler(event.key, { inVideo })) event.preventDefault();
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}

/**
 * True in the macOS desktop app, where the window buttons overlay the top-left corner of a
 * full-window modal. Browsers and native platforms keep their own window chrome.
 */
export function hasWindowButtons(): boolean {
  if (Platform.OS !== "web") return false;
  const agent = navigator.userAgent;
  return agent.includes("Electron") && agent.includes("Macintosh");
}
