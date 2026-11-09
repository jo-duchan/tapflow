import type { PointSpace } from '@tapflowio/protocol'
import type { CaptureEntry, CapturedMessage } from '@tapflowio/protocol/capture'
import type { FocusedField } from '@tapflowio/protocol'
import { keyChar } from './keys.js'

export type Point = [number, number]
export type Fingers = [Point, Point]

/** What the agent said about a step: its ack, or none — a message nothing acks, or an ack the record does not have. */
export type Outcome = 'landed' | 'refused' | 'unknown'

/** A recorded message with the relay's clock, as the raw replayer sends it again. */
export interface TimedMessage {
  at: number
  msg: CapturedMessage
}

interface StepBase {
  /** The relay's clock at the step's first and last message. */
  at: number
  endAt: number
  outcome: Outcome
  /** The chrome in force when the step began (images emptied). It lags a turn by up to 3.6 s, so it is for showing the
   *  step, never for placing its points: those are placed against the screen read when the step is replayed. */
  chrome?: unknown
  /** What the replayer sends, in order, with the times they were sent. */
  messages: TimedMessage[]
}

/** A person's action on the device: the unit the dialog lists, replays and turns into a flow step. */
export type RawStep = StepBase & (
  | { kind: 'tap'; point: Point; space?: PointSpace }
  | { kind: 'longPress'; point: Point; space?: PointSpace; durationMs: number }
  | { kind: 'swipe'; from: Point; to: Point; space?: PointSpace; durationMs: number }
  /** Held, then moved: a drag after a long press. No flow step says it. */
  | { kind: 'holdDrag'; from: Point; to: Point; space?: PointSpace; durationMs: number }
  | { kind: 'pinch'; start: Fingers; end: Fingers; space?: PointSpace; durationMs: number }
  /**
   * Keys that each typed a character, in a row, and what they typed. Two ways to know it:
   * - `replace`: the relay read the field once the person paused (#1135), so `text` is what the field held, and the
   *   step is every run and edit key typed into that one field. Whatever the device's IME, language or Caps Lock made
   *   of the keys is in it.
   * - otherwise, `text` is the keys read on a US layout — right on Android, whose agent types them from that table, and
   *   a guess on iOS, where the device's IME decides. `fieldRead` says whether a read was tried: `unread` when the
   *   agent reads fields but none was usable (the warning is the reader's), `secure` for a field that never shows its
   *   value. Absent: no read was tried, as on Android, or as on iOS when the relay read no field at all (the matcher
   *   warns there, by platform).
   */
  | { kind: 'text'; text: string; replace?: true; fieldRead?: 'unread' | 'secure' }
  /** A key that types no character — Enter, Tab, Backspace, an arrow — or a chord. */
  | { kind: 'key'; code: string; modifiers: number }
  | { kind: 'paste'; text: string }
  /** `input:type`: an MCP client's typing. The dashboard types key by key. */
  | { kind: 'type'; text: string }
  /** `heldMs` when it came as a down and an up, the way iOS's bezel sends every press. */
  | { kind: 'button'; name: string; heldMs?: number }
  | { kind: 'rotate'; to: { orientation: 'portrait' | 'landscape' } | { direction: 'clockwise' | 'counterclockwise' } | null }
  | { kind: 'posture'; postureId: string }
  | { kind: 'keyboardToggle' }
  | { kind: 'launch'; buildId: number }
  | { kind: 'install'; buildId: number }
  | { kind: 'clearState'; bundleId: string }
  | { kind: 'openUrl'; url: string }
  | { kind: 'network'; offline: boolean }
  | { kind: 'cut' }
)

/** Both platforms recognise a long press at about half a second. */
export const LONG_PRESS_MS = 500
/** The dashboard sends no move until the pointer has gone this far (`DRAG_THRESHOLD`), so a smaller one is a tap's
 *  tremble, kept as a tap. */
export const TAP_SLOP = 0.02
/** A pause this long between two keys starts a new run: the person may have moved on between them. Not shorter:
 *  measured, a person typing a seven-character password paused 2.1 s in the middle of it, and a run cut there made
 *  one field two secrets. */
