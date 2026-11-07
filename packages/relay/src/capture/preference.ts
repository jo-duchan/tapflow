import { getDb } from '../db.js'

/**
 * Each person's Flow Capture setting (`users.flow_capture`), read on every input the relay passes on. Kept in
 * memory so that path never reads the database, and updated by the one route that writes it, so turning capture
 * back on takes effect on the next input rather than the next join.
 */
export class FlowCapturePreference {
  private readonly known = new Map<string, boolean>()

  isEnabled(user: string): boolean {
    const cached = this.known.get(user)
    if (cached !== undefined) return cached
    const row = getDb().prepare('SELECT flow_capture FROM users WHERE id = ?').get(user) as { flow_capture: number } | undefined
    // No such user records nothing; the next lookup asks again, since the row may be created later.
    if (!row) return false
    const on = row.flow_capture === 1
    this.known.set(user, on)
    return on
  }

  set(user: string, on: boolean): void {
    getDb().prepare('UPDATE users SET flow_capture = ? WHERE id = ?').run(on ? 1 : 0, user)
    this.known.set(user, on)
  }

  /** A member was removed (`DELETE /api/v1/team/members/:id`): drop what is cached for them. */
  forget(user: string): void {
    this.known.delete(user)
  }
}
