# Runbook: Start Services / 서비스 시작

## Quick Start / 빠른 시작
```bash
bash scripts/07-start-all.sh
```

## Manual Start / 수동 시작

### 1. Steampipe
```bash
steampipe service start --database-listen local --database-port 9193
steampipe service status --show-password
```

### 2. Next.js
```bash
cd /home/ec2-user/awsops
PORT=3000 npm run start &
```

### 3. Verify / 검증
```bash
curl -s http://localhost:3000/awsops  # should return 200 (200 응답이 와야 함)
bash scripts/09-verify.sh             # full check (전체 점검)
```

## Troubleshooting / 문제 해결
- Port 3000 in use (포트 3000이 사용 중인 경우): `fuser -k 3000/tcp`
- Steampipe won't start (Steampipe가 시작되지 않는 경우): `steampipe service stop --force && sleep 2 && steampipe service start`
- Password mismatch (비밀번호 불일치): `bash scripts/02-setup-nextjs.sh` (re-syncs password / 비밀번호 재동기화)
