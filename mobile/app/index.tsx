import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAgents } from "@/lib/agents-context";
import { useSession } from "@/lib/session-context";
import type { Agent } from "@/lib/api";
import { colors, font, radius, space } from "@/lib/theme";
import { AgentAvatar, GlowBackdrop } from "@/components/ui";

export default function AgentsListScreen() {
  const { agents, loading, error, refresh } = useAgents();
  const { user } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const name = user?.email?.split("@")[0] ?? "";

  return (
    <View style={styles.container}>
      <GlowBackdrop variant="top" />

      {/* Custom premium header */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Bonjour{name ? "," : ""}</Text>
          <Text style={styles.name} numberOfLines={1}>{name || "bienvenue"}</Text>
        </View>
        <Pressable
          style={styles.gear}
          onPress={() => router.push("/settings")}
          accessibilityLabel="Réglages"
        >
          <Ionicons name="person-circle-outline" size={26} color={colors.text} />
        </Pressable>
      </View>

      <Text style={styles.section}>Vos agents</Text>

      {loading && agents.length === 0 ? (
        <View style={styles.centered}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={agents}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 24, gap: 10 }}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.primary} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="hardware-chip-outline" size={40} color={colors.faint} />
              </View>
              <Text style={styles.emptyTitle}>Aucun agent</Text>
              <Text style={styles.emptyBody}>
                {error
                  ? error
                  : "Créez des agents dans FounderOS (web). Ils apparaîtront ici automatiquement."}
              </Text>
              {error && (
                <Pressable style={styles.retry} onPress={refresh}>
                  <Ionicons name="refresh" size={16} color={colors.primary} />
                  <Text style={styles.retryText}>Réessayer</Text>
                </Pressable>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <AgentRow agent={item} onPress={() => router.push(`/agent/${item.id}`)} />
          )}
        />
      )}
    </View>
  );
}

function AgentRow({ agent, onPress }: { agent: Agent; onPress: () => void }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.75, transform: [{ scale: 0.99 }] }]}
      onPress={onPress}
    >
      <AgentAvatar agent={agent} size={48} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowName} numberOfLines={1}>{agent.name || "Agent"}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {agent.description?.trim() || "Appuyez pour discuter"}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  hello: { color: colors.muted, fontSize: font.small },
  name: { color: colors.text, fontSize: font.h2, fontWeight: "800", textTransform: "capitalize" },
  gear: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center",
  },
  section: {
    color: colors.faint, fontSize: font.tiny, fontWeight: "700",
    textTransform: "uppercase", letterSpacing: 0.6,
    paddingHorizontal: space.xl, paddingTop: space.sm, paddingBottom: space.xs,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", gap: 10, paddingTop: 90, paddingHorizontal: space.xl },
  emptyIcon: {
    width: 78, height: 78, borderRadius: 39,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center", marginBottom: 4,
  },
  emptyTitle: { color: colors.text, fontSize: font.h3, fontWeight: "700" },
  emptyBody: { color: colors.muted, fontSize: font.small, textAlign: "center", lineHeight: 20 },
  retry: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  retryText: { color: colors.primary, fontSize: font.small, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: 14,
  },
  rowName: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  rowSub: { color: colors.muted, fontSize: font.small, marginTop: 3 },
});
