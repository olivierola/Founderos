import { useCallback, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { Alert, Animated, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLock } from "@/lib/lock-context";
import { biometricAvailable, setBiometricEnabled, setPin } from "@/lib/security";
import { colors, font, space } from "@/lib/theme";
import { GlowBackdrop } from "@/components/ui";
import { PinDots, PinKeypad } from "@/components/PinKeypad";

const PIN_LENGTH = 4;

export default function SetPinScreen() {
  const router = useRouter();
  const { refresh } = useLock();
  const [step, setStep] = useState<"enter" | "confirm">("enter");
  const [first, setFirst] = useState("");
  const [entered, setEntered] = useState("");
  const [error, setError] = useState(false);
  const shake = useRef(new Animated.Value(0)).current;

  const runShake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shake, { toValue: 1, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -1, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 1, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shake]);

  const finish = useCallback(async (pin: string) => {
    await setPin(pin);
    await refresh();
    if (await biometricAvailable()) {
      Alert.alert(
        "Déverrouillage biométrique",
        "Activer Face ID / empreinte pour déverrouiller l'app plus vite ?",
        [
          { text: "Plus tard", style: "cancel", onPress: () => router.back() },
          { text: "Activer", onPress: async () => { await setBiometricEnabled(true); router.back(); } },
        ],
      );
    } else {
      router.back();
    }
  }, [refresh, router]);

  const complete = useCallback((pin: string) => {
    if (step === "enter") {
      setFirst(pin);
      setEntered("");
      setStep("confirm");
    } else if (pin === first) {
      finish(pin);
    } else {
      setError(true);
      runShake();
      setTimeout(() => {
        setError(false); setEntered(""); setFirst(""); setStep("enter");
      }, 500);
    }
  }, [step, first, finish, runShake]);

  const onDigit = useCallback((d: string) => {
    setEntered((prev) => {
      if (prev.length >= PIN_LENGTH) return prev;
      const next = prev + d;
      if (next.length === PIN_LENGTH) complete(next);
      return next;
    });
  }, [complete]);

  const translateX = shake.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] });

  return (
    <View style={styles.fill}>
      <GlowBackdrop variant="center" />
      <SafeAreaView style={styles.fill} edges={["bottom"]}>
        <View style={styles.top}>
          <View style={styles.icon}>
            <Ionicons name="keypad" size={26} color={colors.primaryBright} />
          </View>
          <Text style={styles.title}>
            {step === "enter" ? "Choisissez un code" : "Confirmez le code"}
          </Text>
          <Text style={styles.subtitle}>
            {error
              ? "Les codes ne correspondent pas. Réessayez."
              : "Code à 4 chiffres pour verrouiller l'app"}
          </Text>
          <Animated.View style={{ transform: [{ translateX }] }}>
            <PinDots length={PIN_LENGTH} filled={entered.length} error={error} />
          </Animated.View>
        </View>

        <View style={styles.padWrap}>
          <PinKeypad onDigit={onDigit} onBackspace={() => setEntered((e) => e.slice(0, -1))} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  top: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md },
  icon: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: colors.primarySoft,
    alignItems: "center", justifyContent: "center",
    marginBottom: space.xs,
  },
  title: { color: colors.text, fontSize: font.h3, fontWeight: "700" },
  subtitle: { color: colors.muted, fontSize: font.small, textAlign: "center", paddingHorizontal: 32 },
  padWrap: { paddingBottom: space.xxl },
});
