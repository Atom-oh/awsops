// AI routing API: routes user messages to the appropriate backend / AI 라우팅 API: 사용자 메시지를 적절한 백엔드로 라우팅
// Priority: Code Interpreter → Infra → IaC → Data → Security → Monitoring → Cost → AWSData → Ops → Fallback
// 우선순위: 코드 인터프리터 → 인프라 → IaC → 데이터 → 보안 → 모니터링 → 비용 → AWS데이터 → 운영 → 폴백
import { NextRequest, NextResponse } from 'next/server';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
  StartCodeInterpreterSessionCommand,
  InvokeCodeInterpreterCommand,
  StopCodeInterpreterSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { runQuery } from '@/lib/steampipe';

// Service configuration / 서비스 설정
const BEDROCK_REGION = 'us-east-1';           // Bedrock model region / Bedrock 모델 리전
const AGENTCORE_REGION = 'ap-northeast-2';    // AgentCore Runtime region / AgentCore Runtime 리전
const AGENT_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-northeast-2:605134447633:runtime/awsops_agent-zMwFdo9X4Y';
const CODE_INTERPRETER_ID = 'awsops_code_interpreter-pnEkzLpDfH';

// Available Bedrock models / 사용 가능한 Bedrock 모델
const MODELS: Record<string, string> = {
  'sonnet-4.6': 'us.anthropic.claude-sonnet-4-6',
  'opus-4.6': 'us.anthropic.claude-opus-4-6-v1',
};

// AWS SDK clients / AWS SDK 클라이언트
const bedrockClient = new BedrockRuntimeClient({ region: BEDROCK_REGION });
const agentCoreClient = new BedrockAgentCoreClient({ region: AGENTCORE_REGION });

const SYSTEM_PROMPT = `You are AWSops AI Assistant, an expert in AWS cloud operations.
You help users understand and manage their AWS infrastructure.
You have access to real-time AWS resource data via Steampipe queries.
When users ask about their resources, analyze the data provided.
Always be concise and provide actionable insights.
Format responses in markdown for readability.
When discussing security issues, prioritize them by severity.
Respond in the same language as the user's question.`;

