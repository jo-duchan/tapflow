---
title: Comments
description: "Leave notes and images on a build from a QA Session. Comments collect in a flat list by day, and each one has a link you can copy and pass on."
---

# Comments

A comment is a note on a build. Write down what you found while testing, with a screenshot, and every teammate who opens the same build sees it. Every role can comment, and there is nothing to turn on.

## How to use {#how-to-use}

1. In a [QA Session](/testing/qa-session), open the **Comments** tab under the info card. It is the tab that shows first.
2. Write in the **Leave a comment…** box.
3. To add an image, press **Attach image** and choose a file.
4. Press **Post comment**.

Comments form one flat list with no threads, grouped under **Today**, **Yesterday** and earlier dates. Each shows its author and time, and clicking an attached image opens it in a new tab.

### Share a link to a comment {#comment-links}

Press the link button next to a comment (**Copy link to comment**) to copy an address that goes straight to it, and a **Link copied** notice appears. The address ends in `#comment-<number>`. Whoever opens it is scrolled to that comment, which is highlighted for a moment.

## Platform support {#platform-support}

Comments belong to the build, not the device, so they work the same for iOS and Android builds.

## Limits {#limits}

- Attached images must be PNG, JPG or WebP, up to 5 MB. Another format shows **Only png, jpg, webp allowed**, and a larger file shows **Max 5MB**.
- The dashboard cannot edit or delete a comment. Deleting one takes the [REST API](/reference/api#delete-api-v1-comments-id), and only its author or an Admin can.
- Copying a comment link works only when the dashboard is open over HTTPS (or `localhost`). Over HTTP the browser blocks the clipboard write and **Could not copy link** appears.

## Setup (operator) {#setup-operator}

CI can leave the branch or commit as a comment while it uploads a build; see [Upload from CI](/operate/ci-distribution). The attachment limit can be changed on the relay with `TAPFLOW_MAX_COMMENT_BYTES`, but the dashboard still refuses files over 5 MB before uploading them.

## Troubleshooting {#troubleshooting}

- **Couldn't load comments.** means the list could not be fetched. Reload the page.
- **Could not copy link** appears. Check whether the dashboard address starts with `http://`, and ask your operator to set up HTTPS.

## Related {#related}

- [Screenshots & recordings](/testing/screenshots-and-recordings): capturing the screen to attach to a comment
- [App Center](/testing/app-center#review-status): changing a build's review status once it is checked
- [Upload from CI](/operate/ci-distribution): leaving comments from CI
