import { useState } from "react";
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet,
  Text, TextInput, View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSession } from "@/lib/session-context";
import { colors, font, radius, space } from "@/lib/theme";
import { GlowBackdrop, PrimaryButton } from "./ui";

type Mode = "signin" | "signup";

export function AuthScreen() {
  const { signIn, signUp } = useSession();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const emailOk = /.+@.+\..+/.test(email.trim());
  const canSubmit = emailOk && password.length >= 6 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true); setError(null); setInfo(null);
    try {
      if (mode === "signin") {
        await signIn(email, password);
      } else {
        const signedIn = await signUp(email, password);
        if (!signedIn) {
          setInfo("Compte créé. Confirmez votre e-mail puis connectez-vous.");
          setMode("signin");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Échec de l'authentification");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.fill}>
      <GlowBackdrop variant="top" />
      <SafeAreaView style={styles.fill} edges={["top", "bottom"]}>
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Brand hero */}
            <View style={styles.hero}>
              <View style={styles.mark}>
                <Ionicons name="flash" size={30} color={colors.onPrimary} />
              </View>
              <Text style={styles.brand}>FounderOS</Text>
              <Text style={styles.tagline}>Votre workforce IA, dans votre poche.</Text>
            </View>

            {/* Segmented toggle */}
            <View style={styles.segment}>
              {(["signin", "signup"] as const).map((m) => (
                <Pressable
                  key={m}
                  onPress={() => { setMode(m); setError(null); setInfo(null); }}
                  style={[styles.segBtn, mode === m && styles.segBtnActive]}
                >
                  <Text style={[styles.segText, mode === m && styles.segTextActive]}>
                    {m === "signin" ? "Connexion" : "Créer un compte"}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.card}>
              <Field label="Adresse e-mail">
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="vous@entreprise.com"
                  placeholderTextColor={colors.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  style={styles.input}
                />
              </Field>

              <Field label="Mot de passe">
                <View style={styles.pwWrap}>
                  <TextInput
                    value={password}
                    onChangeText={setPassword}
                    placeholder="••••••••"
                    placeholderTextColor={colors.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={!show}
                    style={[styles.input, { flex: 1, borderWidth: 0, paddingHorizontal: 0 }]}
                  />
                  <Pressable onPress={() => setShow((s) => !s)} hitSlop={8}>
                    <Ionicons name={show ? "eye-off" : "eye"} size={20} color={colors.faint} />
                  </Pressable>
                </View>
              </Field>

              {error && (
                <View style={styles.banner}>
                  <Ionicons name="alert-circle" size={16} color={colors.danger} />
                  <Text style={styles.bannerText}>{error}</Text>
                </View>
              )}
              {info && (
                <View style={[styles.banner, styles.bannerOk]}>
                  <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                  <Text style={[styles.bannerText, { color: colors.success }]}>{info}</Text>
                </View>
              )}

              <PrimaryButton
                label={mode === "signin" ? "Se connecter" : "Créer mon compte"}
                icon={mode === "signin" ? "arrow-forward" : "person-add"}
                onPress={submit}
                loading={busy}
                disabled={!canSubmit}
                style={{ marginTop: space.xs }}
              />
            </View>

            <Text style={styles.foot}>
              Connectez-vous avec votre compte FounderOS pour retrouver vos agents et leurs
              conversations, synchronisés avec le web.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
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
  fill: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, justifyContent: "center", padding: space.xl, gap: space.xl },
  hero: { alignItems: "center", gap: space.sm, marginBottom: space.sm },
  mark: {
    width: 66, height: 66, borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center",
    shadowColor: colors.primary, shadowOpacity: 0.6, shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 }, elevation: 10,
    marginBottom: space.xs,
  },
  brand: { color: colors.text, fontSize: font.h1, fontWeight: "800", letterSpacing: 0.3 },
  tagline: { color: colors.muted, fontSize: font.small, textAlign: "center" },
  segment: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: 4,
  },
  segBtn: { flex: 1, paddingVertical: 10, borderRadius: radius.sm, alignItems: "center" },
  segBtnActive: { backgroundColor: colors.surfaceHi },
  segText: { color: colors.muted, fontSize: font.small, fontWeight: "600" },
  segTextActive: { color: colors.text },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.xl,
    padding: space.xl,
    gap: space.lg,
  },
  field: { gap: 7 },
  label: { color: colors.muted, fontSize: font.tiny, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    backgroundColor: colors.bgElevated,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 13,
    color: colors.text, fontSize: font.body,
  },
  pwWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: colors.bgElevated,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
  },
  banner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.sm, padding: 10,
  },
  bannerOk: { backgroundColor: colors.successSoft },
  bannerText: { color: colors.danger, fontSize: font.small, flex: 1 },
  foot: { color: colors.faint, fontSize: font.tiny, lineHeight: 17, textAlign: "center", paddingHorizontal: space.md },
});
