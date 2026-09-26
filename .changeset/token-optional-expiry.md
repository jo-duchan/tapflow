---
'@tapflowio/relay': minor
---

The dashboard's **New token** dialog offers **No expiration**, matching the API, which has always read an omitted `expires_in_days` as a token that never expires. The expiry is now a choice of 7, 30, 60 or 90 days, a custom number of days (still 1–365), or **No expiration**; the default stays 30 days. Choosing **No expiration** shows a recommendation beside the field: such a token stays valid until it is revoked, so CI tokens should expire in 90 days or less. The token list marks tokens with no expiry **No expiration** instead of "Never", so an Admin can find them and clean them up.

`POST /api/v1/tokens` now answers `400` for an `expires_in_days` that is negative, not a number or numeric string (an empty or blank string, a boolean or an array included), or too large to be a date. A negative count used to create a token that was already expired, and a value too large for a date failed with an error instead of a response. An empty string used to mean no expiry, so a CI template whose variable came out empty got a token that never expires; it is now rejected. Omitting it, `null` or `0` still means no expiry, a numeric string such as `"30"` still works, and there is still no upper limit through the API.
