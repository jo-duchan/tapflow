---
title: Sign-in & accounts
description: "`tapflow admin init` reporting Already initialized, and an invitation or password reset link that has expired."
---

# Sign-in & accounts

## `tapflow admin init` fails (`Already initialized`)

An admin account already exists on the relay. Sign in and invite teammates from **Settings → Team**.

## Invitation link expired

Invitation links expire after **7 days**. An Admin must create a new invitation from **Settings → Team**. If SMTP is not configured, copy the link shown in the invite dialog and share it manually.

## Password reset link expired

Password reset links expire after **2 hours**. An Admin can send a new link with **Reset pwd** on the member's row in **Settings → Team**. Reset links go out by email only, so SMTP must be configured.
