# Brain-Evolve 🧠

> 让 Claude Code 从你的行为中学习，自动生成可复用的规则和技能。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue.svg)]()
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Hook-orange.svg)]()

## 它是什么

Brain-Evolve 是一个 **Claude Code 自我进化系统**。它通过 Hook 监听你的工作行为，自动提取规则、评分、衰减、合并，最终将成熟的行为模式生成为可复用的 skill 文件。

简单说：**你用 Claude Code 越多，它越懂你该怎么干活。**

## 工作原理

```
你的会话 → 行为捕获 → 规则提取 → 衰减评分 → 生命周期管理 → skill 生成
```

### 核心机制

| 机制 | 说明 |
|------|------|
| **Hook 监听** | SessionStart 注入上下文、PostToolUse 记录行为、Stop 触发进化 |
| **基因管道** | 7 种基因自动选择：repair / innovate / optimize / cleanup / skillify / harvest / observe |
| **指数衰减** | `C(t) = C₀ × e^(-λt)`，规则不用就忘，用了就强化 |
| **贝叶斯反馈** | 成功（α+1）减缓衰减，失败（β×1.5）加速衰减——1 次失败 ≈ 5 次成功 |
| **生命周期** | `candidate → active → dormant → dead`，硬上限 10 条活跃规则 |
| **Skill 生成** | score > 7 + relevance ≥ 5 + stability ≥ 5 → 自动升级为方法论文件 |

## 快速开始

### 1. 安装

```bash
# 克隆到你的项目
cd your-project/.claude
git clone https://github.com/JohnUncle/brain-evolve.git
cd brain-evolve

# 注册 Hook
node install.js
```

安装脚本会向 `~/.claude/settings.json` 注册 3 个 Hook：
- `SessionStart` — 注入规则上下文
- `PostToolUse` — 记录工具调用
- `Stop` — 触发进化管道

### 2. 重启 Claude Code

```bash
exit  # 退出当前会话
claude  # 重新启动
```

### 3. 正常使用

不需要任何额外操作。系统会在每次会话结束时自动：
1. 分析你的工具调用模式
2. 提取规则和反模式
3. 更新衰减评分
4. 必要时合并冗余规则
5. 条件成熟时生成 skill 文件

### 4. 卸载

```bash
cd your-project/.claude/brain-evolve
node install.js --uninstall
```

## 配置

编辑 `learning/data/config.json`：

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

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `skill_mode` | `conservative`（5+ 规则生成 skill）/ `aggressive`（3+） | conservative |
| `min_score` | 规则成熟的最低分数（0-10） | 7 |
| `min_stability` | 生成 skill 的最低稳定性（< 5 永不生成） | 5 |
| `similarity_threshold` | 规则合并的关键词相似度阈值 | 0.4 |
| `max_active` | 活跃规则上限 | 10 |

## 衰减模型

每条规则有一个 **stability** 值（1-10），决定衰减速率：

| Stability | 半衰期 | 适用场景 |
|-----------|--------|----------|
| 1-3 | 35-56 天 | 临时技巧、特定命令 |
| 4-6 | 56-115 天 | 工具流程、项目规范 |
| 7-10 | 115-231 天 | 行为模式、核心原则 |

```
lambda_base = 0.003 + (0.020 - 0.003) × (10 - stability) / 9
lambda_eff  = lambda_base × (β + 1) / (α + 1)
confidence  = C₀ × e^(-lambda_eff × days)
```

三级置信状态：
- **TRUST** (≥ 0.8)：直接应用
- **VERIFY** (0.5-0.8)：需要验证
- **REVALIDATE** (< 0.5)：需要重新评估

## 目录结构

```
brain-evolve/
├── install.js                    # 安装/卸载脚本
├── learning/
│   ├── processRules.js           # 进化管道主流程
│   ├── ruleEngine.js             # 规则引擎（生命周期管理）
│   ├── decay_scorer.js           # 衰减计算引擎
│   ├── llmBrain.js               # LLM 调用封装（带重试+退避）
│   ├── claudeMdWriter.js         # CLAUDE.md 自动写入
│   ├── cognitiveModel.js         # 认知模型集成
│   ├── skillWriter.js            # Skill 文件生成
│   ├── crossProjectStore.js      # 跨项目模式迁移
│   ├── sessionMemory.js          # 会话记忆索引
│   ├── genes.json                # 基因定义
│   ├── hooks/
│   │   ├── session-start.js      # 会话启动：注入上下文
│   │   ├── post-tool.js          # 工具调用后：记录行为
│   │   └── session-end.js        # 会话结束：触发进化
│   └── data/
│       ├── config.json           # 配置（需提交）
│       └── rules.json            # 规则数据库（运行时生成）
└── test/                         # 测试
```

## 与 claude-mem 的关系

两者可以共存，职责互补：

| 系统 | 职责 | 类比 |
|------|------|------|
| **claude-mem** | 记录发生了什么 | 情景记忆 |
| **brain-evolve** | 提炼应该怎么做 | 程序性记忆 |

## 成本估算

系统通过 `claude` CLI 调用 LLM（你的本地 Claude Code 已配置即可），典型场景：

| 场景 | LLM 调用 | 月成本估算 |
|------|---------|-----------|
| 每天 5 个会话 | ~8 次/天 | ~$7/月 |
| 每天 10 个会话 | ~15 次/天 | ~$13/月 |

使用 Haiku 做 routine 分类，Sonnet 做复杂决策，自动分层。

## 隐私

- 所有数据存储在本地 `learning/data/`
- 不外传任何数据（除 LLM 调用外）
- 原子写入（tmp + rename），防止数据损坏
- 不包含遥测或追踪

## License

MIT
