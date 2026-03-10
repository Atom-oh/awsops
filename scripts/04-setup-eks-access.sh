#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 4: EKS 접근 설정 / EKS Access Setup                                   #
#                                                                              #
#   설정 내용 / What this does:                                                 #
#     1. kubectl 설치 / Install kubectl                                        #
#     2. EKS 클러스터 탐색 / Discover EKS clusters                             #
#     3. kubeconfig 설정 / Configure kubeconfig                                #
#     4. EKS 접근 항목 등록 / Register access entry (API mode)                  #
#     5. Steampipe kubernetes 플러그인 설정 / Configure K8s plugin              #
#     6. 연결 테스트 / Test connection                                          #
#                                                                              #
#   필요 권한 / Required permissions:                                           #
#     EC2 역할: eks:*, iam:GetRole (ReadOnlyAccess에 포함)                      #
#     EKS: API 인증 모드 또는 aws-auth ConfigMap 수정 권한                       #
#                                                                              #
################################################################################

# -- 색상 / Colors ------------------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
BOLD='\033[1m'; DIM='\033[2m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 4: EKS 접근 설정 / EKS Access Setup${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""
echo "  리전 / Region:  $REGION"
echo "  계정 / Account: $ACCOUNT_ID"
echo ""

###############################################################################
#  [1/6] kubectl 설치 / Install kubectl                                        #
###############################################################################
echo -e "${CYAN}[1/6] kubectl 설치 / Install kubectl...${NC}"

if command -v kubectl &>/dev/null; then
    echo "  이미 설치됨 / Already installed: $(kubectl version --client --short 2>/dev/null || kubectl version --client 2>/dev/null | head -1)"
else
    echo "  kubectl 설치 중... / Installing kubectl..."
    ARCH=$(uname -m)
    if [ "$ARCH" = "aarch64" ]; then
        KUBECTL_ARCH="arm64"
    else
        KUBECTL_ARCH="amd64"
    fi
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/${KUBECTL_ARCH}/kubectl"
    sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
    rm -f kubectl
    echo "  설치 완료 / Installed: $(kubectl version --client --short 2>/dev/null || echo OK)"
fi

###############################################################################
#  [2/6] EKS 클러스터 탐색 / Discover EKS clusters                             #
###############################################################################
echo ""
echo -e "${CYAN}[2/6] EKS 클러스터 탐색 / Discovering EKS clusters...${NC}"

# 현재 리전의 클러스터 / Clusters in current region
CLUSTERS=$(aws eks list-clusters --region "$REGION" --query "clusters" --output text 2>/dev/null || echo "")

if [ -z "$CLUSTERS" ]; then
    # 다른 리전도 검색 / Search other regions
    echo -e "  ${YELLOW}$REGION 에 EKS 클러스터 없음. 다른 리전 검색 중...${NC}"
    echo -e "  ${YELLOW}No clusters in $REGION. Searching other regions...${NC}"

    ALL_CLUSTERS=""
    for R in ap-northeast-2 us-east-1 us-west-2 eu-west-1 ap-northeast-1 ap-southeast-1; do
        RC=$(aws eks list-clusters --region "$R" --query "clusters" --output text 2>/dev/null || echo "")
        if [ -n "$RC" ]; then
            for C in $RC; do
                ALL_CLUSTERS="$ALL_CLUSTERS $R:$C"
            done
        fi
    done

    if [ -z "$ALL_CLUSTERS" ]; then
        echo -e "  ${YELLOW}EKS 클러스터를 찾을 수 없습니다.${NC}"
        echo -e "  ${YELLOW}No EKS clusters found in any common region.${NC}"
        echo ""
        echo "  이 스크립트는 EKS 클러스터가 생성된 후 다시 실행하세요."
        echo "  Run this script again after creating an EKS cluster."
        exit 0
    fi

    echo ""
    echo -e "  ${BOLD}다른 리전에서 발견된 클러스터 / Clusters found in other regions:${NC}"
    echo ""
    CLUSTER_LIST=()
    IDX=0
    for ENTRY in $ALL_CLUSTERS; do
        IDX=$((IDX + 1))
        CR="${ENTRY%%:*}"
        CN="${ENTRY##*:}"
        printf "    %2d) %-30s (리전: %s)\n" "$IDX" "$CN" "$CR"
        CLUSTER_LIST+=("$ENTRY")
    done
