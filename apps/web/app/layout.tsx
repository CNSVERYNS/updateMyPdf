import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'updateMyPDF · Document Translation',
  description: 'Translate PDF and DOCX files while preserving their layout.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="tr"><body>{children}</body></html>
}
