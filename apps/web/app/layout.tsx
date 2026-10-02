import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Archivo, Bodoni_Moda } from "next/font/google";
import "./globals.css";

const geistSans = localFont({ src: "./fonts/GeistVF.woff", variable: "--font-sans" });
const geistMono = localFont({ src: "./fonts/GeistMonoVF.woff", variable: "--font-mono" });
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-display" });
const bodoni = Bodoni_Moda({ subsets: ["latin"], style: ["italic"], variable: "--font-latin" });

export const metadata: Metadata = {
  title: "Cloudly — coding agents on a server you already own",
  description:
    "Run Claude Code, Codex or Gemini against your GitHub repos on a VM in your own cloud account, with a monthly spend limit that actually stops runs. Free and MIT-licensed.",
};

export const viewport: Viewport = {
  themeColor: "#1F3F8C",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${archivo.variable} ${bodoni.variable}`}>
      <body>{children}</body>
    </html>
  );
}
