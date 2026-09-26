---
title: Team, roles & tokens
description: "The dashboard's Settings pages: your profile, the member list with roles and invitations (Admin only), and personal access tokens for CI and remote agents."
---

# Team, roles & tokens

Settings has three sub-pages accessible from the left nav.

## Default

Personal profile settings for the currently signed-in user.

- **Workspace** — the team name and logo. Visible to Admins only.
- **Apps** — rename or delete apps. Visible to Admins, Developers and QA, hidden from Viewers.
- **Nickname** — shown in comments and session history.
- **Avatar** — click the pencil icon on the avatar to upload a new image (PNG or JPEG, max 2 MB).
- **Change password** — requires current password.

## Team

Visible to **Admin** only.

- **Members list** — all accounts with email, role, and join date.
- **Invite member** — send an email invite or generate a copy-paste link. Invites expire after 7 days.
- **Change role** — reassign any member's role (Admin / Developer / QA / Viewer).
- **Remove member** — permanently deletes the account. You cannot remove yourself.
- **Reset pwd** — send a password reset email to a specific member. Requires SMTP.

## Tokens

Personal access tokens (PATs) for CI/CD scripts and API access. The sidebar shows this page to **Admin** only.

- **New token** — enter a name, an **Expiration**, and a Type. Choose 7, 30, 60 or 90 days, a custom number (1–365 days), or **No expiration**; the default is 30 days. A token with no expiration stays valid until you revoke it, so keep CI tokens to 90 days or less. The list marks these tokens **No expiration** so you can find and clean them up. **API** is for CI uploads and API access (scope `view, builds:write`); **Agent** connects remote Mac agents. The token is shown once — copy it immediately.
- **Revoke** — instantly invalidates the token.

Use PATs with the `Authorization: Bearer tflw_pat_<token>` header to upload builds from CI. See [Uploading Builds](/testing/app-center).
