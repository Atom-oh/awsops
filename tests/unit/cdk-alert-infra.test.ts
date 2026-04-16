// CDK stack validation — verify SQS/SNS alert infrastructure resources exist
// ADR-009: SNS → SQS → EC2 Polling primary path

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CDK_STACK_PATH = resolve(__dirname, '../../infra-cdk/lib/awsops-stack.ts');
let stackContent: string;

try {
  stackContent = readFileSync(CDK_STACK_PATH, 'utf-8');
} catch {
  stackContent = '';
}

describe('CDK awsops-stack.ts — Alert Infrastructure (ADR-009)', () => {
  it('stack file exists and is readable', () => {
    expect(stackContent.length).toBeGreaterThan(0);
  });

  // --- SQS Dead Letter Queue ---

  describe('Alert DLQ', () => {
    it('defines AlertDLQ with correct queue name', () => {
      expect(stackContent).toContain("'AlertDLQ'");
      expect(stackContent).toContain("'awsops-alert-dlq'");
    });

    it('DLQ has 14-day retention', () => {
      expect(stackContent).toMatch(/retentionPeriod.*Duration\.days\(14\)/);
    });
  });

  // --- SQS Alert Queue ---

  describe('Alert Queue', () => {
    it('defines AlertQueue with correct queue name', () => {
      expect(stackContent).toContain("'AlertQueue'");
      expect(stackContent).toContain("'awsops-alert-queue'");
    });

    it('has 120-second visibility timeout', () => {
      expect(stackContent).toMatch(/visibilityTimeout.*Duration\.seconds\(120\)/);
    });

    it('has 4-day retention period', () => {
      expect(stackContent).toMatch(/retentionPeriod.*Duration\.days\(4\)/);
    });

    it('uses DLQ with maxReceiveCount of 3', () => {
      expect(stackContent).toContain('maxReceiveCount: 3');
    });
  });

  // --- SNS Topic ---

  describe('Alert SNS Topic', () => {
    it('defines AlertTopic with correct name', () => {
      expect(stackContent).toContain("'AlertTopic'");
      expect(stackContent).toContain("'awsops-alert-topic'");
    });

    it('has SQS subscription to alertQueue', () => {
      expect(stackContent).toContain('SqsSubscription');
      expect(stackContent).toContain('addSubscription');
    });
  });

  // --- IAM Permissions ---

  describe('EC2 IAM permissions for SQS', () => {
    it('grants sqs:ReceiveMessage', () => {
      expect(stackContent).toContain('sqs:ReceiveMessage');
    });

    it('grants sqs:DeleteMessage', () => {
      expect(stackContent).toContain('sqs:DeleteMessage');
    });

    it('grants sqs:GetQueueAttributes', () => {
      expect(stackContent).toContain('sqs:GetQueueAttributes');
    });

    it('grants sqs:ChangeMessageVisibility', () => {
      expect(stackContent).toContain('sqs:ChangeMessageVisibility');
    });

    it('has SQSAlertPoller policy statement ID', () => {
      expect(stackContent).toContain('SQSAlertPoller');
    });
  });

  // --- CloudFormation Outputs ---

  describe('CloudFormation Outputs', () => {
    it('outputs AlertTopicArn', () => {
      expect(stackContent).toContain('AlertTopicArn');
    });

    it('outputs AlertQueueUrl', () => {
      expect(stackContent).toContain('AlertQueueUrl');
    });
  });

  // --- ADR-009 comment documentation ---

  describe('code documentation', () => {
    it('references ADR-009', () => {
      expect(stackContent).toContain('ADR-009');
    });

    it('documents CloudFront/Cognito constraint', () => {
      expect(stackContent).toMatch(/CloudFront.*Cognito|Cognito.*CloudFront/i);
    });

    it('describes primary path as SNS → SQS → EC2 Polling', () => {
      expect(stackContent).toContain('SQS');
      expect(stackContent).toContain('Polling');
    });
  });

  // --- Existing SNS permissions preserved ---

  describe('existing SNS permissions preserved', () => {
    it('retains SNSNotification policy for report emails', () => {
      expect(stackContent).toContain('SNSNotification');
      expect(stackContent).toContain('sns:Publish');
    });
  });
});