export const KEY_RUN_GAP_MS = 10_000

type Msg<T extends CapturedMessage['type']> = Extract<CapturedMessage, { type: T }>

/**
 * A capture's entries as the actions a person took. Each action keeps its messages, so the replayer can send it again;
 * the agent's acks settle each action's outcome; a chrome entry is carried forward to the actions after it.
 *
 * A run of typing is cut at every key that types no character, at every other input, and at a pause: each piece is
 * typed into whatever field had focus when it began, and an Enter or a Tab can move that focus. Thinning (the relay's
 * budget) keeps a gesture's start and its first and last moves, which is all this reads.
 */
export function segment(entries: readonly CaptureEntry[]): RawStep[] {
  const acks = new Map<string, boolean>()
  for (const e of entries) if (e.kind === 'ack') acks.set(e.requestId, e.ok)
  const outcomeOf = (requestId: string | undefined): Outcome => {
    if (requestId === undefined) return 'unknown'
    const ok = acks.get(requestId)
    return ok === undefined ? 'unknown' : ok ? 'landed' : 'refused'
  }

  const out: RawStep[] = []
  let chrome: unknown
  let touch: TimedMessage[] | null = null
  let pinch: TimedMessage[] | null = null
  let run: { steps: TimedMessage[]; text: string } | null = null
  const buttonsDown = new Map<string, TimedMessage>()
  const push = (step: RawStep): void => {
    out.push(chrome === undefined ? step : { ...step, chrome })
  }
  const base = (messages: TimedMessage[], outcome: Outcome) => ({
    at: messages[0]!.at, endAt: messages[messages.length - 1]!.at, outcome, messages,
  })
  const endRun = (): void => {
    if (run && run.text.length > 0) push({ ...base(run.steps, 'landed'), kind: 'text', text: run.text })
    // Caps Lock with nothing typed after it still changed the device, so it is a step of its own.
    else if (run) for (const t of run.steps) push({ ...base([t], outcomeOf((t.msg as Msg<'input:key'>).requestId)), kind: 'key', code: (t.msg as Msg<'input:key'>).payload.code, modifiers: 0 })
    run = null
  }

  for (const e of entries) {
    if (e.kind === 'chrome') { chrome = e.chrome; continue }
    if (e.kind !== 'input') continue
    const timed: TimedMessage = { at: e.at, msg: e.msg }
    const m = e.msg

    if (m.type === 'input:key') {
      const modifiers = m.payload.modifiers ?? 0
      const refused = outcomeOf(m.requestId) === 'refused'
      if (m.payload.code === 'CapsLock' && modifiers === 0) {
        // Refused, it toggled nothing; and it is not replayed, since a refusal can be transient (the input channel
        // still starting) and would land on replay, changing what every letter after it types.
        if (refused) continue
        run ??= { steps: [], text: '' }
        run.steps.push(timed)
        continue
      }
      const char = keyChar(m.payload.code, modifiers)
      if (char !== null) {
        const last = run?.steps[run.steps.length - 1]
        if (run && last && e.at - last.at > KEY_RUN_GAP_MS) endRun()
        // A key the device refused typed nothing: neither written down nor sent again, for the reason above.
        if (refused) continue
        run ??= { steps: [], text: '' }
        run.steps.push(timed)
        run.text += char
        continue
      }
      endRun()
      push({ ...base([timed], outcomeOf(m.requestId)), kind: 'key', code: m.payload.code, modifiers })
      continue
    }
    endRun()

    switch (m.type) {
      case 'input:touch:start':
        touch = [timed]
        break
      case 'input:touch:move':
        touch?.push(timed)
        break
      case 'input:touch:cancel':
        // Lifted without completing: the app saw no tap, so there is no step.
        touch = null
        break
      case 'input:touch:end': {
        if (!touch) break
        touch.push(timed)
        push(touchStep(touch, outcomeOf(m.requestId)))
        touch = null
        break
      }
      case 'input:pinch:start':
        pinch = [timed]
        break
      case 'input:pinch:move':
        pinch?.push(timed)
        break
      case 'input:pinch:end': {
        if (!pinch) break
        pinch.push(timed)
        push(pinchStep(pinch, outcomeOf(m.requestId)))
        pinch = null
        break
      }
      case 'input:button': {
        const { name, phase } = m.payload
        if (phase === 'down') { buttonsDown.set(name, timed); break }
        if (phase === 'up') {
          const down = buttonsDown.get(name)
          buttonsDown.delete(name)
          if (!down) break
          const outcome = worst(outcomeOf((down.msg as Msg<'input:button'>).requestId), outcomeOf(m.requestId))
          push({ ...base([down, timed], outcome), kind: 'button', name, heldMs: timed.at - down.at })
          break
        }
        push({ ...base([timed], outcomeOf(m.requestId)), kind: 'button', name })
        break
      }
      case 'input:type':
        push({ ...base([timed], outcomeOf(m.requestId)), kind: 'type', text: m.payload.text })
        break
      case 'clipboard:write':
        // Recorded only with pasteAfter (`CaptureStore`): a paste, not a copy to the device's clipboard.
        push({ ...base([timed], outcomeOf(m.requestId)), kind: 'paste', text: m.payload.text })
        break
      case 'clipboard:read':
        // Recorded only when it presses cut.
        push({ ...base([timed], outcomeOf(m.requestId)), kind: 'cut' })
        break
      case 'input:rotate':
        push({ ...base([timed], 'unknown'), kind: 'rotate', to: m.payload ?? null })
        break
      case 'input:posture':
        push({ ...base([timed], 'unknown'), kind: 'posture', postureId: m.payload.postureId })
        break
      case 'input:keyboard:toggle':
        push({ ...base([timed], 'unknown'), kind: 'keyboardToggle' })
        break
      case 'app:launch':
        push({ ...base([timed], outcomeOf(m.requestId)), kind: 'launch', buildId: m.buildId })
        break
      case 'app:install':
        push({ ...base([timed], outcomeOf(m.requestId)), kind: 'install', buildId: m.buildId })
        break
      case 'app:clear-state':
        push({ ...base([timed], outcomeOf(m.requestId)), kind: 'clearState', bundleId: m.payload.bundleId })
        break
      case 'open-url':
        push({ ...base([timed], outcomeOf(m.requestId)), kind: 'openUrl', url: m.payload.url })
        break
      case 'network:set':
        push({ ...base([timed], outcomeOf(m.requestId)), kind: 'network', offline: m.payload.offline })
        break
    }
  }
  endRun()
  return withFieldValues(out, entries)
}

