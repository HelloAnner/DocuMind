import type { Metadata } from "next";
import "./globals.css";
import "./product-theme.css";
import { AuthProvider } from "@/components/providers/auth-provider";

const themeBootstrapScript = `
(() => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = () => {
    const theme = media.matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  };
  applyTheme();
  media.addEventListener("change", applyTheme);
})();`;

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
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
