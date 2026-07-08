import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AgentsProvider } from "@/lib/agents-context";
import { AuthOverlay } from "@/lib/auth-gate";
import { colors } from "@/lib/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <AgentsProvider>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.text,
              headerTitleStyle: { fontWeight: "600" },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="index" options={{ title: "Mes agents" }} />
            <Stack.Screen
              name="register"
              options={{ title: "Enregistrer un agent", presentation: "modal" }}
            />
            <Stack.Screen name="agent/[id]" options={{ title: "Conversations" }} />
            <Stack.Screen name="chat/[id]" options={{ title: "Agent" }} />
          </Stack>
        </AgentsProvider>
        {/* Lock overlay sits ON TOP of the navigator, never replaces it. */}
        <AuthOverlay />
      </View>
    </SafeAreaProvider>
  );
}
