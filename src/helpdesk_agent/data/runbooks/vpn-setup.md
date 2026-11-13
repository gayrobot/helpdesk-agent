# VPN setup

Larkspur Labs uses the Larkspur Connect VPN client for access to internal tools (the wiki, the build farm, the finance system). Synthetic runbook for helpdesk-agent.

## Who can use the VPN

Anyone in the `vpn-users` group. Engineering and IT get it by default. Others request it through an access request (see the access-requests runbook) with a one-line business reason. Contractors need their sponsor's approval.

## Installing the client

On a managed Mac, open Self Service and install "Larkspur Connect". On a managed Windows laptop, open Company Portal and install "Larkspur Connect". Unmanaged personal devices can't use the VPN.

## First connection

1. Open Larkspur Connect and enter the portal address `vpn.example.test`.
2. Sign in with your work email and password.
3. Approve the Okta Verify push on your phone.
4. The menu-bar icon turns green when the tunnel is up.

## Split tunnelling

Only internal addresses go through the VPN. Video calls and general browsing stay on your normal connection, so you don't need to disconnect for meetings.
