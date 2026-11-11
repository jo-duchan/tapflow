// What an agent is told about using tapflow, and how to test with it. Two texts with two costs:
//
// - `INSTRUCTIONS` is the MCP server `instructions` field. Clients that honour it put it in the system prompt of
//   every session, whether or not the session tests anything, so it is short and holds only what goes wrong
//   when an agent does not know it. Claude Code cuts it at 4,096 characters and Codex reads the first 512 as the
//   namespace's description, so the rules that matter most come first. It does not repeat the tool
//   descriptions (the spec asks servers not to).
// - `TESTING_GUIDE` is returned by the `get_testing_guide` tool, so it costs nothing until an agent asks for it.
//   It recommends only what these tools can do: an untestable case is reported as untested, never described.
//
// Both are held to a size in `__tests__/guide.test.ts`, and every tool they name must be registered.

export const INSTRUCTIONS = `tapflow drives iOS simulators and Android emulators on your team's Macs, which people also use by hand.
- Before testing a feature or screen, call get_testing_guide once: what to cover, what these tools cannot test, and how to report.
- When you are done, call disconnect_device. A session you keep holds the device away from everyone else.
- Read the screen with query_ui_tree, not screenshot. It is far cheaper and gives ids, labels, enabled state and frames. Take a screenshot only for something visual (keyboard covering a field, clipped text, a system dialog missing from the tree), as evidence, or once per device to learn the pixel size swipe and a point tap need. Tap a listed element with tap's element, not its frame centre, which a tab bar or sheet can cover.

Session: list_devices, connect_device (give the person the watchUrl), boot_device unless already booted, install_app, launch_app. After launch_app or any navigation, read the tree again until the screen you expect is there; never tap a screen you have not just read.

When something refuses or is unsure:
- boot_device refused because the Mac is busy (another boot, low memory, at capacity): people's sessions come first. Wait as the message says and retry; it is not a broken device.
- An input reported as "could not confirm" may still have landed. Read the tree before repeating it, or it may happen twice.
- A failure caused by the device, the session or the relay is an environment problem, not an app bug. Report it as blocked.

Flows: once a scenario is verified, write it as YAML and replay it with run_flow (selectors by id, then label; wait with assertVisible, never coordinates or sleeps). Keep a flow only after it replays passing. run_flow resets nothing beyond the flow's own clearState.

Report only what you ran and observed. A case you did not run is untested, not passed.`

export const TESTING_GUIDE = `# Testing a mobile screen with tapflow

Goal: find real defects in the requested feature, prove each with evidence, and leave a replayable flow. Report only what you observed.

## 1. Before tapping
- Map the screen from query_ui_tree: its inputs, buttons and text. Plan the cases below, then run them.
- After every action, read the tree again. Never tap by coordinates on a screen you have not just read.

## 2. Cases, in this order
**Happy path**
- Complete the main task with valid input. Check the outcome screen, and that the data shows where it should (list, detail, after leaving and returning).
- Try the other trigger: press_key Enter instead of the button.

**Inputs** (each field)
- Empty, spaces only, leading/trailing spaces.
- Too long, too short, exactly at a visible limit.
- Wrong format (bad email, letters in a number field), 0, negative, decimal.
- Special characters (' " < > &), accented, CJK and emoji.
- A required field missing; fields that disagree (password and confirmation).
- Expect: an error that names the problem, near the field, gone once fixed. Submit stays disabled (enabled: false) or is rejected, never accepted.

**States**
- First run: run_flow with clearState then launchApp.
- Returning: press_button home, then launch_app. The screen and typed input should survive.
- Empty list or no data. A loading state must resolve: read the tree a few times; a spinner that never ends or a blank screen is a finding.
- Submit twice quickly: look for a duplicate result or two navigations.

**Navigation**
- Back from every screen: press_button back on Android; the on-screen back button or a swipe from the left edge on iOS. Back after a successful submit must not reopen a stale form.
- Scroll to the end of long content. Open each modal and dismiss it.
- Deep link to the screen, signed in and out, with run_flow openUrl.

**Lifecycle**
- Leave mid-input (press_button home or lock) and return.
- Android: press_button recent_apps and come back.
- A permission dialog: try allow, and deny where you can. clearState resets permissions on Android but not on iOS, so on iOS an already answered dialog will not come back; report deny as untested there. The app must keep working or say what is missing. Confirm the dialog with a screenshot; it may not be in the tree.

**Layout and accessibility**
- With the keyboard up, are the focused field and the submit button visible? Screenshot.
- Every button and input has a meaningful label or placeholder. An icon button with an empty or file-name label is a finding. Key controls without an identifier make flows fragile: note them.
- Overlapping or clipped text: report only when clearly visible.

## 3. Not testable here: list, never attempt
Rotation, dark mode, font size, locale and RTL, network loss or throttling, push notifications, calls, location, paste and autofill, long-press, multi-touch, granting or revoking permissions outside the app, performance, contrast, screen-reader order. If the feature depends on one, write "untested: <item> (no tool)". Never describe how it behaves.

## 4. Before calling something a bug
- Read the tree again after the action. A missing element may still be loading: check a few times first.
- Reproduce it once more from a clean state (clearState, launchApp). Seen once is "intermittent", not confirmed.
- Did your tap land? If the screen did not change, the miss may be yours, not the app's.
- Device, session, relay, a build not installed, missing test data: that is "blocked", not a bug.
- Without a spec, judge by the app's own consistency and platform conventions, and say so. Design opinions are suggestions, not defects.

## 5. Turn the verified path into a flow
- Write the passing scenario as YAML for run_flow, starting with clearState and launchApp.
- Selectors: id first, then exact label, then { role, index }. No coordinates.
- Wait with assertVisible (add timeout for a slow step), never a pause. End on an assertion about the outcome, and assertNotVisible for what should be gone (spinner, error).
- One flow per scenario: the happy path, and one per important negative case.
- Replay it twice and keep it only if both pass. If it fails, fix the selector or the wait, or report the instability. Never loosen an assertion to make it pass.
- For a failed CI run, list_runs then get_run: it separates app failures from environment ones and suggests selectors.

## 6. Report
One block per finding:

[BUG|A11Y|INTERMITTENT] <title> (severity: high|medium|low)
Steps: 1. ... 2. ... (from launch, with the exact text typed)
Expected: ...
Actual: ... (quote labels from the tree)
Evidence: tree excerpt, or the screenshot at step N
Reproduced: 2/2 from a clean state

Then: Passed (only cases you ran and checked, one line each), Untested (and why), Blocked (environment), Flows (each flow with its replay result, such as "passed 2/2").`
