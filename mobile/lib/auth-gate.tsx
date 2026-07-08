import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as LocalAuthentication from "expo-local-authentication";
import { colors, radius } from "./theme";

// A full-screen lock overlay rendered ON TOP of the navigator (never in place of
// it — the root layout must always mount <Stack> or Expo Router can't match any
// route). Returns null once authenticated. If the device has no lock configured,
// it lets the user straight through.
export function AuthOverlay() {
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);

  const authenticate = useCallback(async () => {
    setChecking(true);
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !enrolled) {
        setUnlocked(true);
        return;
      }
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: "Déverrouiller FounderOS Agents",
        fallbackLabel: "Utiliser le code",
      });
      setUnlocked(res.success);
    } catch {
      setUnlocked(false);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    authenticate();
  }, [authenticate]);

  if (unlocked) return null;

  return (
    <View style={styles.overlay}>
      <View style={styles.lockIcon}>
        <Ionicons name="lock-closed" size={30} color={colors.primary} />
      </View>
      <Text style={styles.title}>App verrouillée</Text>
      <Text style={styles.body}>Authentifiez-vous pour accéder à vos agents et leurs secrets.</Text>
      {checking ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
      ) : (
        <Pressable style={styles.btn} onPress={authenticate}>
          <Ionicons name="finger-print" size={18} color="#fff" />
          <Text style={styles.btnText}>Déverrouiller</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    elevation: 100,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 8,
    backgroundColor: colors.bg,
  },
  lockIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  body: { color: colors.muted, fontSize: 13, textAlign: "center", lineHeight: 19 },
  btn: {
    marginTop: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: radius.md,
  },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
