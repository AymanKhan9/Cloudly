import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Script from "next/script";
import { themeScript } from "@/lib/theme";
import { PageViews } from "@/components/ads-pixel";
import { PIXEL_ID, pixelScript } from "@/lib/ads-pixel";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/lib/site";

const geistSans = localFont({ src: "./fonts/GeistVF.woff", variable: "--font-sans-face" });
const geistMono = localFont({ src: "./fonts/GeistMonoVF.woff", variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: `%s · ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "self-hosted coding agents", "Claude Code", "Codex", "Gemini CLI", "background coding agent",
    "AI pull requests", "open source Devin alternative", "cloud coding agent", "ACP agents", "usecloudly",
  ],
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: SITE_NAME, url: "/", title: SITE_TITLE, description: SITE_DESCRIPTION },
  twitter: { card: "summary_large_image", title: SITE_TITLE, description: SITE_DESCRIPTION },
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
        {PIXEL_ID && (
          <>
            <Script id="oai-pixel" strategy="beforeInteractive">
              {pixelScript}
            </Script>
            <PageViews />
          </>
        )}
      </body>
    </html>
  );
}
