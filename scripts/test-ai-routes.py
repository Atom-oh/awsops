#!/usr/bin/env python3
"""AI Route Test Script — Interactive category/question selection with 100 questions.
AI 라우트 테스트 스크립트 — 카테고리/질문 선택 + 100개 질문.

Usage / 사용법:
  python3 scripts/test-ai-routes.py                    # Interactive menu / 대화형 메뉴
  python3 scripts/test-ai-routes.py --all              # Run all questions / 전체 실행
  python3 scripts/test-ai-routes.py --cat security     # Run one category / 카테고리 지정
  python3 scripts/test-ai-routes.py --cat cost,infra   # Run multiple categories / 복수 카테고리
  python3 scripts/test-ai-routes.py --quick            # 1 question per category / 카테고리별 1개
  python3 scripts/test-ai-routes.py --url http://host:3000/awsops/api/ai
  python3 scripts/test-ai-routes.py --timeout 120
"""
import json, time, urllib.request, sys, os
from datetime import datetime
from collections import OrderedDict

# -- Configuration / 설정 --------------------------------------------------
URL = "http://localhost:3000/awsops/api/ai"
TIMEOUT = 90

# Parse CLI args / CLI 인자 파싱
for i, arg in enumerate(sys.argv):
    if arg == "--url" and i + 1 < len(sys.argv):
        URL = sys.argv[i + 1]
    if arg == "--timeout" and i + 1 < len(sys.argv):
        TIMEOUT = int(sys.argv[i + 1])

