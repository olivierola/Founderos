import { useCallback, useEffect, useRef, useState } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform,
  StyleSheet, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageBubble } from "@/components/MessageBubble";
import { Composer } from "@/components/Composer";
import { AgentAvatar } from "@/components/ui";
import { useAgents } from "@/lib/agents-context";
import { useSession } from "@/lib/session-context";
import { getMessages, sendMessage, type Message } from "@/lib/api";
import { colors, font, space } from "@/lib/theme";

export default function ChatScreen() {
  const { id, conversation } = useLocalSearchParams<{ id: string; conversation?: string }>();
  const { get } = useAgents();
  const { getToken } = useSession();
  const insets = useSafeAreaInsets();
  const agent = id ? get(id) : undefined;

  const [messages, setMessages] = useState<Message[]>([]);
  const [convId, setConvId] = useState<string | null>(conversation ?? null);
  const [loading, setLoading] = useState(!!conversation);
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);
  const polling = useRef(false);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  // Poll the conversation until its in-flight run finishes (server is source of truth).
  const pollUntilDone = useCallback(async (cid: string, baseAssistantCount: number) => {
    if (!id || polling.current) return;
    polling.current = true;
    const deadline = Date.now() + 120_000;
    try {
      while (Date.now() < deadline) {
        await delay(2000);
        const token = await getToken();
        const res = await getMessages(token, id, cid);
        setMessages(res.messages);
        scrollToEnd();
        const assistantCount = res.messages.filter((m) => m.role === "assistant").length;
        if (!res.running && assistantCount > baseAssistantCount) break;
      }
    } finally {
      polling.current = false;
      setSending(false);
    }
  }, [id, getToken, scrollToEnd]);

  // Load existing history (and resume polling if a run is still active).
  useEffect(() => {
    if (!id || !convId) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const res = await getMessages(token, id, convId);
        if (cancelled) return;
        setMessages(res.messages);
        scrollToEnd();
        if (res.running) {
          setSending(true);
          pollUntilDone(convId, res.messages.filter((m) => m.role === "assistant").length);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, convId]);

  async function onSend(text: string) {
    if (!id || sending) return;
    const baseAssistantCount = messages.filter((m) => m.role === "assistant").length;
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: text, created_at: new Date().toISOString() },
    ]);
    setSending(true);
    scrollToEnd();
    try {
      const token = await getToken();
      const { conversationId } = await sendMessage(token, id, text, convId);
      if (conversationId !== convId) setConvId(conversationId);
      await pollUntilDone(conversationId, baseAssistantCount);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: `⚠️ ${e instanceof Error ? e.message : "Échec de l'envoi"}`,
          created_at: new Date().toISOString(),
        },
      ]);
      setSending(false);
    }
  }

  if (!agent) {
    return (
      <View style={styles.missing}>
        <Stack.Screen options={{ title: "Agent" }} />
        <Text style={styles.missingText}>Cet agent n'est plus disponible sur votre compte.</Text>
      </View>
    );
  }

  const visible = messages.filter((m) => m.role === "user" || m.role === "assistant");

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
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
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <FlatList
          ref={listRef}
          data={visible}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <MessageBubble
              role={item.role}
              text={item.content}
              time={formatTime(item.created_at)}
              agent={agent}
            />
          )}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={scrollToEnd}
          ListEmptyComponent={
            <View style={styles.empty}>
              <AgentAvatar agent={agent} size={64} />
              <Text style={styles.emptyName}>{agent.name}</Text>
              <Text style={styles.emptyText}>Écrivez un message pour démarrer la conversation.</Text>
            </View>
          }
        />
      )}

      {sending && (
        <View style={styles.typing}>
          <ActivityIndicator size="small" color={colors.muted} />
          <Text style={styles.typingText}>{agent.name} réfléchit…</Text>
        </View>
      )}

      <View style={[styles.composerWrap, { paddingBottom: insets.bottom + 8 }]}>
        <Composer onSend={onSend} sending={sending} />
      </View>
    </KeyboardAvoidingView>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  headerTitle: { flexDirection: "row", alignItems: "center", gap: 9, maxWidth: 220 },
  headerName: { color: colors.text, fontSize: font.h3, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { paddingVertical: 12, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 32 },
  emptyName: { color: colors.text, fontSize: font.h3, fontWeight: "700", marginTop: 4 },
  emptyText: { color: colors.muted, fontSize: font.small, textAlign: "center" },
  typing: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 22, paddingBottom: 6 },
  typingText: { color: colors.muted, fontSize: 12 },
  composerWrap: { paddingHorizontal: 10, paddingTop: 6, backgroundColor: colors.bg },
  missing: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 32, backgroundColor: colors.bg },
  missingText: { color: colors.muted, fontSize: font.body, textAlign: "center" },
});
