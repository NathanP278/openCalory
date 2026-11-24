import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { PwaRegister } from "@/components/shell/pwa-register";
import { VisualViewportSync } from "@/components/shell/visual-viewport-sync";
import { AppBootGate } from "@/components/shell/app-boot-gate";
import { MotionRoot } from "@/components/motion/motion-primitives";
import { RouteDirectionProvider } from "@/components/motion/route-direction-context";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "openCalory - Adherence-Neutral Macro & Calorie Tracker",
  description: "100% free, offline-first calorie and macro tracking with AI meal scanning and adherence-neutral analytics.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "openCalory",
  },
  formatDetection: {
    telephone: false,
    date: false,
    email: false,
    address: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#1e2229" },
    { media: "(prefers-color-scheme: light)", color: "#f2f4f8" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        <ThemeProvider defaultTheme="dark">
          <MotionRoot>
            <RouteDirectionProvider>
              <PwaRegister />
              <VisualViewportSync />
              <AppBootGate>{children}</AppBootGate>
            </RouteDirectionProvider>
          </MotionRoot>
          <Analytics />
          <SpeedInsights />
        </ThemeProvider>
      </body>
    </html>
  );
}