else
    echo ""
    echo -e "  ${BOLD}$REGION 리전의 EKS 클러스터 / EKS clusters in $REGION:${NC}"
    echo ""
    CLUSTER_LIST=()
    IDX=0
    for C in $CLUSTERS; do
        IDX=$((IDX + 1))
        VERSION=$(aws eks describe-cluster --name "$C" --region "$REGION" --query "cluster.version" --output text 2>/dev/null || echo "?")
        STATUS=$(aws eks describe-cluster --name "$C" --region "$REGION" --query "cluster.status" --output text 2>/dev/null || echo "?")
        printf "    %2d) %-30s v%-6s [%s]\n" "$IDX" "$C" "$VERSION" "$STATUS"
        CLUSTER_LIST+=("$REGION:$C")
    done
fi

echo ""
echo "     0) 모든 클러스터 설정 / Configure all clusters"
echo ""
read -p "  클러스터 선택 (번호 또는 0) / Select cluster (number or 0) [0]: " CLUSTER_SELECT
CLUSTER_SELECT="${CLUSTER_SELECT:-0}"

SELECTED_CLUSTERS=()
if [ "$CLUSTER_SELECT" = "0" ]; then
    SELECTED_CLUSTERS=("${CLUSTER_LIST[@]}")
elif [[ "$CLUSTER_SELECT" =~ ^[0-9]+$ ]] && [ "$CLUSTER_SELECT" -ge 1 ] && [ "$CLUSTER_SELECT" -le "${#CLUSTER_LIST[@]}" ]; then
    SELECTED_CLUSTERS=("${CLUSTER_LIST[$((CLUSTER_SELECT-1))]}")
fi