async function queryAWS(sql: string): Promise<string> {
  try {
    const result = await runQuery(sql);
    if (result.error) return `Query error: ${result.error}`;
    if (result.rows.length === 0) return 'No results found.';
    return JSON.stringify(result.rows.slice(0, 20), null, 2);
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function detectQueries(message: string): Record<string, string> {
  const queries: Record<string, string> = {};
  const lower = message.toLowerCase();
  if (lower.includes('ec2') || lower.includes('instance') || lower.includes('서버'))
    queries.ec2 = "SELECT instance_id, tags ->> 'Name' AS name, instance_type, instance_state, private_ip_address, public_ip_address FROM aws_ec2_instance ORDER BY instance_state";
  if (lower.includes('s3') || lower.includes('bucket') || lower.includes('스토리지'))
    queries.s3 = "SELECT name, region, versioning_enabled, bucket_policy_is_public FROM aws_s3_bucket";
  if (lower.includes('rds') || lower.includes('database') || lower.includes('db') || lower.includes('데이터베이스'))
    queries.rds = "SELECT db_instance_identifier, engine, engine_version, class AS instance_class, status, allocated_storage, multi_az FROM aws_rds_db_instance";
  if (lower.includes('vpc') || lower.includes('network') || lower.includes('네트워크'))
    queries.vpc = "SELECT vpc_id, cidr_block, state, tags ->> 'Name' AS name FROM aws_vpc";
  if (lower.includes('lambda') || lower.includes('함수') || lower.includes('serverless'))
    queries.lambda = "SELECT name, runtime, memory_size, timeout FROM aws_lambda_function";
  if (lower.includes('security') || lower.includes('보안') || lower.includes('sg'))
    queries.security = "SELECT group_id, group_name, vpc_id FROM aws_vpc_security_group LIMIT 20";
  if (lower.includes('iam') || lower.includes('user') || lower.includes('role') || lower.includes('사용자'))
    queries.iam = "SELECT name, arn, create_date FROM aws_iam_user UNION ALL SELECT name, arn, create_date FROM aws_iam_role LIMIT 20";
  if (lower.includes('cost') || lower.includes('비용') || lower.includes('billing'))
    queries.cost = "SELECT service AS name, ROUND(CAST(SUM(unblended_cost_amount) AS numeric), 2) AS value FROM aws_cost_by_service_monthly WHERE period_start >= (CURRENT_DATE - INTERVAL '1 month') GROUP BY service HAVING SUM(unblended_cost_amount) > 0 ORDER BY value DESC LIMIT 15";
  if (lower.includes('k8s') || lower.includes('kubernetes') || lower.includes('eks') || lower.includes('pod'))
    queries.k8s = "SELECT name, namespace, phase, node_name FROM kubernetes_pod WHERE phase = 'Running' LIMIT 20";
  if (lower.includes('elb') || lower.includes('load balancer') || lower.includes('로드밸런서'))
    queries.elb = "SELECT name, type, scheme, state_code, vpc_id, dns_name FROM aws_ec2_application_load_balancer";
  if (Object.keys(queries).length === 0 && (lower.includes('현황') || lower.includes('overview') || lower.includes('summary') || lower.includes('리소스') || lower.includes('전체')))
    queries.overview = "SELECT 'EC2' AS resource, COUNT(*) AS count FROM aws_ec2_instance UNION ALL SELECT 'VPC', COUNT(*) FROM aws_vpc UNION ALL SELECT 'RDS', COUNT(*) FROM aws_rds_db_instance UNION ALL SELECT 'Lambda', COUNT(*) FROM aws_lambda_function UNION ALL SELECT 'S3', COUNT(*) FROM aws_s3_bucket";
  return queries;
}

// Code execution keywords → route to Code Interpreter / 코드 실행 키워드 → 코드 인터프리터로 라우팅
// Detects requests to run Python code or perform calculations / Python 코드 실행 또는 계산 요청 감지
function needsCodeInterpreter(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ['코드 실행', 'execute', 'run code', '계산'];
  return keywords.some(k => lower.includes(k));
}

// Extract python code blocks from AI response text / AI 응답 텍스트에서 Python 코드 블록 추출
function extractPythonCode(text: string): string | null {
  const match = text.match(/```python\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

// Execute code via Code Interpreter / 코드 인터프리터를 통해 코드 실행
// Creates a session, runs Python code, collects output, then stops session / 세션 생성, Python 코드 실행, 출력 수집 후 세션 종료
async function executeCodeInterpreter(code: string): Promise<{ output: string; exitCode: number }> {
  let sessionId: string | undefined;
  try {
    const startResp = await agentCoreClient.send(
      new StartCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: CODE_INTERPRETER_ID,
      })
    );
    sessionId = startResp.sessionId;
    if (!sessionId) throw new Error('No sessionId returned');

    const invokeResp = await agentCoreClient.send(
      new InvokeCodeInterpreterCommand({
        codeInterpreterIdentifier: CODE_INTERPRETER_ID,
        sessionId,
        name: 'executeCode',
        arguments: { code, language: 'python' } as any,
      })
    );

    let output = '';
    let exitCode = 0;

    if (invokeResp.stream) {
      for await (const event of invokeResp.stream) {
        if (event.result) {
          const content = event.result.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.text) output += block.text;
            }
          }
        }
        if ('error' in event) {
          output += `Error: ${JSON.stringify((event as any).error)}`;
          exitCode = 1;
        }
      }
    }

    await agentCoreClient.send(
      new StopCodeInterpreterSessionCommand({
        codeInterpreterIdentifier: CODE_INTERPRETER_ID,
        sessionId,
      })
    ).catch(() => {});

    return { output: output || '(no output)', exitCode };
  } catch (err: any) {
    if (sessionId) {
      await agentCoreClient.send(
        new StopCodeInterpreterSessionCommand({
          codeInterpreterIdentifier: CODE_INTERPRETER_ID,
          sessionId,
        })
      ).catch(() => {});
    }
    return { output: `Code execution failed: ${err.message}`, exitCode: 1 };
  }
}

// Infrastructure keywords → route to Infra Gateway (network + EKS + ECS + Istio) / 인프라 키워드 → 인프라 게이트웨이로 라우팅 (네트워크 + EKS + ECS + Istio)
// Matches networking, container orchestration, and service mesh terms / 네트워킹, 컨테이너 오케스트레이션, 서비스 메시 관련 용어 매칭
function needsInfra(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ['eni','reachability','연결 확인','경로 분석','flow log','플로우','route table',
    '라우트','라우팅','security group rule','sg rule','보안그룹 규칙','vpn','트러블슈팅','troubleshoot',
    'network path','네트워크 경로','connectivity','연결성','find ip','ip 찾','ip 검색',
    'eks','kubernetes','k8s cluster','클러스터','node group','pod log','container insight',
    'ecs','fargate','task definition','태스크','서비스 이벤트','ecr','컨테이너',
    'istio','service mesh','서비스 메시','virtualservice','destinationrule','sidecar','envoy','mtls'];
  return keywords.some(k => lower.includes(k));
}

// Data & Analytics keywords → route to Data Gateway / 데이터 및 분석 키워드 → 데이터 게이트웨이로 라우팅
// Matches database (DynamoDB, RDS, ElastiCache) and streaming (MSK) terms / 데이터베이스(DynamoDB, RDS, ElastiCache)와 스트리밍(MSK) 관련 용어 매칭
function needsData(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ['dynamodb','dynamo','rds','aurora','mysql','postgres','postgresql',
    'database','데이터베이스','db instance','db cluster','elasticache','valkey','redis',
    'memcached','cache cluster','replication group','msk','kafka','broker','topic',
    'partition','consumer','producer','스트리밍'];
  return keywords.some(k => lower.includes(k));
}

// Security keywords → route to Security Gateway (IAM) / 보안 키워드 → 보안 게이트웨이로 라우팅 (IAM)
// Matches IAM, policy, access control, and credential management terms / IAM, 정책, 접근 제어, 자격 증명 관리 관련 용어 매칭
function needsSecurity(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ['iam','사용자 권한','role policy','역할 정책','policy simulation','정책 시뮬레이션',
    'access key','액세스 키','mfa','인라인 정책','inline policy','trust policy','신뢰 정책',
    'least privilege','최소 권한','security summary','보안 요약','who has access','권한 확인'];
  return keywords.some(k => lower.includes(k));
}

// Monitoring keywords → route to Monitoring Gateway (CloudWatch + CloudTrail) / 모니터링 키워드 → 모니터링 게이트웨이로 라우팅 (CloudWatch + CloudTrail)
// Matches observability, metrics, alarms, logs, and audit trail terms / 관측성, 메트릭, 알람, 로그, 감사 추적 관련 용어 매칭
function needsMonitoring(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ['cloudwatch','metric','메트릭','alarm','알람','경보','log group','로그 그룹',
    'log insights','cloudtrail','이벤트 조회','api 호출','audit','감사','누가','who did',
    'cpu utilization','memory utilization','disk','네트워크 트래픽'];
  return keywords.some(k => lower.includes(k));
}

// Cost keywords → route to Cost Gateway / 비용 키워드 → 비용 게이트웨이로 라우팅
// Matches FinOps, billing, budgets, pricing, and optimization terms / FinOps, 청구, 예산, 가격, 최적화 관련 용어 매칭
function needsCost(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ['cost','비용','billing','청구','forecast','예측','budget','예산',
    'pricing','가격','spend','지출','savings','절감','optimization','최적화',
    'cost explorer','월별','monthly cost','daily cost'];
  return keywords.some(k => lower.includes(k));
}

// IaC keywords → route to IaC Gateway (CDK, CloudFormation, Terraform) / IaC 키워드 → IaC 게이트웨이로 라우팅 (CDK, CloudFormation, Terraform)
// Matches Infrastructure as Code tools and deployment terms / IaC 도구 및 배포 관련 용어 매칭
function needsIaC(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ['cdk','cloudformation','cfn','terraform','terragrunt','checkov',
    'infrastructure as code','iac','스택','template','모듈','module','provider',
    'cdk best practice','validate template','deploy stack'];
  return keywords.some(k => lower.includes(k));
}

// AWS resource overview keywords → Steampipe + Bedrock direct / AWS 리소스 개요 키워드 → Steampipe + Bedrock 직접 호출
// Matches general AWS resource names for live data queries via Steampipe / 라이브 데이터 쿼리를 위해 일반적인 AWS 리소스 이름 매칭
function needsAWSData(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = ['ec2','s3','vpc','lambda','k8s','elb',
    'instance','bucket','서버','네트워크','현황','리소스','pod'];
  return keywords.some(k => lower.includes(k));
}

// AgentCore Runtime invoke with gateway selection / 게이트웨이 선택을 통한 AgentCore Runtime 호출
// Sends prompt + gateway role to the Strands agent running on AgentCore / Strands 에이전트에 프롬프트 + 게이트웨이 역할을 전송
// Returns agent response text or null on failure / 에이전트 응답 텍스트 반환, 실패 시 null
async function invokeAgentCore(message: string, gateway: 'infra' | 'ops' | 'iac' | 'cost' | 'monitoring' | 'security' | 'data' = 'ops'): Promise<string | null> {
  try {
    // Build the invoke command with prompt and gateway role in payload / 페이로드에 프롬프트와 게이트웨이 역할을 포함한 호출 명령 구성
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGENT_RUNTIME_ARN,
      qualifier: 'DEFAULT',
      payload: JSON.stringify({ prompt: message, gateway }),
    });
    const response = await agentCoreClient.send(command);
    const sessionId = response.runtimeSessionId;
    // Parse streaming response body to string / 스트리밍 응답 본문을 문자열로 파싱
    const body = await streamToString(response.response);
    // Handle double-quoted JSON string responses / 이중 따옴표로 감싸진 JSON 문자열 응답 처리
    const text = body.startsWith('"') ? JSON.parse(body) : body;

    // Stop session to release microVM / microVM 해제를 위해 세션 중지
    if (sessionId) {
      try {
        await agentCoreClient.send(new StopRuntimeSessionCommand({
          agentRuntimeArn: AGENT_RUNTIME_ARN,
          runtimeSessionId: sessionId,
          qualifier: 'DEFAULT',
        }));
      } catch {}
    }
    return text;
  } catch (err: any) {
    console.error('[AgentCore Error]', err?.message || err);
    return null;
  }
}

async function streamToString(stream: any): Promise<string> {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  // AWS SDK v3 Streaming Blob
  if (typeof stream.transformToString === 'function') return stream.transformToString();
  if (typeof stream.transformToByteArray === 'function') {
    const bytes = await stream.transformToByteArray();
    return new TextDecoder().decode(bytes);
  }
  if (typeof stream.read === 'function') return stream.read().toString('utf-8');
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    }
    return chunks.join('');
  }
  return String(stream);
}

// POST handler: main AI routing logic / POST 핸들러: 메인 AI 라우팅 로직
// Routes user messages through keyword detection to the appropriate backend / 키워드 감지를 통해 사용자 메시지를 적절한 백엔드로 라우팅
export async function POST(request: NextRequest) {
  try {
    // Parse request body and validate messages array / 요청 본문 파싱 및 메시지 배열 유효성 검증
    const { messages, model: modelKey } = await request.json();
    if (!messages || !Array.isArray(messages) || messages.length === 0)
      return NextResponse.json({ error: 'Messages required' }, { status: 400 });

    // Detect routing keywords from the last user message / 마지막 사용자 메시지에서 라우팅 키워드 감지
    const lastMessage = messages[messages.length - 1]?.content || '';
    const useCodeInterpreter = needsCodeInterpreter(lastMessage);
    const useInfra = needsInfra(lastMessage);
    const useIaC = needsIaC(lastMessage);
    const useDataAnalytics = needsData(lastMessage);
    const useSecurity = needsSecurity(lastMessage);
    const useMonitoring = needsMonitoring(lastMessage);
    const useCost = needsCost(lastMessage);
    const needsData = needsAWSData(lastMessage);

    // Route Code: Code execution request → Code Interpreter + AI analysis / 코드 라우트: 코드 실행 요청 → 코드 인터프리터 + AI 분석
    if (useCodeInterpreter) {
      // First, get AI to generate or process the code request
      const modelId = MODELS[modelKey || 'sonnet-4.6'] || MODELS['sonnet-4.6'];
      const codeSystemPrompt = SYSTEM_PROMPT + `\n\nThe user wants to execute code. If they provide code, wrap it in a \`\`\`python code block. If they describe a task, generate Python code to accomplish it and wrap it in a \`\`\`python code block. Always include print statements to show results.`;

      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        system: codeSystemPrompt,
        messages: messages.map((m: any) => ({ role: m.role, content: m.content })),
      });

      const aiResponse = await bedrockClient.send(new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: new TextEncoder().encode(body),
      }));

      const aiResult = JSON.parse(new TextDecoder().decode(aiResponse.body));
      const aiText = aiResult.content?.[0]?.text || '';

      // Extract and execute any Python code from the AI response
      const pythonCode = extractPythonCode(aiText) || extractPythonCode(lastMessage);
      if (pythonCode) {
        const codeResult = await executeCodeInterpreter(pythonCode);
        const executionBlock = `\n\n---\n**Code Execution Result** (exit code: ${codeResult.exitCode}):\n\`\`\`\n${codeResult.output}\n\`\`\``;

        return NextResponse.json({
          content: aiText + executionBlock,
          model: modelKey || 'sonnet-4.6',
          via: 'Bedrock + Code Interpreter',
          queriedResources: ['code-interpreter'],
          codeExecution: {
            output: codeResult.output,
            exitCode: codeResult.exitCode,
          },
        });
      }

      // No code block found, return AI response as-is
      return NextResponse.json({
        content: aiText,
        model: modelKey || 'sonnet-4.6',
        via: 'Bedrock (code request - no executable code generated)',
        queriedResources: [],
      });
    }

    // Route 0: Infrastructure (network + EKS) → AgentCore Runtime (Infra Gateway) / 라우트 0: 인프라 (네트워크 + EKS) → AgentCore Runtime (인프라 게이트웨이)
    if (useInfra) {
      const agentResponse = await invokeAgentCore(lastMessage, 'infra');
      if (agentResponse) {
        return NextResponse.json({
          content: agentResponse,
          model: 'sonnet-4.6',
          via: 'AgentCore Runtime → Infra Gateway (12 tools)',
          queriedResources: ['infra-gateway'],
        });
      }
      // Fall through to Bedrock if AgentCore fails / AgentCore 실패 시 Bedrock으로 폴스루
    }

    // Route 0.5: IaC questions → AgentCore Runtime (IaC Gateway) / 라우트 0.5: IaC 질문 → AgentCore Runtime (IaC 게이트웨이)
    if (useIaC) {
      const agentResponse = await invokeAgentCore(lastMessage, 'iac');
      if (agentResponse) {
        return NextResponse.json({
          content: agentResponse,
          model: 'sonnet-4.6',
          via: 'AgentCore Runtime → IaC Gateway (16 tools)',
          queriedResources: ['iac-gateway'],
        });
      }
    }

    // Route 1: Data & Analytics → AgentCore Runtime (Data Gateway) / 라우트 1: 데이터 및 분석 → AgentCore Runtime (데이터 게이트웨이)
    if (useDataAnalytics) {
      const agentResponse = await invokeAgentCore(lastMessage, 'data');
      if (agentResponse) {
        return NextResponse.json({
          content: agentResponse,
          model: 'sonnet-4.6',
          via: 'AgentCore Runtime → Data Gateway (24 tools)',
          queriedResources: ['data-gateway'],
        });
      }
    }

    // Route 2: Security → AgentCore Runtime (Security Gateway) / 라우트 2: 보안 → AgentCore Runtime (보안 게이트웨이)
    if (useSecurity) {
      const agentResponse = await invokeAgentCore(lastMessage, 'security');
      if (agentResponse) {
        return NextResponse.json({
          content: agentResponse,
          model: 'sonnet-4.6',
          via: 'AgentCore Runtime → Security Gateway (14 tools)',
          queriedResources: ['security-gateway'],
        });
      }
    }

    // Route 2: Monitoring → AgentCore Runtime (Monitoring Gateway) / 라우트 2: 모니터링 → AgentCore Runtime (모니터링 게이트웨이)
    if (useMonitoring) {
      const agentResponse = await invokeAgentCore(lastMessage, 'monitoring');
      if (agentResponse) {
        return NextResponse.json({
          content: agentResponse,
          model: 'sonnet-4.6',
          via: 'AgentCore Runtime → Monitoring Gateway (16 tools)',
          queriedResources: ['monitoring-gateway'],
        });
      }
    }

    // Route 2: Cost questions → AgentCore Runtime (Cost Gateway) / 라우트 2: 비용 질문 → AgentCore Runtime (비용 게이트웨이)
    if (useCost) {
      const agentResponse = await invokeAgentCore(lastMessage, 'cost');
      if (agentResponse) {
        return NextResponse.json({
          content: agentResponse,
          model: 'sonnet-4.6',
          via: 'AgentCore Runtime → Cost Gateway (9 tools)',
          queriedResources: ['cost-gateway'],
        });
      }
    }

    // Route 2: AWS resource questions → Bedrock Direct + Steampipe data / 라우트 2: AWS 리소스 질문 → Bedrock 직접 호출 + Steampipe 데이터
    // Queries live AWS data via Steampipe and enriches AI context / Steampipe로 실시간 AWS 데이터 조회 후 AI 컨텍스트에 추가
    if (needsData) {
      const modelId = MODELS[modelKey || 'sonnet-4.6'] || MODELS['sonnet-4.6'];
      const autoQueries = detectQueries(lastMessage);
      let contextData = '';

      if (Object.keys(autoQueries).length > 0) {
        const results: string[] = [];
        for (const [key, sql] of Object.entries(autoQueries)) {
          const data = await queryAWS(sql);
          results.push(`### ${key.toUpperCase()} Data:\n\`\`\`json\n${data}\n\`\`\``);
        }
        contextData = '\n\n--- LIVE AWS RESOURCE DATA ---\n' + results.join('\n\n');
      }

      const bedrockMessages = messages.map((m: any) => ({ role: m.role, content: m.content }));
      if (contextData) bedrockMessages[bedrockMessages.length - 1].content += contextData;

      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: bedrockMessages,
      });

      const response = await bedrockClient.send(new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: new TextEncoder().encode(body),
      }));

      const result = JSON.parse(new TextDecoder().decode(response.body));
      const responseText = result.content?.[0]?.text || 'No response';

      // Check if response contains Python code that could be executed
      const pythonCodeInResponse = extractPythonCode(responseText);
      const codeInterpreterHint = pythonCodeInResponse
        ? '\n\n> **Tip**: This response contains Python code. Send a message with "코드 실행" or "execute" to run it.'
        : '';

      return NextResponse.json({
        content: responseText + codeInterpreterHint,
        model: modelKey || 'sonnet-4.6',
        via: 'Bedrock + Steampipe',
        queriedResources: Object.keys(autoQueries),
        hasExecutableCode: !!pythonCodeInResponse,
      });
    }

    // Route 2: General questions → AgentCore Runtime (Ops Gateway) / 라우트 2: 일반 질문 → AgentCore Runtime (운영 게이트웨이)
    // Default route when no specific domain is matched / 특정 도메인이 매칭되지 않을 때 기본 라우트
    const agentResponse = await invokeAgentCore(lastMessage, 'ops');
    if (agentResponse) {
      return NextResponse.json({
        content: agentResponse,
        model: 'sonnet-4.6',
        via: 'AgentCore Runtime → Ops Gateway (9 tools)',
        queriedResources: ['ops-gateway'],
      });
    }

    // Route 3: Fallback → Bedrock Direct (no tools, pure LLM) / 라우트 3: 폴백 → Bedrock 직접 호출 (도구 없이 순수 LLM)
    // Last resort when all AgentCore routes fail / 모든 AgentCore 라우트 실패 시 최후 수단
    const modelId = MODELS[modelKey || 'sonnet-4.6'] || MODELS['sonnet-4.6'];
    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: messages.map((m: any) => ({ role: m.role, content: m.content })),
    });

    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId, contentType: 'application/json', accept: 'application/json',
      body: new TextEncoder().encode(body),
    }));

    const result = JSON.parse(new TextDecoder().decode(response.body));
    return NextResponse.json({
      content: result.content?.[0]?.text || 'No response',
      model: modelKey || 'sonnet-4.6',
      via: 'Bedrock Direct',
      queriedResources: [],
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'AI request failed' }, { status: 500 });
  }
}
