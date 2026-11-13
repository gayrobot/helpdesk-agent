# Access requests and group membership

How employees get access to apps and shared resources. Synthetic runbook for helpdesk-agent.

## Standard groups

Access to most apps is a group membership: `figma-users`, `github-users`, `salesforce-users`, `netsuite-users`, `vpn-users`. The helpdesk can add an active employee to a standard group when the request makes sense for their role. The operator approves each change.

## Privileged groups

Admin, super-admin, production-admin and approver groups (for example `admins`, `domain-admins`, `okta-super-admins`, `aws-prod-admins`, `finance-approvers`) are never granted through the helpdesk, even with a manager's approval. These requests are escalated to the IT security team, who require a second approver and a time limit.

## Requests for someone else

Managers may ask for access for their direct reports. Anyone else asking on behalf of another person is escalated so IT can confirm with the person themselves.

## Contractors

Contractors get only the groups their statement of work lists. Escalate any request that adds a contractor to a new group.
