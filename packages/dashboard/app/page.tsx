'use client'

import { useState } from 'react'
import { SessionList } from '@/components/SessionList'
import { SimulatorViewer } from '@/components/SimulatorViewer'

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null)

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-xl font-bold tracking-tight">tapflow</h1>
      </header>

      {sessionId ? (
        <SimulatorViewer sessionId={sessionId} onBack={() => setSessionId(null)} />
      ) : (
        <div>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Available Devices
          </h2>
          <SessionList onSelect={setSessionId} />
        </div>
      )}
    </main>
  )
}
