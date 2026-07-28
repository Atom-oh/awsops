// Owns the site root route "/". No doc may declare `slug: /` — it would
// collide with this page route and fail the Docusaurus build.
import React, { useEffect, useRef, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import Translate, { translate } from '@docusaurus/Translate';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './index.module.css';

const HERO_FRAMES = ['dashboard', 'topology', 'cost-explorer', 'ai-diagnosis'];
const DASHBOARD_URL = 'https://awsops.atomai.click/';

function useScrollReveal(): React.RefObject<HTMLDivElement> {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const items = Array.from(el.querySelectorAll<HTMLElement>('[data-reveal]'));
    items.forEach((item) => {
      item.dataset.reveal = 'pending';
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.reveal = 'in';
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    items.forEach((item) => observer.observe(item));

    return () => observer.disconnect();
  }, []);

  return rootRef;
}

function TourVideo(): React.ReactElement {
  const webmUrl = useBaseUrl('/video/product-tour.webm');
  const mp4Url = useBaseUrl('/video/product-tour.mp4');
  const posterUrl = useBaseUrl('/video/product-tour-poster.webp');
  const [motionOk, setMotionOk] = useState(false);

  useEffect(() => {
    setMotionOk(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  return (
    <figure className={`${styles.frame} ${styles.frameWide} ${styles.tourFrame}`} data-reveal="">
      {motionOk ? (
        <video
          className={styles.tourVideo}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={posterUrl}
          aria-hidden="true"
        >
          <source src={webmUrl} type="video/webm" />
          <source src={mp4Url} type="video/mp4" />
        </video>
      ) : (
        <img
          className={styles.tourVideo}
          src={posterUrl}
          loading="lazy"
          alt={translate({ id: 'home.watch.alt', message: 'AWSops 제품 투어 미리보기' })}
        />
      )}
      <figcaption>
        <Translate id="home.watch.caption">
          대시보드 → AI 어시스턴트 → 토폴로지 → AI 진단으로 이어지는 10초 투어입니다.
        </Translate>
      </figcaption>
    </figure>
  );
}

function Hero(): React.ReactElement {
  const mediaBase = useBaseUrl('/showcase/media/');
  const [frame, setFrame] = useState(0);
  const [extraFrames, setExtraFrames] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setExtraFrames(true);
    const timer = setInterval(() => {
      setFrame((n) => (n + 1) % HERO_FRAMES.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const frames = extraFrames ? HERO_FRAMES : HERO_FRAMES.slice(0, 1);

  return (
    <header className={styles.hero}>
      {frames.map((name, i) => (
        <img
          key={name}
          className={styles.heroMedia}
          data-active={i === frame}
          src={`${mediaBase}${name}.webp`}
          alt={
            i === 0
              ? translate({
                  id: 'home.hero.alt',
                  message: 'AWSops 통합 운영 대시보드',
                })
              : ''
          }
          fetchPriority={i === 0 ? 'high' : undefined}
        />
      ))}
      <div className={styles.heroScrim} aria-hidden="true" />
      <div className={`${styles.wrap} ${styles.heroContent}`}>
        <span className={styles.eyebrow}>
          <Translate id="home.hero.eyebrow">AWS + Kubernetes operations</Translate>
        </span>
        <h1>AWSops</h1>
        <p className={styles.heroLine}>
          <Translate id="home.hero.line">흩어진 AWS 운영을 하나의 화면에.</Translate>
        </p>
        <p className={styles.heroCopy}>
          <Translate id="home.hero.copy">
            운영 현황을 보고, 라이브 데이터에 질문하고, Well-Architected 관점의 진단까지 한
            흐름으로 이어갑니다.
          </Translate>
        </p>
        <div className={styles.ctaRow}>
          <Link className={styles.button} to="/intro">
            <Translate id="home.hero.ctaPrimary">가이드 시작하기</Translate>
          </Link>
          <Link className={`${styles.button} ${styles.buttonGhost}`} to="/overview/dashboard">
            <Translate id="home.hero.ctaSecondary">대시보드 살펴보기</Translate>
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home(): React.ReactElement {
  const rootRef = useScrollReveal();

  return (
    <Layout
      title={translate({ id: 'home.meta.title', message: 'AWSops | 흩어진 AWS 운영을 하나의 화면에' })}
      description={translate({
        id: 'home.meta.description',
        message:
          'AWS 운영 현황, 리소스 관계, 비용과 보안을 한 화면에서 보고 Amazon Bedrock AgentCore로 근거 기반 진단을 수행하는 읽기 전용 운영 대시보드입니다.',
      })}
    >
      <div ref={rootRef} className={styles.page}>
        <Hero />

        <section className={styles.section}>
          <div className={styles.wrap}>
            <div className={styles.sectionHead} data-reveal="">
              <span className={styles.kicker}>Watch</span>
              <h2>
                <Translate id="home.watch.heading">10초로 보는 AWSops</Translate>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.watch.lead">
                  실제 화면을 이어붙인 짧은 투어로 무엇을 할 수 있는지 먼저 확인하세요.
                </Translate>
              </p>
            </div>
            <TourVideo />
          </div>
        </section>

        <section className={styles.band}>
          <div className={styles.wrap}>
            <div className={styles.sectionHead} data-reveal="">
              <span className={styles.kicker}>See</span>
              <h2>
                <Link to="/overview/agentcore">
                  <Translate id="home.proof.heading">먼저, 운영 전체를 봅니다.</Translate>
                </Link>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.proof.lead">
                  AWS 리소스, Kubernetes, 비용, 보안 신호를 하나의 대시보드에서 비교합니다.
                </Translate>
              </p>
            </div>
            <div className={styles.proofs} data-reveal="">
              <div className={styles.proof}>
                <b>9</b>
                <span>
                  <Translate id="home.proof.routes">AI 라우팅 섹션</Translate>
                </span>
              </div>
              <div className={styles.proof}>
                <b>6</b>
                <span>
                  <Translate id="home.proof.pillars">Well-Architected 필러</Translate>
                </span>
              </div>
              <div className={styles.proof}>
                <b>3</b>
                <span>
                  <Translate id="home.proof.exports">리포트 내보내기 형식</Translate>
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={`${styles.wrap} ${styles.story}`}>
            <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
              <img
                src={useBaseUrl('/showcase/media/dashboard.webp')}
                loading="lazy"
                alt={translate({ id: 'home.see.alt', message: 'AWSops 통합 운영 대시보드' })}
              />
              <figcaption>
                <Translate id="home.see.caption">
                  컴퓨트·스토리지·네트워크·보안·비용 KPI를 메인 화면에 모아 봅니다.
                </Translate>
              </figcaption>
            </figure>
            <div className={styles.storyCopy} data-reveal="">
              <span className={styles.kicker}>See</span>
              <h2>
                <Link to="/overview/dashboard">
                  <Translate id="home.see.heading">대시보드에서 한눈에 확인합니다.</Translate>
                </Link>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.see.lead">
                  분산된 리소스 현황을 한 화면의 KPI와 분포 차트로 정리해 보여줍니다.
                </Translate>
              </p>
            </div>
          </div>
        </section>

        <section className={styles.band}>
          <div className={`${styles.wrap} ${styles.story}`}>
            <figure className={`${styles.frame} ${styles.frameTall}`} data-reveal="">
              <img
                src={useBaseUrl('/showcase/media/assistant-answer.webp')}
                loading="lazy"
                alt={translate({
                  id: 'home.ask.alt',
                  message: '비용 질문에 근거를 제시하는 AWSops AI 어시스턴트',
                })}
              />
              <figcaption>
                <Translate id="home.ask.caption">
                  도메인별 읽기 전용 도구가 수집한 근거를 하나의 답변으로 합성합니다.
                </Translate>
              </figcaption>
            </figure>
            <div className={styles.storyCopy} data-reveal="">
              <span className={styles.kicker}>Ask</span>
              <h2>
                <Link to="/overview/assistant">
                  <Translate id="home.ask.heading">운영 데이터에 바로 질문합니다.</Translate>
                </Link>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.ask.lead">
                  질문 의도를 전문 라우트로 분류하고 라이브 데이터를 조회합니다. 여러 도메인의
                  결과는 한 번에 읽을 수 있는 답변으로 돌아옵니다.
                </Translate>
              </p>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.wrap}>
            <div className={styles.sectionHead} data-reveal="">
              <span className={styles.kicker}>Explore</span>
              <h2>
                <Translate id="home.explore.heading">관계, 비용, 통제를 같은 맥락에서.</Translate>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.explore.lead">
                  리소스 흐름을 따라가고, 비용 추이와 보안 통제를 함께 확인합니다.
                </Translate>
              </p>
            </div>
            <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
              <Link to="/resources/topology">
                <img
                  src={useBaseUrl('/showcase/media/topology.webp')}
                  loading="lazy"
                  alt={translate({
                    id: 'home.explore.topologyAlt',
                    message: 'DNS에서 타깃까지 이어지는 AWS 리소스 토폴로지',
                  })}
                />
              </Link>
              <figcaption>
                <Translate id="home.explore.topologyCaption">
                  요청 경로와 리소스 관계를 시각적으로 탐색합니다.
                </Translate>
              </figcaption>
            </figure>
            <div className={styles.pair}>
              <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
                <Link to="/cost/cost-explorer">
                  <img
                    src={useBaseUrl('/showcase/media/cost-explorer.webp')}
                    loading="lazy"
                    alt={translate({
                      id: 'home.explore.costAlt',
                      message: '월별 및 일별 AWS 비용 추이',
                    })}
                  />
                </Link>
                <figcaption>
                  <Translate id="home.explore.costCaption">
                    서비스별 비용과 변화를 비교합니다.
                  </Translate>
                </figcaption>
              </figure>
              <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
                <Link to="/security/compliance">
                  <img
                    src={useBaseUrl('/showcase/media/compliance.webp')}
                    loading="lazy"
                    alt={translate({
                      id: 'home.explore.complianceAlt',
                      message: '보안 이슈와 CIS 컴플라이언스 요약',
                    })}
                  />
                </Link>
                <figcaption>
                  <Translate id="home.explore.complianceCaption">
                    위험 신호와 컴플라이언스 상태를 빠르게 확인합니다.
                  </Translate>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className={styles.band}>
          <div className={`${styles.wrap} ${styles.story} ${styles.storyReverse}`}>
            <div className={styles.storyCopy} data-reveal="">
              <span className={styles.kicker}>Diagnose</span>
              <h2>
                <Link to="/operations/ai-diagnosis">
                  <Translate id="home.diagnose.heading">관찰을 의사결정 자료로 바꿉니다.</Translate>
                </Link>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.diagnose.lead">
                  무거운 진단은 비동기 워커에서 처리하고, Well-Architected 관점의 결과를 MD,
                  DOCX, PDF로 내보냅니다.
                </Translate>
              </p>
            </div>
            <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
              <img
                src={useBaseUrl('/showcase/media/ai-diagnosis.webp')}
                loading="lazy"
                alt={translate({
                  id: 'home.diagnose.alt',
                  message: 'AWSops AI 진단 보고서와 목차',
                })}
              />
              <figcaption>
                <Translate id="home.diagnose.caption">
                  진단 결과와 개선 제안을 구조화된 보고서로 제공합니다.
                </Translate>
              </figcaption>
            </figure>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.wrap}>
            <div className={styles.sectionHead} data-reveal="">
              <span className={styles.kicker}>Trust</span>
              <h2>
                <Translate id="home.trust.heading">변경보다 근거를 우선합니다.</Translate>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.trust.lead">
                  AWSops는 운영 상태를 관찰하고 진단과 개선 제안을 제공합니다. 진단 결과로
                  고객 AWS 리소스를 자동 변경하거나 자율 복구하지 않습니다.
                </Translate>
              </p>
            </div>
            <div className={styles.trustGrid} data-reveal="">
              <article className={styles.trustItem}>
                <h3>
                  <Translate id="home.trust.edge.title">Private edge</Translate>
                </h3>
                <p>
                  <Translate id="home.trust.edge.body">
                    CloudFront VPC Origin 뒤의 내부 ALB로 애플리케이션을 보호합니다.
                  </Translate>
                </p>
              </article>
              <article className={styles.trustItem}>
                <h3>
                  <Translate id="home.trust.identity.title">Verified identity</Translate>
                </h3>
                <p>
                  <Translate id="home.trust.identity.body">
                    Cognito와 Lambda@Edge의 RS256 검증으로 접근을 통제합니다.
                  </Translate>
                </p>
              </article>
              <article className={styles.trustItem}>
                <h3>
                  <Translate id="home.trust.privilege.title">Least privilege</Translate>
                </h3>
                <p>
                  <Translate id="home.trust.privilege.body">
                    라이브 조회는 AgentCore MCP 도구 경계 안에서 읽기 전용으로 수행합니다.
                  </Translate>
                </p>
              </article>
              <article className={styles.trustItem}>
                <h3>
                  <Translate id="home.trust.encrypted.title">Encrypted state</Translate>
                </h3>
                <p>
                  <Translate id="home.trust.encrypted.body">
                    Aurora와 관리형 시크릿으로 상태와 자격 증명을 분리합니다.
                  </Translate>
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.closing}`}>
          <div className={styles.wrap} data-reveal="">
            <h2>
              <Translate id="home.cta.heading">운영을 하나의 화면으로 옮겨보세요.</Translate>
            </h2>
            <p>
              <Translate id="home.cta.lead">
                실제 대시보드에서 통합 가시성과 AI 진단 흐름을 확인할 수 있습니다.
              </Translate>
            </p>
            <div className={styles.ctaRow}>
              <Link className={styles.button} to="/intro">
                <Translate id="home.cta.ctaGuide">가이드 시작하기</Translate>
              </Link>
              <a
                className={`${styles.button} ${styles.buttonGhost}`}
                href={DASHBOARD_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Translate id="home.cta.ctaDemo">제품 데모 보기</Translate>
              </a>
            </div>
          </div>
        </section>
      </div>
    </Layout>
  );
}