# -- Question Bank / 질문 은행 (9 categories, 100 questions) ----------------
# Format: { category: [(expected_route, label, question), ...] }
QUESTION_BANK = OrderedDict([

    ("security", [
        # Basic IAM queries / 기본 IAM 조회
        ("security", "보안 요약",               "보안 이슈가 있는지 확인해줘"),
        ("security", "IAM 사용자 목록",          "IAM 사용자 목록과 Access Key 상태를 보여줘"),
        ("security", "역할 분석",               "AWSopsAgentCoreRole의 권한을 분석해줘"),
        ("security", "그룹 목록",               "IAM 그룹 목록을 보여줘"),
        ("security", "정책 목록",               "현재 계정의 커스텀 IAM 정책을 조회해줘"),
        # Advanced security / 고급 보안
        ("security", "권한 시뮬레이션",          "EC2 역할이 S3에 접근할 수 있는지 테스트해줘"),
        ("security", "미사용 자격 증명",         "90일 이상 사용하지 않은 Access Key가 있는지 확인해줘"),
        ("security", "역할 상세",               "AWSopsLambdaNetworkRole에 연결된 모든 정책을 보여줘"),
        ("security", "인라인 정책",             "AWSopsAgentCoreRole의 인라인 정책 내용을 보여줘"),
        ("security", "사용자 상세",             "whchoi98 사용자의 권한과 그룹 멤버십을 알려줘"),
        ("security", "MFA 상태",               "MFA가 설정되지 않은 사용자가 있는지 확인해줘"),
        ("security", "루트 계정 보안",           "루트 계정의 보안 상태를 점검해줘"),
    ]),

    ("infra", [
        # VPC / Network / VPC / 네트워크
        ("infra", "VPC 현황",                  "VPC 현황과 서브넷 구성을 알려줘"),
        ("infra", "보안그룹",                   "보안그룹 규칙을 확인해줘"),
        ("infra", "네트워크 토폴로지",           "전체 네트워크 구성을 설명해줘"),
        ("infra", "라우트 테이블",              "VPC 라우트 테이블을 조회해줘"),
        ("infra", "NAT Gateway",              "NAT Gateway 상태와 사용량을 확인해줘"),
        ("infra", "ENI 조회",                  "10.0.0.1 IP를 사용하는 ENI를 찾아줘"),
        # Transit Gateway / Transit Gateway
        ("infra", "TGW 현황",                  "Transit Gateway 현황과 라우팅을 알려줘"),
        ("infra", "TGW 피어링",                "TGW 피어링 연결 상태를 확인해줘"),
        ("infra", "VPN 연결",                  "VPN 연결 상태를 확인해줘"),
        # EKS / EKS
        ("infra", "EKS 클러스터",              "EKS 클러스터 상태와 노드 현황을 확인해줘"),
        ("infra", "EKS 로그",                  "EKS 클러스터의 CloudWatch 로그를 확인해줘"),
        ("infra", "EKS 네트워크",              "EKS 클러스터의 VPC 설정과 서브넷 구성을 알려줘"),
        ("infra", "EKS 트러블슈팅",            "EKS Pod가 Pending 상태일 때 원인을 분석해줘"),
        ("infra", "EKS 메트릭",               "EKS 노드의 CPU와 메모리 사용률을 확인해줘"),
        # ECS / ECS
        ("infra", "ECS 서비스",                "ECS 클러스터와 서비스 현황을 보여줘"),
        ("infra", "ECS 태스크",                "ECS 태스크 정의 목록을 확인해줘"),
        ("infra", "ECS 트러블슈팅",            "ECS 서비스가 DRAINING 상태인 원인을 분석해줘"),
        # Istio / Istio
        ("infra", "Istio 현황",               "Istio 서비스 메시 전체 현황을 보여줘"),
        ("infra", "Istio VirtualService",     "Istio VirtualService 목록을 조회해줘"),
    ]),

    ("cost", [
        # Basic cost queries / 기본 비용 조회
        ("cost", "비용 분석",                  "이번 달 비용을 서비스별로 분석해줘"),
        ("cost", "비용 비교",                  "전월 대비 비용 변화와 증가 원인을 알려줘"),
        ("cost", "비용 예측",                  "다음 달 비용을 예측해줘"),
        ("cost", "비용 동인",                  "비용이 가장 많이 증가한 서비스가 뭐야?"),
        ("cost", "예산 확인",                  "현재 예산 상태를 확인해줘"),
        # Detailed cost analysis / 상세 비용 분석
        ("cost", "EC2 비용",                  "EC2 인스턴스 타입별 비용을 분석해줘"),
        ("cost", "일별 비용",                  "최근 7일간 일별 비용 추이를 보여줘"),
        ("cost", "비용 태그",                  "비용 할당 태그별 비용을 분석해줘"),
        ("cost", "서비스 가격",                "서울 리전 t4g.2xlarge 인스턴스 가격을 알려줘"),
        ("cost", "3개월 비교",                 "최근 3개월 비용을 비교해줘"),
        ("cost", "리전별 비용",                "리전별 비용을 비교 분석해줘"),
    ]),

    ("monitoring", [
        # CloudWatch / CloudWatch
        ("monitoring", "알람 확인",            "현재 활성화된 CloudWatch 알람이 있어?"),
        ("monitoring", "CPU 추세",             "EC2 인스턴스 CPU 사용량 추세를 보여줘"),
        ("monitoring", "로그 그룹",            "CloudWatch 로그 그룹 목록을 보여줘"),
        ("monitoring", "알람 추천",            "EC2 CPU에 대한 알람 임계값을 추천해줘"),
        ("monitoring", "알람 이력",            "최근 발생한 알람 이력을 보여줘"),
        ("monitoring", "메트릭 목록",           "EC2 네임스페이스의 사용 가능한 메트릭을 알려줘"),
        ("monitoring", "메모리 사용량",         "EC2 인스턴스 메모리 사용량을 확인해줘"),
        ("monitoring", "디스크 사용량",         "EBS 볼륨의 읽기/쓰기 IOPS를 확인해줘"),
        ("monitoring", "로그 분석",            "Lambda 함수의 에러 로그를 분석해줘"),
        # CloudTrail / CloudTrail
        ("monitoring", "CloudTrail",          "최근 CloudTrail 이벤트를 조회해줘"),
        ("monitoring", "API 감사",             "최근 1시간 동안 누가 어떤 API를 호출했는지 알려줘"),
        ("monitoring", "보안그룹 변경",         "보안그룹을 변경한 최근 이벤트를 찾아줘"),
        ("monitoring", "IAM 변경 추적",        "IAM 정책 변경 이력을 조회해줘"),
    ]),

    ("data", [
        # DynamoDB / DynamoDB
        ("data", "DynamoDB 목록",             "DynamoDB 테이블 목록을 보여줘"),
        ("data", "DynamoDB 상세",             "DynamoDB 테이블의 스키마와 인덱스를 확인해줘"),
        ("data", "DynamoDB 모델링",           "DynamoDB 데이터 모델링 가이드를 알려줘"),
        ("data", "DynamoDB 비용",             "DynamoDB 읽기 100회/초, 쓰기 50회/초 비용을 추정해줘"),
        # RDS / RDS
        ("data", "RDS 인스턴스",              "RDS 인스턴스 현황과 상태를 확인해줘"),
        ("data", "Aurora 클러스터",            "Aurora 클러스터 구성을 보여줘"),
        ("data", "RDS 스냅샷",                "RDS 스냅샷 목록을 확인해줘"),
        # ElastiCache / ElastiCache
        ("data", "ElastiCache",              "ElastiCache 클러스터 구성을 알려줘"),
        ("data", "복제 그룹",                 "ElastiCache 복제 그룹 상태를 확인해줘"),
        ("data", "캐시 모범사례",              "ElastiCache 모범사례를 알려줘"),
        # MSK / MSK
        ("data", "MSK Kafka",                "MSK Kafka 클러스터 정보를 보여줘"),
        ("data", "Kafka 브로커",              "Kafka 브로커 노드 목록과 엔드포인트를 알려줘"),
        ("data", "Kafka 모범사례",             "MSK Kafka 모범사례를 알려줘"),
    ]),

    ("aws-data", [
        # EC2 / EC2
        ("aws-data", "EC2 목록",              "EC2 인스턴스 목록을 보여줘"),
        ("aws-data", "EC2 상태별",             "실행 중인 EC2 인스턴스만 보여줘"),
        ("aws-data", "EC2 타입별",             "인스턴스 타입별 EC2 개수를 알려줘"),
        # S3 / S3
        ("aws-data", "S3 버킷",               "S3 버킷 현황을 정리해줘"),
        ("aws-data", "S3 공개 버킷",           "공개 접근 가능한 S3 버킷이 있는지 확인해줘"),
        # Lambda / Lambda
        ("aws-data", "Lambda 함수",           "Lambda 함수 목록과 런타임을 알려줘"),
        ("aws-data", "Lambda 메모리",          "Lambda 함수별 메모리 설정과 타임아웃을 보여줘"),
        # Cross-service / 서비스 간
        ("aws-data", "리소스 요약",            "전체 AWS 리소스 개수를 요약해줘"),
        ("aws-data", "VPC 보안그룹 수",        "VPC별 보안그룹 개수를 알려줘"),
        ("aws-data", "ALB 목록",              "Application Load Balancer 목록을 보여줘"),
        ("aws-data", "IAM 역할 수",           "IAM 역할 총 개수를 알려줘"),
        ("aws-data", "EBS 볼륨",              "EBS 볼륨 목록과 크기를 보여줘"),
        ("aws-data", "서브넷 목록",            "모든 서브넷의 CIDR과 가용영역을 알려줘"),
    ]),

    ("iac", [
        # CDK / CDK
        ("iac", "CDK 모범사례",               "CDK 모범사례를 알려줘"),
        ("iac", "CDK 예제",                   "CDK로 S3 버킷 만드는 예제를 보여줘"),
        ("iac", "CDK VPC",                    "CDK로 VPC와 서브넷을 만드는 방법을 알려줘"),
        ("iac", "CDK Lambda",                 "CDK로 Lambda 함수를 배포하는 방법을 알려줘"),
        # CloudFormation / CloudFormation
        ("iac", "CF 문서",                    "CloudFormation Lambda 리소스 문서를 찾아줘"),
        ("iac", "CF EC2 문서",                "CloudFormation EC2 Instance 속성을 알려줘"),
        # Terraform / Terraform
        ("iac", "Terraform 모듈",             "Terraform VPC 모듈을 검색해줘"),
        ("iac", "Terraform S3",              "Terraform으로 S3 버킷 만드는 문서를 찾아줘"),
        ("iac", "AWSCC 프로바이더",            "AWSCC 프로바이더의 Lambda 함수 문서를 찾아줘"),
    ]),

    ("code", [
        # Math / Algorithms / 수학 / 알고리즘
        ("code", "피보나치",                   "피보나치 수열 처음 20개를 파이썬으로 계산해줘"),
        ("code", "정렬 비교",                  "버블 정렬과 퀵 정렬의 성능을 비교하는 코드를 실행해줘"),
        ("code", "소수 분포",                  "1부터 100까지 소수를 구하고 분포를 보여주는 코드를 만들어줘"),
        ("code", "팩토리얼",                   "재귀와 반복문으로 20 팩토리얼을 각각 계산해줘"),
        # Data processing / 데이터 처리
        ("code", "JSON 파싱",                 "파이썬으로 샘플 JSON 데이터를 파싱하고 정리하는 코드를 실행해줘"),
        ("code", "CSV 생성",                  "파이썬으로 10개의 샘플 사용자 데이터를 CSV로 생성하는 코드를 만들어줘"),
        ("code", "통계 계산",                  "1부터 1000까지 랜덤 숫자 100개의 평균, 중앙값, 표준편차를 계산해줘"),
        ("code", "날짜 계산",                  "오늘부터 100일 후의 날짜와 요일을 파이썬으로 계산해줘"),
    ]),

    ("general", [
        # AWS documentation / AWS 문서
        ("general", "리전 가용성",             "서울 리전에서 Bedrock이 사용 가능한지 확인해줘"),
        ("general", "AWS 문서 검색",           "Lambda 동시성 제한에 대한 문서를 찾아줘"),
        ("general", "서비스 추천",             "실시간 스트리밍 처리에 적합한 AWS 서비스를 추천해줘"),
        ("general", "ECS vs EKS",            "ECS와 EKS의 차이점과 선택 기준을 알려줘"),
        ("general", "리전 목록",              "AWS 리전 목록을 보여줘"),
        ("general", "아키텍처 추천",           "서버리스 웹 앱 아키텍처를 추천해줘"),
    ]),

])