/** Keys that edit what a field holds without typing a character: a run of typing goes on through them. */
const EDIT_KEYS = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'])
const isEdit = (s: RawStep): boolean => s.kind === 'key' && EDIT_KEYS.has(s.code) && (s.modifiers & ~0x02) === 0

const sameField = (a: FocusedField, b: FocusedField): boolean =>
  a.identifier === b.identifier && a.placeholder === b.placeholder
  // A field with no identifier is told apart by where it is: the keyboard is already up by the first read.
  && (a.identifier !== '' || (a.frame.x === b.frame.x && a.frame.y === b.frame.y))

/**
 * Typing into one field as one step with the value the relay read (#1135). A group is the text runs and edit keys
 * between two other inputs. Its value read counts only when it was asked after the group's last input, answered
 * before the next one, and is of the field the group's first key went into — a read that raced an input, or an app
 * that moved focus by itself (a one-time-code field), says nothing about this field. Two fields that move focus on
 * the first character are the one case the identity check cannot catch.
 */
function withFieldValues(steps: RawStep[], entries: readonly CaptureEntry[]): RawStep[] {
  const reads = entries.flatMap((e) => (e.kind === 'field' ? [e] : []))
  if (reads.length === 0) return steps
  const inputs = entries.flatMap((e) => (e.kind === 'input' ? [e.at] : []))
  const out: RawStep[] = []
  for (let i = 0; i < steps.length;) {
    let j = i
    while (j < steps.length && (steps[j]!.kind === 'text' || isEdit(steps[j]!))) j++
    const group = steps.slice(i, j)
    if (!group.some((s) => s.kind === 'text')) { out.push(...steps.slice(i, Math.max(j, i + 1))); i = Math.max(j, i + 1); continue }
    i = j
    const first = group[0]!
    const last = group[group.length - 1]!
    const nextInput = inputs.find((at) => at > last.endAt)
    const focus = reads.find((r) => r.phase === 'focus' && r.requestedAt >= first.at && r.requestedAt <= last.endAt)
    // The agent reads fields (there are reads), but none says which field this went into — typing that went on past
    // a key the relay does not end a run at, like Escape. Not read, so the reader warns.
    if (!focus) { out.push(...group.map((s) => (s.kind === 'text' ? { ...s, fieldRead: 'unread' } as RawStep : s))); continue }
    // `phase` is also implied by the times — a focus read is asked at a key, so never between this group's last input
    // and the next — and no test can tell the two apart; it stays so the rule does not rest on the relay's timing alone.
    const value = focus.field && !focus.field.secure ? reads.filter((r) => r.phase === 'value'
      && r.requestedAt > last.endAt && (nextInput === undefined || r.at < nextInput)
      && r.field !== null && !r.field.secure && sameField(r.field, focus.field!)
      && typeof r.field.value === 'string' && r.field.value !== '').at(-1) : undefined
    if (value?.field?.value !== undefined) {
      out.push({
        at: first.at, endAt: last.endAt, outcome: 'landed', messages: group.flatMap((s) => s.messages),
        ...(first.chrome === undefined ? {} : { chrome: first.chrome }),
        kind: 'text', text: value.field.value, replace: true,
      })
      continue
    }
    const fieldRead = focus.reason === 'secure' || focus.field?.secure ? 'secure' : 'unread'
    out.push(...group.map((s) => (s.kind === 'text' ? { ...s, fieldRead } as RawStep : s)))
  }
  return out
}

