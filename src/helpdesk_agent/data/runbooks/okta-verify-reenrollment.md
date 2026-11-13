# Okta Verify re-enrollment and MFA resets

How a user gets back into their account after a new phone, a lost phone or a broken authenticator. Synthetic runbook for helpdesk-agent.

## When an MFA reset is needed

The user has a new or wiped phone, uninstalled Okta Verify, or pushes never arrive and re-installing didn't help. A reset removes their current factor so they can enroll again at next sign-in.

## Verifying the requester

The helpdesk only resets MFA for the person who owns the account, filing the ticket from their own account or confirmed by their manager. A request to reset someone else's MFA is escalated. Accounts in privileged groups (admins, super-admins, production admins, approvers) are never reset by the helpdesk: the security team verifies identity in person or on video first.

## Re-enrolling after a reset

1. Install Okta Verify from the App Store or Google Play.
2. Sign in at `login.example.test` with your email and password.
3. You will be asked to set up a factor. Choose Okta Verify and scan the QR code.
4. Approve the test push.

## Security keys

People who use a WebAuthn security key enroll it at the same prompt. Keep a second key registered as a backup; a lost key with no backup needs a reset.