CATEGORIES = list(QUESTION_BANK.keys())
TOTAL_QUESTIONS = sum(len(qs) for qs in QUESTION_BANK.values())


# -- Content validation / 응답 내용 검증 ------------------------------------
# Patterns that indicate a failed or empty response / 실패 또는 빈 응답을 나타내는 패턴
FAIL_PATTERNS = [
    "직접 실행할 수 없",
    "직접 조회할 수 없",
    "직접 접근할 수 없",
    "도구가 실행 역할",
    "연결 불가",
    "연결 오류",
    "MCP 서버 연결",
    "Failed to obtain",
    "credentials",
    "InternalServerException",
    "tool_call>",
    "tool_response>",
]

# Minimum content length to consider valid / 유효한 최소 응답 길이
MIN_CONTENT_LENGTH = 100


def validate_content(content, route):
    """Validate response content quality. / 응답 내용 품질 검증.
    Returns (is_valid, issues) / (유효 여부, 문제 목록) 반환."""
    issues = []

    if not content:
        return False, ["empty response / 빈 응답"]

    if len(content) < MIN_CONTENT_LENGTH:
        issues.append(f"too short ({len(content)} chars) / 너무 짧음")

    # Check for failure patterns / 실패 패턴 확인
    content_lower = content.lower()
    for pattern in FAIL_PATTERNS:
        if pattern.lower() in content_lower:
            issues.append(f"fail pattern: '{pattern}'")

    # Check for raw tool tags exposed to user / 사용자에게 노출된 도구 태그 확인
    if "<tool_call>" in content or "<tool_response>" in content:
        issues.append("raw tool tags exposed / 도구 태그 노출")

    # Route-specific checks / 라우트별 검증
    if route == "code" and "```" not in content and "output" not in content_lower:
        issues.append("no code block or output / 코드 블록 또는 출력 없음")

    is_valid = len(issues) == 0
    return is_valid, issues


