import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pawline",
  description: "Long-term health trends and baseline alerts for pet activity trackers.",
};

// Stated explicitly: without it a phone lays the page out at desktop width and
// zooms out, which makes every chart unreadable on the device most likely to be
// used to check on a pet.
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
