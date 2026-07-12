import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AgentsProvider } from "@/lib/agents-context";
import { SessionProvider, useSession } from "@/lib/session-context";
import { LockProvider, useLock } from "@/lib/lock-context";
import { AuthScreen } from "@/components/AuthScreen";
import { LockScreen } from "@/components/LockScreen";
import { colors } from "@/lib/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.root}>
        <SessionProvider>
          <LockProvider>
            <AgentsProvider>
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: colors.bg },
                  headerTintColor: colors.text,
                  headerTitleStyle: { fontWeight: "700" },
                  headerShadowVisible: false,
                  contentStyle: { backgroundColor: colors.bg },
                }}
              >
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen name="agent/[id]" options={{ title: "Agent" }} />
                <Stack.Screen name="chat/[id]" options={{ title: "Agent" }} />
                <Stack.Screen name="settings" options={{ title: "Réglages", presentation: "modal" }} />
                <Stack.Screen name="set-pin" options={{ title: "Verrou par code", presentation: "modal" }} />
              </Stack>

              {/* Auth + lock gates sit ON TOP of the navigator (never replace it,
                  so Expo Router always has a route mounted). */}
              <Gate />
            </AgentsProvider>
          </LockProvider>
        </SessionProvider>
      </View>
    </SafeAreaProvider>
  );
}

function Gate() {
  const { loading: sessionLoading, session } = useSession();
  const { ready: lockReady, pinSet, locked } = useLock();

  if (sessionLoading || !lockReady) {
    return (
      <View style={styles.overlay}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (!session) {
    return <View style={styles.overlay}><AuthScreen /></View>;
  }
  if (pinSet && locked) {
    return <View style={styles.overlay}><LockScreen /></View>;
  }
  return null;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    elevation: 100,
    backgroundColor: colors.bg,
  },
});
