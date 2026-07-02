#!/usr/bin/env bash
# 공용 헬퍼: 슬롯 디렉터리, 스킵 로깅.
set -uo pipefail

# slot 디렉터리 보장
ensure_slots() { mkdir -p "$1/slot"; }

# 한 패널 실행 결과를 평가해 responded 에 기록.
#   $1 슬롯 파일 경로, $2 패널 라벨, $3 responded 파일
# non-empty 체크만으로는 "응답함"이 실제 리뷰인지 보일러플레이트/거부 응답인지 구분이 안 되고,
# 그 원문은 어디에도 로깅되지 않아 사후 조사가 불가능했다(2026-07 감사: 샘플 18개 PR 중 17개에서
# CHAIR 가 "일부 패널이 diff 를 못 받았다"고 사후 진단했지만 원인 텍스트는 로그에 없었음).
# 성공/실패 무관하게 앞부분을 항상 찍어 다음번엔 CI 로그만으로 실제 내용을 바로 확인할 수 있게 한다.
record_result() {
  local slot="$1" label="$2" responded="$3"
  echo "[preview] $label: $(head -c 200 "$slot" | tr '\n' ' ')" >&2
  if [ -s "$slot" ]; then
    echo "$label" >> "$responded"
  else
    echo "[skip] $label" >&2
    : > "$slot"  # 빈 슬롯 보장
  fi
}
