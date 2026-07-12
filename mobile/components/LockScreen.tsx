import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLock } from "@/lib/lock-context";
import {
  biometricAvailable, getBiometricEnabled, promptBiometric, verifyPin,
} from "@/lib/security";
import { colors, font, space } from "@/lib/theme";
import { GlowBackdrop } from "./ui";
import { PinDots, PinKeypad } from "./PinKeypad";

const PIN_LENGTH = 4;

export function LockScreen() {
  const { unlock } = useLock();
  const [entered, setEntered] = useState("");
  const [error, setError] = useState(false);
  const [bioOn, setBioOn] = useState(false);
  const shake = useRef(new Animated.Value(0)).current;

  const tryBiometric = useCallback(async () => {
    if (await promptBiometric()) unlock();
  }, [unlock]);

  useEffect(() => {
    (async () => {
      const on = (await getBiometricEnabled()) && (await biometricAvailable());
      setBioOn(on);
      if (on) tryBiometric();
    })();
  }, [tryBiometric]);

  const runShake = useCallback(() => {
    Animated.sequence([
      Animated.timing(shake, { toValue: 1, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -1, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 1, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [shake]);

  const submit = useCallback(async (pin: string) => {
    if (await verifyPin(pin)) {
      unlock();
    } else {
      setError(true);
      runShake();
      setTimeout(() => { setEntered(""); setError(false); }, 450);
    }
  }, [unlock, runShake]);

  const onDigit = useCallback((d: string) => {
    setEntered((prev) => {
      if (prev.length >= PIN_LENGTH) return prev;
      const next = prev + d;
      if (next.length === PIN_LENGTH) submit(next);
      return next;
    });
  }, [submit]);

  const translateX = shake.interpolate({ inputRange: [-1, 1], outputRange: [-10, 10] });

  return (
    <View style={styles.fill}>
      <GlowBackdrop variant="center" />
      <SafeAreaView style={styles.fill} edges={["top", "bottom"]}>
        <View style={styles.top}>
          <View style={styles.lockIcon}>
            <Ionicons name="lock-closed" size={26} color={colors.primaryBright} />
          </View>
          <Text style={styles.title}>App verrouillée</Text>
          <Text style={styles.subtitle}>Saisissez votre code pour continuer</Text>
          <Animated.View style={{ transform: [{ translateX }] }}>
            <PinDots length={PIN_LENGTH} filled={entered.length} error={error} />
          </Animated.View>
        </View>

        <View style={styles.padWrap}>
          <PinKeypad
            onDigit={onDigit}
            onBackspace={() => setEntered((e) => e.slice(0, -1))}
            bio={bioOn}
            onBio={tryBiometric}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  top: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md },
  lockIcon: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: colors.primarySoft,
    alignItems: "center", justifyContent: "center",
    marginBottom: space.xs,
  },
  title: { color: colors.text, fontSize: font.h3, fontWeight: "700" },
  subtitle: { color: colors.muted, fontSize: font.small },
  padWrap: { paddingBottom: space.xxl },
});
