---
'@tapflowio/relay': minor
---

Viewer is now read-only. A Viewer can look at builds, test them in a QA Session and comment, but uploading a build (`POST /api/v1/builds`), changing its status (`PATCH /api/v1/builds/:id`), scheduling or cancelling its deletion, and every `/api/v1/webhooks` route — listing included — answer `403 { "error": "Viewers have read-only access" }`. This holds for a personal access token too: the owner's role decides, so a `builds:write` token owned by a Viewer can no longer upload. In the App Center a Viewer's **Add App** and **Upload build** buttons explain the refusal in a toast instead of opening a dialog, and build rows show the status without the status menu or the deletion button.

QA can now create, rename and delete apps, as Developer can, and sees the apps section in Settings.

Roles are read from the database on every request instead of from the 7-day login cookie, so promoting or demoting a member — including an Admin — takes effect on their next request, without signing in again or issuing a new token.
