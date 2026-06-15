/**
 * cognitiveModel.js — 认知模型集成模块
 *
 * 将 brain-evolve 的规则进化系统与用户的认知模型对接
 *
 * 功能:
 * 1. 行为模式自动检测（4 种模式）
 * 2. 导师框架自动推荐（6 位导师）
 * 3. 认知模型文件自动更新
 * 4. SessionStart 注入活跃模式 + 推荐导师
 */

const fs = require('fs');
const path = require('path');

// ─── 行为模式定义 ─────────────────────────────────────────

const PATTERNS = {
  pattern_1: {
    id: 'pattern_1',
    name: '用准备逃避行动',
    description: '用搭建系统、调研方案来逃避真正动手做事',
    signals: [
      '搭建系统', '创建工具', '完美框架', '调研超过3轮',
      '不想动手', '过度设计', '追求完美', '反复对比方案',
      '先完善这个', '让我先看看', '还想再研究',
    ],
    mentors: ['Karpathy', 'Feynman'],
    responses: [
      '端到端跑通最小闭环了吗？',
      '能用3句话说清这个系统是干什么的吗？',
      '你又在准备而不是行动了',
    ],
    knowledge_type: 'behavioral_pattern',
  },

  pattern_2: {
    id: 'pattern_2',
    name: '被工具和系统吸引',
    description: '对新工具、新方法论过度兴奋，偏离用户真实需求',
    signals: [
      '新工具兴奋', '同时看多个方案', '追求完美工具',
      '偏离用户需求', '这个工具很酷', '想试试这个新框架',
      '别人也这么做', '这个方案更优雅',
    ],
    mentors: ['PG', 'Naval'],
    responses: [
      '用户在要什么？不是你觉得这个工具酷',
      '你的特定知识是什么？这个工具在积累特定知识吗？',
      '你在用哪种杠杆？',
    ],
    knowledge_type: 'behavioral_pattern',
  },

  pattern_3: {
    id: 'pattern_3',
    name: '对直接挑战有反应',
    description: '被直接指出问题时会接受并调整，这是正面特质',
    signals: [
      '被指出后接受', '反思调整', '不抵触',
      '承认问题', '好的你说得对', '确实是这样',
    ],
    mentors: ['继续直接挑战'],
    responses: [
      '保持直接，不委婉',
      '继续挑战，不要因为他接受了就放松',
    ],
    knowledge_type: 'behavioral_pattern',
  },

  pattern_4: {
    id: 'pattern_4',
    name: '难以聚焦',
    description: '同时追多个方向，难以取舍和排序优先级',
    signals: [
      '追多个方向', '难以取舍', '同时做5件事',
      '这个也想做那个也想做', '难以聚焦', '优先级混乱',
      '我想同时做这几个', '都很有价值',
    ],
    mentors: ['Naval', 'Munger'],
    responses: [
      '你在用哪种杠杆？如果同时追5个方向，每个方向的复利都会被断掉',
      '反过来想：这个方向怎么会失败？止损线呢？',
      '什么情况下你会放弃其中一个？',
    ],
    knowledge_type: 'behavioral_pattern',
  },
};

// ─── 模式→导师映射 ───────────────────────────────────────

const PATTERN_MENTOR_MAP = {
  pattern_1: { primary: 'Karpathy', secondary: ['Feynman', 'Taleb'] },
  pattern_2: { primary: 'PG', secondary: ['Naval', 'Feynman'] },
  pattern_3: { primary: 'direct_challenge', secondary: [] },
  pattern_4: { primary: 'Naval', secondary: ['Munger', 'PG'] },
};

// ─── 导师框架 ─────────────────────────────────────────────

