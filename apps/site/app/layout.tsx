import type { Metadata, Viewport } from "next";
import { Archivo, Martian_Mono } from "next/font/google";

import { siteUrl } from "@/lib/links";

import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const martian = Martian_Mono({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-martian",
  display: "swap",
});

const TITLE = "Rivet - turn a GitHub issue into a tested pull request";
const DESCRIPTION =
  "Rivet is an open-source autonomous software engineer. It plans a fix, writes the code in an isolated sandbox, runs the project's own tests, has a second agent review the change, and opens the pull request.";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Rivet",
    url: "/",
    images: [
      { url: "/og.png", width: 1200, height: 630, alt: "Rivet's console replaying a real job" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0d1317",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${martian.variable}`}>
      <body className="min-h-svh">{children}</body>
    </html>
  );
}
