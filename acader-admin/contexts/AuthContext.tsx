"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { onIdTokenChanged, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase";

const STORAGE_KEY = "acader_admin_token";

type AuthContextValue = {
  token: string | null;
  setToken: (token: string | null) => void;
  logout: () => Promise<void>;
  authHeaders: (options?: { json?: boolean }) => HeadersInit;
  isAuthenticated: boolean;
  isLoading: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [token, setTokenState] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      try {
        return localStorage.getItem(STORAGE_KEY);
      } catch (error) {
        console.error("Failed to access localStorage:", error);
      }
    }
    return null;
  });

  const setToken = useCallback((value: string | null) => {
    setTokenState(value);
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  useEffect(() => {
    const unsub = onIdTokenChanged(auth, async (user) => {
      try {
        if (!user) {
          setTokenState(null);
          localStorage.removeItem(STORAGE_KEY);
          return;
        }

        const freshToken = await user.getIdToken();
        setTokenState(freshToken);
        localStorage.setItem(STORAGE_KEY, freshToken);
      } catch (error) {
        console.error("Failed to sync auth token:", error);
      } finally {
        setIsLoading(false);
      }
    });

    return () => unsub();
  }, []);

  const logout = useCallback(async () => {
    try {
      await signOut(auth);
    } finally {
      setToken(null);
    }
  }, [setToken]);

  const authHeaders = useCallback(
    (options?: { json?: boolean }): HeadersInit => {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      if (options?.json) headers["Content-Type"] = "application/json";
      return headers;
    },
    [token],
  );

  const value: AuthContextValue = {
    token,
    setToken,
    logout,
    authHeaders,
    isAuthenticated: !!token,
    isLoading,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