const MENTORS = {
  Feynman: {
    name: '费曼',
    core_question: '能用3句话说清吗？一个高中生能听懂吗？',
    strength: '简化与清晰',
    best_for: '过度设计、用术语装逼',
  },
  Karpathy: {
    name: 'Karpathy',
    core_question: '端到端跑通最小闭环了吗？是基于第一性原理吗？',
    strength: '端到端验证',
    best_for: '过度准备、中间步骤过多',
  },
  Munger: {
    name: '芒格',
    core_question: '反过来想：怎么会失败？止损线设好了吗？',
    strength: '逆向思考与止损',
    best_for: '盲目乐观、难以取舍',
  },
  Naval: {
    name: 'Naval',
    core_question: '用什么杠杆？特定知识是什么？在积累复利吗？',
    strength: '杠杆与聚焦',
    best_for: '分散精力、难以聚焦',
  },
  PG: {
    name: 'PG (Paul Graham)',
    core_question: '用户在要什么？这个想法反共识吗？',
    strength: '用户需求',
    best_for: '自嗨、不考虑用户需求',
  },
  Taleb: {
    name: '塔勒布',
    core_question: '这个选择是反脆弱的吗？有Skin in the Game吗？',
    strength: '反脆弱与行动',
    best_for: '纸上谈兵、过度准备',
  },
};

// ─── 模式检测 ─────────────────────────────────────────────

/**
 * 中文模糊匹配：用字符 bigram 重叠度判断
 * "搭建系统" vs "搭建一个完整的知识库管理系统"
 *   bigrams of signal: [搭建, 建系, 系统]
 *   text contains: 搭建, 系统 → 2/3 overlap = 0.67
 */
function chineseFuzzyMatch(signal, text) {
  // 短信号（≤3字）直接包含匹配
  if (signal.length <= 3) {
    return text.includes(signal);
  }

  // 长信号用 bigram 重叠
  const signalBigrams = [];
  for (let i = 0; i < signal.length - 1; i++) {
    signalBigrams.push(signal.slice(i, i + 2));
  }

  let hits = 0;
  for (const bg of signalBigrams) {
    if (text.includes(bg)) hits++;
  }

  // 至少 50% bigrams 命中才算匹配
  return hits / signalBigrams.length >= 0.5;
}

/**
 * 从会话观察中检测行为模式
 * brain-evolve: 使用中文模糊匹配代替精确子串匹配
 *
 * @param {Array<object>} observations - 会话观察数组，每项包含 { tool, input, output }
 * @param {string} userTranscript - 用户对话文本
 * @returns {Array<object>} 检测到的模式，按信号命中数排序
 */
function detectPatterns(observations, userTranscript = '') {
  const combinedText = [
    userTranscript,
    ...observations.map(o => `${o.input || ''} ${o.output || ''}`),
  ].join(' ');

  const detected = [];

  for (const [patternId, pattern] of Object.entries(PATTERNS)) {
    let signalHits = 0;
    const matchedSignals = [];

    for (const signal of pattern.signals) {
      if (chineseFuzzyMatch(signal, combinedText)) {
        signalHits++;
        matchedSignals.push(signal);
      }
    }

    if (signalHits > 0) {
      // 置信度基于命中信号数
      // 1 signal = low, 2-3 = medium, 4+ = high
      const confidence = Math.min(1.0, signalHits / pattern.signals.length * 2);
      detected.push({
        pattern_id: patternId,
        pattern_name: pattern.name,
        signal_count: signalHits,
        matched_signals: matchedSignals,
        confidence: parseFloat(confidence.toFixed(2)),
        mentors: pattern.mentors,
        responses: pattern.responses,
      });
    }
  }

  // 按信号数降序排序
  detected.sort((a, b) => b.signal_count - a.signal_count);
  return detected;
}

/**
 * 从规则中提取认知模式规则
 * 当 gene_skillify 发现行为模式被反复确认时调用
 *
 * @param {object} rule - 成熟的规则（score>7, α≥5）
 * @returns {object|null} 格式化的认知模式条目，或 null
 */
function extractCognitivePattern(rule) {
  if (rule.knowledge_type !== 'behavioral_pattern') return null;
  if ((rule.alpha || 0) < 5) return null;
  if ((rule.score || 0) < 7) return null;

  // 查找匹配的模式定义
  const patternDef = Object.values(PATTERNS).find(
    p => rule.content && rule.content.includes(p.name)
  );

  if (!patternDef) return null;

  return {
    date: new Date().toISOString().split('T')[0],
    pattern_id: patternDef.id,
    pattern_name: patternDef.name,
    description: rule.content,
    confidence: rule.confidence || 0.8,
    alpha: rule.alpha,
    beta: rule.beta,
    mentors: patternDef.mentors,
    response_strategy: patternDef.responses[0],
    source_rule_id: rule.id,
  };
}

