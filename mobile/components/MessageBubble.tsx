import { StyleSheet, Text, View } from "react-native";
import { colors, radius } from "@/lib/theme";

export type ChatRole = "user" | "assistant" | "tool";

export function MessageBubble({
  role, text, time, agentInitial,
}: {
  role: ChatRole;
  text: string;
  time?: string;
  agentInitial?: string;
}) {
  const isUser = role === "user";
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAgent]}>
      {!isUser && (
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(agentInitial || "A").toUpperCase()}</Text>
        </View>
      )}
      <View style={[styles.col, isUser ? styles.colUser : styles.colAgent]}>
        <View style={[styles.bubble, isUser ? styles.user : styles.agent]}>
          <Text style={[styles.text, isUser && styles.userText]}>{text}</Text>
        </View>
        {time ? <Text style={[styles.time, isUser ? styles.timeUser : styles.timeAgent]}>{time}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    marginVertical: 5,
    paddingHorizontal: 14,
  },
  rowUser: { justifyContent: "flex-end" },
  rowAgent: { justifyContent: "flex-start" },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  avatarText: { color: colors.primary, fontSize: 11, fontWeight: "700" },
  col: { maxWidth: "80%" },
  colUser: { alignItems: "flex-end" },
  colAgent: { alignItems: "flex-start" },
  bubble: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.lg,
  },
  user: {
    backgroundColor: colors.primary,
    borderBottomRightRadius: 6,
  },
  agent: {
    backgroundColor: colors.cardAlt,
    borderBottomLeftRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  text: { color: colors.text, fontSize: 15, lineHeight: 21 },
  userText: { color: "#ffffff" },
  time: { fontSize: 10, color: colors.faint, marginTop: 3, paddingHorizontal: 4 },
  timeUser: { textAlign: "right" },
  timeAgent: { textAlign: "left" },
});
