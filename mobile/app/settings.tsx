import { useCallback, useState } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "@/lib/session-context";
import { useLock } from "@/lib/lock-context";
import {
  biometricAvailable, clearPin, getBiometricEnabled, setBiometricEnabled,
} from "@/lib/security";
import { colors, font, radius, space } from "@/lib/theme";

export default function SettingsScreen() {
  const { user, signOut } = useSession();
  const { pinSet, refresh } = useLock();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [bioAvail, setBioAvail] = useState(false);
  const [bioOn, setBioOn] = useState(false);

  const reload = useCallback(async () => {
    setBioAvail(await biometricAvailable());
    setBioOn(await getBiometricEnabled());
    await refresh();
  }, [refresh]);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  async function toggleBio(next: boolean) {
    setBioOn(next);
    await setBiometricEnabled(next);
  }

  function disablePin() {
    Alert.alert("Désactiver le code", "L'app ne sera plus verrouillée. Continuer ?", [
      { text: "Annuler", style: "cancel" },
      {
        text: "Désactiver",
        style: "destructive",
        onPress: async () => { await clearPin(); await reload(); setBioOn(false); },
      },
    ]);
  }

  function confirmSignOut() {
    Alert.alert("Se déconnecter", "Vous devrez vous reconnecter avec votre compte.", [
      { text: "Annuler", style: "cancel" },
      { text: "Se déconnecter", style: "destructive", onPress: () => signOut() },
    ]);
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 24, gap: space.xl }}
    >
      {/* Account */}
      <View>
        <Text style={styles.section}>Compte</Text>
        <View style={styles.card}>
          <View style={styles.accountRow}>
            <View style={styles.accountAvatar}>
              <Text style={styles.accountInitial}>
                {(user?.email ?? "?").charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.accountEmail} numberOfLines={1}>{user?.email ?? "—"}</Text>
              <Text style={styles.accountMeta}>Compte AchiCorp</Text>
            </View>
          </View>
        </View>
      </View>

      {/* Security */}
      <View>
        <Text style={styles.section}>Sécurité</Text>
        <View style={styles.card}>
          <Row
            icon="keypad-outline"
            title="Verrou par code"
            subtitle={pinSet ? "Activé" : "Désactivé"}
            onPress={() => router.push("/set-pin")}
            right={<Ionicons name="chevron-forward" size={18} color={colors.faint} />}
          />
          {pinSet && (
            <>
              <Divider />
              <Row
                icon="finger-print"
                title="Déverrouillage biométrique"
                subtitle={bioAvail ? "Face ID / empreinte" : "Indisponible sur cet appareil"}
                right={
                  <Switch
                    value={bioOn}
                    onValueChange={toggleBio}
                    disabled={!bioAvail}
                    trackColor={{ true: colors.primary, false: colors.surfaceHi }}
                    thumbColor="#fff"
                  />
                }
              />
              <Divider />
              <Row
                icon="close-circle-outline"
                title="Désactiver le code"
                tone="danger"
                onPress={disablePin}
              />
            </>
          )}
        </View>
      </View>

      {/* Sign out */}
      <Pressable
        style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.7 }]}
        onPress={confirmSignOut}
      >
        <Ionicons name="log-out-outline" size={18} color={colors.danger} />
        <Text style={styles.signOutText}>Se déconnecter</Text>
      </Pressable>

      <Text style={styles.version}>AchiCorp Agents · v0.1.0</Text>
    </ScrollView>
  );
}

function Row({
  icon, title, subtitle, right, onPress, tone = "default",
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  tone?: "default" | "danger";
}) {
  const color = tone === "danger" ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, pressed && onPress && { opacity: 0.6 }]}
    >
      <View style={[styles.rowIcon, tone === "danger" && { backgroundColor: colors.dangerSoft }]}>
        <Ionicons name={icon} size={18} color={tone === "danger" ? colors.danger : colors.primaryBright} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.rowTitle, { color }]}>{title}</Text>
        {subtitle && <Text style={styles.rowSub}>{subtitle}</Text>}
      </View>
      {right}
    </Pressable>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  section: {
    color: colors.faint, fontSize: font.tiny, fontWeight: "700",
    textTransform: "uppercase", letterSpacing: 0.6,
    marginBottom: space.sm, marginLeft: space.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  accountRow: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16 },
  accountAvatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: colors.primarySoft,
    alignItems: "center", justifyContent: "center",
  },
  accountInitial: { color: colors.primaryBright, fontSize: 20, fontWeight: "800" },
  accountEmail: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  accountMeta: { color: colors.muted, fontSize: font.small, marginTop: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  rowIcon: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: colors.primarySoft,
    alignItems: "center", justifyContent: "center",
  },
  rowTitle: { fontSize: font.body, fontWeight: "600" },
  rowSub: { color: colors.muted, fontSize: font.small, marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.border, marginLeft: 60 },
  signOut: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md, paddingVertical: 14,
  },
  signOutText: { color: colors.danger, fontSize: font.body, fontWeight: "700" },
  version: { color: colors.faint, fontSize: font.tiny, textAlign: "center" },
});
