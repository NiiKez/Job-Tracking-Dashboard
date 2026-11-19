import type { Metadata, Viewport } from "next";
import { Geist_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Job Tracker", template: "%s · Job Tracker" },
  description: "Every job you saved or applied to, and where each application stands.",
  // <meta name="job-tracker" content="app">: the Chrome extension's popup offers the open tab's
  // address as the tracker to connect to when the page carries it (docs/plan/4-chrome-extension.md).
  other: { "job-tracker": "app" },
};

export const viewport: Viewport = {
  // Dark is the default theme (components/providers.tsx), whatever the device prefers.
  themeColor: "#0d0d0d",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${jakarta.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* The sidebar shell lives in (app)/layout.tsx, so /login can sit outside it. */}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
