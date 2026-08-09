import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const description =
  "A hosted application backend with ChatGPT sign-in, AittaDB-issued sessions, isolated JSON records, and file storage.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host");
  const host = safeHost(forwardedHost ?? requestHeaders.get("host"));
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "http" ? "http" : "https";
  const metadataBase = new URL(`${protocol}://${host}`);

  return {
    metadataBase,
    title: "AittaDB",
    description,
    icons: {
      icon: "/aittadb-mark.svg",
      shortcut: "/aittadb-mark.svg",
    },
    openGraph: {
      title: "AittaDB",
      description,
      type: "website",
      images: [
        {
          url: "/og.png",
          width: 1200,
          height: 630,
          alt: "AittaDB: ChatGPT sign-in, app-ready identity and data.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "AittaDB",
      description,
      images: ["/og.png"],
    },
  };
}

function safeHost(value: string | null): string {
  if (value && /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)) return value;
  return "localhost:3000";
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
