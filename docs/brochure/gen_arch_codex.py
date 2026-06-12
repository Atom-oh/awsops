#!/usr/bin/env python3
"""Generate AWSops v2 architecture diagram (read-only ops dashboard + AI diagnosis)."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle
from matplotlib.lines import Line2D

# ---- canvas: 1600x900 px @ 100 dpi ----
DPI = 100
FIG_W, FIG_H = 16.0, 9.0
fig = plt.figure(figsize=(FIG_W, FIG_H), dpi=DPI)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, 160)
ax.set_ylim(0, 90)
ax.axis("off")
fig.patch.set_facecolor("white")

# ---- palette ----
EDGE   = "#FF8A00"; EDGE_BG   = "#FFF1E0"   # orange  - edge
COMPUTE= "#7C4DFF"; COMPUTE_BG= "#EEE7FF"   # purple  - compute
AI     = "#1FA971"; AI_BG     = "#E3F6EC"   # green   - AI
WORKER = "#E0568B"; WORKER_BG = "#FCE4EF"   # pink    - workers
OBS    = "#2D7FF9"; OBS_BG    = "#E3EEFE"   # blue    - observed
NEUTRAL= "#5A5A66"; NEUTRAL_BG= "#F1F1F4"   # grey    - config / user
INK    = "#1F2430"

def zone(x, y, w, h, color, label):
    r = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.2,rounding_size=1.6",
                       linewidth=1.4, edgecolor=color, facecolor="none",
                       linestyle=(0, (6, 4)), alpha=0.9)
    ax.add_patch(r)
    ax.text(x + 1.2, y + h - 2.2, label, fontsize=11, fontweight="bold",
            color=color, ha="left", va="center")

def box(x, y, w, h, color, bg, title, sub=None, fs=10.5, sub_fs=8.2):
    r = FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.15,rounding_size=1.1",
                       linewidth=1.8, edgecolor=color, facecolor=bg)
    ax.add_patch(r)
    cy = y + h / 2 + (1.3 if sub else 0)
    ax.text(x + w / 2, cy, title, fontsize=fs, fontweight="bold",
            color=INK, ha="center", va="center")
    if sub:
        ax.text(x + w / 2, y + h / 2 - 1.7, sub, fontsize=sub_fs,
                color="#4A4A55", ha="center", va="center")
    return (x, y, w, h)

def cx(b):  return b[0] + b[2] / 2
def cyc(b): return b[1] + b[3] / 2
def right(b): return (b[0] + b[2], b[1] + b[3] / 2)
def left(b):  return (b[0], b[1] + b[3] / 2)
def top(b):   return (b[0] + b[2] / 2, b[1] + b[3])
def bottom(b):return (b[0] + b[2] / 2, b[1])

def arrow(p0, p1, color=INK, num=None, rad=0.0, lw=2.0, ls="-", num_off=(0, 2.4)):
    a = FancyArrowPatch(p0, p1, arrowstyle="-|>", mutation_scale=16,
                        linewidth=lw, color=color, linestyle=ls,
                        connectionstyle=f"arc3,rad={rad}", shrinkA=2, shrinkB=2,
                        zorder=5)
    ax.add_patch(a)
    if num:
        mx = (p0[0] + p1[0]) / 2 + num_off[0]
        my = (p0[1] + p1[1]) / 2 + num_off[1]
        ax.scatter([mx], [my], s=300, color=color, zorder=6)
        ax.text(mx, my, num, fontsize=9.5, fontweight="bold", color="white",
                ha="center", va="center", zorder=7)

# ---- title ----
ax.text(3, 86.5, "AWSops", fontsize=27, fontweight="bold", color=INK, ha="left")
ax.text(3, 82.6, "Read-only AWS / Kubernetes operations dashboard  +  AI diagnosis  (v2 · no mutation)",
        fontsize=12, color="#4A4A55", ha="left")

# =================== ZONES ===================
zone(2,   6, 18, 70, NEUTRAL, "USER")
zone(22,  6, 34, 70, EDGE,    "EDGE")
zone(58,  6, 30, 70, COMPUTE, "COMPUTE (private)")
zone(90,  6, 36, 70, AI,      "AI — AgentCore")
zone(90, 52, 36, 0.01, AI, "")  # placeholder no-op
zone(128, 6, 30, 36, WORKER, "ASYNC WORKERS")
zone(128,44, 30, 32, OBS,    "OBSERVED (read-only)")

# =================== NODES ===================
# USER
user = box(4.5, 38, 13, 14, NEUTRAL, NEUTRAL_BG, "User", "browser / operator", fs=12)

# EDGE
cf   = box(25, 50, 28, 12, EDGE, EDGE_BG, "CloudFront", "TLS · VPC Origin", fs=11.5)
ledge= box(25, 35, 28, 11, EDGE, EDGE_BG, "Lambda@Edge", "RS256 / PKCE verify", fs=11)
cog  = box(25, 21, 28, 11, EDGE, EDGE_BG, "Cognito", "User Pool", fs=11)
alb  = box(25, 9,  28, 9.5, EDGE, EDGE_BG, "Internal ALB", "HTTPS 443", fs=10.5)

# COMPUTE
web  = box(60.5, 40, 25, 16, COMPUTE, COMPUTE_BG, "Fargate web",
           "Next.js 14 thin-BFF", fs=12)
aurora=box(60.5, 18, 25, 13, COMPUTE, COMPUTE_BG, "Aurora\nServerless v2",
           "PostgreSQL 17", fs=11)

# AI (AgentCore)
runtime = box(92, 58, 32, 13, AI, AI_BG, "AgentCore Runtime",
              "Strands · Bedrock", fs=11.5)
gw      = box(92, 44, 15, 11, AI, AI_BG, "8 Gateways", None, fs=10)
mcp     = box(109, 44, 15, 11, AI, AI_BG, "MCP Lambda", "~125 tools", fs=9.5, sub_fs=7.8)
mem     = box(92, 30, 15, 11, AI, AI_BG, "Memory", None, fs=10)
ci      = box(109, 30, 15, 11, AI, AI_BG, "Code\nInterpreter", None, fs=9)

# WORKERS
sqs   = box(130, 33, 26, 7.5, WORKER, WORKER_BG, "SQS queue", fs=10)
disp  = box(130, 24, 26, 7.5, WORKER, WORKER_BG, "dispatcher Lambda", fs=9.5)
sfn   = box(130, 15, 26, 7.5, WORKER, WORKER_BG, "Step Functions", fs=10)
runl  = box(130, 7.5, 12, 6.2, WORKER, WORKER_BG, "Run Lambda", fs=8.3)
fwork = box(144, 7.5, 12, 6.2, WORKER, WORKER_BG, "Fargate worker", fs=7.8)

# OBSERVED
eks   = box(130, 64, 26, 9, OBS, OBS_BG, "EKS clusters", "View policy", fs=10.5)
telem = box(130, 51, 26, 10, OBS, OBS_BG, "Prometheus / Loki", "Tempo", fs=10.5)

# CONFIG (SSM) - small node bridging compute/AI bottom
ssm = box(60.5, 8, 25, 7, NEUTRAL, NEUTRAL_BG, "SSM Parameter Store", "config", fs=9.5, sub_fs=7.5)

# =================== ARROWS ===================
# (1) user -> CloudFront
arrow(right(user), left(cf), color=EDGE, num="①", rad=0.12, num_off=(0, 2.6))
# edge internal chain
arrow(bottom(cf), top(ledge), color=EDGE, rad=0.0)
arrow(right(ledge), (54.5, 26.5), color=EDGE, rad=-0.25)        # ledge -> cognito (validate)
arrow(left(cog), (24.6, 26.5), color="#bdbdbd", rad=0.0, lw=1.4, ls=(0,(3,3)))  # token issue back (subtle)
arrow(bottom(ledge), top(alb), color=EDGE, rad=-0.15)
# (2) ALB -> Fargate web
arrow(right(alb), left(web), color=COMPUTE, num="②", rad=0.0, num_off=(0, 2.6))
# (3) web <-> Aurora
arrow((cx(web), web[1]), (cx(aurora), aurora[1]+aurora[3]), color=COMPUTE, num="③",
      rad=0.0, num_off=(-3.0, 0))
arrow((cx(aurora)+3, aurora[1]+aurora[3]), (cx(web)+3, web[1]), color=COMPUTE,
      rad=0.0, lw=1.6, ls=(0,(3,3)))
# (4) web -> AgentCore Runtime
arrow(right(web), left(runtime), color=AI, num="④", rad=0.10, num_off=(0, 3.0))
# runtime -> gateways / memory / CI
arrow(bottom(runtime), top(gw), color=AI, rad=0.05)
arrow((cx(runtime)+6, runtime[1]), top(mcp), color=AI, rad=0.05)
arrow((right(gw)[0], cyc(gw)), left(mcp), color=AI, lw=1.5)
arrow(bottom(gw), top(mem), color=AI, rad=0.0, lw=1.5)
arrow(bottom(mcp), top(ci), color=AI, rad=0.0, lw=1.5)
# (5) web -> SQS (async workers)
arrow(right(web), left(sqs), color=WORKER, num="⑤", rad=-0.32, num_off=(0, -3.4))
arrow(bottom(sqs), top(disp), color=WORKER, rad=0.0)
arrow(bottom(disp), top(sfn), color=WORKER, rad=0.0)
arrow(bottom(sfn), top(runl), color=WORKER, rad=0.12, lw=1.6)
arrow(bottom(sfn), top(fwork), color=WORKER, rad=-0.12, lw=1.6)

# AgentCore -> Observed (live read-only query)
arrow((right(mcp)[0], cyc(mcp)), left(telem), color=OBS, rad=0.18, lw=1.7, ls=(0,(4,3)))
arrow((right(runtime)[0], cyc(runtime)), left(eks), color=OBS, rad=0.12, lw=1.7, ls=(0,(4,3)))

# SSM config -> web & runtime (dotted)
arrow(top(ssm), bottom(aurora), color="#bbbbbb", lw=1.2, ls=(0,(2,3)))
arrow((cx(ssm)+8, ssm[1]+ssm[3]), (cx(web)-6, web[1]), color=NEUTRAL, lw=1.3, ls=(0,(2,3)))

# reaper / status_updater note
ax.text(143, 5.0, "+ reaper Lambda  ·  status_updater Lambda",
        fontsize=8, color=WORKER, ha="center", style="italic")

# =================== LEGEND ===================
leg_items = [
    (EDGE,   "Edge"), (COMPUTE,"Compute"), (AI,"AI / AgentCore"),
    (WORKER, "Async workers"), (OBS,"Observed (read-only)"),
]
lx = 3.0
for col, lab in leg_items:
    ax.add_patch(Rectangle((lx, 1.5), 1.8, 1.8, color=col))
    ax.text(lx + 2.4, 2.4, lab, fontsize=9, color=INK, va="center")
    lx += 4.0 + len(lab) * 0.62

ax.text(157, 2.2, "① ② ③ ④ ⑤  request → compute → data → AI → async",
        fontsize=8.5, color="#777", ha="right", va="center")

fig.savefig("/home/atomoh/awsops/docs/brochure/awsops-arch-codex.png",
            dpi=DPI, facecolor="white")
print("saved")
