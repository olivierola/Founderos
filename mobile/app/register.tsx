import { useState } from "react";
import { useRouter } from "expo-router";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { useAgents } from "@/lib/agents-context";
import { verifyAgent } from "@/lib/api";
import { colors, radius } from "@/lib/theme";

export default function RegisterScreen() {
  const { add } = useAgents();
  const router = useRouter();
  const [agentId, setAgentId] = useState("");
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = agentId.trim().length > 0 && secret.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const draft = { id: agentId.trim(), secret: secret.trim(), name: name.trim() || "Agent" };
    try {
      await verifyAgent(draft);
      await add(draft);
      router.replace(`/agent/${draft.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec de l'enregistrement");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.lead}>
          Collez l'identifiant et le secret de l'agent depuis FounderOS pour l'ajouter à cet appareil.
        </Text>

        <Field label="Identifiant de l'agent">
          <TextInput
            value={agentId}
            onChangeText={setAgentId}
            placeholder="ex. 3f9a…-agent-id"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </Field>

        <Field label="Secret (mot de passe)">
          <TextInput
            value={secret}
            onChangeText={setSecret}
            placeholder="Secret de l'agent"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
          />
        </Field>

        <Field label="Nom affiché (optionnel)">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="ex. Assistant marketing"
            placeholderTextColor={colors.faint}
            style={styles.input}
          />
        </Field>

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          style={[styles.submit, !canSubmit && styles.submitDisabled]}
          onPress={submit}
          disabled={!canSubmit}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitText}>Enregistrer et discuter</Text>
          )}
        </Pressable>

        <Text style={styles.hint}>
          Le secret est stocké de façon chiffrée sur l'appareil (SecureStore) et n'est envoyé
          qu'au backend FounderOS pour authentifier l'agent.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 16 },
  lead: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  field: { gap: 6 },
  label: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  input: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 15,
  },
  error: { color: colors.danger, fontSize: 13 },
  submit: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  hint: { color: colors.faint, fontSize: 11, lineHeight: 16 },
});