function worst(a: Outcome, b: Outcome): Outcome {
  if (a === 'refused' || b === 'refused') return 'refused'
  return a === 'unknown' || b === 'unknown' ? 'unknown' : 'landed'
}

const distance = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])

function touchStep(messages: TimedMessage[], outcome: Outcome): RawStep {
  const start = messages[0]!
  const { x, y, space } = (start.msg as Msg<'input:touch:start'>).payload
  const from: Point = [x, y]
  const moves = messages.filter((t) => t.msg.type === 'input:touch:move')
  const points = moves.map((t) => {
    const p = (t.msg as Msg<'input:touch:move'>).payload
    return { at: t.at, point: [p.x, p.y] as Point }
  })
  const durationMs = messages[messages.length - 1]!.at - start.at
  const base = { at: start.at, endAt: messages[messages.length - 1]!.at, outcome, messages, ...(space ? { space } : {}) }
  const firstAway = points.find((p) => distance(p.point, from) >= TAP_SLOP)
  if (!firstAway) {
    return durationMs >= LONG_PRESS_MS
      ? { ...base, kind: 'longPress', point: from, durationMs }
      : { ...base, kind: 'tap', point: from }
  }
  // The dashboard's end carries no point, so the last move is where the finger lifted.
  const to = points[points.length - 1]!.point
  return firstAway.at - start.at >= LONG_PRESS_MS
    ? { ...base, kind: 'holdDrag', from, to, durationMs }
    : { ...base, kind: 'swipe', from, to, durationMs }
}

function pinchStep(messages: TimedMessage[], outcome: Outcome): RawStep {
  const first = (messages[0]!.msg as Msg<'input:pinch:start'>).payload
  const moves = messages.filter((t) => t.msg.type === 'input:pinch:move')
  const last = moves.length > 0 ? (moves[moves.length - 1]!.msg as Msg<'input:pinch:move'>).payload : first
  return {
    at: messages[0]!.at, endAt: messages[messages.length - 1]!.at, outcome, messages,
    kind: 'pinch',
    start: [[first.f0.x, first.f0.y], [first.f1.x, first.f1.y]],
    end: [[last.f0.x, last.f0.y], [last.f1.x, last.f1.y]],
    durationMs: messages[messages.length - 1]!.at - messages[0]!.at,
    ...(first.space ? { space: first.space } : {}),
  }
}
