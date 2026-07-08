import { useCallback, useState } from "react";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAgents } from "@/lib/agents-context";
import { listConversations, type Conversation } from "@/lib/api";
import { colors, radius } from "@/lib/theme";

export default function ConversationsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { get } = useAgents();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agent = id ? get(id) : undefined;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!agent) return;
    setError(null);
    try {
      setConversations(await listConversations(agent));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec du chargement");
    } finally {
      setLoading(false);
    }
  }, [agent]);

  // Refresh whenever the screen regains focus (e.g. returning from a chat).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  function openChat(conversationId?: string) {
    if (!agent) return;
    router.push({
      pathname: "/chat/[id]",
      params: conversationId ? { id: agent.id, conversation: conversationId } : { id: agent.id },
    });
  }

  if (!agent) {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: "Agent introuvable" }} />
        <Text style={styles.muted}>Cet agent n'est plus enregistré.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: agent.name }} />

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 120 }}
          ListHeaderComponent={
            error ? <Text style={styles.error}>{error}</Text> : null
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="chatbubbles-outline" size={40} color={colors.faint} />
              <Text style={styles.muted}>Aucune conversation. Démarrez-en une.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
              onPress={() => openChat(item.id)}
            >
              <View style={styles.rowIcon}>
                <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.title || "Conversation"}
                </Text>
                <Text style={styles.rowMeta}>{formatDate(item.updated_at)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.faint} />
            </Pressable>
          )}
        />
      )}

      <Pressable
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
        onPress={() => openChat()}
        accessibilityLabel="Nouveau chat"
      >
        <Ionicons name="add" size={22} color="#fff" />
        <Text style={styles.fabText}>Nouveau chat</Text>
      </Pressable>
    </View>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "à l'instant";
  if (diff < 3_600_000) return `il y a ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `il y a ${Math.floor(diff / 3_600_000)} h`;
  return d.toLocaleDateString();
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  empty: { alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 80 },
  muted: { color: colors.muted, fontSize: 13, textAlign: "center" },
  error: { color: colors.danger, fontSize: 13, marginBottom: 8 },
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
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  rowMeta: { color: colors.faint, fontSize: 12, marginTop: 2 },
  fab: {
    position: "absolute",
    right: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 28,
    shadowColor: colors.primary,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
