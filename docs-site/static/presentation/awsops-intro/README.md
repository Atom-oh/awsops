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
- `deploy-guide.yml` 의 build 검증 단계가 pptx 존재 + zip 컨테이너 무결성을 게이트한다 (누락 시 배포 실패).
- `.gitignore` 는 전역 `*.pptx` 를 무시하되 이 파일 하나만 예외 처리되어 있다.
