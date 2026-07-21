import type { GuideSpec } from './DiagnosisGuide';

// 서비스별 진단 가이드 콘텐츠 (owner 제공 가이드를 데이터로) — 렌더링은 DiagnosisGuide 하나가 담당.
// 새 서비스 추가 = 여기에 GuideSpec 하나 + 해당 테이블에서 <DiagnosisGuide spec={...} /> 한 줄.

const code = (t: string) => <code className="rounded bg-ink-50 px-1 font-mono text-[11px]">{t}</code>;

export const MSK_GUIDE: GuideSpec = {
  service: 'MSK',
  intro: (
    <>MSK는 <b>모니터링 레벨</b>(DEFAULT / PER_BROKER / PER_TOPIC_PER_BROKER / PER_TOPIC_PER_PARTITION)에 따라
    노출되는 메트릭이 달라집니다. 진단이 필요하면 최소 <b>PER_BROKER 이상</b>으로 올려두는 것을 권장합니다.</>
  ),
  sections: [
    { title: '① 브로커 리소스 (병목의 근원)', items: [
      <><b>CpuUser + CpuSystem</b> — 합산 60~70% 초과 시 경보. MSK 권장: CPU 여유 40% 이상 유지.</>,
      <><b>KafkaDataLogsDiskUsed</b> — 데이터 디스크 사용률(%). <b>가장 흔한 장애 원인</b> — 85% 초과 시 위험, 스토리지 확장/오토스케일링 필요.</>,
      <><b>MemoryUsed / MemoryFree</b>, <b>RootDiskUsed</b> — 루트 볼륨도 함께 확인.</>,
    ]},
    { title: '② 클러스터 건강성', items: [
      <><b>ActiveControllerCount</b> — 정상값은 정확히 <b>1</b>. 0이거나 2 이상이면 컨트롤러 이상 → 즉시 조사.</>,
      <><b>OfflinePartitionsCount</b> — 정상값 <b>0</b>. 0보다 크면 해당 파티션 서비스 불가 (데이터 가용성 문제).</>,
      <><b>UnderReplicatedPartitions</b> — 정상값 <b>0</b>. 0보다 크면 복제가 뒤처지는 중 (브로커 부하/장애 신호).</>,
      <><b>UnderMinIsrPartitionCount</b> — min.insync.replicas 미달 파티션. acks=all 프로듀서가 쓰기 거부당하는 상황.</>,
    ]},
    { title: '③ 처리량·트래픽', items: [
      <><b>BytesInPerSec / BytesOutPerSec</b> — 인스턴스 타입의 네트워크 한계 대비 확인. <b>MessagesInPerSec</b> 병행.</>,
      <><b>ProduceThrottleTime / FetchThrottleTime</b> — 쿼터/네트워크 스로틀링 발생 여부.</>,
    ]},
    { title: '④ 지연(Latency)', items: [
      <><b>RequestQueueSize / ResponseQueueSize</b> — 큐가 쌓이면 브로커가 요청을 못 따라가는 중.</>,
      <>Produce/Fetch 레이턴시 (FetchConsumerTotalTimeMsMean 등)로 상세 확인.</>,
    ]},
    { title: '⑤ 컨슈머 지연 — 실무에서 가장 중요', items: [
      <><b>MaxOffsetLag / SumOffsetLag / EstimatedMaxTimeLag</b> — 컨슈머가 프로듀서를 못 따라가면 lag이 계속 증가. 실시간 파이프라인 진단의 최우선 지표.</>,
      <>컨슈머 그룹 lag은 CloudWatch 외에 Kafka 자체 {code('kafka-consumer-groups.sh')}로도 확인.</>,
    ]},
    { title: '⑥ 연결', items: [
      <><b>ConnectionCount / ClientConnectionCount</b>, <b>ConnectionCreationRate / CloseRate</b> — 커넥션 폭증·재연결 폭풍 감지.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '정상값', '의미'],
  priority: [
    ['ActiveControllerCount', '= 1', '컨트롤러 정상'],
    ['OfflinePartitionsCount', '= 0', '가용성'],
    ['UnderReplicatedPartitions', '= 0', '복제 건강성'],
    ['KafkaDataLogsDiskUsed', '< 85%', '디스크 고갈 방지'],
    ['CpuUser + CpuSystem', '< ~60%', '부하 여유'],
    ['MaxOffsetLag', '추세 안정', '컨슈머 처리 지연'],
  ],
};

export const RDS_GUIDE: GuideSpec = {
  service: 'RDS',
  intro: (
    <>RDS 진단은 <b>CloudWatch 기본 메트릭 · Enhanced Monitoring · Performance Insights</b> 세 층위를
    함께 봅니다 — 각각 인스턴스 / OS / 쿼리 관점입니다.</>
  ),
  sections: [
    { title: '① CloudWatch 기본 메트릭 (인스턴스 레벨)', items: [
      <><b>CPUUtilization</b> — 지속 80% 초과 시 인스턴스 확장 또는 쿼리 튜닝.</>,
      <><b>CPUCreditBalance / CPUCreditUsage</b> — T계열(버스터블) 한정. 크레딧이 0에 수렴하면 성능 급락. <b>프로덕션에서 자주 놓치는 함정.</b></>,
      <><b>FreeableMemory</b> — 지속적으로 낮으면 스왑 위험. <b>SwapUsage</b>는 0에 가까워야 정상 — 커지면 성능 급락 신호.</>,
      <><b>FreeStorageSpace</b> — <b>가장 흔한 장애 원인.</b> 고갈되면 DB가 멈춤 → 스토리지 오토스케일링/경보 필수. <b>DiskQueueDepth</b>가 높으면 스토리지 병목.</>,
      <><b>ReadIOPS / WriteIOPS</b> — 프로비저닝 IOPS(gp3/io1/io2) 한계 대비. <b>ReadLatency / WriteLatency</b> 급증 = 스토리지 병목. <b>BurstBalance</b>(gp2)는 고갈 시 baseline IOPS로 강등.</>,
      <><b>DatabaseConnections</b> — max_connections 대비. 커넥션 고갈/누수(풀 미사용) 진단.</>,
    ]},
    { title: '② 복제 / 고가용성', items: [
      <><b>ReplicaLag</b>(리드 리플리카, 초) / <b>AuroraReplicaLag</b> — 읽기 분산 시 데이터 최신성 문제.</>,
      <>Multi-AZ 페일오버 이벤트는 RDS Events로 추적.</>,
    ]},
    { title: '③ Enhanced Monitoring (OS 레벨, 최소 1초 간격)', items: [
      <>CloudWatch 기본은 하이퍼바이저 관점 — OS 내부는 Enhanced Monitoring으로: 프로세스별 CPU/메모리, os.cpuUtilization 세부(user/system/wait/idle), os.diskIO, loadAverage.</>,
      <><b>CPU wait 높음 = I/O 병목, system 높음 = 커널 오버헤드</b> — 원인 구분에 유용.</>,
    ]},
    { title: '④ Performance Insights (쿼리 레벨 — 진단의 핵심)', items: [
      <><b>DB Load (AAS)</b> — 핵심 지표. <b>Max vCPU 라인 위</b>로 올라가면 과부하.</>,
      <><b>Wait events 분해</b> — CPU / IO / Lock 중 무엇이 병목인지 (io/table/sql/handler, 락 대기 등).</>,
      <><b>Top SQL</b> — 부하 유발 상위 쿼리 식별 → 튜닝 대상.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['CPUUtilization', '> 80% 지속', '컴퓨트 병목'],
    ['FreeStorageSpace', '임계치 이하', '디스크 고갈 → DB 정지'],
    ['FreeableMemory', '낮음 + SwapUsage 증가', '메모리 부족'],
    ['DatabaseConnections', 'max 근접', '커넥션 고갈/누수'],
    ['ReadLatency/WriteLatency', '급증', '스토리지 병목'],
    ['ReplicaLag', '증가 추세', '복제 지연'],
    ['BurstBalance/CPUCreditBalance', '0 근접', 'gp2/T계열 크레딧 고갈'],
    ['DB Load (PI)', '> Max vCPU', '전반 과부하'],
  ],
};

export const DDB_GUIDE: GuideSpec = {
  service: 'DynamoDB',
  intro: (
    <>DynamoDB는 관리형 서비스라 OS/디스크 층위가 없고 <b>CloudWatch 중심으로 처리량·스로틀링·지연·에러</b>를
    봅니다. 캐패시티 모드(On-Demand vs Provisioned)에 따라 관심 지표가 달라집니다.</>
  ),
  sections: [
    { title: '① 스로틀링 — 진단에서 가장 중요', items: [
      <><b>ThrottledRequests</b>, <b>ReadThrottleEvents / WriteThrottleEvents</b>, <b>OnlineIndexThrottleEvents</b>(GSI 인덱싱).</>,
      <>원인은 보통 둘 중 하나: <b>프로비저닝 부족</b>(용량 &lt; 트래픽) 또는 <b>핫 파티션/핫 키</b> — 전체 용량은 남는데 특정 파티션이 한계(파티션당 3000 RCU / 1000 WCU)에 걸림. 후자가 가장 진단하기 까다로운 케이스.</>,
    ]},
    { title: '② 캐패시티 사용량', items: [
      <><b>ConsumedRead/WriteCapacityUnits</b>(실소비) vs <b>ProvisionedRead/WriteCapacityUnits</b>(설정값)를 겹쳐 여유/부족 판단.</>,
      <>On-Demand는 소비량 추세 + AccountMaxTableLevelReads/Writes 상한 + 순간 급증(2배 룰 초과) 여부.</>,
    ]},
    { title: '③ 지연 (Latency)', items: [
      <><b>SuccessfulRequestLatency</b> — <b>오퍼레이션별 분해가 핵심</b>(GetItem/Query/PutItem/Scan…). 서비스 측 지연(네트워크 왕복 제외).</>,
      <>Scan/Query 지연이 튀면 비효율적 액세스 패턴(풀스캔, 큰 결과셋) 의심.</>,
    ]},
    { title: '④ 에러', items: [
      <><b>SystemErrors</b>(HTTP 500, 서버 측) / <b>UserErrors</b>(HTTP 400, 클라이언트 측).</>,
      <><b>ConditionalCheckFailedRequests</b> — 낙관적 락 사용 시 정상적으로도 발생 → 맥락 판단. <b>TransactionConflict</b> 높으면 경합 심함.</>,
    ]},
    { title: '⑤ Global Tables / 스트림', items: [
      <><b>ReplicationLatency</b>, PendingReplicationCount, AgeOfOldestUnreplicatedRecord — 리전 간 복제 지연.</>,
      <>Streams를 Lambda로 소비 중이면 Lambda의 <b>IteratorAge</b>로 스트림 처리 지연 확인.</>,
    ]},
    { title: '진단 심화: CloudWatch Contributor Insights for DynamoDB', items: [
      <><b>핫 파티션/핫 키 탐지 특화 도구</b> — 가장 자주 접근되는 파티션 키를 순위로 표시해, 스로틀 원인이 "용량 부족"인지 "키 분포 불균형"인지 구분할 때 결정적.</>,
      <>Throttled key(스로틀된 키)도 별도 룰로 확인 가능 — 테이블별로 Contributor Insights를 활성화해 사용.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['ReadThrottleEvents / WriteThrottleEvents', '> 0 지속', '용량 부족 또는 핫 파티션'],
    ['SystemErrors', '급증', '서버 측 이상'],
    ['ConsumedRCU/WCU vs Provisioned', '근접/초과', '용량 여유 부족'],
    ['SuccessfulRequestLatency', '급증', '액세스 패턴/성능 문제'],
    ['ConditionalCheckFailedRequests', '예상보다 높음', '경합 또는 로직 문제'],
    ['ReplicationLatency (Global Tables)', '증가 추세', '리전 간 복제 지연'],
  ],
};

export const EC_GUIDE: GuideSpec = {
  service: 'ElastiCache',
  intro: (
    <>엔진(Redis/Valkey vs Memcached)에 따라 메트릭이 다르지만 공통적으로 <b>CPU · 메모리 · 연결 ·
    성능(히트율/지연) · 엔진 고유 지표</b>를 봅니다. 아래는 Redis/Valkey 기준입니다.</>
  ),
  sections: [
    { title: '① CPU', items: [
      <><b>EngineCPUUtilization</b> — Redis/Valkey에서 가장 중요. 주 명령 처리가 사실상 <b>단일 스레드</b>라 코어 하나가 포화되면 CPUUtilization(전체 vCPU 평균)은 낮아 보여도 실제로는 병목.</>,
      <><b>CPUUtilization</b> — 노드 전체. <b>Memcached는 멀티스레드라 이쪽이 유효.</b></>,
      <>EngineCPU 지속 높음 → 느린 명령(O(N): KEYS, 큰 HGETALL, 대형 SORT) 의심 또는 샤드 확장.</>,
    ]},
    { title: '② 메모리 — 진단 핵심', items: [
      <><b>DatabaseMemoryUsagePercentage</b> — maxmemory 대비 사용률. <b>가장 중요한 경보 지표.</b> FreeableMemory / BytesUsedForCache 병행.</>,
      <><b>SwapUsage</b> — 커지면 위험(디스크 스왑 → 지연 급증).</>,
      <><b>Evictions</b> — 메모리가 꽉 차 키 강제 축출. 지속 발생 시 노드 확장·샤딩·maxmemory-policy 재검토. <b>Reclaimed</b>(TTL 만료 제거)는 정상 동작.</>,
    ]},
    { title: '③ 성능 — 히트율과 지연', items: [
      <><b>CacheHitRate</b>(또는 CacheHits/CacheMisses) — 캐시 효용의 핵심. 낮으면 TTL 너무 짧음 / 캐시 키 설계 문제 / 콜드 캐시.</>,
      <>명령군별 지연(StringBasedCmdsLatency, GetType/SetType/HashBasedCmdsLatency…)으로 어떤 명령이 느린지 분해. SuccessfulRead/WriteRequestLatency 병행.</>,
    ]},
    { title: '④ 연결', items: [
      <><b>CurrConnections</b> — maxclients 대비. <b>NewConnections</b> 급증 = 커넥션 풀 미사용/재연결 폭풍 의심(연결 수립 비용 큼). <b>CurrItems</b>는 아이템 수.</>,
    ]},
    { title: '⑤ 네트워크·처리량', items: [
      <>NetworkBytesIn/Out, <b>NetworkBandwidthIn/OutAllowanceExceeded</b> — 인스턴스 타입별 네트워크 상한 초과. <b>놓치기 쉬운 병목.</b> ConnTrack/PPS AllowanceExceeded도 동류.</>,
      <><b>ReplicationBytes / ReplicationLag</b> — 리드 리플리카 복제 지연.</>,
    ]},
    { title: '⑥ 엔진 고유 (Redis/Valkey)', items: [
      <>KeyspaceHits/Misses, SaveInProgress, BytesUsedForCache. 느린 명령 추적은 Redis {code('SLOWLOG')} 병행.</>,
      <>클러스터 모드면 샤드/노드별로 분해해 <b>핫 샤드</b> 확인.</>,
    ]},
    { title: '증상별 진단 경로', items: [
      <>지연 증가 + 전체 CPU 낮음 → <b>EngineCPUUtilization + SLOWLOG</b> 확인.</>,
      <>간헐적 성능 저하 + Evictions → <b>메모리 부족 / TTL·eviction 정책</b> 재검토.</>,
      <>원인 불명 지연 + 트래픽 많음 → <b>Network...AllowanceExceeded</b> 대역폭 상한 확인.</>,
      <>히트율 낮음 → <b>캐시 키 설계·TTL</b> 재검토.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['EngineCPUUtilization', '> 90% (Redis)', '단일 스레드 포화/느린 명령'],
    ['DatabaseMemoryUsagePercentage', '높음', '메모리 압박'],
    ['Evictions', '> 0 지속', '메모리 부족 → 키 축출'],
    ['SwapUsage', '증가', '성능 급락 위험'],
    ['CacheHitRate', '낮음', '캐시 효용 저하'],
    ['CurrConnections', 'max 근접', '연결 고갈'],
    ['Network...AllowanceExceeded', '> 0', '네트워크 상한 병목'],
    ['ReplicationLag', '증가 추세', '복제 지연'],
  ],
};

export const OS_GUIDE: GuideSpec = {
  service: 'OpenSearch',
  intro: (
    <>OpenSearch는 <b>클러스터 상태 · JVM/메모리 · 스토리지 · 검색/인덱싱 성능 · 스레드 풀 큐</b>를
    핵심으로 봅니다 (관리형 OpenSearch Service, CloudWatch 메트릭 기준).</>
  ),
  sections: [
    { title: '① 클러스터 상태 — 가장 먼저 보는 것', items: [
      <><b>ClusterStatus.green/yellow/red</b> — <b>red는 즉시 대응</b>: 프라이머리 샤드 미할당(데이터 접근 불가). yellow는 레플리카 미할당(가용성 저하, 데이터는 접근 가능).</>,
      <><b>Nodes</b> — 예상값과 다르면 노드 이탈/장애.</>,
      <><b>ClusterIndexWritesBlocked</b> — 값 1 = 쓰기 차단(디스크 부족/JVM 압박/red 등). <b>매우 중요한 경보 지표.</b></>,
    ]},
    { title: '② JVM 메모리 압박 — 진단의 핵심', items: [
      <><b>JVMMemoryPressure</b>(신형 OldGenJVMMemoryPressure) — 가장 중요. <b>80% 초과 시 잦은 GC로 성능 저하</b>, 92% 이상 지속 시 보호 메커니즘이 쓰기를 차단할 수 있음.</>,
      <><b>JVMGCYoung/OldCollectionCount·Time</b> — Old GC가 잦고 길면 힙 압박 심각.</>,
      <>압박 높음 → 샤드 수 과다(오버샤딩), 큰 집계 쿼리, 필드 데이터 캐시 과다, 노드 확장 필요 의심.</>,
    ]},
    { title: '③ CPU', items: [
      <><b>CPUUtilization</b>(데이터 노드) / <b>MasterCPUUtilization</b>(전용 마스터 — 포화 시 샤드 할당·상태 갱신 지연) / WarmCPUUtilization(UltraWarm).</>,
    ]},
    { title: '④ 스토리지', items: [
      <><b>FreeStorageSpace</b> — 노드별 여유 디스크. <b>가장 흔한 장애 원인.</b> 디스크 워터마크(low 85% / high 90% / flood 95%)에 걸리면 샤드 재배치·쓰기 차단.</>,
      <>ClusterUsedSpace, <b>DiskQueueDepth</b>(I/O 대기), Read/WriteLatency·Throughput(EBS).</>,
    ]},
    { title: '⑤ 검색·인덱싱 성능', items: [
      <><b>SearchRate / SearchLatency</b>, <b>IndexingRate / IndexingLatency</b> — 지연이 튀면 무거운 쿼리·오버샤딩·리소스 포화 의심.</>,
    ]},
    { title: '⑥ 스레드 풀 큐와 거부 — 부하 포화 신호', items: [
      <><b>ThreadpoolSearchQueue / ThreadpoolWriteQueue</b> — 큐가 쌓이면 처리 지연 중.</>,
      <><b>ThreadpoolSearchRejected / ThreadpoolWriteRejected</b> — 큐가 꽉 차 요청 거부. <b>0보다 크면 클라이언트가 에러를 받는 중 → 즉시 조사.</b> 용량 부족/쿼리 비효율의 강한 신호. CoordinatingWriteRejected·PrimaryWriteRejected는 쓰기 배압.</>,
    ]},
    { title: '⑦ 기타 자주 보는 것', items: [
      <><b>MasterReachableFromNode</b>(1이 정상), <b>AutomatedSnapshotFailure</b>(백업 실패), <b>KMSKeyError/KMSKeyInaccessible</b>(값 1이면 클러스터 접근 불가 위험).</>,
      <>5xx/4xx/2xx HTTP 코드, InvalidHostHeaderRequests, ThroughputThrottle/IopsThrottle(gp3).</>,
    ]},
    { title: '증상별 진단 경로', items: [
      <>클러스터 red/yellow → 샤드 할당 실패 원인(디스크 워터마크, 노드 이탈) 확인.</>,
      <>간헐적 요청 실패(429/거부) → <b>Threadpool...Rejected + JVM 압박</b> 확인.</>,
      <>검색 지연 급증 → 무거운 쿼리, 오버샤딩(샤드 수 대비 데이터량), 리소스 포화 점검.</>,
      <>쓰기 차단 → <b>ClusterIndexWritesBlocked + FreeStorageSpace + JVMMemoryPressure</b> 조합.</>,
      <>CloudWatch로 안 잡히는 세밀한 원인(특정 인덱스/샤드/쿼리)은 자체 API로: {code('_cluster/health')}, {code('_cat/indices?v')}, {code('_cat/shards')}, {code('_nodes/stats')}, Slow logs / Error logs.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['ClusterStatus.red', '= 1', '프라이머리 샤드 미할당(데이터 불가)'],
    ['ClusterIndexWritesBlocked', '= 1', '쓰기 차단'],
    ['JVMMemoryPressure', '> 80%', '힙 압박 → GC/성능 저하'],
    ['FreeStorageSpace', '워터마크 근접', '디스크 고갈'],
    ['Threadpool...Rejected', '> 0', '요청 거부(포화)'],
    ['MasterCPUUtilization', '높음', '마스터 병목'],
    ['SearchLatency/IndexingLatency', '급증', '쿼리/인덱싱 성능'],
    ['AutomatedSnapshotFailure', '= 1', '백업 실패'],
  ],
};

export const ALB_GUIDE: GuideSpec = {
  service: 'ALB',
  intro: (
    <>ALB는 <b>HTTP 응답 코드 · 지연 · 연결/요청 수 · 타깃 헬스 · 용량(LCU)</b>을 핵심으로 봅니다.
    특히 <b>"로드밸런서 자체가 낸 에러"(HTTPCode_ELB_*)와 "타깃이 낸 에러"(HTTPCode_Target_*)를
    구분하는 것</b>이 진단의 출발점입니다.</>
  ),
  sections: [
    { title: '① HTTP 응답 코드 — 진단의 핵심', items: [
      <><b>HTTPCode_ELB_5XX_Count</b> — ALB가 직접 생성한 5xx(타깃까지 못 갔거나 응답을 못 받음). 502/503/504로 세분하면 원인이 좁혀집니다.</>,
      <><b>502</b>(Bad Gateway) — 타깃의 malformed 응답/연결 끊김. <b>가장 흔한 트러블.</b> <b>503</b> — 정상 타깃이 없음(전부 unhealthy), 매우 중요. <b>504</b> — idle timeout 내 응답 실패, 백엔드 느림 신호.</>,
      <><b>HTTPCode_Target_5XX_Count</b> — 백엔드 애플리케이션 오류. Target_2XX/3XX는 정상 트래픽 기준선.</>,
      <><b>핵심 구분</b>: ELB_5XX↑ = LB↔타깃 연결/헬스 문제, Target_5XX↑ = 애플리케이션 코드 문제.</>,
    ]},
    { title: '② 지연 (Latency)', items: [
      <><b>TargetResponseTime</b> — 가장 중요. <b>p50/p90/p99 백분위로</b> 봐야 함(평균은 롱테일을 숨김). 급증 = 백엔드 성능 저하.</>,
    ]},
    { title: '③ 요청·연결 수', items: [
      <><b>RequestCount</b>(트래픽 기준선), <b>ActiveConnectionCount</b>, <b>NewConnectionCount</b>(TLS 재협상 폭주 감지).</>,
      <><b>RejectedConnectionCount</b> — ALB 최대 연결 한도 도달. <b>0보다 크면 용량 문제.</b></>,
      <><b>Client/TargetTLSNegotiationErrorCount</b> — TLS 협상 실패.</>,
    ]},
    { title: '④ 타깃 헬스 — 가용성 (타깃 그룹 차원으로 봐야 의미)', items: [
      <><b>HealthyHostCount</b> — 0에 가까워지면 위험, 0이면 503 발생.</>,
      <><b>UnHealthyHostCount</b> — 증가 시 헬스체크 실패 원인 조사(앱 크래시, 헬스체크 경로 오류, 시작 지연).</>,
    ]},
    { title: '⑤ 용량 / 스로틀', items: [
      <><b>ConsumedLCUs</b>(요금·용량 산정, 급증 감지), ProcessedBytes.</>,
      <><b>TargetConnectionErrorCount</b> — ALB→타깃 연결 실패. 네트워크/보안그룹/타깃 포트 문제 신호.</>,
    ]},
    { title: '⑥ 기타 상황별', items: [
      <><b>RequestCountPerTarget</b> — 부하 분산 불균형 감지. HTTP_Redirect/Fixed_Response_Count.</>,
      <>DesyncMitigationMode_NonCompliant_Request_Count(HTTP desync 위험), GrpcRequestCount(gRPC).</>,
    ]},
    { title: '증상별 진단 흐름', items: [
      <>502 급증 → 타깃 앱 크래시/커넥션 조기 종료, <b>keep-alive 타임아웃 불일치</b>(ALB idle timeout &gt; 백엔드 keep-alive면 발생) 점검.</>,
      <>503 급증 → <b>HealthyHostCount</b> 확인, 헬스체크 실패 원인 조사.</>,
      <>504 급증 → 백엔드 느림(TargetResponseTime) + ALB idle timeout 설정.</>,
      <>간헐적 5xx인데 Target은 2xx → LB 레벨 문제: <b>RejectedConnectionCount / TargetConnectionErrorCount</b> 확인.</>,
      <>원인 불명 → <b>액세스 로그(S3)</b>로 개별 요청의 elb_status_code vs target_status_code, request/target/response_processing_time 분해 — 지연이 LB 큐잉인지 백엔드인지 정확히 구분.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['HTTPCode_ELB_5XX_Count', '급증', 'LB↔타깃 문제(502/503/504로 세분)'],
    ['HTTPCode_Target_5XX_Count', '급증', '백엔드 앱 오류'],
    ['TargetResponseTime (p99)', '급증', '백엔드 성능 저하'],
    ['HealthyHostCount', '낮음/0', '가용 타깃 부족 → 503'],
    ['UnHealthyHostCount', '> 0', '헬스체크 실패'],
    ['RejectedConnectionCount', '> 0', '연결 한도 도달'],
    ['TargetConnectionErrorCount', '> 0', '타깃 연결 실패(네트워크/SG)'],
  ],
};

export const NLB_GUIDE: GuideSpec = {
  service: 'NLB',
  intro: (
    <>NLB는 <b>L4(TCP/UDP/TLS)</b>에서 동작해 ALB와 관점이 다릅니다 — HTTP 응답 코드가 없고
    <b> 연결(플로우) · 리셋(RST) · 타깃 헬스 · 처리량 · 용량(LCU)</b>을 중심으로 봅니다.
    CloudWatch 메트릭이 제한적이라 <b>RST 카운트와 타깃 헬스가 진단의 핵심</b>입니다.</>
  ),
  sections: [
    { title: '① 연결(플로우) 수', items: [
      <><b>ActiveFlowCount</b> — 활성 플로우(TCP 기준). 급증/급감으로 트래픽 이상 감지. <b>NewFlowCount</b>는 연결 수립률.</>,
      <>프로토콜별 분해: ActiveFlowCount_TCP/_UDP/_TLS, NewFlowCount_TCP/_UDP/_TLS. <b>ConsumedLCUs</b>(_TCP/_UDP/_TLS)는 용량·요금 산정.</>,
    ]},
    { title: '② 리셋(RST) — NLB 진단의 핵심', items: [
      <><b>TCP_Target_Reset_Count</b> — 타깃이 보낸 RST: 백엔드가 연결을 끊음(앱 크래시, 포트 닫힘, 백로그 초과). <b>급증 = 백엔드 문제 강한 신호.</b></>,
      <><b>TCP_ELB_Reset_Count</b> — NLB가 생성한 RST: 유휴 타임아웃 초과 등. <b>TCP_Client_Reset_Count</b> — 클라이언트발.</>,
      <><b>핵심 구분</b>: Target RST 급증 → 백엔드 문제, ELB RST 급증 → NLB 레벨(주로 <b>idle timeout 350초</b>) 또는 비대칭 라우팅.</>,
    ]},
    { title: '③ 타깃 헬스 — 가용성 (타깃 그룹 차원)', items: [
      <><b>HealthyHostCount</b>(0에 가까우면 위험) / <b>UnHealthyHostCount</b>(증가 시 헬스체크 실패 조사).</>,
      <>NLB는 액티브(TCP/HTTP/HTTPS) 헬스체크 + 자체 판단이 섞임 — 대상 그룹의 헬스체크 설정(프로토콜/포트/경로)도 함께 점검.</>,
    ]},
    { title: '④ 처리량·바이트', items: [
      <><b>ProcessedBytes</b>(_TCP/_UDP/_TLS), ProcessedPackets.</>,
    ]},
    { title: '⑤ TLS (TLS 리스너 사용 시)', items: [
      <><b>Client/TargetTLSNegotiationErrorCount</b>, TLSNegotiationErrorCount — 협상 실패.</>,
    ]},
    { title: '⑥ 용량 한계·기타', items: [
      <><b>PortAllocationErrorCount</b> — 클라이언트 IP 보존 + PrivateLink/SNAT 상황의 소스 포트 고갈. <b>0보다 크면 연결 실패 발생 — 놓치기 쉬운 원인.</b></>,
      <>PeakPackets/BytesPerSecond, <b>UnhealthyRoutingFlowCount</b>(정상 타깃이 없어 라우팅 실패 — 페일오버 오픈 관련).</>,
    ]},
    { title: '증상별 진단 흐름', items: [
      <>간헐적 연결 끊김 → <b>Target RST(백엔드) vs ELB RST(idle timeout 350초 초과)</b> 구분, keep-alive 설정 점검.</>,
      <>연결 자체가 안 됨 → HealthyHostCount + 보안그룹/NACL/타깃 포트. <b>NLB는 클라이언트 IP를 보존하므로 타깃 SG가 클라이언트 IP를 허용해야 함 — 흔한 함정.</b></>,
      <>부하 높을 때 연결 실패 → <b>PortAllocationErrorCount</b>(SNAT 포트 고갈).</>,
      <>TLS 리스너 오류 → Client/TargetTLSNegotiationErrorCount.</>,
    ]},
    { title: 'ALB와 다른 주의점', items: [
      <>L4라 <b>애플리케이션 레벨 지연/에러를 못 봄</b> — HTTP 문제는 타깃(백엔드) 메트릭·로그로.</>,
      <><b>VPC Flow Logs</b>가 트러블슈팅에 매우 유용(연결 수락/거부, 클라이언트 IP 추적). NLB 자체 액세스 로그는 <b>TLS 리스너에서만</b> 제공.</>,
      <>클라이언트 IP 보존 특성 때문에 <b>타깃 보안그룹 규칙</b>이 자주 원인.</>,
    ]},
  ],
  priorityHeader: ['메트릭', '주의 기준', '의미'],
  priority: [
    ['HealthyHostCount', '낮음/0', '가용 타깃 부족'],
    ['UnHealthyHostCount', '> 0', '헬스체크 실패'],
    ['TCP_Target_Reset_Count', '급증', '백엔드가 연결 리셋'],
    ['TCP_ELB_Reset_Count', '급증', 'NLB 리셋(idle timeout 등)'],
    ['PortAllocationErrorCount', '> 0', 'SNAT 소스 포트 고갈'],
    ['ActiveFlowCount', '이상 추세', '트래픽/연결 이상'],
    ['TargetTLSNegotiationErrorCount', '> 0', '타깃 TLS 문제'],
  ],
};
