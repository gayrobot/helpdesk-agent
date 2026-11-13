# Mac enrollment in Jamf

Every company Mac is managed by Jamf. Synthetic runbook for helpdesk-agent.

## New Macs

New Macs enroll automatically on first boot through Automated Device Enrollment. Connect to Wi-Fi, sign in with your work email when asked, and wait for the Larkspur setup screen to finish installing apps (about 20 minutes).

## Re-enrolling an existing Mac

If a Mac shows as "not compliant" or drops out of Jamf:
1. Open System Settings > Privacy & Security > Profiles and remove any old Larkspur profile.
2. Visit `enroll.example.test` in Safari and sign in.
3. Install the downloaded profile from System Settings.

## Compliance checks

Jamf marks a Mac non-compliant when FileVault is off, macOS is more than one major version behind, or the device hasn't checked in for 14 days. Non-compliant devices lose access to the VPN and Google Drive until fixed.

## OS updates

Updates are pushed with a 7-day deferral. Users get reminders and the update is forced after the deferral ends.
