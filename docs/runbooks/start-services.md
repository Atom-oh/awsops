# Runbook: 서비스 시작 / Start Services

## 빠른 시작 / Quick Start
```bash
bash scripts/09-start-all.sh   # systemd 유닛이 있으면 systemctl 사용 / uses systemctl when units exist
```

## systemd 관리 (권장) / systemd Management (recommended)

Steampipe와 Next.js 모두 systemd 유닛으로 관리합니다 (`scripts/13-setup-steampipe-systemd.sh`로 등록).
Both Steampipe and Next.js are managed by systemd units (registered via `scripts/13-setup-steampipe-systemd.sh`).

```bash
sudo systemctl start steampipe    # Steampipe (port 9193, Restart=always)
sudo systemctl start awsops       # Next.js (port 3000, Restart=always)
sudo systemctl status steampipe awsops
```

주의: CLI `steampipe service stop`은 Restart=always가 10초 뒤 자동으로 되돌립니다. 의도적으로 중지하려면 `sudo systemctl stop steampipe`를 사용합니다.
Note: a bare CLI `steampipe service stop` is auto-undone by Restart=always within ~10s. Use `sudo systemctl stop steampipe` for an intentional stop.

## 수동 시작 (systemd 유닛이 없는 호스트) / Manual Start (hosts without units)

### 1. Steampipe
```bash
steampipe service start --database-listen network --database-port 9193 --database-password <data/config.json의 steampipePassword>
steampipe service status --show-password
```

### 2. Next.js
```bash
cd /home/ec2-user/awsops
PORT=3000 npm run start &
```

### 3. 검증 / Verify
```bash
curl -s http://localhost:3000/awsops  # 200 응답이 와야 함 (should return 200)
bash scripts/11-verify.sh             # 전체 점검 (full check)
```

## 문제 해결 / Troubleshooting
- 포트 3000이 사용 중인 경우 (Port 3000 in use): `fuser -k 3000/tcp`
- Steampipe가 시작되지 않는 경우 (Steampipe won't start): `sudo systemctl restart steampipe` 후 `journalctl -u steampipe -n 50` 확인 (then check logs)
- 대시보드 값이 안 보이는 경우 (Dashboard shows no values): API가 `ECONNREFUSED 127.0.0.1:9193`이면 Steampipe 다운 → `sudo systemctl start steampipe`. `timeout exceeded when trying to connect`이면 FDW 좀비/풀 고갈 → `sudo systemctl restart steampipe && sudo systemctl restart awsops`
- 비밀번호 불일치 (Password mismatch): `bash scripts/02-setup-nextjs.sh` (비밀번호 재동기화 / re-syncs password)
