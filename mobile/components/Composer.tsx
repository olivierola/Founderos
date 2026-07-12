import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, shadow } from "@/lib/theme";

export function Composer({
  onSend, sending, disabled, placeholder = "Message…",
}: {
  onSend: (text: string) => void;
  sending?: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const canSend = value.trim().length > 0 && !sending && !disabled;

  function submit() {
    if (!canSend) return;
    const text = value.trim();
    setValue("");
    onSend(text);
  }

  return (
    <View style={styles.wrap}>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        style={styles.input}
        editable={!disabled}
        multiline
      />
      <Pressable
        onPress={submit}
        disabled={!canSend}
        style={({ pressed }) => [
          styles.send,
          canSend ? shadow.glow : styles.sendDisabled,
          pressed && canSend && { opacity: 0.85, transform: [{ scale: 0.95 }] },
        ]}
        accessibilityLabel="Envoyer"
      >
        {sending ? (
          <ActivityIndicator size="small" color={colors.onPrimary} />
        ) : (
          <Ionicons name="arrow-up" size={20} color={colors.onPrimary} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 24,
    paddingHorizontal: 10,
    paddingVertical: Platform.OS === "ios" ? 8 : 3,
    color: colors.text,
    fontSize: 15,
    lineHeight: 20,
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { backgroundColor: colors.surfaceHi },
});
