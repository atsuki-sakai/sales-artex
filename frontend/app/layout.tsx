import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "商談デスク | Sales Artex",
  description: "AI 営業担当との音声商談と、発言に応じた商談分析を確認できます。",
};

export const viewport: Viewport = { themeColor: "#323c77" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="ja"><body>{children}</body></html>;
}
