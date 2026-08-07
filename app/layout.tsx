import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sites Auth Broker",
  description:
    "Independent OAuth 2.0, OpenID Connect, and JWT sessions from ChatGPT Sites identity.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

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
