'use client';

import { Camera, FoldHorizontal, Link2, Loader2, Radio, RadioOff, RefreshCw, RotateCw, Square, UnfoldHorizontal, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useId, useState } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import type { NetworkUnavailableReason } from '@tapflowio/protocol';
import { Kbd, KbdGroup } from '@/components/ui/kbd';

/**
 * Every button this file renders carries an `aria-label` as well as a tooltip.
 *
 * They are icon-only — and lucide marks an icon with no a11y prop `aria-hidden`, in both the version
 * before this and after — while Radix attaches a tooltip's `aria-describedby` **only while it is
 * open**, which on touch is never. That is the same gap #447 named as the reason a disabled control
 * cannot explain itself, and until the network control needed a name to be found by, none of these
 * buttons had one: a screen reader read the whole toolbar as four unlabelled buttons.
 *
 * `navigationSlot`, `deviceSlot` and `launchSlot` arrive as `ReactNode` from the viewers, so their buttons are
 * labelled where they are built rather than here.
 */
function ShortcutTooltip({ label, keys }: { label: string; keys: string[] }) {
  return (
    <span className="flex items-center gap-3">
      {label}
      <KbdGroup>
        {keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
      </KbdGroup>
    </span>
  );
}

interface SimulatorToolbarProps {
  joined: boolean;
  onScreenshot: () => void;
  onRecordToggle: () => void;
  recordState: 'idle' | 'recording' | 'uploading' | 'done';
  onRotate: () => void;
  /** Foldable postures, ordered most closed → most open by the protocol's contract. The control
   *  renders only when there is more than one to choose between, so a device with a single fixed
   *  screen shows nothing and no platform check is needed to decide that. */
  posture?: {
    postures: ReadonlyArray<{ id: string; label: string }>;
    currentId: string | null;
    /** A change is in flight — the device has not answered yet. */
    pending: boolean;
    onSelect: (id: string) => void;
  };
  onDeepLink: () => void;
  /**
   * Platform buttons that move around the app or the OS — home, back, recent apps. Rendered in the
   * **Navigation** group. See `packages/dashboard/AGENTS.md` → "Where a new device button goes".
   */
  navigationSlot?: ReactNode;
  /**
   * Platform buttons that leave the device in a condition — the software keyboard, volume, sleep.
   * Rendered in the **Device** group, before rotate.
   */
  deviceSlot?: ReactNode;
  /** Optional launch button, first in the Navigation group. */
  launchSlot?: ReactNode;
  /** Network control (#607). Absent when the agent does not advertise `network-control`. */
  network?: NetworkControl;
  /**
   * Restart the device (#628). Rendered **last in the Device group** — it acts on the device like the
   * power button, and a group runs frequent → rare.
   *
   * `onReboot` is called only after the tester confirms; the dialog is here rather than at the caller
   * so every platform gets the same wording for the same irreversible thing.
   *
   * `buttonRef` is how focus finds its way back. The restart is the only control here that unmounts
   * the toolbar it was pressed from, so a keyboard user is left on `document.body` while the device
   * comes back; `DeviceViewer` puts them on this button again once it returns.
   */
  reboot?: { pending: boolean; onReboot: () => void; buttonRef?: MutableRefObject<HTMLButtonElement | null> };
}

export interface NetworkControl {
  position: 'waiting' | 'unknown' | 'online' | 'offline';
  /** Whether tapflow can still change it. Separate from where it is, because the protocol makes them
   *  separate — a device it can no longer steer still has a network state, and still shows it. */
  steerable: boolean;
  /** Why it cannot be steered, straight off the wire. `undefined` whenever `steerable` is true.
   *
   *  **This carried one boolean — `awaitingApp` — and the reason it did was about the wire, not about
   *  this component.** Every Android read failure used to arrive as `unsupported-device`, so naming a
   *  reason meant telling a tester "this will never work" about a rebooting device, and the one
   *  member that conflated nothing was the only one worth reading. The set has been split (#618), so
   *  each member now carries a remedy that differs, and a sentence per remedy is the whole point of a
   *  closed set.
   *
   *  A member this build has never heard of still has to render: agents update on their own schedule,
   *  so the switch below carries a `default` rather than trusting the union. */
  reason?: NetworkUnavailableReason;
  pending: boolean;
  onToggle: () => void;
}

/**
 * Muted, **and pinned against hover**.
 *
 * The `ghost` variant carries `hover:text-accent-foreground`, which outranks a plain
 * `text-muted-foreground` — so pointing at the control repainted it as an ordinary enabled button and
 * the state vanished exactly while someone was looking at it. The offline position already defends
 * itself this way (`hover:text-amber-500`); the three muted positions did not, and the one that is
 * reachable on every iOS session before an app is launched is among them.
 *
 * A constant rather than the string three times: the failure here was one branch remembering and
 * three forgetting, so a fourth position cannot be added without carrying the pin.
 *
 * Only the text is pinned. The background still lights up on hover, because these positions stay
 * clickable — the paragraph below is about why.
 */
const MUTED = 'text-muted-foreground hover:text-muted-foreground';

/**
 * A control tapflow cannot currently steer, pinned the same way.
 *
 * **It says the control is unusable now, and the sentence beside it says what to do.** The colour
 * used to carry the whole claim and had to hedge: every Android read failure arrived as
 * `unsupported-device` (#618), a rebooting device included, so there was no member the dashboard
 * could translate into anything specific. The set has been split, so the *remedy* now lives in the
 * reason — restart the device, launch an app, try again, go and ask whoever runs the Mac — and one
 * colour serving all of them is a deliberate choice rather than the only honest option. It stays one
 * colour because `networkLook` has two ternaries and a second failure colour would have to be
 * invented for a distinction the sentence already makes.
 *
 * **Permanence is deliberately not what any of this encodes.** Only `filter-unavailable` is a state
 * no click can leave, and that one is about the Mac rather than the device.
 *
 * It deliberately excludes `awaitingApp`, which resolves itself the moment an app starts: colouring
 * the ordinary opening seconds of every iOS session as an error is how a colour stops meaning
 * anything by the time a real failure uses it.
 *
 * **One rule at both settled positions — and deliberately not at the other two.** This started at
 * `online` only, leaving an unsteerable *offline* device drawn in amber at 60%: the same washed-out
 * rendering that sent this control back for rework in the first place, in another hue, and it read
 * as disabled on a button that still works.
 *
 * `waiting` and `unknown` stay muted however `steerable` reads, on the argument `networkAction` makes
 * below for refusing `Retry:` there — a position-less state has had no attempt, so drawing one as a
 * failure claims something no channel can explain, in the opening seconds of every session.
 *
 * What is left carrying the position at the two that do take this colour is **the icon, and only the
 * icon**, for a sighted mouse or touch user: the status sentence is `sr-only` and the tooltip does
 * not open on touch. `Radio` against `RadioOff` is a real difference and it is asserted in the tests
 * rather than assumed, because unifying them would silently remove the last channel.
 */
const FAILED = 'text-destructive hover:text-destructive';

/**
 * What the tester does next, one sentence per reason.
 *
 * **Every branch names an action they can take**, which is what the reason set exists for — a member
 * per thing a consumer must do differently. Where there is nothing they can do, it says so plainly
 * rather than implying a retry.
 *
 * `filter-unavailable` names the guide instead of linking to it. A link needs a surface, and the two
 * this control has are a tooltip that never opens on touch and an `sr-only` string; putting an anchor
 * in either is worse than a sentence that can be searched for. The destination exists —
 * `docs/testing/network-control.md`, and the setup steps it points at.
 */
function reasonCaveat(reason: NetworkUnavailableReason | undefined): string {
  switch (reason) {
    case 'awaiting-app':
      return ' Launch an app through tapflow so it is told too.';
    case 'not-armed':
      return ' Restart the device so tapflow can set it up.';
    case 'state-unconfirmed':
      return ' tapflow could not confirm the change — try again.';
    case 'unsupported-device':
      // Says what happened, not how long it lasts. The device answered and had not moved, and nothing
      // measured says whether that is a policy that will not budge or a rule that had not landed yet —
      // so this offers the retry and names the fallback instead of declaring the device incapable.
      return ' The device did not change when tapflow asked — try again, or use another device.';
    case 'filter-unavailable':
      return ' This Mac is not set up to take devices off the network — see the network control guide.';
    case 'enforcement-lost':
      // **Short, because the toast carries this one.** `onError` renders `role="alert"`, which
      // interrupts the polite `role="status"` region beside it in the same commit — so saying the
      // whole thing twice drops the position half for anyone who hears the alert first, and repeats
      // the sentence for anyone who hears both.
      return ' It went back on the network on its own.';
    case 'hooks-not-installed':
      return ' tapflow cannot tell this app it is off the network.';
    default:
      // An agent newer than this build. Says the one thing that is true of every member without
      // guessing which: it cannot be changed from here right now.
      return ' tapflow cannot change it right now.';
  }
}

/**
 * Four positions, and **none of them disables the button**.
 *
 * #447 settled that a control nothing acts on should be absent rather than disabled, because a
 * disabled control owes a reason and the only channel here is a tooltip, which never opens on touch.
 * That reasoning holds for a gate known before the control renders and fixed for the session — which
 * is what `full-reset` is, and what this is not. An unreadable network state arrives *after* the
 * control is on screen and can change while it is there, and hiding it then would be a trap: the
 * click is the only thing that produces a fresh `network:state`, so a control that vanishes when the
 * state goes unreadable can never come back.
 *
 * So `waiting` and `unknown` stay clickable, and neither is drawn in a position. They differ from
 * each other because saying "could not read" about a device that is merely slow is a claim made
 * before anything was asked.
 */
function networkLook({ position, steerable, reason }: Pick<NetworkControl, 'position' | 'steerable' | 'reason'>) {
  // Derived rather than passed, so the colour rules below read exactly as they did when this was a
  // prop. Nothing about which states are drawn as failures has changed here.
  const awaitingApp = reason === 'awaiting-app';
  // **Uncertainty is said with the pulse, not with the position.** `state-unconfirmed` means the
  // round trip failed, so where the device is, is the last thing anyone confirmed. Rendering that as
  // a position of `unknown` was tried and reverted: from `unknown` every click asks for offline
  // again, so a device taken offline could not be brought back through the UI. The pulse already
  // means "we are not sure yet" at `waiting`, and it leaves both the position and the colour alone.
  //
  // **Gated on `steerable` like the sentence below, and not on the reason alone.** This file takes the
  // two as independent props and says so, and a pulse derived from `reason` by itself renders
  // `{ steerable: true, reason: 'state-unconfirmed' }` as a permanently pulsing button whose status
  // text says only "Device is on the network" — uncertainty in CSS and in no channel a screen reader
  // can reach.
  const unsure = !steerable && reason === 'state-unconfirmed' ? ' animate-pulse' : '';
  // Said after the position, never instead of it. A device tapflow cannot steer is still somewhere,
  // and an earlier draft that replaced the position with "could not be read" made the control a
  // one-way ratchet — from that rendering every click asked for offline again, so a device taken
  // offline on an unconfirmed write could not be brought back.
  // Three sentences where there was one, because the remedies differ. "tapflow can no longer change
  // it" was said for all of them, and for the waiting-for-an-app state it was wrong twice over:
  // nothing had been armed, so there was no "no longer", and clicking does change the device.
  //
  // **A sentence per remedy, and no implementation words in any of them.** A tester reading these is
  // not going to install a system extension or a hook; what they can do is launch an app, restart a
  // device, try again, or go and ask whoever runs the Mac. Naming the machinery would describe our
  // problem in place of their next step.
  const caveat = steerable ? '' : reasonCaveat(reason);
  switch (position) {
    case 'offline':
      // The only position with colour. It is a state a tester deliberately put the device into and
      // will forget about, and forgetting is what makes the next hour of testing confusing.
      return {
        Icon: RadioOff,
        // Still amber while waiting for an app: the device really is offline, which is the thing this
        // colour is for. An unsteerable control overrides it, and `RadioOff` is then the only thing
        // left saying offline — see `FAILED`.
        className: (steerable || awaitingApp ? 'text-amber-500 hover:text-amber-500' : FAILED) + unsure,
        status: `Device is offline.${caveat}`,
      };
    case 'online':
      return {
        Icon: Radio,
        className: (steerable || awaitingApp ? '' : FAILED) + unsure,
        status: `Device is on the network.${caveat}`,
      };
    case 'waiting':
      return { Icon: Radio, className: `${MUTED} animate-pulse`, status: 'Checking the network state.' };
    case 'unknown':
      return { Icon: Radio, className: MUTED, status: 'No network state has been reported.' };
  }
}

/**
 * What activating the button does from here — which is the button's name.
 *
 * **`aria-pressed` was tried and dropped.** A toggle can carry its state either in a stable name plus
 * `aria-pressed`, or in a name that says the next action; saying both makes "Take device offline,
 * pressed" — two grammars for one fact, and the second of them wrong.
 *
 * **And the two unreadable positions get a name with no direction in it.** "Take device offline"
 * there would assert the device is currently online, which is the same claim-from-silence that
 * `aria-pressed={false}` was dropped for — it does not stop being that claim by moving from the state
 * into the name. The pulse and the muted colour say "we do not know" to everyone who can see them;
 * this is what says it to everyone else, and unlike the description beside it a name cannot be
 * turned off by a verbosity setting.
 */
function networkAction({ position, steerable, reason }: Pick<NetworkControl, 'position' | 'steerable' | 'reason'>) {
  const action = position === 'offline' ? 'Bring device online'
    : position === 'online' ? 'Take device offline'
      : 'Toggle device network';
  // **The caveat goes in the name, not only in the description.** A device tapflow has just said it
  // cannot steer still gets a name that promises the action, and the correction lived in the
  // `aria-describedby` sentence — the very channel the paragraph above calls unreliable, since a
  // verbosity setting can drop it. "Retry" is honest where it is offered: the last attempt did not
  // land, and clicking will try again.
  // **Only where there is an attempt to retry.** `steerable` is about a report that came back, and a
  // position-less state has had none — so prefixing there would assert a failed attempt that no
  // channel explains, which is the claim-from-silence the rest of this file is built to avoid. The
  // combination is unreachable through `useNetworkControl`, where any report settles the position;
  // this component takes the two as independent props and has to be right on its own terms.
  // `awaiting-app` keeps the plain name too. "Retry" claims a previous attempt that did not land, and
  // waiting for an app is not a failed attempt — it is a click that will work, on a device nobody has
  // opened an app on yet.
  //
  // **And the prefix is now scoped to the reasons a retry can land on.** Its justification said so
  // explicitly — "not futile *while #618 leaves a transient failure indistinguishable from a
  // permanent one*" — and #618 split enough of them to make the scoping possible. Offering "Retry" on
  // a Mac that is not set up for this, on a device waiting for a reboot, or on hooks that proved they
  // did not take, recommends a click that cannot work.
  //
  // **`unsupported-device` keeps it, and that is a correction.** Dropping it there assumed the new,
  // narrow meaning — the device was read and had not moved — is permanent, and nothing measured says
  // so: a policy restriction is permanent, a rule that had not propagated yet is not, and the signal
  // cannot tell them apart. Worse, an agent older than this build still sends that literal for every
  // transient failure, and there is no version on the wire to tell the two apart — so removing the
  // affordance reproduced exactly the #618 regression for anyone running a new relay against an agent
  // they installed earlier.
  //
  // **And what is left over needs a marker of its own.** Narrowing the prefix left four reasons with a
  // plain actionable name on a button drawn in the failure colour: colour became the only channel that
  // said it would not work, and colour is exactly the channel a screen-reader user does not have. The
  // description says it, and the paragraph above is about why that channel cannot be relied on alone.
  const settled = position === 'online' || position === 'offline';
  const retryable = reason === 'state-unconfirmed' || reason === 'unsupported-device';
  //
  // **`awaiting-app` is excluded from both**, and that is the same exception it has always had here.
  // Traffic control works in that state — a device taken offline really does stop reaching the
  // network — so neither "Retry" nor "unavailable" is true of it. What is missing is only that the app
  // is told, which the sentence says.
  if (steerable || !settled || reason === 'awaiting-app') return action;
  return retryable ? `Retry: ${action.toLowerCase()}` : `${action} — unavailable`;
}

export function SimulatorToolbar({
  joined,
  onScreenshot,
  onRecordToggle,
  recordState,
  onRotate,
  posture,
  onDeepLink,
  navigationSlot,
  deviceSlot,
  launchSlot,
  network,
  reboot,
}: SimulatorToolbarProps) {
  // Per instance, not a literal: this component takes all its state through props and is rendered per
  // device viewer, so two toolbars on screen would point both buttons' `aria-describedby` at the first
  // span — one device's control described by another device's network state. The unit tests render one
  // toolbar at a time and cannot see that.
  const descId = useId();
  const rebootStatusId = useId();
  const postureStatusId = useId();
  const recordStatusId = useId();
  // Controlled rather than an `AlertDialogTrigger`, because the button it would wrap is already
  // wrapped by a `TooltipTrigger asChild` — two libraries cloning the same child and both wanting to
  // own its ref and its handlers. `BuildRow` drives its dialog the same way.
  const [confirmingReboot, setConfirmingReboot] = useState(false);
  if (!joined) return null;

  return (
    <TooltipProvider delayDuration={400}>
      {/*
        * **Four groups, by what the tester is doing to the device (#634).**
        *
        *   Navigation → Device → Capture → Environment
        *
        * and inside each, the ones reached for most come first. The rule and its worked examples live
        * in `packages/dashboard/AGENTS.md` → "Where a new device button goes"; it is written down
        * there rather than here because the question it answers — *where does this new button go* —
        * gets asked by someone who has not opened this file yet.
        *
        * The order is the same on both platforms, which is the point: a tester moving between iOS and
        * Android finds rotate at the end of Device and the network control alone in Environment on
        * both. That used to be a coincidence — Android's buttons were rendered in whatever order the
        * agent's capability list happened to be in.
        *
        */}
      <div className="flex flex-col items-center gap-0.5 rounded-2xl border bg-background/90 backdrop-blur-sm px-1.5 py-2.5 shrink-0 mt-3">
        {/*
          * **`role="group"` and not only a line, because the grouping is the feature.**
          *
          * The dividers are `<div>`s with a background colour: to a screen reader or voice control
          * they are nothing, so without these the four groups this change exists to create are one
          * flat run of icon buttons. Not `role="toolbar"` on the container — that promises the APG
          * roving-tabindex arrow-key model, which is not implemented here.
          *
          * **A real box, not `display: contents`.** An element that generates no box has been dropped
          * from the accessibility tree along with its role and name — still reproducible in
          * WebKit/VoiceOver for explicitly-roled generics — so `contents` would have left the grouping
          * exactly as absent as the bare dividers it replaces. The test below cannot catch that:
          * jsdom evaluates no CSS, so `getAllByRole('group')` passes either way.
          */}
        <div role="group" aria-label="Navigation" className="flex flex-col items-center gap-0.5">
          {launchSlot}
          {navigationSlot}

        <Tooltip>
          <TooltipTrigger asChild>
            {/* A deeplink is "go to this screen", which is why it is here and not with the tools. */}
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open a deeplink" onClick={onDeepLink}>
              <Link2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><ShortcutTooltip label="Deeplink" keys={['⌘', 'K']} /></TooltipContent>
        </Tooltip>

        </div>

        {/* ── Device: leave the device in a condition ────────────────────────────── */}
        <div role="separator" aria-orientation="horizontal" className="w-4 h-px bg-border my-1" />

        <div role="group" aria-label="Device" className="flex flex-col items-center gap-0.5">
          {deviceSlot}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Rotate the device" onClick={onRotate}>
              <RotateCw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><ShortcutTooltip label="Rotate" keys={['⌘', '⇧', 'O']} /></TooltipContent>
        </Tooltip>

        {/* The outcome of a fold is otherwise conveyed only by pixels — the spinner swapping back
            and the picture returning — so it is announced, as reboot, recording and network already
            are. `polite` because a posture change is something the user asked for and is waiting on,
            not an interruption. */}
        {posture && posture.postures.length === 2 && (
          <span id={postureStatusId} role="status" aria-live="polite" className="sr-only">
            {posture.pending
              ? 'Changing posture'
              /* **Never empty, or the fold is announced as starting and never as finishing.**
                 `currentId` is null when the device reports a posture tapflow cannot name, and a
                 live region emptied back out says nothing at all — so a screen-reader user heard
                 "Changing posture" and then silence, while the spinner turning back into an icon
                 told everyone else it was over. That is the success-is-silent shape the network
                 control below is written to avoid.

                 **A state, not a completion**, because this span is also the button's
                 `aria-describedby` target and so is read on focus. "Posture changed" was tried and
                 asserts a change to someone who has tabbed to the button and pressed nothing — and
                 keeps asserting it for the rest of the session. Naming the state is true at rest
                 *and* still carries the ending: the region goes from "Changing posture" to this,
                 and a change is what a live region announces. */
              : (posture.postures.find((p) => p.id === posture.currentId)?.label ?? 'Current posture unknown')}
          </span>
        )}
        {/* **Exactly two, which is all any device offers today, and the gate says so.** A toggle is
            right for two: opening a menu to pick the only other option is a click for nothing. The
            radio menu that used to stand behind this for three or more was unreachable —
            `android-agent`'s `KNOWN` table has two entries and `parsePostures` filters it, so the
            wire carries 0, 1 or 2, and iOS sends none.

            It is `=== 2` rather than `> 1` so that a third entry added to that table does not
            silently fall into `(at + 1) % length` and start *cycling*, which is the behaviour the
            menu existed to avoid: `HALF_OPENED` and `OPENED` present the same screen on a Pixel 9
            Pro Fold, so a step between them changed nothing visible and read as a press that had
            been dropped. A third posture makes this control disappear instead, which is noticed,
            and whoever adds it decides what replaces the toggle. */}
        {posture && posture.postures.length === 2 && (() => {
          const at = posture.postures.findIndex((p) => p.id === posture.currentId);
          const current = at === -1 ? null : posture.postures[at];
          const other = posture.postures[(at + 1) % 2]!;
          // **The icon says what pressing does, like every other button in this toolbar.** The
          // list runs most closed → most open, so a destination further along it opens the device
          // and one before it closes it. A menu has no single destination, so it asks the weaker
          // question the same way round: from the most closed posture the only move is to open.
          // An unknown current posture falls to Fold, which is where the destination
          // (`postures[0]`, the most closed) actually points.
          const opening = at === 0;
          const PostureIcon = opening ? UnfoldHorizontal : FoldHorizontal;
          // **And the name says the same thing the icon does.** It used to open with `Fold:`
          // whichever way the press went, so someone reading the name alone — a screen reader, or
          // voice control speaking the label — was told a folded device would fold again, while
          // the icon beside it offered to unfold. The verb is the one fact both have to share.
          const verb = opening ? 'Unfold' : 'Fold';
          const label = current ? `${verb}: ${current.label} to ${other.label}` : `${verb}: ${other.label}`;
          const trigger = (onClick?: () => void) => (
            <Button
              variant="ghost" size="icon" className="h-8 w-8 aria-disabled:opacity-50"
              aria-label={posture.pending ? `${label} — changing` : label}
              aria-busy={posture.pending}
              // `aria-disabled`, not `disabled`: this button's name changes at the moment it is
              // pressed, and `disabled` takes the focused element out of the tab order so the new
              // name is announced to nobody — and `aria-describedby` cannot be heard on a control
              // that can no longer be focused, which is the one moment it has something to say.
              // The restart, recording and network controls in this file each avoid the same
              // shape (#447, #624); this one did not, and the refusal lives in the guard below.
              aria-disabled={posture.pending}
              aria-describedby={postureStatusId}
              onClick={() => { if (!posture.pending) onClick?.(); }}
            >
              {posture.pending
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <PostureIcon className="h-4 w-4" />}
            </Button>
          );
          // The refusal while a change is in flight is the guard inside `trigger`, not an absent
          // handler: `aria-disabled` does not stop a press on its own, and `disabled` would take
          // the button out of the tab order at the one moment its name has something new to say.
          return (
            <Tooltip>
              <TooltipTrigger asChild>{trigger(() => posture.onSelect(other.id))}</TooltipTrigger>
              <TooltipContent side="left">{posture.pending ? `${label} — changing` : label}</TooltipContent>
            </Tooltip>
          );
        })()}

        {reboot && (() => {
          // **One string, two channels, so they cannot drift apart.** The tooltip is the visible
          // label and the `aria-label` is the accessible name, and WCAG 2.5.3 wants the first
          // contained in the second — "Restart device" against "Restart the device" is not, so
          // voice control saying the visible words could miss the button. Written as two literals
          // they had already disagreed outright while pending: the name changed and the tooltip did
          // not. The other controls in this file hold the same rule by branching both together;
          // this one holds it by having nothing to branch.
          const rebootLabel = reboot.pending ? 'Restarting the device' : 'Restart the device';
          return (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={reboot.buttonRef}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={rebootLabel}
                  aria-busy={reboot.pending}
                  // `aria-disabled`, not `disabled`: a disabled button is removed from the tab order and
                  // stops being describable, so the one moment it has something to say is the moment it
                  // cannot say it. #447 is where that was measured; the click guard is below.
                  aria-disabled={reboot.pending}
                  aria-describedby={rebootStatusId}
                  onClick={() => { if (!reboot.pending) setConfirmingReboot(true); }}
                >
                  {/* **Not `Power`, which Android's own power key already uses.** They sit two apart in
                      this same group and the glyph was byte-identical — one blanks the screen, the
                      other throws away everything on the device.
                      `RefreshCw` is next to `RotateCw` and that is accepted rather than missed: the
                      silhouettes differ where it counts, a closed loop with two heads against an open
                      arc with one, and it is the glyph people already read as "start this again".
                      `RotateCcwSquare` was tried first and is worse — it *depicts* a rotation, so next
                      to the rotate button it moves the confusion instead of ending it. */}
                  {reboot.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{rebootLabel}</TooltipContent>
            </Tooltip>
            <span id={rebootStatusId} role="status" className="sr-only">
              {reboot.pending ? 'Restarting the device.' : ''}
            </span>
          </>
          );
        })()}

        </div>

        {/* ── Capture: take the current state out of the session ───────────────── */}
        <div role="separator" aria-orientation="horizontal" className="w-4 h-px bg-border my-1" />

        <div role="group" aria-label="Capture" className="flex flex-col items-center gap-0.5">

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Take a screenshot" onClick={onScreenshot}>
              <Camera className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><ShortcutTooltip label="Screenshot" keys={['⌘', 'S']} /></TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost" size="icon"
              className={cn('h-8 w-8 aria-disabled:opacity-50', recordState === 'recording' && 'text-red-500 hover:text-red-500')}
              // The name carries the state, so `aria-pressed` would say it twice — "Stop recording,
              // pressed" states the same fact in two grammars and reads as a contradiction. Pick one:
              // this button flips its name, so it is a plain action button.
              //
              // **All four states, not just `recording`.** While disabled it announced "Start
              // recording, unavailable" — the wrong action and no reason — and the tooltip cannot
              // supply one, because a disabled button suppresses pointer events so Radix never opens
              // it. The same #447 gap the network control above is built around.
              aria-label={
                recordState === 'recording' ? 'Stop recording'
                  : recordState === 'uploading' ? 'Processing the recording'
                    : recordState === 'done' ? 'Recording saved'
                      : 'Start recording'
              }
              aria-busy={recordState === 'uploading'}
              // `aria-disabled`, not `disabled`: activating "Stop recording" turned the focused
              // button non-focusable, so focus fell to `<body>` and the name change was announced
              // to nobody. Same shape as the restart and network controls; the guard is below.
              aria-disabled={recordState === 'uploading' || recordState === 'done'}
              // Both on purpose: the live region fires once, when the state changes; the description
              // is what a user who tabs to the button afterwards gets. Some screen readers read both
              // while the button is focused, which is the cheaper failure.
              aria-describedby={recordStatusId}
              onClick={() => { if (recordState === 'idle' || recordState === 'recording') onRecordToggle(); }}
            >
              {recordState === 'uploading'
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : recordState === 'recording'
                ? <Square className="h-4 w-4 fill-current" />
                : <Video className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {recordState === 'idle'
              ? <ShortcutTooltip label="Start recording" keys={['⌘', '⇧', 'Y']} />
              : recordState === 'recording'
              ? <ShortcutTooltip label="Stop recording" keys={['⌘', '⇧', 'Y']} />
              // The same four branches as the name above. Collapsing `uploading` and `done` here left
              // the two channels disagreeing for `done` — "Recording saved" read out, "Processing…"
              // on screen — which is stale for a sighted user and a Label-in-Name mismatch the moment
              // this trigger becomes hoverable (#624).
              : recordState === 'done' ? 'Recording saved' : 'Processing the recording'}
          </TooltipContent>
        </Tooltip>
        {/* `uploading` and `done` arrive asynchronously, and a name change on a focused button is not
            re-announced — so without this a screen-reader user hears the recording start and never
            hears that it was saved. Mounted unconditionally with only the text toggled, as the
            network control's region is. */}
        <span id={recordStatusId} role="status" className="sr-only">
          {recordState === 'recording' ? 'Recording.'
            : recordState === 'uploading' ? 'Processing the recording.'
              : recordState === 'done' ? 'Recording saved.' : ''}
        </span>

        </div>

        {/* ── Environment: change what the device is sitting in ─────────────────── */}
        {/* Rendered with its contents or not at all: an agent that does not advertise
            `network-control` would otherwise leave a named, empty group behind a separator, so AT
            announces a boundary and a section that holds nothing. */}
        {network && (
        <>
        <div role="separator" aria-orientation="horizontal" className="w-4 h-px bg-border my-1" />

        <div role="group" aria-label="Environment" className="flex flex-col items-center gap-0.5">

        {network && (() => {
          const { Icon, className, status } = networkLook(network);
          const label = networkAction(network);
          // Whether the *visible* tooltip needs the sentence too. A settled, steerable position says
          // enough in the name; the two with no position and the ones tapflow cannot change do not,
          // and a tooltip carrying a sentence for every position would be noise on the common one.
          // `awaitingApp` counts here even though it keeps a normal colour and a plain name: the
          // whole point of that state is that the sentence carries what the rendering does not.
          const unsettled = network.position === 'waiting' || network.position === 'unknown' || !network.steerable;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost" size="icon"
                  className={cn('h-8 w-8', className)}
                  aria-label={label}
                  // The icon is swapped for a spinner and the live region says so once — neither is a
                  // property AT can query on the control, and `toggle` refuses a click for as long as
                  // this lasts, which is up to `NETWORK_REQUEST_DEADLINE_MS`.
                  aria-busy={network.pending}
                  // `aria-busy` is a hint that content is updating; NVDA, JAWS and VoiceOver do not
                  // read it as unavailability on a button. Without this the control still presents
                  // itself as fully actionable while `toggle` refuses every click, so a screen-reader
                  // user activates it repeatedly and nothing happens or is said. `aria-disabled`
                  // rather than `disabled`: that would suppress the tooltip trigger and drop focus,
                  // which is #624's shape — and the reason a disabled control owes is already in the
                  // live region beside it.
                  aria-disabled={network.pending}
                  aria-describedby={descId}
                  // Enforced here, not only announced here. `aria-disabled` said the control was
                  // unavailable while the refusal lived in `useNetworkControl.toggle` — a state in
                  // ARIA and not in behaviour, which is the mirror of a state in CSS and not in ARIA.
                  // Same reason as the `Retry:` scoping above: this takes its state as props and has
                  // to hold on its own terms, whichever viewer supplies the handler.
                  onClick={() => { if (!network.pending) network.onToggle(); }}
                >
                  {network.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              {/* The two positions the button cannot draw say why, and say it **outside the tooltip**:
                  Radix attaches a tooltip's own `aria-describedby` only while it is open, and on touch
                  it never opens — the same gap #447 named as the reason a disabled control cannot
                  explain itself. The colour and the pulse say it to everyone else.
                  `role="status"` because the sentence *changes on screen* — `useNetworkControl` flips
                  `waiting` to `unknown` on a timer — and a description that changes on an element
                  nobody is focused on is announced by no AT at all.
                  **Every position has a sentence, including the settled ones.** Clearing this to empty
                  on success announced nothing, so a screen-reader user heard the request begin and
                  never heard it finish — the failure path was announced and success was the silent
                  one. A name change on an already-focused button is not reliably re-announced, so the
                  name could not carry it either. */}
              {/* **Mounted unconditionally, with only the text toggled.** A live region inserted in the
                  same commit as its first sentence is routinely dropped by NVDA, JAWS and VoiceOver —
                  which would have silenced exactly the one case that replaced `aria-busy`, since
                  `online → pending` is where the region would have appeared. */}
              <span id={descId} role="status" className="sr-only">
                {network.pending ? 'Changing the network state.' : status}
              </span>
              {/* The visible text contains the accessible name (WCAG 2.5.3): a voice-control user says
                  what the tooltip shows, and the status is appended rather than substituted. */}
              <TooltipContent side="left">{unsettled ? `${label} — ${status}` : label}</TooltipContent>
            </Tooltip>
          );
        })()}
        </div>
        </>
        )}
      </div>

      {/* **Outside the toolbar's column**: Radix portals the open dialog, and an `AlertDialog` that
          is closed renders nothing — but leaving the element inside a `role="group"` would still put
          it in that group's accessibility subtree while it is open. */}
      {reboot && (
        <AlertDialog open={confirmingReboot} onOpenChange={setConfirmingReboot}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Restart this device?</AlertDialogTitle>
              {/* Says what is lost rather than that something is. A tester who has spent ten minutes
                  reaching a screen is deciding whether to spend them again, and "this cannot be
                  undone" does not tell them that. Apps and their data survive — this is a restart,
                  not the wipe the selector screen offers. */}
              <AlertDialogDescription>
                Anything open on the device closes, and whatever you had set up on screen is gone.
                Installed apps and their data stay. The device takes a moment to come back.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmingReboot(false);
                  reboot.onReboot();
                }}
              >
                Restart
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </TooltipProvider>
  );
}
