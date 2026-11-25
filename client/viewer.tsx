import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  PanResponder,
  Pressable,
  Text,
  View,
} from "react-native";
import type { GalleryImage } from "../shared/gallery";
import { fileName, useImageUri } from "./image";
import { hasWindowButtons, onKeyDown } from "./web";

type Theme = PluginWorkspacePanelProps["theme"];
type Layout = PluginWorkspacePanelProps["layout"];
type Zone = "top" | "bottom" | "left" | "right";

const EDGE = 96;
const BAR = 72;
const HIDE_DELAY_MS = 250;
/** Room for the macOS window buttons, which sit over the top-left corner of a full-window modal. */
const WINDOW_BUTTONS_INSET = 80;

/**
 * Hover tracking for one zone. The zone and every button inside it report hover separately,
 * because moving onto a child button can end the zone's own hover.
 */
const HoverContext = createContext<{ enter: (id: string) => void; leave: (id: string) => void } | null>(null);

/** Pressable hover props that keep the surrounding zone revealed. */
function useZoneHover(id: string) {
  const hover = useContext(HoverContext);
  return hover ? { onHoverIn: () => hover.enter(id), onHoverOut: () => hover.leave(id) } : {};
}

function clamp(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value));
}

function ToolButton({
  icon,
  label,
  theme,
  compact,
  disabled = false,
  onPress,
}: {
  icon: string;
  label: string;
  theme: Theme;
  compact: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const hover = useZoneHover(`button:${label}`);
  return (
    <Pressable
      {...hover}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Icon name={icon} size={16} color={theme.colors.foreground} />
      {!compact ? <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{label}</Text> : null}
    </Pressable>
  );
}

function NavButton({
  side,
  enabled,
  theme,
  onPress,
}: {
  side: "left" | "right";
  enabled: boolean;
  theme: Theme;
  onPress: () => void;
}) {
  const hover = useZoneHover("nav");
  return (
    <Pressable
      {...hover}
      accessibilityRole="button"
      accessibilityLabel={side === "left" ? "Previous image" : "Next image"}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={{
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        opacity: enabled ? 1 : 0.3,
      }}
    >
      <Icon name={side === "left" ? "ChevronLeft" : "ChevronRight"} size={22} color={theme.colors.foreground} />
    </Pressable>
  );
}

/** A region that reveals its controls while hovered (web) or while controls are pinned by a tap. */
function HoverZone({
  zone,
  style,
  visible,
  hoverable,
  onHover,
  children,
}: {
  zone: Zone;
  style: object;
  visible: boolean;
  hoverable: boolean;
  onHover: (id: string, zone: Zone, hovered: boolean) => void;
  children: ReactNode;
}) {
  const context = useMemo(
    () => ({
      enter: (id: string) => onHover(`${zone}:${id}`, zone, true),
      leave: (id: string) => onHover(`${zone}:${id}`, zone, false),
    }),
    [onHover, zone],
  );
  const content = (
    <View style={{ flex: 1, opacity: visible ? 1 : 0 }} pointerEvents={visible ? "box-none" : "none"}>
      {children}
    </View>
  );
  if (!hoverable) {
    return (
      <View style={[{ position: "absolute" }, style]} pointerEvents="box-none">
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessible={false}
      onHoverIn={() => context.enter("zone")}
      onHoverOut={() => context.leave("zone")}
      style={[{ position: "absolute" }, style]}
    >
      <HoverContext.Provider value={context}>{content}</HoverContext.Provider>
    </Pressable>
  );
}

export function Viewer({
  images,
  index,
  theme,
  layout,
  onIndexChange,
  onClose,
}: {
  images: readonly GalleryImage[];
  index: number;
  theme: Theme;
  layout: Layout;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const image = images[index];
  const { uri, error } = useImageUri(image);
  const hoverable = layout.platform === "web";

  const [hovered, setHovered] = useState<Zone | null>(null);
  // Every hovered zone or button, keyed by id. Controls hide only after all of them are left.
  const hoverSources = useRef(new Map<string, Zone>());
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onHover = useCallback((id: string, zone: Zone, isHovered: boolean) => {
    if (isHovered) hoverSources.current.set(id, zone);
    else hoverSources.current.delete(id);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    const active = [...hoverSources.current.values()].at(-1);
    if (active) setHovered(active);
    else hideTimer.current = setTimeout(() => setHovered(null), HIDE_DELAY_MS);
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );
  const [pinned, setPinned] = useState(!hoverable);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [measureFailed, setMeasureFailed] = useState(false);
  const [scale, setScale] = useState<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  // Reset zoom and position for each image.
  useEffect(() => {
    setNatural(null);
    setMeasureFailed(false);
    setScale(null);
    setOffset({ x: 0, y: 0 });
  }, [image.src]);

  useEffect(() => {
    if (!uri) return;
    let current = true;
    setMeasureFailed(false);
    Image.getSize(
      uri,
      (width, height) => current && setNatural({ width, height }),
      () => current && setMeasureFailed(true),
    );
    return () => {
      current = false;
    };
  }, [uri]);

  const hasPrevious = index > 0;
  const hasNext = index < images.length - 1;

  const fit =
    natural && viewport.width > 0
      ? Math.min(viewport.width / natural.width, viewport.height / natural.height)
      : 1;
  const base = Math.min(1, fit);
  const current = scale ?? base;
  const zoomed = scale !== null && scale !== base;
  const small = fit > 1;
  const displayed = natural
    ? { width: natural.width * current, height: natural.height * current }
    : { width: 0, height: 0 };
  const limit = {
    x: Math.max(0, (displayed.width - viewport.width) / 2),
    y: Math.max(0, (displayed.height - viewport.height) / 2),
  };

  // PanResponder is created once; read the latest values through a ref.
  const latest = useRef({ limit, offset });
  latest.current = { limit, offset };
  const dragStart = useRef({ x: 0, y: 0 });
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStart.current = latest.current.offset;
        },
        onPanResponderMove: (_, gesture) => {
          const { limit: max } = latest.current;
          setOffset({
            x: clamp(dragStart.current.x + gesture.dx, max.x),
            y: clamp(dragStart.current.y + gesture.dy, max.y),
          });
        },
        onPanResponderRelease: (_, gesture) => {
          // A tap without movement toggles the controls, which is how touch devices reveal them.
          if (Math.abs(gesture.dx) < 4 && Math.abs(gesture.dy) < 4) setPinned((value) => !value);
        },
      }),
    [],
  );

  const go = (next: number) => {
    if (next >= 0 && next < images.length) onIndexChange(next);
  };
  const latestNav = useRef({ index, go, onClose });
  latestNav.current = { index, go, onClose };
  useEffect(
    () =>
      onKeyDown((key) => {
        const nav = latestNav.current;
        if (key === "ArrowLeft") nav.go(nav.index - 1);
        else if (key === "ArrowRight") nav.go(nav.index + 1);
        else if (key === "Escape") nav.onClose();
        else return false;
        return true;
      }),
    [],
  );

  const show = (zone: Zone) => pinned || hovered === zone;
  const bar = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingHorizontal: layout.compact ? 12 : 20,
    paddingVertical: 10,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
  };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setViewport({ width, height });
        }}
      >
        <View style={{ flex: 1, overflow: "hidden" }} {...pan.panHandlers}>
          {uri && natural ? (
            <Image
              source={{ uri }}
              accessibilityLabel={fileName(image.src)}
              style={{
                position: "absolute",
                width: displayed.width,
                height: displayed.height,
                left: (viewport.width - displayed.width) / 2 + offset.x,
                top: (viewport.height - displayed.height) / 2 + offset.y,
              }}
              resizeMode="stretch"
            />
          ) : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              {error ? (
                <Text style={{ color: theme.colors.statusDanger }}>{error.message}</Text>
              ) : measureFailed ? (
                <Text style={{ color: theme.colors.statusDanger }}>Couldn't load this image</Text>
              ) : (
                <ActivityIndicator color={theme.colors.foregroundMuted} />
              )}
            </View>
          )}
        </View>

        <HoverZone
          zone="top"
          style={{ top: 0, left: 0, right: 0, height: BAR }}
          visible={show("top")}
          hoverable={hoverable}
          onHover={onHover}
        >
          <View style={[bar, { borderBottomWidth: 1 }, hasWindowButtons() ? { paddingLeft: WINDOW_BUTTONS_INSET } : null]}>
            <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 14 }}>
              {fileName(image.src)}
            </Text>
            <Text style={muted}>
              {index + 1} / {images.length}
            </Text>
            {zoomed ? (
              <ToolButton
                icon="Minimize2"
                label="Reset" compact={layout.compact}
                theme={theme}
                onPress={() => {
                  setScale(null);
                  setOffset({ x: 0, y: 0 });
                }}
              />
            ) : small ? (
              <ToolButton
                icon="ZoomIn"
                label="Zoom to fit" compact={layout.compact}
                theme={theme}
                disabled={!natural}
                onPress={() => setScale(fit)}
              />
            ) : (
              <ToolButton
                icon="Scan"
                label="Actual size" compact={layout.compact}
                theme={theme}
                disabled={!natural || fit >= 1}
                onPress={() => setScale(1)}
              />
            )}
            <ToolButton icon="X" label="Close" compact={layout.compact} theme={theme} onPress={onClose} />
          </View>
        </HoverZone>

        <HoverZone
          zone="bottom"
          style={{ bottom: 0, left: 0, right: 0, height: BAR }}
          visible={show("bottom")}
          hoverable={hoverable}
          onHover={onHover}
        >
          <View style={[bar, { flex: 1, borderTopWidth: 1, flexDirection: "column", alignItems: "flex-start", gap: 2 }]}>
            <Text selectable numberOfLines={1} style={muted}>
              {image.src}
            </Text>
            <Text style={muted}>
              {image.agentTitle} · {image.source} · {new Date(image.timestamp).toLocaleString()}
            </Text>
          </View>
        </HoverZone>

        {(["left", "right"] as const).map((side) => (
          <HoverZone
            key={side}
            zone={side}
            style={{ [side]: 0, top: "30%", height: "40%", width: EDGE }}
            visible={show(side)}
            hoverable={hoverable}
            onHover={onHover}
          >
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }} pointerEvents="box-none">
              <NavButton
                side={side}
                enabled={side === "left" ? hasPrevious : hasNext}
                theme={theme}
                onPress={() => go(side === "left" ? index - 1 : index + 1)}
              />
            </View>
          </HoverZone>
        ))}
      </View>
    </Modal>
  );
}
