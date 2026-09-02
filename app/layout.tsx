import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import '@openmaic/renderer/fonts.css';
import 'animate.css';
import 'katex/dist/katex.min.css';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import { Toaster } from '@/components/ui/sonner';
import { ServerProvidersInit } from '@/components/server-providers-init';
import { AccessCodeGuard } from '@/components/access-code-guard';

const inter = localFont({
  src: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  variable: '--font-sans',
  weight: '100 900',
});

export const metadata: Metadata = {
  title: '锐捷来学',
  description:
    'The open-source AI interactive classroom. Upload a PDF to instantly generate an immersive, multi-agent learning experience.',
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-icon.png',
  },
};

// Public browser configuration is injected at request time. This keeps Docker
// builds independent from runtime environment variables in Dokploy.
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const runtimeConfig = JSON.stringify({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  }).replace(/</g, '\\u003c');

  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
        suppressHydrationWarning
      >
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__LAIXUE_RUNTIME_CONFIG__=${runtimeConfig};`,
          }}
        />
        <ThemeProvider>
          <I18nProvider>
            <ServerProvidersInit />
            <AccessCodeGuard>{children}</AccessCodeGuard>
            <Toaster position="top-center" />
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
