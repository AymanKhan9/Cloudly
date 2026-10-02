"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, type Budget, type User } from "@/lib/api";

interface AppState {
  user: User | null;
  budget: Budget | null;
  refreshBudget: () => Promise<void>;
}

const Ctx = createContext<AppState>({ user: null, budget: null, refreshBudget: async () => {} });

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);

  const refreshBudget = useCallback(async () => {
    setBudget(await api<Budget>("/budget"));
  }, []);

  useEffect(() => {
    api<{ user: User | null }>("/me").then(({ user }) => {
      if (!user) window.location.assign("/signin");
      else setUser(user);
    });
    refreshBudget().catch(() => {});
    const timer = window.setInterval(() => refreshBudget().catch(() => {}), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshBudget]);

  return <Ctx.Provider value={{ user, budget, refreshBudget }}>{children}</Ctx.Provider>;
}

export function useApp() {
  return useContext(Ctx);
}