# -- API call / API 호출 ---------------------------------------------------
def call_ai(question):
    """Call AI API and return result dict. / AI API 호출 후 결과 딕셔너리 반환."""
    payload = json.dumps({"messages": [{"role": "user", "content": question}]}).encode()
    req = urllib.request.Request(URL, data=payload, headers={"Content-Type": "application/json"})
    start = time.time()
    try:
        resp = urllib.request.urlopen(req, timeout=TIMEOUT)
        elapsed = time.time() - start
        data = json.loads(resp.read())
        content = data.get("content", "")
        route = data.get("route", "?")
        is_valid, issues = validate_content(content, route)
        return {
            "time": elapsed,
            "route": route,
            "via": data.get("via", "?"),
            "content_length": len(content),
            "content_preview": content[:200].replace("\n", " "),
            "content_valid": is_valid,
            "content_issues": issues,
            "error": None,
        }
    except Exception as e:
        return {
            "time": time.time() - start,
            "route": "?",
            "via": "?",
            "content_length": 0,
            "content_preview": "",
            "content_valid": False,
            "content_issues": [f"request error: {str(e)[:80]}"],
            "error": str(e)[:100],
        }


# -- Interactive menu / 대화형 메뉴 -----------------------------------------
def show_menu():
    """Show interactive category and question selection menu. / 대화형 선택 메뉴 표시."""
    print(f"\n{'='*70}")
    print(f"  AWSops AI Route Test — Interactive Mode")
    print(f"  URL: {URL}  |  Timeout: {TIMEOUT}s")
    print(f"{'='*70}\n")
    print("  카테고리 선택 / Select category:\n")
    print(f"   {'#':<4} {'Category':<14} {'Questions':>9}  Description")
    print(f"   {'-'*60}")
    print(f"   {'0':<4} {'ALL':<14} {TOTAL_QUESTIONS:>9}  전체 실행 / Run all")
    print(f"   {'Q':<4} {'QUICK':<14} {len(CATEGORIES):>9}  카테고리별 1개 / 1 per category")
    print()

    cat_descriptions = {
        "security":   "IAM 보안 점검, 사용자/역할/정책 분석",
        "infra":      "VPC, EKS, ECS, TGW, 네트워크 진단",
        "cost":       "비용 분석, 비교, 예측, FinOps",
        "monitoring": "CloudWatch 알람/메트릭, CloudTrail 감사",
        "data":       "DynamoDB, RDS, ElastiCache, MSK",
        "aws-data":   "Steampipe SQL로 리소스 조회",
        "iac":        "CDK, Terraform, CloudFormation",
        "code":       "Python 코드 실행 (Code Interpreter)",
        "general":    "AWS 문서, 리전 가용성, 추천",
    }

    for i, cat in enumerate(CATEGORIES, 1):
        qs = QUESTION_BANK[cat]
        desc = cat_descriptions.get(cat, "")
        print(f"   {i:<4} {cat:<14} {len(qs):>9}  {desc}")

    print()
    choice = input("  선택 (번호/이름, 쉼표 구분 가능) / Choice: ").strip()

    if not choice:
        return None
    if choice.upper() == "Q":
        return "quick"
    if choice == "0":
        return "all"

    # Parse selection / 선택 파싱
    selected = []
    for part in choice.split(","):
        part = part.strip()
        if part.isdigit():
            idx = int(part)
            if 1 <= idx <= len(CATEGORIES):
                selected.append(CATEGORIES[idx - 1])
        elif part in CATEGORIES:
            selected.append(part)

    if not selected:
        print("  잘못된 입력 / Invalid input")
        return None

    return selected


