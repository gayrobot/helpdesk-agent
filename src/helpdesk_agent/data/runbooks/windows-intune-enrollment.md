# Windows enrollment in Intune

Company Windows laptops are managed by Intune. Synthetic runbook for helpdesk-agent.

## New laptops

New laptops arrive registered with Autopilot. On first boot, connect to Wi-Fi and sign in with your work email. Setup installs the company apps and BitLocker policy.

## Company Portal

Software is installed from the Company Portal app. If an app is missing, check Company Portal first before filing a software request.

## Non-compliant laptops

Intune marks a device non-compliant when BitLocker is off, Windows is behind on security updates by more than 14 days, or Defender is disabled. Open Company Portal, select the device and choose "Check status" to see what's wrong.
