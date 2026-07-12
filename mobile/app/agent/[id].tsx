import { useCallback, useState } from "react";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAgents } from "@/lib/agents-context";
import { useSession } from "@/lib/session-context";
import { listConversations, type Conversation } from "@/lib/api";
import { colors, font, radius, shadow, space } from "@/lib/theme";
import { AgentAvatar } from "@/components/ui";

export default function ConversationsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { get } = useAgents();
  const { getToken } = useSession();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agent = id ? get(id) : undefined;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const token = await getToken();
      setConversations(await listConversations(token, id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec du chargement");
    } finally {
      setLoading(false);
    }
  }, [id, getToken]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  function openChat(conversationId?: string) {
    if (!id) return;
    router.push({
      pathname: "/chat/[id]",
      params: conversationId ? { id, conversation: conversationId } : { id },
    });
  }

  if (!agent) {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: "Agent" }} />
        <Text style={styles.muted}>Cet agent n'est plus disponible.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.headerTitle}>
              <AgentAvatar agent={agent} size={30} />
              <Text style={styles.headerName} numberOfLines={1}>{agent.name}</Text>
            </View>
          ),
        }}
      />

      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ padding: space.lg, gap: 10, paddingBottom: 130 }}
          ListHeaderComponent={error ? <Text style={styles.error}>{error}</Text> : null}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="chatbubbles-outline" size={36} color={colors.faint} />
              </View>
              <Text style={styles.muted}>Aucune conversation.{"\n"}Démarrez-en une.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}
              onPress={() => openChat(item.id)}
            >
              <View style={styles.rowIcon}>
                <Ionicons name="chatbubble-ellipses-outline" size={18} color={colors.primaryBright} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{item.title || "Conversation"}</Text>
                <Text style={styles.rowMeta}>{formatDate(item.updated_at)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.faint} />
            </Pressable>
          )}
        />
      )}

      <Pressable
        style={[styles.fab, shadow.glow, { bottom: insets.bottom + 24 }]}
        onPress={() => openChat()}
        accessibilityLabel="Nouveau chat"
      >
        <Ionicons name="add" size={22} color={colors.onPrimary} />
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
  headerTitle: { flexDirection: "row", alignItems: "center", gap: 9, maxWidth: 220 },
  headerName: { color: colors.text, fontSize: font.h3, fontWeight: "700" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10, backgroundColor: colors.bg },
  empty: { alignItems: "center", gap: 12, paddingTop: 90 },
  emptyIcon: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center",
  },
  muted: { color: colors.muted, fontSize: font.small, textAlign: "center", lineHeight: 20 },
  error: { color: colors.danger, fontSize: font.small, marginBottom: 8 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg, padding: 14,
  },
  rowIcon: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: colors.primarySoft,
    alignItems: "center", justifyContent: "center",
  },
  rowTitle: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  rowMeta: { color: colors.faint, fontSize: 12, marginTop: 2 },
  fab: {
    position: "absolute", right: 20,
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.primary,
    paddingVertical: 12, paddingHorizontal: 18,
    borderRadius: radius.pill,
  },
  fabText: { color: colors.onPrimary, fontWeight: "700", fontSize: font.small },
});