def select_questions(category):
    """Show questions in a category and let user select. / 카테고리 내 질문 선택."""
    questions = QUESTION_BANK[category]
    print(f"\n  [{category.upper()}] 질문 선택 / Select questions:\n")
    print(f"   {'#':<4} {'Label':<20} Question")
    print(f"   {'-'*65}")
    print(f"   {'0':<4} {'ALL':<20} 전체 실행 / Run all ({len(questions)})")

    for i, (_, label, question) in enumerate(questions, 1):
        print(f"   {i:<4} {label:<20} {question[:50]}")

    print()
    choice = input(f"  선택 (번호, 쉼표 구분, 0=전체) [{category}]: ").strip()

    if not choice or choice == "0":
        return questions

    selected = []
    for part in choice.split(","):
        part = part.strip()
        if part.isdigit():
            idx = int(part)
            if 1 <= idx <= len(questions):
                selected.append(questions[idx - 1])

    return selected if selected else questions


# -- Run tests / 테스트 실행 ------------------------------------------------
def run_tests(test_list):
    """Run selected tests and print results. / 선택된 테스트 실행 및 결과 출력."""
    print(f"\n{'='*90}")
    print(f"  AWSops AI Route Test — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  URL: {URL}  |  Timeout: {TIMEOUT}s  |  Questions: {len(test_list)}")
    print(f"{'='*90}\n")

    results = []
    pass_count = 0
    fail_count = 0
    content_ok = 0
    content_warn = 0
    route_match = 0
    total_time = 0

    for i, (expected_route, label, question) in enumerate(test_list, 1):
        print(f"  [{i:2d}/{len(test_list)}] {label:<20} {question[:36]:<36} ", end="", flush=True)
        result = call_ai(question)
        result["label"] = label
        result["question"] = question
        result["expected_route"] = expected_route

        elapsed = result["time"]
        total_time += elapsed

        if result["error"]:
            fail_count += 1
            result["status"] = "FAIL"
            print(f" {elapsed:>5.1f}s  ❌ {result['error'][:45]}")
        else:
            pass_count += 1
            matched = result["route"] == expected_route
            if matched:
                route_match += 1
            match_icon = "✓" if matched else "✗"

            # Content validation result / 응답 내용 검증 결과
            if result["content_valid"]:
                content_ok += 1
                quality = "📗"
                result["status"] = "OK"
            else:
                content_warn += 1
                quality = "📙"
                result["status"] = "WARN"

            print(f" {elapsed:>5.1f}s  {quality} route={result['route']:<11} {match_icon} {result['content_length']:>5}ch {result['via'][:28]}")

            # Show content issues if any / 내용 문제 표시
            if result["content_issues"]:
                for issue in result["content_issues"]:
                    print(f"         ⚠ {issue}")

        results.append(result)

    # Summary / 요약
    total = len(test_list)
    avg_time = total_time / total if total else 0
    ok_times = [r["time"] for r in results if not r["error"]]
    min_time = min(ok_times) if ok_times else 0
    max_time = max(ok_times) if ok_times else 0

    print(f"\n{'='*90}")
    print(f"  SUMMARY / 요약")
    print(f"{'='*90}")
    print(f"  API Status:   {pass_count} passed / {fail_count} failed / {total} total")
    print(f"  Content:      📗 {content_ok} valid / 📙 {content_warn} issues / ❌ {fail_count} errors")
    if total:
        print(f"  Route match:  {route_match}/{total} ({route_match/total*100:.0f}%)")
    print(f"  Avg time:     {avg_time:.1f}s")
    print(f"  Min / Max:    {min_time:.1f}s / {max_time:.1f}s")
    print(f"  Total time:   {total_time:.1f}s")
    print()

    # Per-route stats / 라우트별 통계
    route_stats = {}
    for r in results:
        key = r["route"] if not r["error"] else "error"
        if key not in route_stats:
            route_stats[key] = {"count": 0, "total_time": 0, "errors": 0, "match": 0, "valid": 0, "warn": 0}
        route_stats[key]["count"] += 1
        route_stats[key]["total_time"] += r["time"]
        if r["error"]:
            route_stats[key]["errors"] += 1
        elif r["route"] == r["expected_route"]:
            route_stats[key]["match"] += 1
        if r.get("content_valid"):
            route_stats[key]["valid"] += 1
        elif not r["error"] and not r.get("content_valid"):
            route_stats[key]["warn"] += 1

    print(f"  {'Route':<14} {'Count':>5} {'Avg':>8} {'Match':>6} {'📗':>5} {'📙':>5} {'❌':>5}")
    print(f"  {'-'*55}")
    for route, s in sorted(route_stats.items()):
        avg = s["total_time"] / s["count"]
        print(f"  {route:<14} {s['count']:>5} {avg:>7.1f}s {s['match']:>6} {s['valid']:>5} {s['warn']:>5} {s['errors']:>5}")

    # Save JSON report / JSON 리포트 저장
    output_file = f"/tmp/ai-test-results-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    report = {
        "timestamp": datetime.now().isoformat(),
        "url": URL, "timeout": TIMEOUT,
        "summary": {
            "passed": pass_count, "failed": fail_count, "total": total,
            "content_valid": content_ok, "content_issues": content_warn,
            "route_match": route_match,
            "avg_time_sec": round(avg_time, 2),
            "min_time_sec": round(min_time, 2),
            "max_time_sec": round(max_time, 2),
            "total_time_sec": round(total_time, 2),
        },
        "results": results,
    }
    with open(output_file, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\n  Results saved: {output_file}\n")

    return results


# -- Main / 메인 -----------------------------------------------------------
def main():
    # CLI modes / CLI 모드
    if "--all" in sys.argv:
        all_tests = [q for qs in QUESTION_BANK.values() for q in qs]
        run_tests(all_tests)
        return

    if "--quick" in sys.argv:
        quick = [qs[0] for qs in QUESTION_BANK.values()]
        run_tests(quick)
        return

    if "--cat" in sys.argv:
        idx = sys.argv.index("--cat")
        if idx + 1 < len(sys.argv):
            cats = [c.strip() for c in sys.argv[idx + 1].split(",")]
            tests = []
            for c in cats:
                if c in QUESTION_BANK:
                    tests.extend(QUESTION_BANK[c])
                else:
                    print(f"  Unknown category: {c}")
                    print(f"  Available: {', '.join(CATEGORIES)}")
                    return
            run_tests(tests)
            return

    # Interactive mode / 대화형 모드
    selection = show_menu()

    if selection is None:
        return
    elif selection == "all":
        all_tests = [q for qs in QUESTION_BANK.values() for q in qs]
        run_tests(all_tests)
    elif selection == "quick":
        quick = [qs[0] for qs in QUESTION_BANK.values()]
        run_tests(quick)
    elif isinstance(selection, list):
        if len(selection) == 1:
            # Single category: allow question selection / 단일 카테고리: 질문 선택
            tests = select_questions(selection[0])
            run_tests(tests)
        else:
            # Multiple categories: run all in each / 복수 카테고리: 각각 전체 실행
            tests = []
            for cat in selection:
                tests.extend(QUESTION_BANK[cat])
            run_tests(tests)


if __name__ == "__main__":
    main()