/**
 * 生成 SessionStart 注入内容
 * 包含当前活跃的行为模式和推荐导师
 *
 * @param {Array<object>} rules - 所有活跃规则
 * @returns {string} 注入到 additionalContext 的 markdown 内容
 */
function generateSessionContext(rules) {
  const activePatterns = rules
    .filter(r =>
      r.knowledge_type === 'behavioral_pattern' &&
      r.status === 'active' &&
      (r.confidence || 0) >= 0.5
    )
    .map(r => {
      // Try multiple ways to find pattern definition
      let patternDef = null;

      // 1. By pattern_id (most reliable)
      if (r.pattern_id && PATTERNS[r.pattern_id]) {
        patternDef = PATTERNS[r.pattern_id];
      }

      // 2. By content matching pattern name (fuzzy)
      if (!patternDef && r.content) {
        patternDef = Object.values(PATTERNS).find(
          p => chineseFuzzyMatch(p.name, r.content) || r.content.includes(p.name)
        );
      }

      // 3. By content matching signals
      if (!patternDef && r.content) {
        let bestMatch = null;
        let bestHits = 0;
        for (const [pid, p] of Object.entries(PATTERNS)) {
          let hits = 0;
          for (const signal of p.signals) {
            if (chineseFuzzyMatch(signal, r.content)) hits++;
          }
          if (hits > bestHits) {
            bestHits = hits;
            bestMatch = { ...p, id: pid };
          }
        }
        if (bestHits >= 2) patternDef = bestMatch;
      }

      return {
        ...r,
        pattern_def: patternDef,
        pattern_id: r.pattern_id || (patternDef ? patternDef.id : null),
      };
    });

  if (activePatterns.length === 0) return '';

  let context = '\n## 活跃行为模式\n\n';
  context += '> 以下模式已被反复确认，在对话中主动关注并应用对应导师框架\n\n';

  for (const p of activePatterns) {
    const patternDef = p.pattern_def || {};
    const mentors = patternDef.mentors || [];
    const responses = patternDef.responses || [];
    const mapEntry = PATTERN_MENTOR_MAP[p.pattern_id || ''];

    context += `### ${p.pattern_name || '行为模式'}（置信度: ${(p.confidence || 0).toFixed(2)}）\n`;
    context += `- 表现: ${p.content || p.description || ''}\n`;

    if (mapEntry) {
      context += `- 首选导师: ${mapEntry.primary}\n`;
      if (mapEntry.secondary.length > 0) {
        context += `- 次选导师: ${mapEntry.secondary.join(', ')}\n`;
      }
    }

    if (responses.length > 0) {
      context += `- 应对: "${responses[0]}"\n`;
    }

    context += `\n`;
  }

  return context;
}

/**
 * 格式化认知模式条目，用于写入观察记录文件
 *
 * @param {object} pattern - extractCognitivePattern 的输出
 * @returns {string} 格式化的 markdown 条目
 */
