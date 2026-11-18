import { useSettings } from "@getpaseo/plugin/client";
import { SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { ActivityIndicator, Text } from "react-native";
import { type AttachmentCopiesMode, GALLERY_SETTINGS } from "../shared/gallery";

const OPTIONS: { label: string; value: AttachmentCopiesMode }[] = [
  { label: "Hide when the original is also shown", value: "duplicates" },
  { label: "Always hide", value: "all" },
];

/** The Image gallery settings screen. */
export function GallerySettings() {
  const settings = useSettings(GALLERY_SETTINGS);
  return (
    <SettingsSection title="Image gallery">
      {settings.status === "loading" ? (
        <ActivityIndicator />
      ) : settings.status === "ready" ? (
        <SettingsSelect
          label="Paseo attachment copies"
          hint="Paseo keeps a hash-named copy of every image shown in chat. Choose when the gallery hides these copies."
          value={settings.values.attachmentCopies}
          options={OPTIONS}
          error={settings.saveError}
          disabled={settings.saving}
          onValueChange={(attachmentCopies) => void settings.save({ attachmentCopies }, settings.revision)}
        />
      ) : (
        <Text>{settings.error}</Text>
      )}
    </SettingsSection>
  );
}
