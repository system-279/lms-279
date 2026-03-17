"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  type User,
} from "firebase/auth";
import { getFirebaseAuth } from "./firebase";
import { useTenantOptional } from "./tenant-context";

type AuthState = {
  user: User | null;
  loading: boolean;
  error: string | null;
};

type AuthContextType = AuthState & {
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
  isDemo?: boolean;
};

const AuthContext = createContext<AuthContextType | null>(null);

const AUTH_MODE = process.env.NEXT_PUBLIC_AUTH_MODE ?? "dev";

// デモ用固定ユーザー（Firebase User互換のモック）
const DEMO_USER = {
  uid: "demo-admin",
  email: "admin@demo.example.com",
  displayName: "管理者デモ",
  getIdToken: async () => null,
} as unknown as User;

export function AuthProvider({ children }: { children: ReactNode }) {
  // テナントコンテキストからデモモードを取得（TenantProvider外ではnull）
  const tenant = useTenantOptional();
  const isDemo = tenant?.isDemo ?? false;

  const [state, setState] = useState<AuthState>({
    user: isDemo ? DEMO_USER : null,
    loading: isDemo ? false : AUTH_MODE === "firebase",
    error: null,
  });

  useEffect(() => {
    // デモモードでは認証状態の監視をスキップ
    if (isDemo) {
      setState({ user: DEMO_USER, loading: false, error: null });
      return;
    }

    if (AUTH_MODE !== "firebase") {
      return;
    }

    const auth = getFirebaseAuth();
    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        setState({ user, loading: false, error: null });
      },
      (error) => {
        setState({ user: null, loading: false, error: error.message });
      }
    );

    return () => unsubscribe();
  }, [isDemo]);

  const signInWithGoogle = async () => {
    // デモモードでは何もしない
    if (isDemo || AUTH_MODE !== "firebase") {
      return;
    }

    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      const auth = getFirebaseAuth();
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ログインに失敗しました";
      setState((prev) => ({ ...prev, loading: false, error: message }));
      throw error;
    }
  };

  const signOut = async () => {
    // デモモードでは何もしない
    if (isDemo || AUTH_MODE !== "firebase") {
      return;
    }

    try {
      const auth = getFirebaseAuth();
      await firebaseSignOut(auth);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ログアウトに失敗しました";
      setState((prev) => ({ ...prev, error: message }));
      throw error;
    }
  };

  const getIdToken = async (): Promise<string | null> => {
    // デモモードではトークン不要
    if (isDemo || AUTH_MODE !== "firebase" || !state.user) {
      return null;
    }

    try {
      return await state.user.getIdToken();
    } catch {
      return null;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        ...state,
        signInWithGoogle,
        signOut,
        isDemo,
        getIdToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
