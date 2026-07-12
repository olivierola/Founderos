import type { ReactNode } from "react";
import {
  ActivityIndicator, Image, Pressable, StyleSheet, Text, View,
  type StyleProp, type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, shadow, space } from "@/lib/theme";

// ── Ambient glow backdrop ──────────────────────────────────────────────────
// Two soft violet blooms behind the content — fakes a premium radial gradient
// without pulling in a native gradient module.
export function GlowBackdrop({ variant = "top" }: { variant?: "top" | "center" }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={[
          styles.glow,
          variant === "center"
            ? { top: "18%", alignSelf: "center", backgroundColor: colors.primaryGlow }
            : { top: -160, right: -120, backgroundColor: colors.primaryGlow },
        ]}
      />
      <View style={[styles.glow, styles.glowSecondary]} />
    </View>
  );
}

// ── Primary button ─────────────────────────────────────────────────────────
export function PrimaryButton({
  label, onPress, loading, disabled, icon, style,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [
        styles.btn,
        shadow.glow,
        off && styles.btnOff,
        pressed && !off && { transform: [{ scale: 0.985 }], opacity: 0.95 },
        style,
      ]}
    >
      {/* Top sheen for a subtle gradient feel. */}
      <View pointerEvents="none" style={styles.btnSheen} />
      {loading ? (
        <ActivityIndicator color={colors.onPrimary} />
      ) : (
        <View style={styles.btnRow}>
          {icon && <Ionicons name={icon} size={18} color={colors.onPrimary} />}
          <Text style={styles.btnText}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

export function GhostButton({
  label, onPress, icon, tone = "muted",
}: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: "muted" | "danger";
}) {
  const c = tone === "danger" ? colors.danger : colors.muted;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.6 }]}
    >
      {icon && <Ionicons name={icon} size={16} color={c} />}
      <Text style={[styles.ghostText, { color: c }]}>{label}</Text>
    </Pressable>
  );
}

// ── Agent avatar ───────────────────────────────────────────────────────────
export interface AvatarSource {
  name?: string | null;
  avatar_url?: string | null;
  avatar_emoji?: string | null;
  accent_color?: string | null;
}

export function AgentAvatar({ agent, size = 46 }: { agent: AvatarSource; size?: number }) {
  const accent = agent.accent_color || colors.primary;
  const r = size / 2;
  const inner = (() => {
    if (agent.avatar_url) {
      return <Image source={{ uri: agent.avatar_url }} style={{ width: size, height: size, borderRadius: r }} />;
    }
    if (agent.avatar_emoji) {
      return <Text style={{ fontSize: size * 0.5 }}>{agent.avatar_emoji}</Text>;
    }
    return (
      <Text style={{ color: accent, fontSize: size * 0.4, fontWeight: "800" }}>
        {(agent.name || "A").trim().charAt(0).toUpperCase()}
      </Text>
    );
  })();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: r,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hexSoft(accent),
        borderWidth: 1,
        borderColor: hexSoft(accent, 0.4),
        overflow: "hidden",
      }}
    >
      {inner}
    </View>
  );
}

// ── Card ───────────────────────────────────────────────────────────────────
export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

// Turn a hex accent into a translucent tint (fallback to the brand soft).
function hexSoft(hex: string, alpha = 0.16): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return colors.primarySoft;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

const styles = StyleSheet.create({
  glow: {
    position: "absolute",
    width: 360,
    height: 360,
    borderRadius: 180,
    opacity: 0.55,
  },
  glowSecondary: {
    bottom: -180,
    left: -140,
    backgroundColor: "rgba(99,102,241,0.22)",
    width: 320,
    height: 320,
    borderRadius: 160,
  },
  btn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 15,
    paddingHorizontal: space.xl,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  btnOff: { opacity: 0.45, shadowOpacity: 0 },
  btnSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "55%",
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  btnRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  btnText: { color: colors.onPrimary, fontWeight: "700", fontSize: 15, letterSpacing: 0.2 },
  ghost: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, justifyContent: "center" },
  ghostText: { fontSize: 13, fontWeight: "600" },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    ...shadow.card,
  },
});
