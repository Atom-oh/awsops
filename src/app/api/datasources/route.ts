// External Datasource CRUD + Test + Query API
// 외부 데이터소스 CRUD + 연결 테스트 + 쿼리 API
// Supports: Prometheus, Loki, Tempo, ClickHouse
import { NextRequest, NextResponse } from 'next/server';
import { getConfig, saveConfig, getDatasources, getDatasourceById } from '@/lib/app-config';
import type { DatasourceConfig, DatasourceType } from '@/lib/app-config';
import { queryDatasource, testConnection } from '@/lib/datasource-client';
import { getUserFromRequest } from '@/lib/auth-utils';

const VALID_TYPES: DatasourceType[] = ['prometheus', 'loki', 'tempo', 'clickhouse', 'jaeger', 'dynatrace', 'datadog'];

// --- URL validation (SSRF prevention) / URL 검증 (SSRF 방지) ---
// Block requests to internal/private networks and cloud metadata endpoints
// 내부/사설 네트워크 및 클라우드 메타데이터 엔드포인트 요청 차단
function isAllowedUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    // Block cloud metadata endpoints / 클라우드 메타데이터 엔드포인트 차단
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal' || hostname === '100.100.100.200') return false;
    // Block link-local and loopback / 링크로컬 및 루프백 차단
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return false;
    if (hostname.endsWith('.internal') || hostname.endsWith('.local')) return false;
    // Block private IP ranges / 사설 IP 대역 차단
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return false;                          // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return false;   // 172.16.0.0/12
      if (a === 192 && b === 168) return false;             // 192.168.0.0/16
      if (a === 169 && b === 254) return false;             // 169.254.0.0/16
    }
    // Only allow http/https protocols / http/https 프로토콜만 허용
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return true;
  } catch {
    return false;
  }
}

// --- Credential masking / 자격증명 마스킹 ---
// Returns a shallow copy with sensitive fields replaced by '***'
// password, token 등 민감 필드를 '***'로 대체한 복사본 반환
function maskCredentials(ds: DatasourceConfig): DatasourceConfig {
  const masked = { ...ds };
  if (masked.auth) {
    masked.auth = { ...masked.auth };
    if (masked.auth.password) masked.auth.password = '***';
    if (masked.auth.token) masked.auth.token = '***';
    if (masked.auth.headerValue) masked.auth.headerValue = '***';
  }
  return masked;
}

// --- Admin check helper / 관리자 권한 확인 ---
// If adminEmails is not configured, all authenticated users are treated as admin (fresh install)
// adminEmails가 설정되지 않은 경우, 모든 인증된 사용자를 관리자로 취급 (초기 설치)
function isAdminUser(req: NextRequest): boolean {
  const user = getUserFromRequest(req);
  const config = getConfig();
  if (!config.adminEmails || config.adminEmails.length === 0) return true;
  return config.adminEmails.includes(user.email);
}

function checkAdmin(req: NextRequest): { isAdmin: boolean; error?: NextResponse } {
  if (!isAdminUser(req)) {
    return { isAdmin: false, error: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
  }
  return { isAdmin: true };
}

// ============================================================================
// GET — List / Get datasources / 데이터소스 목록 조회 / 단건 조회
// ============================================================================
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';

  // Single datasource by ID / ID로 단건 조회
  if (action === 'get') {
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
    }
    const ds = getDatasourceById(id);
    if (!ds) {
      return NextResponse.json({ error: 'Datasource not found' }, { status: 404 });
    }
    return NextResponse.json(maskCredentials(ds));
  }

  // List all datasources (masked) / 전체 목록 (마스킹)
  const datasources = getDatasources().map(maskCredentials);
  const isAdmin = isAdminUser(request);
  return NextResponse.json({ datasources, isAdmin });
}

