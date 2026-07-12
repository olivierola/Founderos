import { StyleSheet, Text, View } from "react-native";
import { colors, font, radius } from "@/lib/theme";
import { AgentAvatar, type AvatarSource } from "./ui";

export type ChatRole = "user" | "assistant" | "tool";

export function MessageBubble({
  role, text, time, agent,
}: {
  role: ChatRole;
  text: string;
  time?: string;
  agent: AvatarSource;
}) {
  const isUser = role === "user";
  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAgent]}>
      {!isUser && <AgentAvatar agent={agent} size={28} />}
      <View style={[styles.col, isUser ? styles.colUser : styles.colAgent]}>
        <View style={[styles.bubble, isUser ? styles.user : styles.agent]}>
          <Text style={[styles.text, isUser && styles.userText]}>{text}</Text>
        </View>
        {time ? <Text style={[styles.time, isUser ? styles.timeR : styles.timeL]}>{time}</Text> : null}
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
  col: { maxWidth: "82%" },
  colUser: { alignItems: "flex-end" },
  colAgent: { alignItems: "flex-start" },
  bubble: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.lg,
  },
  user: {
    backgroundColor: colors.primary,
    borderBottomRightRadius: 5,
  },
  agent: {
    backgroundColor: colors.surfaceAlt,
    borderBottomLeftRadius: 5,
    borderWidth: 1,
    borderColor: colors.border,
  },
  text: { color: colors.text, fontSize: font.body, lineHeight: 21 },
  userText: { color: colors.onPrimary },
  time: { fontSize: 10, color: colors.faint, marginTop: 3, paddingHorizontal: 4 },
  timeR: { textAlign: "right" },
  timeL: { textAlign: "left" },
});
