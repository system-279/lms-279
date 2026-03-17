"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

/**
 * テナントコンテキストの型定義
 */
type TenantContextType = {
  /** テナントID（URLパスから抽出） */
  tenantId: string;
  /** デモテナントかどうか */
  isDemo: boolean;
};

const TenantContext = createContext<TenantContextType | null>(null);

/**
 * テナントプロバイダー
 * URL パラメータから抽出したテナントIDを子コンポーネントに提供
 */
export function TenantProvider({
  tenantId,
  children,
}: {
  tenantId: string;
  children: ReactNode;
}) {
  const isDemo = tenantId === "demo";

  return (
    <TenantContext.Provider value={{ tenantId, isDemo }}>
      {children}
    </TenantContext.Provider>
  );
}

/**
 * テナント情報を取得するフック
 * TenantProvider 配下でのみ使用可能
 */
export function useTenant(): TenantContextType {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error("useTenant must be used within a TenantProvider");
  }
  return context;
}

/**
 * テナント情報を取得するフック（オプショナル）
 * TenantProvider 外でも使用可能（null を返す）
 */
export function useTenantOptional(): TenantContextType | null {
  return useContext(TenantContext);
}