if [ ${#SELECTED_CLUSTERS[@]} -eq 0 ]; then
    echo -e "  ${YELLOW}선택된 클러스터 없음 / No cluster selected${NC}"
    exit 0
fi

echo -e "  ${GREEN}${#SELECTED_CLUSTERS[@]}개 클러스터 설정 예정 / Will configure ${#SELECTED_CLUSTERS[@]} cluster(s)${NC}"

###############################################################################
#  [3/6] kubeconfig 설정 / Configure kubeconfig                                #
###############################################################################
echo ""
echo -e "${CYAN}[3/6] kubeconfig 설정 / Configuring kubeconfig...${NC}"

mkdir -p ~/.kube

for ENTRY in "${SELECTED_CLUSTERS[@]}"; do
    CR="${ENTRY%%:*}"
    CN="${ENTRY##*:}"
    echo "  $CN ($CR)..."
    # ec2-user 홈에 kubeconfig 생성 (SSM은 root로 실행되므로 명시적 경로 지정)
    # Explicit path since SSM runs as root, but Steampipe/Next.js runs as ec2-user
    aws eks update-kubeconfig --name "$CN" --region "$CR" \
        --kubeconfig /home/ec2-user/.kube/config 2>&1 | sed 's/^/    /'
done
chown -R ec2-user:ec2-user /home/ec2-user/.kube 2>/dev/null || true

echo "  kubeconfig 위치 / Location: ~/.kube/config"
echo "  컨텍스트 목록 / Contexts:"
kubectl config get-contexts --no-headers 2>/dev/null | awk '{printf "    %s %s\n", $1, $2}' || echo "    (없음 / none)"

###############################################################################
#  [4/6] EKS 접근 항목 등록 / Register EKS access entry                        #
###############################################################################
echo ""
echo -e "${CYAN}[4/6] EKS 접근 항목 등록 / Registering access entry...${NC}"

# EC2 역할 ARN 조회 / Get EC2 role ARN
# sts:assumed-role → iam:role 변환 / Convert sts:assumed-role to iam:role format
EC2_ROLE_ARN=$(aws sts get-caller-identity --query "Arn" --output text 2>/dev/null \
    | sed 's|:assumed-role/|:role/|; s|/i-.*||; s|:sts:|:iam:|')
echo "  EC2 역할 / EC2 Role: $EC2_ROLE_ARN"

for ENTRY in "${SELECTED_CLUSTERS[@]}"; do
    CR="${ENTRY%%:*}"
    CN="${ENTRY##*:}"
    echo ""
    echo "  클러스터 / Cluster: $CN ($CR)"

    # 인증 모드 확인 / Check authentication mode
    AUTH_MODE=$(aws eks describe-cluster --name "$CN" --region "$CR" \
        --query "cluster.accessConfig.authenticationMode" --output text 2>/dev/null || echo "UNKNOWN")
    echo "    인증 모드 / Auth mode: $AUTH_MODE"

    if [ "$AUTH_MODE" = "API" ] || [ "$AUTH_MODE" = "API_AND_CONFIG_MAP" ]; then
        # API 모드: access entry 등록 / API mode: create access entry
        echo "    API 접근 항목 등록 중... / Creating access entry..."
        aws eks create-access-entry \
            --cluster-name "$CN" --region "$CR" \
            --principal-arn "$EC2_ROLE_ARN" \
            --type STANDARD 2>/dev/null && \
        echo -e "    ${GREEN}✓ 접근 항목 생성됨 / Access entry created${NC}" || \
        echo -e "    ${YELLOW}이미 존재하거나 권한 부족 / Already exists or insufficient permission${NC}"

        # 정책 연결 / Associate policy
        aws eks associate-access-policy \
            --cluster-name "$CN" --region "$CR" \
            --principal-arn "$EC2_ROLE_ARN" \
            --policy-arn "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy" \
            --access-scope type=cluster 2>/dev/null && \
        echo -e "    ${GREEN}✓ ClusterAdmin 정책 연결됨 / ClusterAdmin policy associated${NC}" || \
        echo -e "    ${YELLOW}정책 이미 연결됨 또는 권한 부족 / Policy already associated or insufficient permission${NC}"

    elif [ "$AUTH_MODE" = "CONFIG_MAP" ]; then
        # ConfigMap 모드: aws-auth 수동 수정 안내 / ConfigMap mode: manual edit needed
        echo -e "    ${YELLOW}⚠ CONFIG_MAP 모드: aws-auth ConfigMap에 수동 추가 필요${NC}"
        echo -e "    ${YELLOW}  CONFIG_MAP mode: manual aws-auth ConfigMap edit needed${NC}"
        echo ""
        echo "    다음 명령을 EKS 관리자 권한으로 실행하세요:"
        echo "    Run with EKS admin credentials:"
        echo ""
        echo "    kubectl edit configmap aws-auth -n kube-system"
        echo ""
        echo "    mapRoles에 추가 / Add to mapRoles:"
        echo "    - rolearn: $EC2_ROLE_ARN"
        echo "      username: awsops-ec2"
        echo "      groups:"
        echo "        - system:masters"
    else
        echo -e "    ${YELLOW}인증 모드 확인 불가 / Cannot determine auth mode${NC}"
    fi
done

###############################################################################
#  [5/6] Steampipe kubernetes 플러그인 설정 / Configure K8s plugin              #
###############################################################################
echo ""
echo -e "${CYAN}[5/6] Steampipe kubernetes 플러그인 설정 / Configuring K8s plugin...${NC}"

# kubernetes.spc 설정 / Configure kubernetes.spc
cat > ~/.steampipe/config/kubernetes.spc << 'EOF'
connection "kubernetes" {
  plugin = "kubernetes"

  # 모든 kubeconfig 컨텍스트 사용 / Use all kubeconfig contexts
  # config_paths = ["~/.kube/config"]

  # 모든 CRD 테이블 활성화 (Istio 포함) / Enable all CRD tables (including Istio)
  custom_resource_tables = ["*"]
}
EOF

echo "  kubernetes.spc 설정 완료 / configured"
echo "  CRD 테이블 활성화 / CRD tables enabled (Istio 포함 / including Istio)"

# Steampipe 재시작 / Restart Steampipe
echo "  Steampipe 재시작 중... / Restarting Steampipe..."
steampipe service restart --database-listen network --database-port 9193 2>&1 | tail -3

###############################################################################
#  [6/6] 연결 테스트 / Test connection                                          #
###############################################################################
echo ""
echo -e "${CYAN}[6/6] 연결 테스트 / Testing connection...${NC}"

for ENTRY in "${SELECTED_CLUSTERS[@]}"; do
    CR="${ENTRY%%:*}"
    CN="${ENTRY##*:}"
    CONTEXT="arn:aws:eks:${CR}:${ACCOUNT_ID}:cluster/${CN}"
    echo ""
    echo "  클러스터 / Cluster: $CN ($CR)"

    # kubectl 테스트 (ec2-user로 실행) / kubectl test (run as ec2-user)
    echo -n "    kubectl:    "
    KUBECONFIG=/home/ec2-user/.kube/config
    if sudo -u ec2-user kubectl get nodes --context "$CONTEXT" --request-timeout=10s &>/dev/null; then
        NODE_COUNT=$(sudo -u ec2-user kubectl get nodes --context "$CONTEXT" --no-headers 2>/dev/null | wc -l)
        echo -e "${GREEN}✓ 연결됨 / Connected ($NODE_COUNT nodes)${NC}"
    else
        echo -e "${RED}✗ 연결 실패 / Connection failed${NC}"
        echo -e "    ${YELLOW}  EKS 접근 항목 등록을 확인하세요 / Check access entry registration${NC}"
    fi

    # Steampipe 테스트 (ec2-user로 실행) / Steampipe test (run as ec2-user)
    echo -n "    steampipe:  "
    SP_RESULT=$(sudo -u ec2-user steampipe query "SELECT count(*) as cnt FROM kubernetes_namespace" --output json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('rows',[{}])[0].get('cnt','0'))" 2>/dev/null || echo "0")
    if [ "$SP_RESULT" != "0" ] && [ -n "$SP_RESULT" ]; then
        echo -e "${GREEN}✓ 조회됨 / Working ($SP_RESULT namespaces)${NC}"
    else
        echo -e "${YELLOW}⚠ 데이터 없음 (연결 확인 필요) / No data (check connection)${NC}"
    fi
done

###############################################################################
#  요약 / Summary                                                               #
###############################################################################
echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Step 4 완료: EKS 접근 설정 / EKS Access Configured${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  설정된 클러스터 / Configured clusters: ${#SELECTED_CLUSTERS[@]}"
echo "  kubeconfig:  ~/.kube/config"
echo "  kubernetes.spc: ~/.steampipe/config/kubernetes.spc"
echo ""
echo -e "  ${BOLD}대시보드에서 확인 가능한 항목 / Dashboard features:${NC}"
echo "    - /awsops/k8s          : K8s 개요 (노드, 파드, 네임스페이스)"
echo "    - /awsops/k8s/pods     : 파드 목록 및 상태"
echo "    - /awsops/k8s/nodes    : 노드 목록 및 리소스"
echo "    - /awsops/k8s/deployments : 디플로이먼트"
echo "    - /awsops/k8s/services : 서비스"
echo "    - /awsops/k8s/explorer : K9s 스타일 탐색기"
echo ""
echo -e "  ${YELLOW}⚠ EKS 접근이 안 되는 경우:${NC}"
echo "    1. EKS 클러스터 인증 모드를 'API' 또는 'API_AND_CONFIG_MAP'으로 변경"
echo "    2. 또는 aws-auth ConfigMap에 EC2 역할 수동 추가"
echo "    3. EC2 역할에 ReadOnlyAccess 또는 eks:* 권한 확인"
echo ""
