import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { DemoBanner } from "@/app/components/DemoBanner";
import { Sidebar } from "@/app/components/Sidebar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// A template rather than a bare title: every page below sets its own short
// title ("Sign in", "Authorize access"), and this is what puts the app's name
// after it in the tab and in a bookmark.
export const metadata: Metadata = {
  metadataBase: new URL("https://ragurgitator.com"),
  title: {
    default: "Ragurgitator",
    template: "%s · Ragurgitator",
  },
  description: "A RAG workbench that measures its own retrieval.",
  applicationName: "Ragurgitator",
  // app/icon.svg, app/apple-icon.png and app/opengraph-image.png are picked up
  // by file convention; only the ones with no file convention are listed here.
  openGraph: {
    siteName: "Ragurgitator",
    type: "website",
  },
};

// The tile's own black, so mobile browser chrome meets the mark rather than
// framing it in white.
export const viewport: Viewport = {
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* App frame: the togglable corpora sidebar + the page column. The
            sidebar is a self-fetching Client Component so this layout stays
            DB-free (it also wraps build-time statics like the 404 page). */}
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Renders nothing for a real account — it is a Client Component
                for the same reason the sidebar is, so this layout stays DB-free
                (docs/guest-demo-plan.md). */}
            <DemoBanner />
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
