import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Script from "next/script";
import { themeScript } from "@/lib/theme";

const geistSans = localFont({ src: "./fonts/GeistVF.woff", variable: "--font-sans-face" });
const geistMono = localFont({ src: "./fonts/GeistMonoVF.woff", variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Cloudly: cloud coding agents you own end to end",
  description:
    "Run Claude Agent, Codex or Gemini against your GitHub repos on a VM in your own cloud account, on your API keys or your Claude or ChatGPT plan. Your server, database, keys and spend limit. Free and MIT-licensed.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0e11" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The theme script sets data-theme before React hydrates, so the attribute differs on purpose.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body>
        {children}
        <Script id="theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
      </body>
    </html>
  );
}
