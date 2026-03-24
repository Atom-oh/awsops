import React, { useState, useCallback, useEffect } from 'react';
import { useCanvas, THEME, roundRect, isHover, canvasWrapperStyle, DrawContext } from './useCanvas';

interface Step {
  id: string;
  num: string;
  script: string;
  where: 'Local' | 'EC2';
  description: string;
  color: string;
  row: number;
}

const STEPS: Step[] = [
  // Row 1
  { id: '0', num: '0', script: '00-deploy-infra.sh', where: 'Local', description: 'CDK Infrastructure (VPC, EC2, ALB, CloudFront)', color: THEME.purple, row: 0 },
  { id: '1', num: '1', script: '01-install-base.sh', where: 'EC2', description: 'Steampipe + Powerpipe', color: THEME.cyan, row: 0 },
  { id: '2', num: '2', script: '02-setup-nextjs.sh', where: 'EC2', description: 'Next.js + Steampipe Service', color: THEME.cyan, row: 0 },
  { id: '3', num: '3', script: '03-build-deploy.sh', where: 'EC2', description: 'Production Build', color: THEME.green, row: 0 },
  // Row 2
  { id: '5', num: '5', script: '05-setup-cognito.sh', where: 'EC2', description: 'Cognito Auth', color: THEME.orange, row: 1 },
  { id: '6', num: '6a-6f', script: '06a~06f*.sh', where: 'EC2', description: 'AgentCore (Runtime, 8 Gateway, 19 Lambda, Code Interpreter, Memory)', color: THEME.purple, row: 1 },
  { id: '7', num: '7', script: '07-setup-cloudfront-auth.sh', where: 'EC2', description: 'Lambda@Edge -> CloudFront', color: THEME.orange, row: 1 },
];

const CANVAS_HEIGHT = 400;

