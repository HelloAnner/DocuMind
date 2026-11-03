import type { Metadata } from "next";
import { BRAND_ICON_URL } from "@/lib/brand-icon-url";
import "streamdown/styles.css";
import "./globals.css";
import "./product-theme.css";
import "./density.css";
import { AuthProvider } from "@/components/providers/auth-provider";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/theme";


export const metadata: Metadata = {
  title: "DocuMind",
  description: "企业级文档智能问答系统",
  icons: {
    icon: { url: BRAND_ICON_URL, type: "image/svg+xml" },
    shortcut: BRAND_ICON_URL,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html data-theme="light" lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta content="light dark" name="color-scheme" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,500;1,600;1,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
