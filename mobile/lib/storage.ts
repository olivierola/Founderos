import * as SecureStore from "expo-secure-store";

// A FounderOS agent registered on this device. The secret is the password the
// user pasted from FounderOS; it is kept in the OS secure store, never in plain
// AsyncStorage.
export interface RegisteredAgent {
  id: string;
  secret: string;
  name: string;
  addedAt: string;
}

const KEY = "founderos.agents.v1";

export async function loadAgents(): Promise<RegisteredAgent[]> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RegisteredAgent[]) : [];
  } catch {
    return [];
  }
}

export async function persistAgents(list: RegisteredAgent[]): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(list));
}
