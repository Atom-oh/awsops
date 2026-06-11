import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EKSClient, DescribeAccessEntryCommand } from '@aws-sdk/client-eks';

// Access-entry awareness for the EKS page: who am I (task role), does a cluster
// already trust me (DescribeAccessEntry), and the v1-style onboarding guide.

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const ARN_TTL_MS = 10 * 60 * 1000;

let sts: STSClient | null = null;
let eks: EKSClient | null = null;
let arnCache: { arn: string; at: number } | null = null;

export function _resetForTests() { sts = null; eks = null; arnCache = null; }

/** Current task-role ARN (assumed-role STS ARN → IAM role ARN, v1 callerRole transform). */
export async function getTaskRoleArn(): Promise<string> {
  if (arnCache && Date.now() - arnCache.at < ARN_TTL_MS) return arnCache.arn;
  if (!sts) sts = new STSClient({ region: REGION });
  const { Arn = '' } = await sts.send(new GetCallerIdentityCommand({}));
  const m = Arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//);
  const arn = m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : Arn;
  arnCache = { arn, at: Date.now() };
  return arn;
}

/** Does the cluster have an access entry for our task role? null = couldn't determine. */
export async function hasAccessEntry(cluster: string): Promise<boolean | null> {
  const principalArn = await getTaskRoleArn();
  if (!eks) eks = new EKSClient({ region: REGION });
  try {
    await eks.send(new DescribeAccessEntryCommand({ clusterName: cluster, principalArn }));
    return true;
  } catch (e) {
    if (e instanceof Error && e.name === 'ResourceNotFoundException') return false;
    return null;
  }
}

export interface OnboardingGuide { commands: string[]; note: string }

/** v1-parity copy-paste onboarding guide with the role ARN and region filled in. */
export async function onboardingGuide(cluster: string): Promise<OnboardingGuide> {
  const arn = await getTaskRoleArn();
  return {
    commands: [
      `aws eks create-access-entry --cluster-name ${cluster} --region ${REGION} --principal-arn ${arn} --type STANDARD`,
      `aws eks associate-access-policy --cluster-name ${cluster} --region ${REGION} --principal-arn ${arn} --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=cluster`,
    ],
    note: '명령 실행 후 [조회 등록]을 다시 누르세요. 영구 온보딩(Terraform)은 make configure → onboard_eks_clusters 를 사용하세요.',
  };
}
