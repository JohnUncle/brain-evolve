/**
 * decay_scorer.js — 指数衰减评分引擎
 *
 * 移植自 Self-Evolving-Skill (191341025) 的衰减模型
 * 核心公式: C(t) = C₀ × e^(-λ_eff × t)
 * 其中: λ_eff = λ_base × (β + 1) / (α + 1)
 *
 * 特性:
 * - 按知识类型差异化半衰期
 * - 贝叶斯反馈 (α/β 非对称)
 * - 三级置信状态: TRUST / VERIFY / REVALIDATE
 * - 非对称反馈: 1 次失败 ≈ 5 次成功抵消
 */

const fs = require('fs');
const path = require('path');

// 加载知识类型配置
const KNOWLEDGE_TYPES_PATH = path.join(__dirname, 'data', 'knowledge_types.json');
let knowledgeTypes = null;

function loadKnowledgeTypes() {
  if (knowledgeTypes) return knowledgeTypes;
  try {
    const raw = fs.readFileSync(KNOWLEDGE_TYPES_PATH, 'utf-8');
    knowledgeTypes = JSON.parse(raw);
    return knowledgeTypes;
  } catch (e) {
    console.error('[decay_scorer] Failed to load knowledge_types.json:', e.message);
    // Fallback defaults
    knowledgeTypes = {
      types: {
        tool_workflow: { lambda_base: 0.005 },
        project_rule: { lambda_base: 0.008 },
        business_knowledge: { lambda_base: 0.010 },
        behavioral_pattern: { lambda_base: 0.003 },
        decision_preference: { lambda_base: 0.006 },
        session_lesson: { lambda_base: 0.020 },
      },
      defaults: { c0: 1.0, alpha: 0, beta: 0, initial_score: 5 },
      thresholds: { TRUST: 0.8, VERIFY: 0.5 },
      feedback: { success_weight: 1.0, failure_weight: 1.5, soft_signal_weight: 0.3 },
    };
    return knowledgeTypes;
  }
}

/**
 * 根据稳定性计算基础衰减率
 * stability 1-10 → lambda 0.020-0.003
 * - stability=1 (临时) → lambda=0.020 (半衰期 35 天)
 * - stability=10 (极稳定) → lambda=0.003 (半衰期 231 天)
 *
 * @param {number} stability - 稳定性评分 1-10
 * @returns {number} 基础衰减率
 */
function calculateLambdaBase(stability) {
  const lambdaMin = 0.003;  // stability=10
  const lambdaMax = 0.020;  // stability=1
  const clampedStability = Math.max(1, Math.min(10, stability || 5));
  const normalized = (10 - clampedStability) / 9;
  return lambdaMin + (lambdaMax - lambdaMin) * normalized;
}

/**
 * 计算有效衰减率
 * λ_eff = λ_base × (β + 1) / (α + 1)
 *
 * @param {string} knowledgeType - 知识类型（可选，用于向后兼容）
 * @param {number} alpha - 累计正面反馈权重
 * @param {number} beta - 累计负面反馈权重
 * @param {number} stability - 稳定性评分 1-10（默认 5）
 * @returns {number} 有效衰减率
 */
function calculateLambdaEff(knowledgeType, alpha = 0, beta = 0, stability = 5) {
  // 优先使用 stability，向后兼容 knowledgeType 查表
  const lambdaBase = (stability !== undefined && stability !== null)
    ? calculateLambdaBase(stability)
    : getLambdaBaseFromType(knowledgeType);

  // Bayesian adjustment: (β+1)/(α+1)
  // - When β=0 and α=0: λ_eff = λ_base (neutral)
  // - When α increases: λ_eff decreases (slower decay)
  // - When β increases: λ_eff increases (faster decay)
  return lambdaBase * (beta + 1) / (alpha + 1);
}

/**
 * 从 knowledgeType 查表获取 lambda_base（向后兼容）
 * @param {string} knowledgeType
 * @returns {number}
 */
function getLambdaBaseFromType(knowledgeType) {
  const config = loadKnowledgeTypes();
  const typeConfig = config.types[knowledgeType];
  if (!typeConfig) {
    return 0.010; // default: business_knowledge
  }
  return typeConfig.lambda_base;
}

/**
 * 计算置信度
 * C(t) = C₀ × e^(-λ_eff × t)
 *
 * @param {object} rule - 规则对象，包含 c0, confirmed_at, knowledge_type, alpha, beta
 * @param {Date} [now] - 当前时间（可注入用于测试）
 * @returns {number} 置信度 [0, C₀]
 */
function calculateConfidence(rule, now = new Date()) {
  const confirmedAt = new Date(rule.confirmed_at || rule.created_at || now);
  const daysSinceConfirm = daysBetween(confirmedAt, now);

  if (daysSinceConfirm < 0) {
    console.warn('[decay_scorer] confirmed_at is in the future, using 0');
    return rule.c0 || 1.0;
  }

  const lambdaEff = calculateLambdaEff(
    rule.knowledge_type || 'session_lesson',
    rule.alpha || 0,
    rule.beta || 0,
    rule.stability || 5  // 新增：从 rule 读取 stability
  );

  const c0 = rule.c0 || 1.0;
  return c0 * Math.exp(-lambdaEff * daysSinceConfirm);
}

/**
 * 分类置信度级别
 *
 * @param {number} confidence - 置信度值
 * @returns {'TRUST'|'VERIFY'|'REVALIDATE'}
 */
function classifyConfidence(confidence) {
  const config = loadKnowledgeTypes();
  const thresholds = config.thresholds;

  if (confidence >= thresholds.TRUST) return 'TRUST';
  if (confidence >= thresholds.VERIFY) return 'VERIFY';
  return 'REVALIDATE';
}

