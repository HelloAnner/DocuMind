import type { Metadata } from "next";
import "./globals.css";
import "./product-theme.css";
import { AuthProvider } from "@/components/providers/auth-provider";
import { ThemeProvider, themeBootstrapScript } from "@/components/providers/theme-provider";

export const metadata: Metadata = {
  title: "DocuMind",
  description: "企业级文档智能问答系统",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html data-theme="dark" lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
