import { describe, it, expect } from 'vitest';
import { pickGateway } from './route';

describe('pickGateway', () => {
  it('honors an explicit pin over keywords', () => {
    expect(pickGateway('이번 달 비용 알려줘', 'security')).toBe('security');
  });
  it('routes cost keywords', () => {
    expect(pickGateway('이번 달 비용 추세')).toBe('cost');
    expect(pickGateway('show me the billing forecast')).toBe('cost');
  });
  it('routes security keywords', () => {
    expect(pickGateway('이 IAM 역할 권한 점검')).toBe('security');
    expect(pickGateway('why is this action denied by policy')).toBe('security');
  });
  it('routes network keywords', () => {
    expect(pickGateway('두 인스턴스 통신이 안 돼요')).toBe('network');
    expect(pickGateway('check the security group ports')).toBe('network');
  });
  it('falls back to ops for unknown prompts', () => {
    expect(pickGateway('안녕하세요')).toBe('ops');
  });
  it('ignores a pin that is not a known section', () => {
    expect(pickGateway('이번 달 비용', 'bogus')).toBe('cost');
  });
});
