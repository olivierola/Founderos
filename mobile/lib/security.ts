import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";

// App-lock secrets live in the OS secure enclave (SecureStore). The PIN is kept
// as a lightweight hash rather than in clear — SecureStore is already encrypted
// at rest, the hash is just defence-in-depth for a 4-digit local gate.
const PIN_KEY = "founderos.lock.pin.v1";
const BIO_KEY = "founderos.lock.biometric.v1";

function hashPin(pin: string): string {
  // djb2 — enough to avoid storing the literal PIN; not a password hash.
  let h = 5381;
  for (let i = 0; i < pin.length; i++) h = ((h << 5) + h + pin.charCodeAt(i)) >>> 0;
  return `h${h.toString(16)}`;
}

export async function hasPin(): Promise<boolean> {
  return !!(await SecureStore.getItemAsync(PIN_KEY));
}

export async function setPin(pin: string): Promise<void> {
  await SecureStore.setItemAsync(PIN_KEY, hashPin(pin));
}

export async function verifyPin(pin: string): Promise<boolean> {
  const stored = await SecureStore.getItemAsync(PIN_KEY);
  return !!stored && stored === hashPin(pin);
}

export async function clearPin(): Promise<void> {
  await SecureStore.deleteItemAsync(PIN_KEY);
  await SecureStore.deleteItemAsync(BIO_KEY);
}

// ── Biometrics ───────────────────────────────────────────────────────────────
export async function biometricAvailable(): Promise<boolean> {
  const [hw, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hw && enrolled;
}

export async function getBiometricEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BIO_KEY)) === "1";
}

export async function setBiometricEnabled(on: boolean): Promise<void> {
  if (on) await SecureStore.setItemAsync(BIO_KEY, "1");
  else await SecureStore.deleteItemAsync(BIO_KEY);
}

export async function promptBiometric(): Promise<boolean> {
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: "Déverrouiller AchiCorp",
      fallbackLabel: "Utiliser le code",
      cancelLabel: "Annuler",
    });
    return res.success;
  } catch {
    return false;
  }
}
