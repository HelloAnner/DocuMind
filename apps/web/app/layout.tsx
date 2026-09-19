import type { Metadata } from "next";
import "streamdown/styles.css";
import "./globals.css";
import "./product-theme.css";
import { AuthProvider } from "@/components/providers/auth-provider";


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
    <html data-theme="light" lang="zh-CN" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
              const media = matchMedia("(prefers-color-scheme: dark)");
              document.documentElement.dataset.theme =
                localStorage.getItem("documind-theme") || (media.matches ? "dark" : "light");
              media.addEventListener("change", () => {
                document.documentElement.dataset.theme =
                  localStorage.getItem("documind-theme") || (media.matches ? "dark" : "light");
              });
            })();`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,500;1,600;1,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