function formatPatternEntry(pattern) {
  const lines = [
    `#### 观察: ${pattern.pattern_name}`,
    `- 日期: ${pattern.date}`,
    `- 置信度: ${pattern.confidence.toFixed(2)}`,
    `- α/β: ${pattern.alpha}/${pattern.beta}`,
    `- 模式识别: ${pattern.pattern_id} - ${pattern.pattern_name}`,
    `- 推荐导师: ${pattern.mentors.join(', ')}`,
    `- 应对策略: ${pattern.response_strategy}`,
    `- 来源规则: ${pattern.source_rule_id}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * 获取所有模式定义
 */
function getAllPatterns() {
  return { ...PATTERNS };
}

/**
 * 获取所有导师定义
 */
function getAllMentors() {
  return { ...MENTORS };
}

/**
 * 获取模式→导师映射
 */
function getPatternMentorMap() {
  return { ...PATTERN_MENTOR_MAP };
}

// ─── 匹配质量追踪（向量库切换预警）─────────────────────────

const STATS_PATH = path.join(__dirname, 'data', 'match_quality.json');

// 预警阈值：低于此值建议切换向量库
const VECTOR_DB_THRESHOLD = {
  detectionRate: 0.3,    // 检测率 < 30%：10 次会话只检测到 3 次模式
  signalHitRate: 0.2,    // 信号命中率 < 20%：信号词匹配不到用户表达
  minSessions: 10,       // 至少 10 个会话后才评估（避免小样本误判）
};

/**
 * 记录一次模式检测的结果
 * @param {object} result
 * @param {boolean} result.detected - 是否检测到模式
 * @param {number} result.signalCount - 命中的信号数
 * @param {number} result.totalSignals - 该模式的总信号数
 * @param {string} result.patternId - 模式 ID
 */
function recordMatchQuality(result) {
  let stats = loadMatchStats();
  stats.totalAttempts++;
  stats.lastUpdated = new Date().toISOString();

  if (result.detected) {
    stats.successfulDetections++;
  }

  if (result.totalSignals > 0) {
    stats.totalSignalChecks += result.totalSignals;
    stats.totalSignalHits += result.signalCount;
  }

  // 按模式记录
  if (result.patternId) {
    if (!stats.byPattern[result.patternId]) {
      stats.byPattern[result.patternId] = { attempts: 0, detections: 0, signalHits: 0, signalChecks: 0 };
    }
    const p = stats.byPattern[result.patternId];
    p.attempts++;
    if (result.detected) p.detections++;
    p.signalHits += result.signalCount;
    p.signalChecks += result.totalSignals;
  }

  saveMatchStats(stats);
  return getMatchQualityReport();
}

function loadMatchStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  } catch {
    return {
      totalAttempts: 0,
      successfulDetections: 0,
      totalSignalChecks: 0,
      totalSignalHits: 0,
      byPattern: {},
      lastUpdated: null,
    };
  }
}

function saveMatchStats(stats) {
  try {
    fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
    fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2) + '\n', 'utf8');
  } catch {}
}

/**
 * 获取匹配质量报告
 * @returns {object} 包含各项指标和是否需要向量库的建议
 */
function getMatchQualityReport() {
  const stats = loadMatchStats();
  const detectionRate = stats.totalAttempts > 0
    ? stats.successfulDetections / stats.totalAttempts
    : 1.0;
  const signalHitRate = stats.totalSignalChecks > 0
    ? stats.totalSignalHits / stats.totalSignalChecks
    : 1.0;

  const needsVectorDB = stats.totalAttempts >= VECTOR_DB_THRESHOLD.minSessions && (
    detectionRate < VECTOR_DB_THRESHOLD.detectionRate ||
    signalHitRate < VECTOR_DB_THRESHOLD.signalHitRate
  );

  return {
    totalSessions: stats.totalAttempts,
    detectionRate: parseFloat(detectionRate.toFixed(3)),
    signalHitRate: parseFloat(signalHitRate.toFixed(3)),
    needsVectorDB,
    recommendation: needsVectorDB
      ? '⚠️ 匹配质量低于阈值，建议切换为向量库语义匹配'
      : detectionRate >= 0.7
        ? '✅ 匹配质量良好'
        : '🟡 匹配质量一般，继续观察',
    thresholds: VECTOR_DB_THRESHOLD,
    byPattern: stats.byPattern,
  };
}

// ─── Exports ───────────────────────────────────────────────

module.exports = {
  // Pattern detection
  detectPatterns,
  extractCognitivePattern,

  // Session context
  generateSessionContext,

  // Formatting
  formatPatternEntry,

  // Data access
  getAllPatterns,
  getAllMentors,
  getPatternMentorMap,

  // Match quality tracking (vector DB alert)
  recordMatchQuality,
  getMatchQualityReport,
  VECTOR_DB_THRESHOLD,

  // Constants
  PATTERNS,
  MENTORS,
  PATTERN_MENTOR_MAP,
};
