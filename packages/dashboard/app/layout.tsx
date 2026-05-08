import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'tapflow',
  description: 'Self-hosted iOS/Android simulator streaming for QA teams',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  )
}
