import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OrderFlow Terminal",
  description: "Browser-based orderflow terminal: footprint, TPO, DOM surface, options money flow and scalper overlays.",
};

export const viewport: Viewport = {
  themeColor: "#07090d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
