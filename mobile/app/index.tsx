import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAgents } from "@/lib/agents-context";
import type { RegisteredAgent } from "@/lib/storage";
import { colors, radius } from "@/lib/theme";

export default function AgentsListScreen() {
  const { agents, loading } = useAgents();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {agents.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="hardware-chip-outline" size={44} color={colors.faint} />
          <Text style={styles.emptyTitle}>Aucun agent enregistré</Text>
          <Text style={styles.emptyBody}>
            Ajoutez un agent créé dans FounderOS avec son identifiant et son secret.
          </Text>
          <Pressable style={styles.emptyCta} onPress={() => router.push("/register")}>
            <Ionicons name="add" size={18} color="#fff" />
            <Text style={styles.emptyCtaText}>Enregistrer un agent</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={agents}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ padding: 16, gap: 10 }}
          renderItem={({ item }) => (
            <AgentRow agent={item} onPress={() => router.push(`/agent/${item.id}`)} />
          )}
        />
      )}

      <Pressable
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
        onPress={() => router.push("/register")}
        accessibilityLabel="Enregistrer un agent"
      >
        <Ionicons name="add" size={28} color="#fff" />
      </Pressable>
    </View>
  );
}

function AgentRow({ agent, onPress }: { agent: RegisteredAgent; onPress: () => void }) {
  const initial = (agent.name || "A").trim().charAt(0).toUpperCase();
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
      onPress={onPress}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initial}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowName} numberOfLines={1}>{agent.name || "Agent"}</Text>
        <Text style={styles.rowId} numberOfLines={1}>{agent.id}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 10,
  },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "600", marginTop: 6 },
  emptyBody: { color: colors.muted, fontSize: 13, textAlign: "center", lineHeight: 19 },
  emptyCta: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.primary,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: radius.md,
  },
  emptyCtaText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: 14,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.primary, fontSize: 18, fontWeight: "700" },
  rowName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  rowId: { color: colors.faint, fontSize: 12, marginTop: 2 },
  fab: {
    position: "absolute",
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.primary,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
