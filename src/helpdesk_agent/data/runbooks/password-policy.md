# Password policy and resets

Synthetic runbook for helpdesk-agent.

## Policy

Passwords are at least 14 characters. Passphrases are encouraged. There is no forced rotation; you change your password only if it may have been exposed. The last 5 passwords can't be reused.

## Self-service reset

Go to `login.example.test`, choose "Forgot password", and confirm with your MFA factor. The new password works everywhere within a few minutes, including the VPN.

## Locked account

Ten failed sign-ins lock the account for 30 minutes. It unlocks by itself. If the user can't wait, or keeps getting locked out (an old password saved on a phone is the usual cause), escalate to IT.

## Exposed passwords

If a user thinks their password was phished or pasted somewhere public, they reset it immediately and report it as described in the phishing-reporting runbook.
