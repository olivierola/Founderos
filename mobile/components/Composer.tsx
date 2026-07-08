import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius } from "@/lib/theme";

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
          !canSend && styles.sendDisabled,
          pressed && canSend && { opacity: 0.85 },
        ]}
        accessibilityLabel="Envoyer"
      >
        {sending ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Ionicons name="arrow-up" size={20} color="#fff" />
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
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 24,
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === "ios" ? 6 : 2,
    color: colors.text,
    fontSize: 15,
    lineHeight: 20,
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { backgroundColor: colors.border },
});
