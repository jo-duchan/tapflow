---
title: App Center
description: "The dashboard's build list, grouped by app and version: uploading builds, search and status filter, review status, scheduled deletion, and starting a QA Session."
---

<a id="uploading-builds"></a>

# App Center

App Center is the build list inside the tapflow dashboard. It has nothing to do with Microsoft App Center. The iOS and Android builds your team uploads collect here by app and version, and this is where you pick one and start a QA Session. It is the first screen you see after signing in.

## How to use {#how-to-use}

1. Pick an app from the **Apps** list on the left. An app is identified by its bundle ID (the iOS bundle identifier or the Android package name), and can have a different one on each platform.
2. Builds are grouped by version name into collapsible releases. A build whose version name could not be read goes under **Unversioned**.
3. Press **Start QA** on the build you want to test. The build's [QA Session](/testing/qa-session) opens.

Each build row shows the build number, label, platform, review status badge, scheduled-deletion badge, uploader, and upload date. A build whose version or build number was [changed](#edit-a-build) carries an **Edited** badge.

### Find a build {#find-a-build}

- Type part of a version name or label into **Search version or label…** to see only builds that contain it.
- Pick **Backlog**, **In Progress**, **Done** or **Rejected** in the status filter (default **All statuses**) to see only builds with that status.

When nothing matches, the list shows **No matching builds**.

## Upload a build {#upload-a-build}

<a id="dashboard-upload"></a>

1. Press **Upload build** at the top right of the screen.
2. Click the **File** area to choose a file, or drag one onto it.
   - iOS: a simulator build, `.app.zip` or `.tar.gz`/`.tgz`. A `.app.zip` is the `.app` folder [built from the command line](https://developer.apple.com/library/archive/technotes/tn2339/_index.html) and zipped. Upload a cloud simulator build's `.tar.gz`/`.tgz`, such as one from EAS, as it is.
   - Android: `.apk`
3. Optionally pick a review status under **Status (optional)**. With the default, **None**, the build has no status.
4. Optionally write a note under **Label (optional)**, such as a branch name or `staging, feature X`. It shows on the build's row and is found by search.
5. To use a version or build number other than the build file's, open **Override version** and fill in **Version** or **Build number**. A field left empty uses the file's value.
6. Press **Upload**. A **Build uploaded** notice appears and the build joins the list.

::: warning iOS `.ipa` files are not supported
`.ipa` is the format for real devices. tapflow accepts `.app.zip` and `.tar.gz`/`.tgz` for simulators. If an upload fails, see [Builds & uploads troubleshooting](/troubleshooting/builds#ios-build-upload-errors).
:::

An uploaded build is linked to an app by its bundle ID. If no app has that bundle ID, a new one is created. Uploading while an app is selected links the build to that app. If the app has no bundle ID on that platform yet, the build's ID is added to it, so an app whose iOS and Android IDs differ can still be one app. If another app already holds the build's ID, or the selected app has a different ID on that platform, the build goes to the app for its own bundle ID.

You can also create the app first with **Add App** below the **Apps** list, giving its **Name**, **Bundle ID** and **Platform** (iOS, Android or Both).

To upload builds automatically from a CI pipeline, see [Upload from CI](/operate/ci-distribution).

## Edit a build {#edit-a-build}

Choose **Edit build** from a build row's **⋯** menu to change its label, version and build number. This needs the **Admin, Developer or QA** role.

- **Label**: a note on the build. Clear it to remove the label.
- **Version**, **Build number**: values to use instead of the ones read from the build file. The file's value is shown under each field, and clearing a field goes back to it.

Changing the version moves the build into that version's release and opens it. A build under **Unversioned** because its version could not be read can be given one this way.

The values you set only change how tapflow shows and groups the build. The app installed on the device is the file you uploaded, with its own version. A build with changed values carries an **Edited** badge; point at it or move to it with the keyboard to see the file's values.

## Merge and split apps {#merge-apps}

If one product split into two apps because its iOS and Android bundle IDs differ, you can merge them. You can also split them again: an app merged by mistake, or a bundle ID attached to the wrong app. This needs the **Admin, Developer or QA** role.

### Merge

1. In **Settings**, on the **Apps** card, press **Arrange apps**. A handle appears in front of each bundle ID row, and the rows start to wiggle.
2. Drag the bundle ID row you want to move onto the app you want to keep. From the keyboard, press Space on the handle to pick it up, choose an app with the arrow keys, and press Space to drop it.
3. Press **Merge** in the confirmation.

That platform's bundle ID and builds move to the app you keep, along with the builds' comments, recordings and run records. If the other app has nothing left, it is deleted. The app keeps the name of the one you dropped onto. You can split a merged app again as below, but the deleted app's name does not come back.

CI that uploads with the deleted app's `app_id` keeps working, because the build's bundle ID finds the app.

### Split

1. Press **Arrange apps** and pick up the bundle ID row to take out. A **New app** area opens right below the app it was in.
2. Drop the row on **New app**. From the keyboard, pick the row up, move down to **New app** with the arrow key, and press Space.
3. Name the new app in the confirmation and press **Split**. The name starts as the original app's name followed by the platform.

That platform's bundle ID and builds move to the new app, which is listed first. The original app has to keep its other platform, so **New app** does not open for an app with only one row.

Builds uploaded with the original app's `app_id` still go to the new app when they carry the bundle ID you moved. If the row you took out had builds but no bundle ID, point CI at the new app's `app_id`: builds whose bundle ID could not be read follow `app_id`.

### Rows that cannot move

They have no handle and do not wiggle. Point at or focus the row to see why.

- A row of an app that uses the same bundle ID on both platforms. That app is already one app.
- A row of the app that collects builds whose bundle ID could not be read.

While you drag, apps the row cannot go to are dimmed: an app that already has a bundle ID on that platform. A row with builds but no bundle ID can still go there.

## Review status {#review-status}

The review status tells the team how far a build has been checked. Change it from the status menu on the build's row.

| Status | Meaning |
|---|---|
| — | No status |
| **Backlog** | Not yet ready |
| **In Progress** | Ready for review |
| **Done** | Stakeholders approved |
| **Rejected** | Issues found, needs fixes |

- A build marked **Done** has its **Start QA** button disabled. To test an approved build again, change its status first.
- In a QA Session, the status badge sits next to the breadcrumb at the top until you pick a Mac.
- When the status changes to **Done** or **Rejected**, any [review webhooks](/operate/webhooks) your operator registered are called.

## Schedule deletion {#schedule-deletion}

Schedule a build you no longer need for deletion by choosing **Schedule deletion** from its row's **⋯** menu. Press **Schedule deletion** in the confirmation and the build files are deleted after 7 days. The row gets a countdown badge such as **Deletes in 6d**.

Until then you can cancel it any time with **Cancel scheduled deletion** in the same menu. Scheduled deletion is independent of the review status.

## Platform support {#platform-support}

| | iOS | Android |
|---|---|---|
| Upload file | `.app.zip`, `.tar.gz`/`.tgz` (simulator build) | `.apk` |
| What identifies the app | Bundle identifier | Package name |

## Limits {#limits}

- The Viewer role is read-only. When a Viewer presses **Upload build** or **Add App**, a notice says QA or Developer access is needed instead of opening the dialog. A Viewer sees no status menu and no **⋯** menu, only **Start QA** and the status badge. For what each role can do, see [Team, roles & tokens](/operate/team-and-roles#team).
- The list shows each app's 100 most recently uploaded builds. Search by version to find older ones.
- App Center cannot rename or delete an app. The Admin, Developer and QA roles can do both from the **⋯** menu of each app on the **Apps** card in **Settings → Default** (**Edit**, **Delete**). Deleting an app deletes all of its builds.
- The deletion confirmation always says 7 days. If your operator changed `TAPFLOW_BUILD_TTL_DAYS` on the relay, the real period follows that value.

## Troubleshooting {#troubleshooting}

- If an upload fails with a `400` error, see [iOS build upload errors](/troubleshooting/builds#ios-build-upload-errors).
- If an APK shows as **Unversioned** or merges into another app, see [Builds & uploads](/troubleshooting/builds). When all it needs is a version, you can set one with [Edit a build](#edit-a-build).

## Related {#related}

- [QA Session](/testing/qa-session): picking a Mac and a device after pressing **Start QA**
- [Upload from CI](/operate/ci-distribution): uploading builds automatically from a pipeline
- [Review webhooks](/operate/webhooks): notifying another system when a review status changes
