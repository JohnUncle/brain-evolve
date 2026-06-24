# Brain-Evolve 🧠

> Let Claude Code learn from your behavior. Automatically generate reusable rules and skills.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue.svg)]()
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Hook-orange.svg)]()

[中文文档](README_zh.md)

## What It Does

Brain-Evolve is a **self-evolution system for Claude Code**. It listens to your workflow via Hooks — capturing behavior, extracting rules, scoring, decaying, and merging them. When patterns mature, they're automatically promoted into reusable skill files.

In short: **the more you use Claude Code, the better it understands how you work.**

## How It Works

```
Your Session → Behavior Capture → Rule Extraction → Decay Scoring → Lifecycle → Skill Generation
```

### Core Mechanisms

| Mechanism | Description |
|-----------|-------------|
| **Hook Listeners** | SessionStart injects context, PostToolUse logs actions, Stop triggers evolution |
| **Gene Pipeline** | 7 genes auto-select based on context: repair / innovate / optimize / cleanup / skillify / harvest / observe |
| **Exponential Decay** | `C(t) = C₀ × e^(-λt)` — unused rules fade, used rules strengthen |
| **Bayesian Feedback** | Success (α+1) slows decay, failure (β×1.5) accelerates it — 1 failure ≈ 5 successes |
| **Lifecycle** | `candidate → active → dormant → dead`, hard cap of 10 active rules |
| **Skill Generation** | score > 7 + relevance ≥ 5 + stability ≥ 5 → auto-promotes to a skill file |

## Quick Start

### 1. Install

```bash
# Clone into your project
cd your-project/.claude
git clone https://github.com/JohnUncle/brain-evolve.git
cd brain-evolve

# Register hooks
node install.js
```

This registers 3 hooks in `~/.claude/settings.json`:
- `SessionStart` — injects rule context
- `PostToolUse` — logs tool calls
- `Stop` — triggers evolution pipeline

### 2. Restart Claude Code

```bash
exit   # quit current session
claude # restart
```

### 3. Use Normally

No extra steps needed. After each session, the system automatically:
1. Analyzes your tool-call patterns
2. Extracts rules and anti-patterns
3. Updates decay scores
4. Merges redundant rules when needed
5. Generates skill files when conditions are met

### 4. Uninstall

```bash
cd your-project/.claude/brain-evolve
node install.js --uninstall
```

## Configuration

Edit `learning/data/config.json`:

```json
{
  "skill_mode": "conservative",
  "skill_policy": {
    "min_rules": 5,
    "min_score": 7,
    "min_stability": 5,
    "similarity_threshold": 0.4
  }
}
```

| Option | Description | Default |
|--------|-------------|---------|
| `skill_mode` | `conservative` (5+ rules to generate) / `aggressive` (3+) | conservative |
| `min_score` | Minimum maturity score (0-10) for skill generation | 7 |
| `min_stability` | Minimum stability for skill generation (< 5 = never) | 5 |
| `similarity_threshold` | Keyword overlap threshold for rule merging | 0.4 |
| `max_active` | Maximum active rules | 10 |

## Decay Model

Every rule has a **stability** value (1-10) that determines its decay rate:

| Stability | Half-life | Best For |
|-----------|-----------|----------|
| 1-3 | 35-56 days | Temporary tricks, one-off commands |
| 4-6 | 56-115 days | Tool workflows, project conventions |
| 7-10 | 115-231 days | Behavioral patterns, core principles |

```
lambda_base = 0.003 + (0.020 - 0.003) × (10 - stability) / 9
lambda_eff  = lambda_base × (β + 1) / (α + 1)
confidence  = C₀ × e^(-lambda_eff × days)
```

Three confidence states:
- **TRUST** (≥ 0.8): apply directly
- **VERIFY** (0.5-0.8): needs verification
- **REVALIDATE** (< 0.5): needs re-evaluation

## Directory Structure

```
brain-evolve/
├── install.js                    # Install / uninstall script
├── learning/
│   ├── processRules.js           # Evolution pipeline orchestrator
│   ├── ruleEngine.js             # Rule engine (lifecycle management)
│   ├── decay_scorer.js           # Decay scoring engine
│   ├── llmBrain.js               # LLM call wrapper (retry + backoff)
│   ├── claudeMdWriter.js         # Auto-write to CLAUDE.md
│   ├── cognitiveModel.js         # Cognitive model integration
│   ├── skillWriter.js            # Skill file generation
│   ├── crossProjectStore.js      # Cross-project pattern migration
│   ├── sessionMemory.js          # Session memory index
│   ├── genes.json                # Gene definitions
│   ├── hooks/
│   │   ├── session-start.js      # Session start: inject context
│   │   ├── post-tool.js          # Post-tool-use: log behavior
│   │   └── session-end.js        # Session end: trigger evolution
│   └── data/
│       ├── config.json           # Config (committed)
│       └── rules.json            # Rule database (runtime-generated)
└── test/                         # Tests
```

## Relationship with claude-mem

Both can coexist with complementary roles:

| System | Role | Analogy |
|--------|------|---------|
| **claude-mem** | Records what happened | Episodic memory |
| **brain-evolve** | Extracts how to act | Procedural memory |

## Cost Estimate

The system calls LLMs via the `claude` CLI (your local Claude Code setup). Typical usage:

| Scenario | LLM Calls | Monthly Cost |
|----------|-----------|--------------|
| 5 sessions/day | ~8 calls/day | ~$7/month |
| 10 sessions/day | ~15 calls/day | ~$13/month |

Haiku is used for routine classification, Sonnet for complex decisions — automatic tiering.

## Privacy

- All data stored locally in `learning/data/`
- No telemetry, no tracking
- Atomic writes (tmp + rename) to prevent corruption
- Nothing leaves your machine except LLM API calls

## License

MIT
