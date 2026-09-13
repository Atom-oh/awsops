// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CustomizationPage from './page';
import { LanguageProvider } from '@/components/shell/LanguageProvider';
import type { Lang } from '@/lib/i18n';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function setup(attachmentStatus = 200, lang: Lang = 'en', integrations: { id: number; name: string; kind: string }[] = [], catalogStatus = 200) {
  const agent = {
    id: 1, name: 'iam-advisor', description: 'IAM diagnosis', gateway: 'security', tier: 'custom',
    enabled: false, version: 1, skills: [{ name: 'existing-skill', ord: 4 }],
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/integrations') return Response.json({ integrations });
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      if (body.op === 'attach' && attachmentStatus === 200) agent.skills.push({ name: 'evidence-skill', ord: body.ord });
      return Response.json(attachmentStatus === 200 ? { ok: true } : { error: 'Skill is disabled' }, { status: attachmentStatus });
    }
    if (init?.method === 'POST') return Response.json({ ok: true, id: 3 });
    if (catalogStatus !== 200) return Response.json({ error: 'Agent Space policy unavailable' }, { status: catalogStatus });
    return Response.json({
      accountId: 'self', space: null, agents: [agent],
      skills: [
        { id: 2, name: 'evidence-skill', description: 'Cite evidence', enabled: true, tier: 'custom', version: 1 },
        { id: 3, name: 'disabled-skill', description: 'Not ready', enabled: false, tier: 'custom', version: 1 },
      ],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  localStorage.setItem('awsops-lang', lang);
  render(<LanguageProvider><CustomizationPage /></LanguageProvider>);
  return fetcher;
}

describe('custom agent registration', () => {
  it('does not show global mode when catalog policy is unavailable', async () => {
    setup(200, 'en', [], 503);
    await screen.findByText('Agent catalog is temporarily unavailable. Refresh the page to retry.');
    expect(screen.queryByText(/Global \(Phase-1\) mode/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Agent Space' })).toBeNull();
  });
  it.each([
    ['ko', '기본 채팅 라우팅에 예약된 이름입니다. 다른 이름을 선택하세요.'],
    ['en', 'This name is reserved for built-in chat routing. Choose another name.'],
    ['zh', '此名称已保留用于内置聊天路由。请选择其他名称。'],
    ['ja', 'この名前は組み込みチャットルーティング用に予約されています。別の名前を選んでください。'],
  ] as const)('explains reserved agent names in %s before submission', async (lang, error) => {
    const fetcher = setup(200, lang);
    await screen.findByText('iam-advisor', { selector: 'span' });
    const form = screen.getByRole('heading', { name: 'New Agent' }).closest('section')!;
    fireEvent.change(within(form).getByPlaceholderText('name (kebab-case)'), { target: { value: 'auto' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    await screen.findByText(error);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('keeps supported integration membership while removing arbitrary registration controls', async () => {
    const fetcher = setup(200, 'en', [
      { id: 4, name: 'team-notion', kind: 'notion' },
      { id: 5, name: 'retired-server', kind: 'custom_mcp' },
    ]);
    const membership = await screen.findByRole('checkbox', { name: 'team-notion' });
    expect(screen.queryByRole('button', { name: 'Register integration' })).toBeNull();
    expect(screen.queryByText('Advanced — register a custom integration')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'retired-server' })).toBeNull();
    fireEvent.click(membership);
    fireEvent.click(screen.getByRole('button', { name: 'Save Agent Space' }));
    await waitFor(() => {
      const request = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ op: 'space', enabledIntegrationIds: [4] });
    });
  });
  it.each([
    ['ko', 'iam-advisor에 연결할 스킬', 'iam-advisor에 스킬 연결', '오류: 스킬이 비활성 상태입니다. 먼저 스킬을 활성화하세요.'],
    ['en', 'Skill for iam-advisor', 'Attach skill to iam-advisor', 'Error: Skill is disabled. Enable it first.'],
    ['zh', '用于 iam-advisor 的技能', '将技能关联到 iam-advisor', '错误：技能已停用。请先启用技能。'],
    ['ja', 'iam-advisor に関連付けるスキル', 'iam-advisor にスキルを関連付ける', 'エラー：スキルは無効です。先に有効にしてください。'],
  ] as const)('localizes attachment controls and failure feedback in %s', async (lang, selectorName, buttonName, error) => {
    setup(409, lang);
    fireEvent.change(await screen.findByRole('combobox', { name: selectorName }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: buttonName }));
    await screen.findByText(error);
  });
  it('offers Observability and sends it as the primary gateway without inactive metadata', async () => {
    const fetcher = setup();
    await screen.findByText('iam-advisor', { selector: 'span' });
    const form = screen.getByRole('heading', { name: 'New Agent' }).closest('section')!;
    const gateway = within(form).getByDisplayValue('ops');
    fireEvent.change(gateway, { target: { value: 'observability' } });
    fireEvent.change(within(form).getByPlaceholderText('name (kebab-case)'), { target: { value: 'obs-advisor' } });
    fireEvent.change(within(form).getByPlaceholderText('description'), { target: { value: 'Observability diagnosis' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      const call = fetcher.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ gateway: 'observability', name: 'obs-advisor' });
    });
    expect(within(form).queryByPlaceholderText('model (optional)')).toBeNull();
    expect(within(form).queryByPlaceholderText('response language (optional)')).toBeNull();
  });

  it('attaches an enabled skill after existing skills and refreshes the visible composition', async () => {
    const fetcher = setup();
    const selector = await screen.findByRole('combobox', { name: 'Skill for iam-advisor' });
    expect(within(selector).queryByRole('option', { name: 'disabled-skill' })).toBeNull();
    fireEvent.change(selector, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach skill to iam-advisor' }));
    await screen.findByText('Skills: existing-skill, evidence-skill');
    const call = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ op: 'attach', agentId: 1, skillId: 2, ord: 5 });
    expect(screen.getAllByText('Disabled', { selector: 'button' }).length).toBeGreaterThan(0);
  });

  it('shows attachment errors without claiming a new composition', async () => {
    setup(409);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Skill for iam-advisor' }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach skill to iam-advisor' }));
    await screen.findByText(/Error:.*Skill is disabled/);
    expect(screen.queryByText('Skills: existing-skill, evidence-skill')).toBeNull();
  });
});