export default function DeploymentPipeline() {
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const [autoPlayIndex, setAutoPlayIndex] = useState(0);
  const [hoveredStep, setHoveredStep] = useState<string | null>(null);

  // Auto-play logic
  useEffect(() => {
    if (!autoPlay) return;
    const interval = setInterval(() => {
      setAutoPlayIndex((prev) => {
        const next = (prev + 1) % (STEPS.length + 1);
        if (next === STEPS.length) {
          // Completed all steps, reset
          return 0;
        }
        setActiveStep(STEPS[next].id);
        return next;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [autoPlay]);

  const draw = useCallback((dc: DrawContext) => {
    const { ctx, width, height, mouse, dpr } = dc;

    const pad = 24 * dpr;
    const progressBarHeight = 8 * dpr;
    const topMargin = 60 * dpr;
    const rowHeight = 140 * dpr;
    const stepGap = 16 * dpr;
    const arrowSize = 8 * dpr;

    // Calculate step dimensions
    const contentWidth = width - pad * 2;
    const row1Steps = STEPS.filter(s => s.row === 0);
    const row2Steps = STEPS.filter(s => s.row === 1);

    // Step 6 is wider
    const normalStepWidth = (contentWidth - stepGap * 4) / 4.5;
    const wideStepWidth = normalStepWidth * 1.5;
    const stepHeight = 80 * dpr;

    // Calculate progress
    const progress = autoPlay ? (autoPlayIndex / STEPS.length) :
                     activeStep ? ((STEPS.findIndex(s => s.id === activeStep) + 1) / STEPS.length) : 0;

    // Draw progress bar background
    ctx.fillStyle = THEME.dim;
    roundRect(ctx, pad, pad, contentWidth, progressBarHeight, 4 * dpr);
    ctx.fill();

    // Draw progress bar fill
    if (progress > 0) {
      const gradient = ctx.createLinearGradient(pad, 0, pad + contentWidth * progress, 0);
      gradient.addColorStop(0, THEME.cyan);
      gradient.addColorStop(1, THEME.green);
      ctx.fillStyle = gradient;
      roundRect(ctx, pad, pad, contentWidth * progress, progressBarHeight, 4 * dpr);
      ctx.fill();
    }

    // Progress text
    ctx.fillStyle = THEME.muted;
    ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(progress * 100)}% Complete`, width - pad, pad + progressBarHeight + 16 * dpr);

    // Helper to draw laptop icon
    function drawLaptopIcon(x: number, y: number, size: number) {
      ctx.strokeStyle = THEME.muted;
      ctx.lineWidth = 1.5 * dpr;
      // Screen
      ctx.strokeRect(x - size/2, y - size/2, size, size * 0.7);
      // Base
      ctx.beginPath();
      ctx.moveTo(x - size/2 - size * 0.1, y + size * 0.25);
      ctx.lineTo(x + size/2 + size * 0.1, y + size * 0.25);
      ctx.stroke();
    }

    // Helper to draw server icon
    function drawServerIcon(x: number, y: number, size: number) {
      ctx.strokeStyle = THEME.muted;
      ctx.lineWidth = 1.5 * dpr;
      const boxH = size * 0.35;
      // Top box
      ctx.strokeRect(x - size/2, y - size/2, size, boxH);
      ctx.beginPath();
      ctx.arc(x - size/2 + size * 0.2, y - size/2 + boxH/2, 2 * dpr, 0, Math.PI * 2);
      ctx.fill();
      // Bottom box
      ctx.strokeRect(x - size/2, y - size/2 + boxH + 2 * dpr, size, boxH);
      ctx.beginPath();
      ctx.arc(x - size/2 + size * 0.2, y - size/2 + boxH * 1.5 + 2 * dpr, 2 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Helper to draw arrow
    function drawArrow(fromX: number, fromY: number, toX: number, toY: number, color: string) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2 * dpr;

      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(toX - arrowSize, toY);
      ctx.stroke();

      // Arrow head
      ctx.beginPath();
      ctx.moveTo(toX, toY);
      ctx.lineTo(toX - arrowSize, toY - arrowSize / 2);
      ctx.lineTo(toX - arrowSize, toY + arrowSize / 2);
      ctx.closePath();
      ctx.fill();
    }

    // Helper to draw step
    function drawStep(step: Step, x: number, y: number, w: number, h: number) {
      const isActive = activeStep === step.id || (autoPlay && STEPS[autoPlayIndex]?.id === step.id);
      const isHovered = isHover(mouse.x, mouse.y, x, y, w, h);

      if (isHovered && hoveredStep !== step.id) {
        setHoveredStep(step.id);
      }

      // Glow effect for active step
      if (isActive) {
        ctx.shadowColor = step.color;
        ctx.shadowBlur = 20 * dpr;
      }

      // Background
      ctx.fillStyle = isHovered ? THEME.border : THEME.card;
      roundRect(ctx, x, y, w, h, 8 * dpr);
      ctx.fill();

      // Border
      ctx.strokeStyle = isActive ? step.color : (isHovered ? step.color : THEME.border);
      ctx.lineWidth = isActive ? 2 * dpr : 1 * dpr;
      roundRect(ctx, x, y, w, h, 8 * dpr);
      ctx.stroke();

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // Step number badge
      const badgeSize = 24 * dpr;
      ctx.fillStyle = step.color;
      ctx.beginPath();
      ctx.arc(x + badgeSize / 2 + 8 * dpr, y + badgeSize / 2 + 8 * dpr, badgeSize / 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = THEME.bg;
      ctx.font = `bold ${11 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(step.num, x + badgeSize / 2 + 8 * dpr, y + badgeSize / 2 + 8 * dpr);

      // Location icon
      const iconX = x + w - 20 * dpr;
      const iconY = y + 20 * dpr;
      const iconSize = 16 * dpr;
      if (step.where === 'Local') {
        drawLaptopIcon(iconX, iconY, iconSize);
      } else {
        drawServerIcon(iconX, iconY, iconSize);
      }

      // Description (truncated)
      ctx.fillStyle = THEME.text;
      ctx.font = `${13 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      const maxTextWidth = w - 24 * dpr;
      let desc = step.description;
      if (ctx.measureText(desc).width > maxTextWidth) {
        while (ctx.measureText(desc + '...').width > maxTextWidth && desc.length > 0) {
          desc = desc.slice(0, -1);
        }
        desc += '...';
      }
      ctx.fillText(desc, x + 12 * dpr, y + 40 * dpr);

      // Where label
      ctx.fillStyle = THEME.muted;
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.fillText(step.where, x + 12 * dpr, y + h - 16 * dpr);

      return { x, y, w, h, step, isHovered };
    }

    // Draw Row 1
    let xPos = pad;
    const row1Y = topMargin;
    const drawnSteps: { x: number; y: number; w: number; h: number; step: Step }[] = [];

    row1Steps.forEach((step, i) => {
      const w = normalStepWidth;
      const info = drawStep(step, xPos, row1Y, w, stepHeight);
      drawnSteps.push(info);

      // Draw arrow to next step
      if (i < row1Steps.length - 1) {
        drawArrow(xPos + w, row1Y + stepHeight / 2, xPos + w + stepGap, row1Y + stepHeight / 2, THEME.dim);
      }

      xPos += w + stepGap;
    });

    // Draw Row 2
    xPos = pad;
    const row2Y = topMargin + rowHeight;

    row2Steps.forEach((step, i) => {
      const w = step.id === '6' ? wideStepWidth : normalStepWidth;
      const info = drawStep(step, xPos, row2Y, w, stepHeight);
      drawnSteps.push(info);

      // Draw arrow to next step
      if (i < row2Steps.length - 1) {
        drawArrow(xPos + w, row2Y + stepHeight / 2, xPos + w + stepGap, row2Y + stepHeight / 2, THEME.dim);
      }

      xPos += w + stepGap;
    });

    // Draw connecting arrow from row 1 to row 2
    const lastRow1 = drawnSteps.find(d => d.step.id === '3');
    const firstRow2 = drawnSteps.find(d => d.step.id === '5');
    if (lastRow1 && firstRow2) {
      ctx.strokeStyle = THEME.dim;
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(lastRow1.x + lastRow1.w / 2, lastRow1.y + lastRow1.h);
      ctx.lineTo(lastRow1.x + lastRow1.w / 2, lastRow1.y + lastRow1.h + (rowHeight - stepHeight) / 2);
      ctx.lineTo(firstRow2.x + firstRow2.w / 2, lastRow1.y + lastRow1.h + (rowHeight - stepHeight) / 2);
      ctx.lineTo(firstRow2.x + firstRow2.w / 2, firstRow2.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrow head at row 2
      ctx.fillStyle = THEME.dim;
      ctx.beginPath();
      ctx.moveTo(firstRow2.x + firstRow2.w / 2, firstRow2.y);
      ctx.lineTo(firstRow2.x + firstRow2.w / 2 - arrowSize / 2, firstRow2.y - arrowSize);
      ctx.lineTo(firstRow2.x + firstRow2.w / 2 + arrowSize / 2, firstRow2.y - arrowSize);
      ctx.closePath();
      ctx.fill();
    }

    // Draw detail panel for active step
    const detailY = row2Y + stepHeight + 30 * dpr;
    const detailHeight = 70 * dpr;
    const activeStepData = STEPS.find(s => s.id === activeStep);

    if (activeStepData) {
      ctx.fillStyle = THEME.card;
      roundRect(ctx, pad, detailY, contentWidth, detailHeight, 8 * dpr);
      ctx.fill();

      ctx.strokeStyle = activeStepData.color;
      ctx.lineWidth = 1 * dpr;
      roundRect(ctx, pad, detailY, contentWidth, detailHeight, 8 * dpr);
      ctx.stroke();

      // Script name
      ctx.fillStyle = activeStepData.color;
      ctx.font = `bold ${14 * dpr}px monospace`;
      ctx.textAlign = 'left';
      ctx.fillText(activeStepData.script, pad + 16 * dpr, detailY + 24 * dpr);

      // Full description
      ctx.fillStyle = THEME.text;
      ctx.font = `${13 * dpr}px system-ui, sans-serif`;
      ctx.fillText(activeStepData.description, pad + 16 * dpr, detailY + 48 * dpr);

      // Location badge
      ctx.fillStyle = THEME.muted;
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(`Runs on: ${activeStepData.where}`, width - pad - 16 * dpr, detailY + 24 * dpr);
    }

    // Check for mouse leave
    const anyHovered = drawnSteps.some(d => isHover(mouse.x, mouse.y, d.x, d.y, d.w, d.h));
    if (!anyHovered && hoveredStep !== null) {
      setHoveredStep(null);
    }
  }, [activeStep, autoPlay, autoPlayIndex, hoveredStep]);

  const canvasRef = useCanvas(draw, CANVAS_HEIGHT);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const mx = (e.clientX - rect.left) * dpr;
    const my = (e.clientY - rect.top) * dpr;

    const pad = 24 * dpr;
    const topMargin = 60 * dpr;
    const rowHeight = 140 * dpr;
    const stepGap = 16 * dpr;
    const contentWidth = canvas.width - pad * 2;
    const normalStepWidth = (contentWidth - stepGap * 4) / 4.5;
    const wideStepWidth = normalStepWidth * 1.5;
    const stepHeight = 80 * dpr;

    // Check row 1
    let xPos = pad;
    const row1Y = topMargin;
    const row1Steps = STEPS.filter(s => s.row === 0);

    for (const step of row1Steps) {
      const w = normalStepWidth;
      if (isHover(mx, my, xPos, row1Y, w, stepHeight)) {
        setActiveStep(activeStep === step.id ? null : step.id);
        setAutoPlay(false);
        return;
      }
      xPos += w + stepGap;
    }

    // Check row 2
    xPos = pad;
    const row2Y = topMargin + rowHeight;
    const row2Steps = STEPS.filter(s => s.row === 1);

    for (const step of row2Steps) {
      const w = step.id === '6' ? wideStepWidth : normalStepWidth;
      if (isHover(mx, my, xPos, row2Y, w, stepHeight)) {
        setActiveStep(activeStep === step.id ? null : step.id);
        setAutoPlay(false);
        return;
      }
      xPos += w + stepGap;
    }
  }, [activeStep, canvasRef]);

  const toggleAutoPlay = () => {
    setAutoPlay(!autoPlay);
    if (!autoPlay) {
      setAutoPlayIndex(0);
      setActiveStep(STEPS[0].id);
    }
  };

  // Tooltip for hovered step
  const tooltipStep = hoveredStep ? STEPS.find(s => s.id === hoveredStep) : null;

  return (
    <div style={canvasWrapperStyle}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ display: 'block', cursor: 'pointer', background: THEME.bg }}
      />
      <button
        onClick={toggleAutoPlay}
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          padding: '6px 12px',
          background: autoPlay ? THEME.green : THEME.card,
          color: autoPlay ? THEME.bg : THEME.text,
          border: `1px solid ${autoPlay ? THEME.green : THEME.border}`,
          borderRadius: 6,
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        {autoPlay ? 'Stop' : 'Auto-Play'}
      </button>
      {tooltipStep && !activeStep && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '8px 16px',
            background: THEME.card,
            border: `1px solid ${tooltipStep.color}`,
            borderRadius: 6,
            color: THEME.text,
            fontSize: 13,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          <span style={{ color: tooltipStep.color, fontFamily: 'monospace', fontWeight: 'bold' }}>
            {tooltipStep.script}
          </span>
          <span style={{ color: THEME.muted, marginLeft: 12 }}>{tooltipStep.description}</span>
        </div>
      )}
    </div>
  );
}
