"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, type Budget, type HarnessInfo, type User } from "@/lib/api";
import { HARNESSES, setKnownHarnesses, type Harness } from "@/lib/harness";

interface AppState {
  user: User | null;
  budget: Budget | null;
  refreshBudget: () => Promise<void>;
  /** Agents sessions can use: built in, then those added under Settings > Agents. */
  harnesses: Harness[];
  refreshHarnesses: () => Promise<void>;
}

const Ctx = createContext<AppState>({
  user: null,
  budget: null,
  refreshBudget: async () => {},
  harnesses: HARNESSES,
  refreshHarnesses: async () => {},
});

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [harnesses, setHarnesses] = useState<Harness[]>(HARNESSES);

  const refreshBudget = useCallback(async () => {
    setBudget(await api<Budget>("/budget"));
  }, []);

  const refreshHarnesses = useCallback(async () => {
    const { harnesses } = await api<{ harnesses: HarnessInfo[] }>("/harnesses");
    setKnownHarnesses(harnesses);
    setHarnesses(harnesses);
  }, []);

  useEffect(() => {
    refreshHarnesses().catch(() => {});
  }, [refreshHarnesses]);

  useEffect(() => {
    api<{ user: User | null }>("/me").then(({ user }) => {
      if (!user) window.location.assign("/signin");
      else setUser(user);
    });
    refreshBudget().catch(() => {});
    const timer = window.setInterval(() => refreshBudget().catch(() => {}), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshBudget]);

  return <Ctx.Provider value={{ user, budget, refreshBudget, harnesses, refreshHarnesses }}>{children}</Ctx.Provider>;
}

export function useApp() {
  return useContext(Ctx);
}
