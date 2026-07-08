'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Header from '@/components/layout/Header';
import { Play, Loader2, Download, FileText, CheckCircle, AlertTriangle, XCircle, Clock, ChevronDown, ChevronRight, FileDown, Printer, List, FileCode, CalendarClock, Mail, Bell, BellOff, Send, Plus, X } from 'lucide-react';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { useAccountContext } from '@/contexts/AccountContext';
import ReportMarkdown from '@/components/ReportMarkdown';

// --- Types ---

interface ReportSection {
  section: string;
  title: string;
  content: string;
}

interface ReportProgress {
  current: number;
  total: number;
  currentSection: string;
  statusMessage?: string;
  completedSections?: string[];
}

interface ReportListItem {
  reportId: string;
  accountId?: string;
  accountAlias?: string;
  downloadUrlDocx?: string;
  downloadUrlMd?: string;
  status: 'generating' | 'completed' | 'failed';
  createdAt: string;
  progress?: ReportProgress;
  elapsedSeconds?: number;
  scheduledBy?: string;
}

interface ReportSchedule {
  enabled: boolean;
  frequency: 'weekly' | 'biweekly' | 'monthly';
  dayOfWeek: number;
  dayOfMonth: number;
  hour: number;
  accountId?: string;
  lang: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

// --- Constants ---

const SECTION_SHORT_NAMES: Record<string, string> = {
  'executive-summary': 'Summary',
  'cost-overview': 'Cost',
  'cost-compute': 'Compute$',
  'cost-network': 'Network$',
  'cost-storage': 'Storage$',
  'idle-resources': 'Idle',
  'security-posture': 'Security',
  'network-architecture': 'Network',
  'compute-analysis': 'Compute',
  'eks-analysis': 'EKS',
  'database-analysis': 'Database',
  'msk-analysis': 'MSK',
  'storage-analysis': 'Storage',
  'recommendations': 'Roadmap',
  'appendix': 'Appendix',
};

const SECTION_ICONS: Record<string, string> = {
  'executive-summary': '\u{1F4CA}',
  'cost-overview': '\u{1F4B0}',
  'cost-compute': '\u{1F5A5}\uFE0F',
  'cost-network': '\u{1F310}',
  'cost-storage': '\u{1F4BE}',
  'idle-resources': '\u{1F5D1}\uFE0F',
  'security-posture': '\u{1F512}',
  'network-architecture': '\u{1F500}',
  'compute-analysis': '\u26A1',
  'eks-analysis': '\u2638\uFE0F',
  'database-analysis': '\u{1F5C4}\uFE0F',
  'msk-analysis': '\u{1F4E1}',
  'storage-analysis': '\u{1F4E6}',
  'recommendations': '\u{1F3AF}',
  'appendix': '\u{1F4CB}',
};

// Section sub-topic descriptions for live progress display
// 섹션별 세부 분석 항목 (실시간 진행 표시용)
const SECTION_SUBTOPICS: Record<string, { ko: string[]; en: string[]; zh: string[] }> = {
  'cost-overview':          { ko: ['서비스별 비용 집계', '월별 추이 분석', '비용 이상 감지'], en: ['Per-service cost aggregation', 'Monthly trend analysis', 'Cost anomaly detection'], zh: ['按服务成本汇总', '月度趋势分析', '成本异常检测'] },
  'cost-compute':           { ko: ['EC2 인스턴스 비용', 'Lambda 실행 비용', 'ECS/Fargate 비용', 'Savings Plans 커버리지'], en: ['EC2 instance costs', 'Lambda execution costs', 'ECS/Fargate costs', 'Savings Plans coverage'], zh: ['EC2 实例成本', 'Lambda 执行成本', 'ECS/Fargate 成本', 'Savings Plans 覆盖率'] },
  'cost-network':           { ko: ['Inter-AZ 데이터 전송', 'NAT Gateway 비용', 'Data Transfer Out', 'VPN/TGW 비용'], en: ['Inter-AZ data transfer', 'NAT Gateway costs', 'Data Transfer Out', 'VPN/TGW costs'], zh: ['跨 AZ 数据传输', 'NAT Gateway 成本', 'Data Transfer Out', 'VPN/TGW 成本'] },
  'cost-storage':           { ko: ['S3 스토리지 클래스', 'EBS 볼륨 비용', 'Snapshot 비용', 'Lifecycle 정책'], en: ['S3 storage classes', 'EBS volume costs', 'Snapshot costs', 'Lifecycle policies'], zh: ['S3 存储类别', 'EBS 卷成本', 'Snapshot 成本', 'Lifecycle 策略'] },
  'idle-resources':         { ko: ['미연결 EBS 스캔', '미사용 EIP 스캔', '중지된 EC2 스캔', '오래된 스냅샷', '미사용 보안그룹'], en: ['Unattached EBS scan', 'Unused EIP scan', 'Stopped EC2 scan', 'Old snapshots', 'Unused security groups'], zh: ['未挂载 EBS 扫描', '未使用 EIP 扫描', '已停止 EC2 扫描', '旧快照', '未使用安全组'] },
  'security-posture':       { ko: ['Security Group 분석', 'S3 퍼블릭 접근', 'EBS 암호화', 'IAM 사용자 점검', 'CIS 컴플라이언스'], en: ['Security Group analysis', 'S3 public access', 'EBS encryption', 'IAM user audit', 'CIS compliance'], zh: ['Security Group 分析', 'S3 公开访问', 'EBS 加密', 'IAM 用户审计', 'CIS 合规'] },
  'network-architecture':   { ko: ['VPC 구성 분석', '서브넷 설계', 'NAT Gateway 이중화', 'Route Table', 'TGW/Peering'], en: ['VPC architecture', 'Subnet design', 'NAT Gateway redundancy', 'Route tables', 'TGW/Peering'], zh: ['VPC 架构分析', '子网设计', 'NAT Gateway 冗余', 'Route Table', 'TGW/Peering'] },
  'compute-analysis':       { ko: ['EC2 활용률 분석', 'Instance Type 적정성', 'Lambda 메모리 최적화', 'Auto Scaling 설정'], en: ['EC2 utilization', 'Instance type fitness', 'Lambda memory optimization', 'Auto Scaling config'], zh: ['EC2 利用率分析', 'Instance Type 适配性', 'Lambda 内存优化', 'Auto Scaling 配置'] },
  'eks-analysis':           { ko: ['EKS 클러스터 구성', '노드풀 분석', 'Pod 리소스 효율', 'Namespace 비용'], en: ['EKS cluster config', 'Node pool analysis', 'Pod resource efficiency', 'Namespace costs'], zh: ['EKS 集群配置', '节点池分析', 'Pod 资源效率', 'Namespace 成本'] },
  'database-analysis':      { ko: ['RDS 인스턴스 분석', 'ElastiCache 노드', 'OpenSearch 도메인', 'Multi-AZ 설정', '스토리지 효율'], en: ['RDS instance analysis', 'ElastiCache nodes', 'OpenSearch domains', 'Multi-AZ setup', 'Storage efficiency'], zh: ['RDS 实例分析', 'ElastiCache 节点', 'OpenSearch 域', 'Multi-AZ 配置', '存储效率'] },
  'msk-analysis':           { ko: ['MSK 브로커 구성', '처리량 분석', 'EBS 사용량', 'Consumer Lag'], en: ['MSK broker config', 'Throughput analysis', 'EBS usage', 'Consumer lag'], zh: ['MSK Broker 配置', '吞吐量分析', 'EBS 使用量', 'Consumer Lag'] },
  'storage-analysis':       { ko: ['S3 버킷 구조', 'EBS 타입 분포', '암호화 현황', 'Lifecycle 적용률'], en: ['S3 bucket structure', 'EBS type distribution', 'Encryption status', 'Lifecycle adoption'], zh: ['S3 存储桶结构', 'EBS 类型分布', '加密现状', 'Lifecycle 采用率'] },
  'executive-summary':      { ko: ['전체 섹션 종합', '6 Pillar 점수 산출', '핵심 발견사항 도출'], en: ['Cross-section synthesis', '6 Pillar scoring', 'Key findings extraction'], zh: ['全部章节综合', '6 Pillar 评分', '关键发现提炼'] },
  'recommendations':        { ko: ['Quick Wins 도출', '단기 로드맵', '중기 로드맵', 'ROI 산출'], en: ['Quick Wins extraction', 'Short-term roadmap', 'Mid-term roadmap', 'ROI calculation'], zh: ['Quick Wins 提炼', '短期路线图', '中期路线图', 'ROI 计算'] },
  'appendix':               { ko: ['리소스 인벤토리 집계'], en: ['Resource inventory aggregation'], zh: ['资源清单汇总'] },
};

// Full section names for detailed display
const SECTION_FULL_NAMES: Record<string, { ko: string; en: string; zh: string }> = {
  'cost-overview':        { ko: '비용 개요', en: 'Cost Overview', zh: '成本概览' },
  'cost-compute':         { ko: '컴퓨팅 비용 분석', en: 'Compute Cost Analysis', zh: '计算成本分析' },
  'cost-network':         { ko: '네트워크 비용 분석', en: 'Network Cost Analysis', zh: '网络成本分析' },
  'cost-storage':         { ko: '스토리지 비용 분석', en: 'Storage Cost Analysis', zh: '存储成本分析' },
  'idle-resources':       { ko: '유휴 리소스 스캔', en: 'Idle Resource Scan', zh: '闲置资源扫描' },
  'security-posture':     { ko: '보안 진단', en: 'Security Posture', zh: '安全态势诊断' },
  'network-architecture': { ko: '네트워크 아키텍처 분석', en: 'Network Architecture', zh: '网络架构分析' },
  'compute-analysis':     { ko: '컴퓨팅 최적화 분석', en: 'Compute Optimization', zh: '计算优化分析' },
  'eks-analysis':         { ko: 'EKS 클러스터 분석', en: 'EKS Cluster Analysis', zh: 'EKS 集群分析' },
  'database-analysis':    { ko: '데이터베이스 분석', en: 'Database Analysis', zh: '数据库分析' },
  'msk-analysis':         { ko: 'MSK 스트리밍 분석', en: 'MSK Streaming Analysis', zh: 'MSK 流式分析' },
  'storage-analysis':     { ko: '스토리지 분석', en: 'Storage Analysis', zh: '存储分析' },
  'executive-summary':    { ko: '종합 요약 (AI 종합)', en: 'Executive Summary (AI Synthesis)', zh: '综合摘要（AI 综合）' },
  'recommendations':      { ko: '개선 로드맵 (AI 종합)', en: 'Improvement Roadmap (AI Synthesis)', zh: '改进路线图（AI 综合）' },
  'appendix':             { ko: '부록: 인벤토리', en: 'Appendix: Inventory', zh: '附录：资源清单' },
};

const POLL_INTERVAL = 5000;

// Section accent colors (Tailwind classes) for visual variety
const SECTION_ACCENT_CLASSES: Record<string, string> = {
  'executive-summary': 'text-accent-cyan border-accent-cyan',
  'cost-overview': 'text-accent-green border-accent-green',
  'cost-compute': 'text-accent-green border-accent-green',
  'cost-network': 'text-accent-green border-accent-green',
  'cost-storage': 'text-accent-green border-accent-green',
  'idle-resources': 'text-accent-orange border-accent-orange',
  'security-posture': 'text-red-400 border-red-400',
  'network-architecture': 'text-accent-purple border-accent-purple',
  'compute-analysis': 'text-accent-cyan border-accent-cyan',
  'eks-analysis': 'text-accent-purple border-accent-purple',
  'database-analysis': 'text-accent-cyan border-accent-cyan',
  'msk-analysis': 'text-accent-orange border-accent-orange',
  'storage-analysis': 'text-accent-cyan border-accent-cyan',
  'recommendations': 'text-accent-green border-accent-green',
  'appendix': 'text-gray-400 border-gray-400',
};

const SECTION_ACCENT_TEXT: Record<string, string> = {
  'executive-summary': 'text-accent-cyan',
  'cost-overview': 'text-accent-green',
  'cost-compute': 'text-accent-green',
  'cost-network': 'text-accent-green',
  'cost-storage': 'text-accent-green',
  'idle-resources': 'text-accent-orange',
  'security-posture': 'text-red-400',
  'network-architecture': 'text-accent-purple',
  'compute-analysis': 'text-accent-cyan',
  'eks-analysis': 'text-accent-purple',
  'database-analysis': 'text-accent-cyan',
  'msk-analysis': 'text-accent-orange',
  'storage-analysis': 'text-accent-cyan',
  'recommendations': 'text-accent-green',
  'appendix': 'text-gray-400',
};

// --- Helpers ---

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function formatDatetime(iso: string): string {
  try {
    const d = new Date(iso);
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const hour = d.getHours().toString().padStart(2, '0');
    const min = d.getMinutes().toString().padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day} ${hour}:${min}`;
  } catch {
    return iso;
  }
}

// --- Component ---

export default function DiagnosisPage() {
  const { lang } = useLanguage();
  const { currentAccountId, accounts } = useAccountContext();
  const isEn = lang === 'en';
  const isZh = lang === 'zh';
  // 3-way language pick / 3개 언어 선택 헬퍼
  const L = (en: string, ko: string, zh: string) => isEn ? en : isZh ? zh : ko;

  // State
  const [currentReportId, setCurrentReportId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') return localStorage.getItem('awsops-diagnosis-reportId');
    return null;
  });
  const [status, setStatus] = useState<'idle' | 'generating' | 'completed' | 'failed'>('idle');
  const [progress, setProgress] = useState<ReportProgress>({ current: 0, total: 15, currentSection: '' });
  const [sections, setSections] = useState<ReportSection[]>([]);
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [downloadUrlDocx, setDownloadUrlDocx] = useState<string | null>(null);
  const [downloadUrlMd, setDownloadUrlMd] = useState<string | null>(null);
  const [showToc, setShowToc] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [showSchedule, setShowSchedule] = useState(false);
  const [schedule, setSchedule] = useState<ReportSchedule | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [showNotification, setShowNotification] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [notifEmails, setNotifEmails] = useState<string[]>([]);
  const [notifNewEmail, setNotifNewEmail] = useState('');
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifMessage, setNotifMessage] = useState<string | null>(null);

  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);

  // --- Cleanup ---

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // --- Persist reportId to localStorage ---

  useEffect(() => {
    if (currentReportId) {
      localStorage.setItem('awsops-diagnosis-reportId', currentReportId);
    }
  }, [currentReportId]);

  // --- Restore state from localStorage on mount ---

  useEffect(() => {
    const savedId = typeof window !== 'undefined' ? localStorage.getItem('awsops-diagnosis-reportId') : null;
    if (savedId && status === 'idle') {
      fetch(`/awsops/api/report?action=status&id=${savedId}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data) return;
          if (data.status === 'generating') {
            setCurrentReportId(savedId);
            setStatus('generating');
            setProgress(data.progress || { current: 0, total: 15, currentSection: '' });
          } else if (data.status === 'completed') {
            setCurrentReportId(savedId);
            setStatus('completed');
            setDownloadUrlDocx(data.downloadUrlDocx || null);
            setDownloadUrlMd(data.downloadUrlMd || null);
            setSections(data.sections || []);
            setCollapsedSections(new Set());
          }
        })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Fetch report list ---

  const fetchReportList = useCallback(async () => {
    try {
      const res = await fetch('/awsops/api/report?action=list');
      if (!res.ok) return;
      const data = await res.json();
      setReports(data.reports || []);

      // If any report is still generating, resume polling for the most recent one
      const generating = (data.reports || []).find((r: ReportListItem) => r.status === 'generating');
      if (generating) {
        setCurrentReportId(generating.reportId);
        setStatus('generating');
        setProgress(generating.progress || { current: 0, total: 15, currentSection: '' });
      }
    } catch {
      // Silently fail on list fetch
    }
  }, [currentReportId]);

  useEffect(() => {
    fetchReportList();
  }, [fetchReportList]);

  // --- Elapsed timer ---

  useEffect(() => {
    if (status === 'generating') {
      startTimeRef.current = Date.now();
      setElapsedTime(0);
      timerRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } else {
      stopTimer();
    }
    return stopTimer;
  }, [status, stopTimer]);

  // --- Poll for status ---

  useEffect(() => {
    if (currentReportId && status === 'generating') {
      const poll = async () => {
        try {
          const res = await fetch(`/awsops/api/report?action=status&id=${currentReportId}`);
          if (!res.ok) return;
          const data = await res.json();

          if (data.progress) {
            setProgress(data.progress);
          }

          if (data.status === 'completed') {
            stopPolling();
            setStatus('completed');
            setDownloadUrlDocx(data.downloadUrlDocx || null);
            setDownloadUrlMd(data.downloadUrlMd || null);
            setSections(data.sections || []);
            setCollapsedSections(new Set());
            fetchReportList();
          } else if (data.status === 'failed') {
            stopPolling();
            setStatus('failed');
            setError(data.error || (isEn ? 'Report generation failed' : isZh ? '报告生成失败' : '리포트 생성 실패'));
            fetchReportList();
          }
        } catch {
          // Poll errors are transient; keep trying
        }
      };

      // Initial poll immediately
      poll();
      pollRef.current = setInterval(poll, POLL_INTERVAL);

      return stopPolling;
    }
  }, [currentReportId, status, stopPolling, fetchReportList, isEn, isZh]);

  // --- Start diagnosis ---

  const startDiagnosis = useCallback(async () => {
    setStatus('generating');
    setError(null);
    setSections([]);
    setCollapsedSections(new Set());
    setDownloadUrlDocx(null);
    setDownloadUrlMd(null);
    setProgress({ current: 0, total: 15, currentSection: '' });

    try {
      const res = await fetch('/awsops/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: currentAccountId && currentAccountId !== '__all__' ? currentAccountId : undefined,
          lang,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setCurrentReportId(data.reportId);
      // Polling will start via useEffect when currentReportId + status change
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setStatus('failed');
      setError(message);
    }
  }, [currentAccountId, lang]);

  // --- View a completed report from history ---

  const viewReport = useCallback(async (reportId: string) => {
    try {
      const res = await fetch(`/awsops/api/report?action=status&id=${reportId}`);
      if (!res.ok) return;
      const data = await res.json();

      if (data.status === 'completed') {
        setCurrentReportId(reportId);
        setStatus('completed');
        setSections(data.sections || []);
        setDownloadUrlDocx(data.downloadUrlDocx || null);
        setDownloadUrlMd(data.downloadUrlMd || null);
        setError(null);
        setCollapsedSections(new Set());
      } else if (data.status === 'generating') {
        setCurrentReportId(reportId);
        setStatus('generating');
        setProgress(data.progress || { current: 0, total: 15, currentSection: '' });
        setError(null);
        setSections([]);
      }
    } catch {
      // Silently fail
    }
  }, []);

  // --- Severity icon for section content ---

  const getSeverityIcon = (content: string | undefined) => {
    if (!content) return <CheckCircle size={16} className="text-gray-600" />;
    const critCount = (content.match(/critical|심각|긴급/gi) || []).length;
    const warnCount = (content.match(/warning|주의|경고/gi) || []).length;
    if (critCount > 2) return <XCircle size={16} className="text-red-400" />;
    if (warnCount > 2) return <AlertTriangle size={16} className="text-accent-orange" />;
    return <CheckCircle size={16} className="text-accent-green" />;
  };

  // --- Resolve account alias ---

  const getAccountAlias = (accountId?: string): string => {
    if (!accountId) return L('All Accounts', '전체 계정', '全部账户');
    const found = accounts.find(a => a.accountId === accountId);
    return found ? found.alias : accountId;
  };

  // --- Schedule ---

  const fetchSchedule = useCallback(async () => {
    try {
      const res = await fetch('/awsops/api/report?action=schedule');
      if (res.ok) {
        const data = await res.json();
        setSchedule(data.schedule);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);

  const saveSchedule = useCallback(async (updates: Partial<ReportSchedule>) => {
    setScheduleLoading(true);
    try {
      const res = await fetch('/awsops/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-schedule', ...updates }),
      });
      if (res.ok) {
        const data = await res.json();
        setSchedule(data.schedule);
      }
    } catch { /* ignore */ }
    setScheduleLoading(false);
  }, []);

  // --- Notification Settings ---
  const fetchNotification = useCallback(async () => {
    try {
      const res = await fetch('/awsops/api/notification');
      if (res.ok) {
        const data = await res.json();
        setNotifEnabled(data.enabled || false);
        setNotifEmails(data.emails || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchNotification(); }, [fetchNotification]);

  const toggleNotification = useCallback(async (enabled: boolean) => {
    setNotifLoading(true);
    try {
      await fetch('/awsops/api/notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', enabled }),
      });
      setNotifEnabled(enabled);
    } catch { /* ignore */ }
    setNotifLoading(false);
  }, []);

  const syncEmails = useCallback(async (emails: string[]) => {
    setNotifLoading(true);
    setNotifMessage(null);
    try {
      const res = await fetch('/awsops/api/notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync-emails', emails }),
      });
      if (res.ok) {
        const data = await res.json();
        setNotifEmails(emails);
        const msgs: string[] = [];
        if (data.added?.length) msgs.push(`${data.added.length} added (confirmation email sent)`);
        if (data.removed?.length) msgs.push(`${data.removed.length} removed`);
        setNotifMessage(msgs.join(', ') || 'No changes');
      }
    } catch { /* ignore */ }
    setNotifLoading(false);
  }, []);

  const sendTestNotification = useCallback(async () => {
    setNotifLoading(true);
    try {
      const res = await fetch('/awsops/api/notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test' }),
      });
      const data = await res.json();
      setNotifMessage(data.sent ? 'Test notification sent!' : 'Failed to send');
    } catch { setNotifMessage('Error sending test'); }
    setNotifLoading(false);
  }, []);

  const addEmail = useCallback(() => {
    const email = notifNewEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    if (notifEmails.includes(email)) return;
    const updated = [...notifEmails, email];
    setNotifNewEmail('');
    syncEmails(updated);
  }, [notifNewEmail, notifEmails, syncEmails]);

  const removeEmail = useCallback((email: string) => {
    const updated = notifEmails.filter(e => e !== email);
    syncEmails(updated);
  }, [notifEmails, syncEmails]);

  // --- Progress bar percentage ---

  const progressPercent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <Header
        title={L('AI Diagnosis', 'AI 종합진단', 'AI 综合诊断')}
        subtitle={L(
          'AWS infrastructure health assessment — Cost, Compute, Security, FinOps (15 sections)',
          'AWS 인프라 건강 진단 — 비용, 컴퓨팅, 보안, FinOps 종합 분석 (15개 섹션)',
          'AWS 基础设施健康诊断 — 成本、计算、安全、FinOps 综合分析（15 个章节）')}
      />

      {/* Control Bar */}
      <div className="flex items-center gap-4 flex-wrap">
        <button
          onClick={startDiagnosis}
          disabled={status === 'generating'}
          className="flex items-center gap-2 px-6 py-3 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg text-accent-cyan hover:bg-accent-cyan/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === 'generating' ? (
            <><Loader2 size={18} className="animate-spin" />{L('Generating...', '생성 중...', '生成中...')}</>
          ) : (
            <><Play size={18} />{L('Run Diagnosis', '진단 시작', '开始诊断')}</>
          )}
        </button>

        {status === 'generating' && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-400">
              {progress.current}/{progress.total}
              {progress.currentSection && progress.currentSection !== 'data-collection' && progress.currentSection !== 'generating-report' && (
                <> — {SECTION_ICONS[progress.currentSection] || ''} {(isEn ? SECTION_FULL_NAMES[progress.currentSection]?.en : isZh ? SECTION_FULL_NAMES[progress.currentSection]?.zh : SECTION_FULL_NAMES[progress.currentSection]?.ko) || progress.currentSection} {L('analyzing...', '분석 중...', '分析中...')}</>
              )}
              {progress.currentSection === 'data-collection' && (
                <> — {L('Collecting data...', '데이터 수집 중...', '数据收集中...')}</>
              )}
              {progress.currentSection === 'generating-report' && (
                <> — {L('Creating report files...', '리포트 파일 생성 중...', '报告文件生成中...')}</>
              )}
            </span>
            <span className="text-accent-cyan font-mono">{formatElapsed(elapsedTime)}</span>
          </div>
        )}

        {status === 'completed' && downloadUrlDocx && (
          <button
            onClick={() => window.open(downloadUrlDocx, '_blank')}
            className="flex items-center gap-2 px-4 py-3 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg text-accent-cyan hover:bg-accent-cyan/20 transition-colors"
          >
            <Download size={18} />
            {L('Download DOCX', 'DOCX 다운로드', '下载 DOCX')}
          </button>
        )}

        <div className="flex-1" />
        <button
          onClick={() => setShowSchedule(s => !s)}
          className={`flex items-center gap-2 px-4 py-3 rounded-lg border transition-colors ${
            schedule?.enabled
              ? 'bg-accent-green/10 border-accent-green/30 text-accent-green'
              : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
          }`}
        >
          <CalendarClock size={18} />
          {L('Schedule', '자동 스케줄', '自动计划')}
          {schedule?.enabled && <span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" />}
        </button>
        <button
          onClick={() => setShowNotification(s => !s)}
          className={`flex items-center gap-2 px-4 py-3 rounded-lg border transition-colors ${
            notifEnabled
              ? 'bg-accent-cyan/10 border-accent-cyan/30 text-accent-cyan'
              : 'bg-navy-800 border-navy-600 text-gray-400 hover:text-gray-200'
          }`}
        >
          {notifEnabled ? <Bell size={18} /> : <BellOff size={18} />}
          {L('Notification', '알림', '通知')}
          {notifEnabled && notifEmails.length > 0 && (
            <span className="bg-accent-cyan/20 text-accent-cyan text-xs px-1.5 py-0.5 rounded-full">{notifEmails.length}</span>
          )}
        </button>
      </div>

      {/* Schedule Panel */}
      {showSchedule && schedule && (
        <div className="bg-navy-800 border border-navy-600 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CalendarClock size={18} className="text-accent-cyan" />
              <span className="text-white font-medium text-sm">{L('Scheduled Diagnosis', '자동 진단 스케줄', '自动诊断计划')}</span>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs text-gray-400">{schedule.enabled ? L('ON', '활성', '启用') : L('OFF', '비활성', '停用')}</span>
              <button
                onClick={() => saveSchedule({ enabled: !schedule.enabled })}
                className={`relative w-10 h-5 rounded-full transition-colors ${schedule.enabled ? 'bg-accent-green' : 'bg-navy-600'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${schedule.enabled ? 'left-5.5 translate-x-0.5' : 'left-0.5'}`} />
              </button>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {/* Frequency */}
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">{L('Frequency', '주기', '频率')}</label>
              <select
                value={schedule.frequency}
                onChange={e => saveSchedule({ frequency: e.target.value as ReportSchedule['frequency'] })}
                className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-sm text-white focus:border-accent-cyan/50 focus:outline-none"
              >
                <option value="weekly">{L('Weekly', '매주', '每周')}</option>
                <option value="biweekly">{L('Biweekly', '격주', '隔周')}</option>
                <option value="monthly">{L('Monthly', '매월', '每月')}</option>
              </select>
            </div>

            {/* Day selection */}
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">
                {schedule.frequency === 'monthly' ? L('Day of Month', '날짜', '日期') : L('Day of Week', '요일', '星期')}
              </label>
              {schedule.frequency === 'monthly' ? (
                <select
                  value={schedule.dayOfMonth}
                  onChange={e => saveSchedule({ dayOfMonth: Number(e.target.value) })}
                  className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-sm text-white focus:border-accent-cyan/50 focus:outline-none"
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d}>{d}{L('', '일', '日')}</option>
                  ))}
                </select>
              ) : (
                <select
                  value={schedule.dayOfWeek}
                  onChange={e => saveSchedule({ dayOfWeek: Number(e.target.value) })}
                  className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-sm text-white focus:border-accent-cyan/50 focus:outline-none"
                >
                  {(isEn
                    ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
                    : isZh
                    ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
                    : ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']
                  ).map((name, i) => (
                    <option key={i} value={i}>{name}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Hour */}
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">{L('Time (KST)', '시간 (KST)', '时间 (KST)')}</label>
              <select
                value={schedule.hour}
                onChange={e => saveSchedule({ hour: Number(e.target.value) })}
                className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-sm text-white focus:border-accent-cyan/50 focus:outline-none"
              >
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{i.toString().padStart(2, '0')}:00</option>
                ))}
              </select>
            </div>

            {/* Language */}
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">{L('Language', '언어', '语言')}</label>
              <select
                value={schedule.lang}
                onChange={e => saveSchedule({ lang: e.target.value })}
                className="w-full bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-sm text-white focus:border-accent-cyan/50 focus:outline-none"
              >
                <option value="ko">한국어</option>
                <option value="en">English</option>
                <option value="zh">简体中文</option>
              </select>
            </div>
          </div>

          {/* Status info */}
          <div className="mt-4 flex items-center gap-4 text-xs text-gray-500">
            {schedule.enabled && schedule.nextRunAt && (
              <span className="flex items-center gap-1.5">
                <Clock size={12} />
                {L('Next run:', '다음 실행:', '下次运行:')}{' '}
                <span className="text-accent-cyan font-mono">{formatDatetime(schedule.nextRunAt)}</span>
              </span>
            )}
            {schedule.lastRunAt && (
              <span className="flex items-center gap-1.5">
                <CheckCircle size={12} />
                {L('Last run:', '최근 실행:', '上次运行:')}{' '}
                <span className="text-gray-400 font-mono">{formatDatetime(schedule.lastRunAt)}</span>
              </span>
            )}
            {scheduleLoading && <Loader2 size={12} className="animate-spin text-accent-cyan" />}
          </div>
        </div>
      )}

      {/* Notification Settings Panel */}
      {showNotification && (
        <div className="bg-navy-800 border border-navy-600 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Mail size={18} className="text-accent-cyan" />
              <span className="text-white font-medium text-sm">{L('Email Notification', '이메일 알림', '邮件通知')}</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={sendTestNotification}
                disabled={notifLoading || !notifEnabled || notifEmails.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-navy-700 text-gray-300 hover:text-white border border-navy-600 disabled:opacity-40"
              >
                <Send size={12} /> {L('Test', '테스트', '测试')}
              </button>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-400">{notifEnabled ? 'ON' : 'OFF'}</span>
                <button
                  onClick={() => toggleNotification(!notifEnabled)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${notifEnabled ? 'bg-accent-green' : 'bg-navy-600'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${notifEnabled ? 'left-5.5 translate-x-0.5' : 'left-0.5'}`} />
                </button>
              </label>
            </div>
          </div>

          <p className="text-xs text-gray-500 mb-3">
            {L(
              'Receive email when diagnosis reports or CIS benchmarks complete. Each email must confirm the subscription.',
              '종합진단 리포트 또는 CIS 벤치마크 완료 시 이메일을 수신합니다. 각 이메일은 SNS 구독 확인이 필요합니다.',
              '综合诊断报告或 CIS 基准完成时接收邮件。每个邮箱均需确认 SNS 订阅。')}
          </p>

          {/* Add email */}
          <div className="flex gap-2 mb-3">
            <input
              type="email"
              value={notifNewEmail}
              onChange={e => setNotifNewEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addEmail()}
              placeholder="email@example.com"
              className="flex-1 bg-navy-900 border border-navy-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-accent-cyan/50 focus:outline-none"
            />
            <button
              onClick={addEmail}
              disabled={notifLoading}
              className="flex items-center gap-1.5 px-4 py-2 bg-accent-cyan/20 text-accent-cyan rounded-lg text-sm font-medium hover:bg-accent-cyan/30 disabled:opacity-40"
            >
              <Plus size={14} /> {L('Add', '추가', '添加')}
            </button>
          </div>

          {/* Email list */}
          {notifEmails.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {notifEmails.map(email => (
                <div key={email} className="flex items-center justify-between bg-navy-900 rounded-lg px-3 py-2">
                  <span className="text-sm text-gray-300">{email}</span>
                  <button
                    onClick={() => removeEmail(email)}
                    className="text-gray-500 hover:text-red-400 transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {notifEmails.length === 0 && (
            <div className="text-center text-xs text-gray-600 py-4">
              {L('No email addresses configured', '등록된 이메일이 없습니다', '未配置邮箱地址')}
            </div>
          )}

          {/* Status message */}
          {notifMessage && (
            <div className="text-xs text-accent-green mt-2">{notifMessage}</div>
          )}
          {notifLoading && <Loader2 size={14} className="animate-spin text-accent-cyan mt-2" />}
        </div>
      )}

      {/* Report History Table */}
      {reports.length > 0 && (
        <div className="bg-navy-800 border border-navy-600 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-navy-600">
            <h3 className="text-sm font-medium text-white">
              {L('Report History', '리포트 이력', '报告历史')}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-navy-600">
                  <th className="px-4 py-2.5 text-left text-xs text-gray-400 font-medium">{L('Date', '날짜', '日期')}</th>
                  <th className="px-4 py-2.5 text-left text-xs text-gray-400 font-medium">{L('Account', '계정', '账户')}</th>
                  <th className="px-4 py-2.5 text-left text-xs text-gray-400 font-medium">{L('Status', '상태', '状态')}</th>
                  <th className="px-4 py-2.5 text-left text-xs text-gray-400 font-medium">{L('Actions', '', '操作')}</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => (
                  <tr
                    key={report.reportId}
                    className={`border-b border-navy-700 hover:bg-navy-700/50 transition-colors ${currentReportId === report.reportId ? 'bg-navy-700/30' : ''}`}
                  >
                    <td className="px-4 py-2.5 text-gray-300 font-mono text-xs">{formatDatetime(report.createdAt)}</td>
                    <td className="px-4 py-2.5 text-gray-300 text-xs">{report.accountAlias || getAccountAlias(report.accountId)}</td>
                    <td className="px-4 py-2.5">
                      {report.status === 'completed' && <span className="inline-flex items-center gap-1 text-accent-green text-xs"><CheckCircle size={14} />{L('Completed', '완료', '已完成')}</span>}
                      {report.status === 'generating' && <span className="inline-flex items-center gap-1 text-accent-cyan text-xs"><Loader2 size={14} className="animate-spin" />{L('Generating', '생성 중', '生成中')}{report.progress && <span className="text-gray-500 ml-1">({report.progress.current}/{report.progress.total})</span>}</span>}
                      {report.status === 'failed' && <span className="inline-flex items-center gap-1 text-red-400 text-xs"><XCircle size={14} />{L('Failed', '실패', '失败')}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {report.status === 'completed' && (
                          <>
                            <button onClick={() => viewReport(report.reportId)} className="text-xs text-accent-cyan hover:text-accent-cyan/80 transition-colors">{L('View', '보기', '查看')}</button>
                            {report.downloadUrlDocx && <button onClick={() => window.open(report.downloadUrlDocx, '_blank')} className="inline-flex items-center gap-1 text-xs text-accent-cyan hover:text-accent-cyan/80 transition-colors"><Download size={12} /> DOCX</button>}
                            {report.downloadUrlMd && <button onClick={() => window.open(report.downloadUrlMd, '_blank')} className="inline-flex items-center gap-1 text-xs text-accent-green hover:text-accent-green/80 transition-colors"><Download size={12} /> MD</button>}
                          </>
                        )}
                        {report.status === 'generating' && <button onClick={() => viewReport(report.reportId)} className="text-xs text-accent-cyan hover:text-accent-cyan/80 transition-colors">{L('Track', '진행 확인', '查看进度')}</button>}
                        {report.status === 'failed' && <span className="text-xs text-gray-500">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Progress Bar (while generating) */}
      {status === 'generating' && (
        <div className="bg-navy-800 border border-navy-600 rounded-lg p-5">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Loader2 size={20} className="animate-spin text-accent-cyan" />
              <span className="text-white font-medium">
                {L('Generating AI Diagnosis Report...', 'AI 종합진단 리포트 생성 중...', 'AI 综合诊断报告生成中...')}
              </span>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-accent-cyan font-mono font-bold">{progress.current}/{progress.total}</span>
              <span className="text-gray-500 flex items-center gap-1"><Clock size={14} />{formatElapsed(elapsedTime)}</span>
            </div>
          </div>

          {/* Progress bar */}
          <div className="h-2 bg-navy-700 rounded-full overflow-hidden mb-4">
            <div
              className="h-full bg-gradient-to-r from-accent-cyan to-accent-purple rounded-full transition-all duration-700 ease-out"
              style={{ width: `${Math.max(progressPercent, 2)}%` }}
            />
          </div>

          {/* Active section detail panel */}
          {progress.currentSection && progress.currentSection !== 'data-collection' && progress.currentSection !== 'generating-report' && (
            <div className="bg-navy-900/50 border border-accent-cyan/20 rounded-lg p-3 mb-3">
              <div className="flex items-center gap-2 mb-2">
                <Loader2 size={14} className="animate-spin text-accent-cyan" />
                <span className="text-accent-cyan font-medium text-sm">
                  {SECTION_ICONS[progress.currentSection] || ''} {(isEn ? SECTION_FULL_NAMES[progress.currentSection]?.en : isZh ? SECTION_FULL_NAMES[progress.currentSection]?.zh : SECTION_FULL_NAMES[progress.currentSection]?.ko) || progress.currentSection}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 ml-6">
                {(isEn ? SECTION_SUBTOPICS[progress.currentSection]?.en : isZh ? SECTION_SUBTOPICS[progress.currentSection]?.zh : SECTION_SUBTOPICS[progress.currentSection]?.ko)?.map((topic, i) => (
                  <span key={i} className="text-[11px] text-gray-400 flex items-center gap-1">
                    <span className="text-accent-cyan/60">&#x2022;</span> {topic}
                  </span>
                )) || null}
              </div>
            </div>
          )}
          {progress.currentSection === 'data-collection' && (
            <div className="bg-navy-900/50 border border-accent-cyan/20 rounded-lg p-3 mb-3">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-accent-cyan" />
                <span className="text-accent-cyan font-medium text-sm">
                  {L('Collecting infrastructure data from Steampipe...', 'Steampipe에서 인프라 데이터 수집 중...', '正在从 Steampipe 收集基础设施数据...')}
                </span>
              </div>
              {progress.statusMessage && (
                <div className="ml-6 mt-1 text-[11px] text-gray-400">{progress.statusMessage}</div>
              )}
            </div>
          )}
          {progress.currentSection === 'generating-report' && (
            <div className="bg-navy-900/50 border border-accent-purple/20 rounded-lg p-3 mb-3">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin text-accent-purple" />
                <span className="text-accent-purple font-medium text-sm">
                  {L('Generating report files...', '리포트 파일 생성 중...', '报告文件生成中...')}
                </span>
              </div>
            </div>
          )}

          {/* Section checklist — compact grid */}
          <div className="grid grid-cols-3 md:grid-cols-5 gap-1.5 text-xs">
            {Object.entries(SECTION_ICONS).map(([key, icon]) => {
              const done = progress.completedSections?.includes(key);
              const active = progress.currentSection === key && !done;
              return (
                <div
                  key={key}
                  title={(isEn ? SECTION_FULL_NAMES[key]?.en : isZh ? SECTION_FULL_NAMES[key]?.zh : SECTION_FULL_NAMES[key]?.ko) || key}
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded transition-colors ${
                    done ? 'bg-accent-green/10 text-accent-green' :
                    active ? 'bg-accent-cyan/15 text-accent-cyan ring-1 ring-accent-cyan/30' :
                    'bg-navy-700/50 text-gray-600'
                  }`}
                >
                  {done ? <CheckCircle size={12} /> : active ? <Loader2 size={12} className="animate-spin" /> : <span className="w-3 h-3 rounded-full border border-gray-700 inline-block" />}
                  <span className="truncate">{icon} {SECTION_SHORT_NAMES[key] || key}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Error */}
      {status === 'failed' && error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400">
          <div className="flex items-center gap-2">
            <XCircle size={18} />
            <span className="font-medium">{L('Generation Failed', '생성 실패', '生成失败')}</span>
          </div>
          <p className="mt-2 text-sm text-red-400/80">{error}</p>
        </div>
      )}

      {/* Idle state */}
      {status === 'idle' && sections.length === 0 && (
        <div className="bg-navy-800 border border-navy-600 rounded-lg p-8 text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-accent-cyan/10 flex items-center justify-center mb-4">
            <FileText size={24} className="text-accent-cyan/50" />
          </div>
          <h3 className="text-lg text-white mb-2">{L('AWS AI Diagnosis', 'AWS AI 종합진단', 'AWS AI 综合诊断')}</h3>
          <p className="text-gray-400 text-sm max-w-lg mx-auto">
            {L(
              'AI-powered analysis of your AWS infrastructure across 15 dimensions: cost breakdown, compute rightsizing, security posture, idle resources, EKS/DB/MSK efficiency. Export as DOCX, Markdown, or PDF.',
              'AI가 전체 AWS 인프라를 15개 영역에서 분석합니다: 비용 분석, 컴퓨팅 rightsizing, 보안 진단, 유휴 리소스, EKS/DB/MSK 효율 분석. DOCX, Markdown, PDF로 내보낼 수 있습니다.',
              'AI 从 15 个维度分析您的 AWS 基础设施：成本分析、计算 rightsizing、安全诊断、闲置资源、EKS/DB/MSK 效率分析。可导出为 DOCX、Markdown、PDF。')}
          </p>
          <div className="mt-6 grid grid-cols-3 md:grid-cols-5 gap-3 max-w-3xl mx-auto text-xs text-gray-500">
            {Object.entries(SECTION_ICONS).map(([key, icon]) => (
              <div key={key} className="bg-navy-700 rounded px-2 py-1.5 flex items-center gap-1.5 justify-center">
                <span>{icon}</span>
                <span className="truncate">{key.replace(/-/g, ' ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Report Results (completed) */}
      {status === 'completed' && sections.length > 0 && (
        <div className="space-y-3">
          {/* Stats + Download bar */}
          <div className="flex flex-wrap items-center gap-3 bg-navy-800 border border-navy-600 rounded-lg px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle size={16} className="text-accent-green" />
              <span className="text-gray-300">{sections.length} {L('sections', '섹션', '个章节')}</span>
              <span className="text-gray-600">|</span>
              <Clock size={14} className="text-gray-500" />
              <span className="text-gray-400">{formatElapsed(elapsedTime)}</span>
              <span className="text-gray-600">|</span>
              <span className="text-gray-500 font-mono text-xs">{currentReportId?.slice(0, 8)}</span>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowToc(t => !t)}
                className={`p-2 rounded-lg border transition-colors ${showToc ? 'border-accent-cyan/30 text-accent-cyan bg-accent-cyan/10' : 'border-navy-600 text-gray-500 hover:text-gray-300'}`}
                title={L('Toggle TOC', '목차 토글', '切换目录')}
              >
                <List size={16} />
              </button>
              <span className="text-gray-600">|</span>
              {downloadUrlDocx && (
                <button
                  onClick={() => window.open(downloadUrlDocx, '_blank')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/10 text-xs font-medium transition-colors"
                >
                  <FileDown size={14} /> DOCX
                </button>
              )}
              {downloadUrlMd && (
                <button
                  onClick={() => window.open(downloadUrlMd, '_blank')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent-green/30 text-accent-green hover:bg-accent-green/10 text-xs font-medium transition-colors"
                >
                  <FileCode size={14} /> MD
                </button>
              )}
              <button
                onClick={() => window.open(`/awsops/ai-diagnosis/report?id=${currentReportId}`, '_blank')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent-purple/30 text-accent-purple hover:bg-accent-purple/10 text-xs font-medium transition-colors"
              >
                <Printer size={14} /> PDF
              </button>
            </div>
          </div>

          {/* TOC Sidebar + Section Content */}
          <div className="flex gap-4">
            {/* Sticky TOC sidebar */}
            {showToc && (
              <nav className="hidden lg:block w-52 flex-shrink-0">
                <div className="sticky top-20 space-y-0.5 bg-navy-800 border border-navy-600 rounded-lg p-2 max-h-[calc(100vh-6rem)] overflow-y-auto">
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider px-2 py-1 font-medium">
                    {L('Contents', '목차', '目录')}
                  </div>
                  {sections.map((section) => {
                    const isCollapsed = collapsedSections.has(section.section);
                    const accentClass = SECTION_ACCENT_CLASSES[section.section] || 'text-accent-cyan border-accent-cyan';
                    return (
                      <button
                        key={section.section}
                        onClick={() => {
                          if (isCollapsed) {
                            setCollapsedSections(prev => { const n = new Set(prev); n.delete(section.section); return n; });
                          }
                          document.getElementById(`section-${section.section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                        className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors hover:bg-navy-700 ${
                          isCollapsed ? 'text-gray-500' : accentClass.split(' ')[0]
                        }`}
                      >
                        <span className="text-sm">{SECTION_ICONS[section.section] || ''}</span>
                        <span className="truncate">{section.title}</span>
                      </button>
                    );
                  })}
                </div>
              </nav>
            )}

            {/* Main content — all sections expanded by default */}
            <div className="flex-1 min-w-0 space-y-4">
              {sections.map((section) => {
                const isCollapsed = collapsedSections.has(section.section);
                const accentClasses = SECTION_ACCENT_CLASSES[section.section] || 'text-accent-cyan border-accent-cyan';
                const accentText = SECTION_ACCENT_TEXT[section.section] || 'text-accent-cyan';
                return (
                  <div
                    key={section.section}
                    id={`section-${section.section}`}
                    className={`bg-navy-800 border rounded-lg overflow-hidden scroll-mt-20 ${
                      isCollapsed ? 'border-navy-600' : `border-l-4 ${accentClasses.split(' ')[1]} border-t border-r border-b border-t-navy-600 border-r-navy-600 border-b-navy-600`
                    }`}
                  >
                    <button
                      onClick={() => {
                        setCollapsedSections(prev => {
                          const n = new Set(prev);
                          if (n.has(section.section)) n.delete(section.section);
                          else n.add(section.section);
                          return n;
                        });
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-navy-700/50 transition-colors"
                    >
                      <span className="text-lg">{SECTION_ICONS[section.section] || '\u{1F4C4}'}</span>
                      <span className={`flex-1 font-semibold text-sm ${isCollapsed ? 'text-gray-400' : 'text-white'}`}>
                        {section.title}
                      </span>
                      {getSeverityIcon(section.content)}
                      {isCollapsed ? (
                        <ChevronRight size={16} className="text-gray-500" />
                      ) : (
                        <ChevronDown size={16} className="text-gray-500" />
                      )}
                    </button>

                    {!isCollapsed && (
                      <div className="px-5 pb-5 border-t border-navy-600/50">
                        <div className="mt-3">
                          <ReportMarkdown content={section.content} accentColor={accentText} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