// ============================================================================
// POST — Test connection / Query / Add new datasource
// POST — 연결 테스트 / 쿼리 실행 / 새 데이터소스 추가
// ============================================================================
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body as { action?: string };

    // --- Test connection (admin-only) / 연결 테스트 (관리자 전용) ---
    if (action === 'test') {
      const adminCheck = checkAdmin(request);
      if (adminCheck.error) return adminCheck.error;

      const { datasource } = body as { datasource: DatasourceConfig };
      if (!datasource || !datasource.url || !datasource.type) {
        return NextResponse.json({ error: 'Missing datasource url or type for test' }, { status: 400 });
      }
      // SSRF prevention: validate URL before making server-side request
      if (!isAllowedUrl(datasource.url)) {
        return NextResponse.json({ ok: false, latency: 0, error: 'URL not allowed: private/internal addresses are blocked' }, { status: 400 });
      }
      try {
        const result = await testConnection(datasource);
        return NextResponse.json(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Connection test failed';
        return NextResponse.json({ ok: false, latency: 0, error: message });
      }
    }

    // --- Execute query / 쿼리 실행 ---
    if (action === 'query') {
      const { datasourceId, query, options } = body as {
        datasourceId: string;
        query: string;
        options?: Record<string, unknown>;
      };
      if (!datasourceId || !query) {
        return NextResponse.json({ error: 'Missing datasourceId or query' }, { status: 400 });
      }
      const ds = getDatasourceById(datasourceId);
      if (!ds) {
        return NextResponse.json({ error: 'Datasource not found' }, { status: 404 });
      }
      try {
        const result = await queryDatasource(ds, query, options);
        return NextResponse.json(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Query execution failed';
        return NextResponse.json({ error: message }, { status: 500 });
      }
    }

    // --- Add new datasource (admin-only) / 새 데이터소스 추가 (관리자 전용) ---
    const adminCheck = checkAdmin(request);
    if (adminCheck.error) return adminCheck.error;

    // UI sends { action: 'create', datasource: {...} } — unwrap if wrapped
    const dsPayload = body.datasource || body;
    const { name, type, url, isDefault, auth, settings } = dsPayload as Partial<DatasourceConfig>;

    // Validate required fields / 필수 필드 검증
    if (!name || !type || !url) {
      return NextResponse.json({ error: 'Missing required fields: name, type, url' }, { status: 400 });
    }
    if (!VALID_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `Invalid type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}` },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const newDs: DatasourceConfig = {
      id: crypto.randomUUID(),
      name: name.trim(),
      type,
      url: url.trim(),
      isDefault: isDefault || false,
      auth,
      settings,
      createdAt: now,
      updatedAt: now,
    };

    const existing = getDatasources();

    // If isDefault, unset other defaults of the same type / isDefault 시 같은 타입 기존 기본값 해제
    if (newDs.isDefault) {
      for (const ds of existing) {
        if (ds.type === type && ds.isDefault) {
          ds.isDefault = false;
        }
      }
    }

    const allDs = [...existing, newDs];
    saveConfig({ datasources: allDs });
    return NextResponse.json({ datasources: allDs.map(maskCredentials) }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ============================================================================
// PUT — Update datasource (admin-only) / 데이터소스 수정 (관리자 전용)
// ============================================================================
export async function PUT(request: NextRequest) {
  try {
    const adminCheck = checkAdmin(request);
    if (adminCheck.error) return adminCheck.error;

    const body = await request.json();
    const { id, ...updates } = body as Partial<DatasourceConfig> & { id: string };

    if (!id) {
      return NextResponse.json({ error: 'Missing id field' }, { status: 400 });
    }

    // Validate type if provided / type이 제공된 경우 검증
    if (updates.type && !VALID_TYPES.includes(updates.type)) {
      return NextResponse.json(
        { error: `Invalid type: ${updates.type}. Must be one of: ${VALID_TYPES.join(', ')}` },
        { status: 400 },
      );
    }

    const datasources = getDatasources();
    const idx = datasources.findIndex(d => d.id === id);
    if (idx === -1) {
      return NextResponse.json({ error: 'Datasource not found' }, { status: 404 });
    }

    // Merge fields / 필드 병합
    const updated: DatasourceConfig = {
      ...datasources[idx],
      ...updates,
      id, // ID cannot change / ID 변경 불가
      createdAt: datasources[idx].createdAt, // createdAt is immutable / 생성일 불변
      updatedAt: new Date().toISOString(),
    };

    // If isDefault toggled on, unset other defaults of same type / isDefault 전환 시 같은 타입 기본값 해제
    if (updated.isDefault) {
      for (const ds of datasources) {
        if (ds.id !== id && ds.type === updated.type && ds.isDefault) {
          ds.isDefault = false;
        }
      }
    }

    datasources[idx] = updated;
    saveConfig({ datasources });
    return NextResponse.json({ datasources: datasources.map(maskCredentials) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ============================================================================
// DELETE — Remove datasource (admin-only) / 데이터소스 삭제 (관리자 전용)
// ============================================================================
export async function DELETE(request: NextRequest) {
  try {
    const adminCheck = checkAdmin(request);
    if (adminCheck.error) return adminCheck.error;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
    }

    const datasources = getDatasources();
    const exists = datasources.some(d => d.id === id);
    if (!exists) {
      return NextResponse.json({ error: 'Datasource not found' }, { status: 404 });
    }

    const filtered = datasources.filter(d => d.id !== id);
    saveConfig({ datasources: filtered });
    return NextResponse.json({ datasources: filtered.map(maskCredentials) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
