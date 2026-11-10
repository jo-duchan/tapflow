import type { FragileReason, RangeWarning, SkipReason } from '@tapflowio/flow-runner/browser'

/**
 * Every word Flow Capture's dialog says (#1125), in one place: the design is still moving, and a change of wording
 * should be one file's diff. Tests find controls by these same strings.
 */
export const copy = {
  title: 'Capture flow',
  // The dialog's description for every step: Match's own help was read out on Range, Edit and Export too.
  description: 'Turn the steps you took on this device into a flow file, replayed and checked on the device first.',
  progressLabel: 'Progress',
  steps: ['Range', 'Match', 'Edit', 'Verify', 'Export'],
  cancel: 'Cancel',
  close: 'Close',

  loading: 'Reading the steps you took…',
  nothingCaptured: 'No steps have been captured on this device yet. Turn on “Capture my steps” and test as usual.',

  rangeHeading: 'Which part of the session is the flow?',
  rangeHelp: 'Starts at the last clean launch, ends at your last step. Drag the handles to change it.',
  rangeStrip: 'Steps',
  rangeStart: 'Start of the flow',
  rangeEnd: 'End of the flow',
  rangeHandleText: (n: number, label: string) => `#${n}, ${label}`,
  rangeCount: (n: number, from: number, to: number) => `${n} ${n === 1 ? 'step' : 'steps'} · #${from} – #${to}`,
  trim: 'Trim:',
  dropFirst: 'drop first',
  dropLast: 'drop last',
  nameLabel: 'Name',
  tagsLabel: 'Tags',
  tagsHint: 'Optional. Separate with commas.',
  appPrefix: 'App:',
  appSuffix: ', from this build',
  noBundleId: 'This build’s bundle id could not be read, so the flow will not clear the app’s data before it starts.',
  // What a run's reset does on each platform (#1139), so the person knows before it wipes their own QA device.
  replayNoticeTitle: 'Continuing resets this device the way tapflow flow run does, then replays from there.',
  replayNotice: {
    ios: 'The app is reinstalled, and the keychain, privacy permissions, clipboard and location are reset for every app on the device, so other apps are signed out too. The device goes back online and upright.',
    android: 'The app’s data is cleared and the device goes back online. On an emulator the clipboard is emptied and the device turned upright too.',
  },
  resetDone: (items: string) => `Reset before the replay: ${items}.`,
  resetFailed: (items: string) => `Could not reset: ${items}. The replay went on, and these may still hold what was left on the device.`,
  // At most the app's data: a build whose bundle id was not read has none to clear.
  resetUnsupported: 'This device’s tapflow agent cannot reset it the way a run does. Update tapflow on that Mac.',
  resetting: 'Resetting the device…',
  resetItems: {
    'app-reinstall': 'app reinstall', 'app-data': 'app data', 'app-files': 'app files', 'app-uninstall': 'app removal',
    keychain: 'keychain', 'privacy-services': 'privacy permissions', pasteboard: 'clipboard', location: 'location',
    network: 'network', orientation: 'orientation',
  } as Record<string, string>,
  rangeWarnings: {
    'no-launch-at-start': 'The flow adds its own launch. Move the start past any tap on the home screen.',
    'no-clean-start': 'The app wasn’t cleared before this launch, so these steps ran on leftover data.',
  } satisfies Record<RangeWarning, string>,
  askedLabel: (step: number) => `Password for step ${step}`,
  askedHint: 'tapflow can’t read password fields. Used for this replay only, never saved.',
  askedPrefilledHint: 'Filled in from what you typed on your computer’s keyboard. Change it if part of it was typed on the on-screen keyboard.',
  typedBeforeRange: 'Nothing had focus to type into. The field was likely focused before this range starts — start the range at the tap on it.',
  screenKeyboardAdvice: 'On-screen keyboard used: your computer’s keyboard replays more reliably.',
  continue: 'Continue',

  matching: (done: number, total: number) => `Step ${done} of ${total}`,
  matchingHelp: 'tapflow is replaying your steps on the device and naming what each one touched.',
  stop: 'Stop',
  restart: 'Start again',
  editWhatMatched: 'Edit what matched',
  matchStopped: 'The replay stopped.',

  editHeading: (n: number) => `${n} steps`,
  removeStep: (label: string) => `Remove ${label}`,
  stepDetails: (label: string) => `Details of ${label}`,
  fragile: 'fragile',
  auto: 'auto',
  skipped: 'not in the flow',
  secret: 'secret',
  fragileReasons: {
    'no-element': 'Nothing on the screen is named at this point, so the flow taps the point itself.',
    'no-selector': 'The element here cannot be named alone, so the flow taps the point itself.',
    'not-centre': 'Tapping the element’s centre would land somewhere else, so the flow taps the point itself.',
    swipe: 'A swipe replays its two ends at the speed it was made, not what it brought on screen.',
    'field-unread': 'The field could not be read after typing, so this is the keys as typed on a US keyboard. Check the text.',
    'keyboard-unknown': 'tapflow could not tell whether this touched a key on the on-screen keyboard or the app. Remove it if it was a key.',
  } satisfies Record<FragileReason, string>,
  skipReasons: {
    refused: 'The device refused this input.',
    'hold-drag': 'A drag after a long press cannot be said in a flow.',
    'held-button': 'A held button cannot be said in a flow.',
    'too-long': 'Held longer than a flow allows (60 seconds).',
    'no-pinch': 'The fingers moved but the scale hardly changed.',
    'orientation-unknown': 'The device did not report which way it ended up.',
    'posture-between': 'A flow can fold or unfold fully, not stop between.',
    install: 'The run installs the build itself.',
    network: 'A flow cannot switch the network.',
    cut: 'A flow cannot cut text.',
    keyboard: 'The on-screen keyboard toggle is not a flow step.',
    'keyboard-key': 'A key on the on-screen keyboard. What it typed could not be read, so it is not in the flow. Type with your computer’s keyboard for text the flow can replay.',
  } satisfies Record<SkipReason, string>,
  autoReason: 'Turned into a scroll to the element the next step taps.',
  secretLabel: 'Secret name',
  secretHint: 'Letters, digits and _, not starting with a digit. The value is read from this environment variable when the flow runs.',
  secretInvalid: 'Use letters, digits and _ only, and do not start with a digit.',
  secretTaken: 'Another secret already has this name.',
  showYaml: 'Show YAML',
  hideYaml: 'Hide YAML',
  yamlLabel: 'Flow YAML',
  verifyAndExport: 'Verify and export',
  backToRange: 'Back to Range',

  verifyHeading: 'Verify',
  verifyHelp: 'Runs the flow on this device with selectors only — the same way tapflow flow run will.',
  verifying: (done: number, total: number) => `Running step ${done} of ${total}`,
  passed: 'Passed. The flow ran on this device with selectors only, the way tapflow flow run will.',
  failed: 'The flow failed on this device.',
  stepStatus: { running: 'running', passed: 'passed', failed: 'failed', skipped: 'not run' },
  suggestionsHeading: 'On that screen, one of these would select it:',
  /** A touch Verify saw change nothing (#1125): an overlay the tree does not show may have taken it. */
  touchChangedNothing: 'Nothing on the screen changed after this touch, so a run cannot check that it lands. If it should have changed something, something may be covering what it touches.',
  /** What a run looks for after this touch, written into the flow (#1125). */
  touchEffect: (line: string) => `A run checks that ${line} after this touch.`,
  /** A touch the device could not judge (#1125): it went to the element's centre, which something may cover. */
  uncheckedTouch: (note: string | undefined) =>
    `Not checked to land on its element${note ? ` (${note})` : ''}, so it touched the centre, which something on screen may cover.`,
  exportAnyway: 'Export anyway',
  backToEdit: 'Back to Edit',

  exportHeading: 'Export',
  exportHelp: 'Your flow is ready. Save the YAML file and add it to your repository.',
  fileLabel: 'File',
  copyYaml: 'Copy YAML',
  copied: 'Copied.',
  copyByHand: 'Copying is not available on this page. The YAML is selected: copy it with your keyboard.',
  download: 'Download',
  howToUse: 'Put it in your app repository’s flows/ folder and CI runs it with tapflow flow run.',
  secretsToSet: (names: string[]) => `Set ${names.join(', ')} when the flow runs: tapflow flow run ${names.map((n) => `--secret ${n}`).join(' ')}`,
  appPinned: (bundleId: string) => `Runs only against builds of ${bundleId}.`,
  done: 'Done',

  errors: {
    pauseLost: 'Capturing could not be paused, so the replay stopped — its steps may now be mixed into your capture.',
    captureEnded: 'Your captured steps are gone: the device was released or restarted.',
    connectionLost: 'The connection to the relay was lost. Start again once it is back.',
  },
}
