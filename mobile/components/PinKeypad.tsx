import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, space } from "@/lib/theme";

// Row of dots showing how many digits have been entered.
export function PinDots({ length, filled, error }: { length: number; filled: number; error?: boolean }) {
  return (
    <View style={styles.dots}>
      {Array.from({ length }).map((_, i) => (
        <View
          key={i}
          style={[styles.dot, i < filled && styles.dotFilled, error && styles.dotError]}
        />
      ))}
    </View>
  );
}

// Numeric keypad. The bottom-left key is either a biometric prompt or a spacer.
export function PinKeypad({
  onDigit, onBackspace, bio, onBio,
}: {
  onDigit: (d: string) => void;
  onBackspace: () => void;
  bio?: boolean;
  onBio?: () => void;
}) {
  return (
    <View style={styles.pad}>
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
        <Key key={d} label={d} onPress={() => onDigit(d)} />
      ))}
      {bio ? <Key icon="finger-print" onPress={onBio} /> : <View style={styles.key} />}
      <Key label="0" onPress={() => onDigit("0")} />
      <Key icon="backspace-outline" onPress={onBackspace} muted />
    </View>
  );
}

function Key({
  label, icon, onPress, muted,
}: {
  label?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  muted?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}>
      {icon ? (
        <Ionicons name={icon} size={24} color={muted ? colors.muted : colors.text} />
      ) : (
        <Text style={styles.keyText}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: "row", gap: 16, marginTop: space.lg },
  dot: {
    width: 14, height: 14, borderRadius: 7,
    borderWidth: 1.5, borderColor: colors.borderStrong,
  },
  dotFilled: { backgroundColor: colors.primary, borderColor: colors.primary },
  dotError: { backgroundColor: colors.danger, borderColor: colors.danger },
  pad: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    paddingHorizontal: space.xxl,
    gap: space.lg,
  },
  key: {
    width: 74, height: 74, borderRadius: 37,
    alignItems: "center", justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  keyPressed: { backgroundColor: colors.surfaceHi, transform: [{ scale: 0.96 }] },
  keyText: { color: colors.text, fontSize: 26, fontWeight: "600" },
});
