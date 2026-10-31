import { useState } from 'react'

const STORAGE_PREFIX = 'tapflow-app-center-releases:'
// A search narrows the list, so a release missing from it may be hidden rather than deleted, and
// nothing here can tell which. Entries are never pruned by presence; the oldest toggles past this
// many fall off instead.
const MAX_TOGGLES = 200

/**
 * Releases the person opened (`true`) or closed (`false`) themselves, oldest first. **Pairs, not an
 * object**: an object lists integer-like keys first in ascending order whatever the insertion order,
 * and `version_name` is free-form — a release called "2" would never be the newest toggle, and the
 * cap would drop the wrong one.
 */
type Toggles = ReadonlyArray<readonly [string, boolean]>

function readToggles(appId: number): Toggles {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + appId) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is [string, boolean] =>
      Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'boolean')
  } catch {
    return []
  }
}

function writeToggles(appId: number, toggles: Toggles): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + appId, JSON.stringify(toggles))
  } catch {
    /* no storage: the toggle still holds for this visit */
  }
}

/**
 * Which releases of an app's list are open — remembered per app, in this browser.
 *
 * **Only what the person toggled is stored.** A release nobody touched follows the default, the
 * newest open and the rest closed, so a version uploaded since the last visit arrives open while one
 * deliberately collapsed stays collapsed. Storing the whole open set instead would have shown every
 * new upload closed — the version a person most often comes to look at.
 *
 * **Derived during render, not seeded by an effect** (#834). The seed ran after the commit that
 * showed the list, so when a retry brought the list back and focus moved to the first release
 * header, that header was announced collapsed and then reported its own expansion.
 *
 * `appId` is the app whose rows are on screen, which during an app switch is still the previous one.
 * "Newest" is the first release *of the list shown*, so under a search or filter it is the newest
 * that matches — the one a person narrowing the list is most likely after. When a status change
 * takes the newest release's last matching row away, the next one opens in the same commit, which
 * is also where focus goes (#833).
 */
export function useReleaseDisclosure(appId: number | null, releaseNames: readonly string[]) {
  // Toggles made during this visit, by app. An app not in here is read from storage.
  const [visit, setVisit] = useState<ReadonlyMap<number, Toggles>>(() => new Map())
  const toggles: Toggles = appId === null ? [] : (visit.get(appId) ?? readToggles(appId))
  const newest = releaseNames[0]

  const isOpen = (name: string): boolean => toggles.find(([n]) => n === name)?.[1] ?? name === newest

  const toggle = (name: string): void => {
    if (appId === null) return
    // Moved to the end, so the cap drops the release toggled longest ago.
    const next: Toggles = [...toggles.filter(([n]) => n !== name), [name, !isOpen(name)] as const].slice(-MAX_TOGGLES)
    writeToggles(appId, next)
    setVisit((prev) => new Map(prev).set(appId, next))
  }

  /** Opens a release and leaves an open one open — unlike `toggle`. A build whose version was edited lands in its new
   *  release, which has to be open for focus to reach it (#1084). */
  const open = (name: string): void => {
    if (!isOpen(name)) toggle(name)
  }

  return { isOpen, toggle, open }
}
