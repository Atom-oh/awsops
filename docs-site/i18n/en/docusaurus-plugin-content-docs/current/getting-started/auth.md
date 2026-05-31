---
sidebar_position: 5
title: Authentication Flow
description: Cognito authentication architecture and flow details
---

import AuthFlow from '@site/src/components/diagrams/AuthFlow';

# Authentication Flow

AWSops handles authentication using Amazon Cognito + Lambda@Edge + CloudFront.

<AuthFlow />

## Cognito Configuration

| Item | Setting |
|------|---------|
| **User Pool** | `awsops-user-pool` (self-signup disabled) |
| **Sign-in** | Email or username |
| **Password Policy** | 8+ characters, upper/lowercase + digits required |
| **OAuth** | Authorization Code Grant, OpenID/Email/Profile |
| **Token Validity** | 1 hour |
| **Domain** | `awsops-{accountId}` (Hosted UI) |

## Authentication Flow Details

### First Visit (No Cookie)

1. Browser navigates to `/awsops`
2. CloudFront triggers Lambda@Edge on viewer-request
3. Lambda@Edge checks for `awsops_token` cookie → not found
4. 302 redirect to Cognito Hosted UI
5. User logs in with email/password
6. Cognito redirects to callback URL with auth code
7. Lambda@Edge exchanges auth code for tokens (OAuth2)
8. Sets `awsops_token` HttpOnly cookie (1 hour)
9. Authenticated request flows through CloudFront → ALB → EC2

### Return Visit (Valid Cookie)

1. Browser sends request with `awsops_token` cookie
2. Lambda@Edge validates JWT → valid
3. Request passes through CloudFront → ALB → EC2

## Lambda@Edge

| Item | Setting |
|------|---------|
| **Region** | us-east-1 (required for Lambda@Edge) |
| **Runtime** | Node.js 20 |
| **Trigger** | CloudFront viewer-request |
| **Functions** | JWT validation, OAuth2 callback handling, cookie management |

:::warning Sign Out
HttpOnly cookies cannot be deleted via JavaScript (`document.cookie`). AWSops deletes cookies server-side via `POST /api/auth`.
:::

## Related Pages

- [Login](./login) - How to log in
- [Deployment Guide](./deployment) - Cognito deployment steps
- [Dashboard](../overview/dashboard) - System architecture overview
