---
sidebar_position: 5
title: 인증 흐름
description: Cognito 인증 아키텍처 및 흐름 상세
---

import AuthFlow from '@site/src/components/diagrams/AuthFlow';

# 인증 흐름

AWSops는 Amazon Cognito + Lambda@Edge + CloudFront 조합으로 인증을 처리합니다.

<AuthFlow />

## Cognito 구성

| 항목 | 설정 |
|------|------|
| **User Pool** | `awsops-user-pool` (셀프 사인업 비활성화) |
| **로그인 방식** | 이메일 또는 사용자명 |
| **비밀번호 정책** | 8자 이상, 대/소문자 + 숫자 필수 |
| **OAuth** | Authorization Code Grant, OpenID/Email/Profile |
| **토큰 유효기간** | 1시간 |
| **Domain** | `awsops-{accountId}` (Hosted UI) |

## 인증 흐름 상세

### 최초 방문 (쿠키 없음)

1. 브라우저가 `/awsops`에 접속
2. CloudFront가 viewer-request 이벤트로 Lambda@Edge 호출
3. Lambda@Edge가 `awsops_token` 쿠키 확인 → 없음
4. Cognito Hosted UI로 302 리다이렉트
5. 사용자가 이메일/비밀번호로 로그인
6. Cognito가 인증 코드와 함께 콜백 URL로 리다이렉트
7. Lambda@Edge가 인증 코드를 토큰으로 교환 (OAuth2)
8. `awsops_token` HttpOnly 쿠키 설정 (1시간)
9. 인증된 요청이 CloudFront → ALB → EC2로 전달

### 재방문 (유효한 쿠키)

1. 브라우저가 `awsops_token` 쿠키와 함께 접속
2. Lambda@Edge가 JWT 검증 → 유효
3. 요청이 그대로 CloudFront → ALB → EC2로 전달

## Lambda@Edge

| 항목 | 설정 |
|------|------|
| **리전** | us-east-1 (Lambda@Edge 필수) |
| **런타임** | Node.js 20 |
| **트리거** | CloudFront viewer-request |
| **기능** | JWT 검증, OAuth2 콜백 처리, 쿠키 설정 |

:::warning 로그아웃
HttpOnly 쿠키는 JavaScript(`document.cookie`)로 삭제할 수 없습니다. AWSops는 `POST /api/auth`를 통해 서버 사이드에서 쿠키를 삭제합니다.
:::

## 관련 페이지

- [로그인](./login) - 로그인 방법
- [배포 가이드](./deployment) - Cognito 배포 단계
- [대시보드](../overview/dashboard) - 시스템 아키텍처 개요
