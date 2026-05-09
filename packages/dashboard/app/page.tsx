'use client'

import { useState } from 'react'
import { SessionList } from '@/components/SessionList'
import { SimulatorViewer } from '@/components/SimulatorViewer'
import { AppCenter } from '@/components/AppCenter'

type Tab = 'devices' | 'app-center'

export default function Home() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('devices')

  if (sessionId) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-8">
        <SimulatorViewer sessionId={sessionId} onBack={() => setSessionId(null)} />
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <header className="mb-8">
        <h1 className="text-xl font-bold tracking-tight">tapflow</h1>
      </header>

      <div className="mb-6 flex gap-1 border-b">
        <button
          className={`px-4 pb-2 text-sm font-medium transition-colors ${
            activeTab === 'devices'
              ? 'border-b-2 border-foreground text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('devices')}
        >
          Devices
        </button>
        <button
          className={`px-4 pb-2 text-sm font-medium transition-colors ${
            activeTab === 'app-center'
              ? 'border-b-2 border-foreground text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('app-center')}
        >
          App Center
        </button>
      </div>

      {activeTab === 'devices' && <SessionList onSelect={setSessionId} />}
      {activeTab === 'app-center' && <AppCenter onSelect={setSessionId} />}
    </main>
  )
}