/**
 * 记录成功反馈
 * - 增加 alpha
 * - 刷新 confirmed_at
 * - 缓慢提升 C₀
 *
 * @param {object} rule - 规则对象（会被修改）
 * @param {object} [options] - 选项
 * @param {boolean} options.softSignal - 是否为软信号（权重 0.3）
 * @returns {object} 更新后的规则
 */
function recordSuccess(rule, options = {}) {
  const config = loadKnowledgeTypes();
  const weight = options.softSignal
    ? config.feedback.soft_signal_weight
    : config.feedback.success_weight;

  rule.alpha = (rule.alpha || 0) + weight;
  rule.confirmed_at = new Date().toISOString().split('T')[0]; // refresh confirmed date
  rule.c0 = Math.min(1.0, (rule.c0 || 1.0) + 0.05); // slowly increase initial confidence

  return rule;
}

/**
 * 记录失败反馈
 * - 增加 beta（非对称：failure_weight = 1.5）
 * - 不刷新 confirmed_at → t 继续增长
 * - 双重加速衰减：t 增长 + λ_eff 增大
 *
 * @param {object} rule - 规则对象（会被修改）
 * @param {object} [options] - 选项
 * @param {boolean} options.softSignal - 是否为软信号（权重 0.3）
 * @returns {object} 更新后的规则
 */
function recordFailure(rule, options = {}) {
  const config = loadKnowledgeTypes();
  const weight = options.softSignal
    ? config.feedback.soft_signal_weight
    : config.feedback.failure_weight;

  rule.beta = (rule.beta || 0) + weight;
  // 注意: 不刷新 confirmed_at，这是非对称反馈的关键
  // t 继续增长 + λ_eff 因 β 增大而增大 = 双重加速衰减

  return rule;
}

/**
 * 使规则失效（手动标记为不可信）
 * 将 C₀ 设为 0.1，立即降为 REVALIDATE
 *
 * @param {object} rule - 规则对象（会被修改）
 * @returns {object} 更新后的规则
 */
function invalidate(rule) {
  rule.c0 = 0.1;
  rule.alpha = 0;
  rule.beta = 0;
  return rule;
}

/**
 * 重置规则（验证后恢复为新鲜状态）
 *
 * @param {object} rule - 规则对象（会被修改）
 * @returns {object} 更新后的规则
 */
function reset(rule) {
  const config = loadKnowledgeTypes();
  rule.c0 = config.defaults.c0;
  rule.alpha = 0;
  rule.beta = 0;
  rule.confirmed_at = new Date().toISOString().split('T')[0];
  return rule;
}

/**
 * 批量扫描规则置信度
 *
 * @param {Array<object>} rules - 规则数组
 * @param {Date} [now] - 当前时间
 * @returns {Array<object>} 带置信度信息的规则数组
 */
function scanAll(rules, now = new Date()) {
  return rules.map(rule => {
    const confidence = calculateConfidence(rule, now);
    const level = classifyConfidence(confidence);
    return {
      ...rule,
      confidence: parseFloat(confidence.toFixed(4)),
      level,
      lambda_eff: parseFloat(calculateLambdaEff(
        rule.knowledge_type,
        rule.alpha || 0,
        rule.beta || 0,
        rule.stability || 5  // 新增
      ).toFixed(6)),
      days_since_confirm: daysBetween(
        new Date(rule.confirmed_at || rule.created_at || now),
        now
      ),
    };
  });
}

/**
 * 按置信度级别过滤规则
 *
 * @param {Array<object>} rules - 规则数组
 * @param {'TRUST'|'VERIFY'|'REVALIDATE'} level - 目标级别
 * @param {Date} [now] - 当前时间
 * @returns {Array<object>} 过滤后的规则数组
 */
function filterByLevel(rules, level, now = new Date()) {
  return scanAll(rules, now).filter(r => r.level === level);
}

/**
 * 计算半衰期（天）
 * t_half = ln(2) / λ_eff
 *
 * @param {string} knowledgeType - 知识类型（可选）
 * @param {number} alpha - 累计正面反馈
 * @param {number} beta - 累计负面反馈
 * @param {number} stability - 稳定性评分 1-10（默认 5）
 * @returns {number} 半衰期（天）
 */
function calculateHalfLife(knowledgeType, alpha = 0, beta = 0, stability = 5) {
  const lambdaEff = calculateLambdaEff(knowledgeType, alpha, beta, stability);
  return Math.LN2 / lambdaEff;
}

// ─── Utility ───────────────────────────────────────────────

function daysBetween(dateA, dateB) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const a = new Date(dateA);
  const b = new Date(dateB);
  // Use date-only (strip time) for day-level precision
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.floor((utcB - utcA) / msPerDay);
}

/**
 * 创建新规则的衰减初始状态
 *
 * @param {string} knowledgeType - 知识类型
 * @param {number} stability - 稳定性评分 1-10（默认 5）
 * @returns {object} 衰减状态字段
 */
function createDecayState(knowledgeType, stability = 5) {
  const config = loadKnowledgeTypes();
  return {
    c0: config.defaults.c0,
    alpha: config.defaults.alpha,
    beta: config.defaults.beta,
    confirmed_at: new Date().toISOString().split('T')[0],
    knowledge_type: knowledgeType,
    stability: stability,  // 新增字段
  };
}

// ─── Exports ───────────────────────────────────────────────

module.exports = {
  // Core calculations
  calculateLambdaBase,
  calculateLambdaEff,
  calculateConfidence,
  classifyConfidence,
  calculateHalfLife,

  // Feedback
  recordSuccess,
  recordFailure,
  invalidate,
  reset,

  // Batch operations
  scanAll,
  filterByLevel,

  // Factory
  createDecayState,

  // Utility
  loadKnowledgeTypes,
  daysBetween,
};
