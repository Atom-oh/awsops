# awsops-intro 프레젠테이션

이 디렉터리에는 **서로 다른 두 개의 덱**이 공존한다. 자동으로 동기화되지 않는다.

| 자산 | 무엇인가 | 소스 / 재생성 경로 |
|---|---|---|
| `index.html` + `0N-*.html` (웹 슬라이드) | remarp 블록 기반 웹 프레젠테이션 (42장) | `_presentation.md` 매니페스트 + `0N-*.md` 블록에서 생성 |
| `awsops-intro.pptx` (정식 PPTX 덱) | 고객 발표용으로 별도 제작한 PowerPoint 덱 — 16:9, Pretendard 폰트(미설치 시 대체 폰트), 슬라이드마다 한국어 스피커 노트 포함 | `docs-site/scripts/pptx/build-awsops-intro-pptx.js` (pptxgenjs) — 아래 참조 |

## 정식 PPTX 덱 재생성

```bash
cd docs-site
npm ci            # pptxgenjs는 devDependency로 고정되어 있음
node scripts/pptx/build-awsops-intro-pptx.js
# → static/presentation/awsops-intro/awsops-intro.pptx 를 덮어씀 → 교체 커밋
```

- 슬라이드 구성·문구·스피커 노트는 전부 생성 스크립트가 단일 소스다. 내용을 고치려면 스크립트를 수정하고 다시 빌드한다.
- `export-utils.js` 의 "Export PPTX" 버튼(웹 슬라이드 스크린샷 기반)과는 무관하다.
- 웹 슬라이드 내용이 크게 바뀌면 이 덱도 함께 갱신할 것 — 두 덱은 자동으로 동기화되지 않는다.

## 배포/보안 유의

- 이 파일은 인증 없는 공개 docs-site 로 배포된다. **덱에 계정 ID·ARN·내부 호스트명·시크릿을 넣지 말 것** (스피커 노트 포함).
- `deploy-guide.yml` 의 build 검증이 **4중 게이트**로 막는다 (누락·위반 시 배포 실패):
  1. 존재 + zip 매직 + `ppt/presentation.xml` 구조 확인
  2. 콘텐츠 XML 민감정보 스캔 — 계정 ID·ARN·액세스 키·내부 호스트명·리소스 ID·사설 CIDR (theme 제외 전 XML/rels)
  3. **생성기 일치(프로비넌스)** — CI가 스크립트로 재빌드해 파트 목록 + 전체 아카이브(media 포함)를 diff. 손으로 바꾼 바이너리는 배포 불가
  4. 외부 관계 타깃(`TargetMode="External"`) 금지
- **한계**: 임베드 이미지의 픽셀 내용은 스캔 불가 — 다만 프로비넌스 게이트가 media를 생성기 산출물로 고정하므로, 이미지 교체는 스크립트/자산 커밋 리뷰를 거쳐야만 가능하다. 배경 PNG 2종은 합성 그라디언트(스크린샷 아님).
- `.gitignore` 는 전역 `*.pptx` 를 무시하되 이 파일 하나만 예외 처리되어 있다.
