import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

type ContextValue = {
  node: ReactNode
  setNode: (node: ReactNode) => void
}

const BreadcrumbContext = createContext<ContextValue>({ node: null, setNode: () => {} })

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode>(null)
  const value = useMemo(() => ({ node, setNode }), [node])
  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>
}

export function useBreadcrumb() {
  return useContext(BreadcrumbContext)
}
