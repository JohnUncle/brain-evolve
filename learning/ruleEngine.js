#!/usr/bin/env node
// ruleEngine.js — Rule population engine (signal-gene pipeline)
// brain-evolve: 集成指数衰减模型 (Self-Evolving-Skill)
//
// Population:
//   active  — in CLAUDE.md, evaluated by LLM each session
//   dormant — demoted, kept in pool (LLM can revive during optimize)
//   dead    — dormant for too long, archived
//
// Scoring (双轨):
//   1. EMA 分数 (0-10): LLM evaluates each active rule per session
//   2. 衰减置信度 C(t) = C₀ × e^(-λ_eff × t): 按知识类型差异化半衰期
//   3. 贝叶斯反馈: α(成功) / β(失败) 非对称调整
//   4. 双重生命周期: EMA 分数 + 衰减置信度共同决定 dormant/dead

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const decay = require('./decay_scorer');

const DATA_DIR = path.join(__dirname, 'data');
const RULES_PATH = path.join(DATA_DIR, 'rules.json');
const CONFLICTS_PATH = path.join(DATA_DIR, 'conflicts.json');
const CHANGELOG_PATH = path.join(DATA_DIR, 'changelog.jsonl');

const MAX_ACTIVE = 10;             // Max rules in CLAUDE.md
const DORMANT_TTL_SESSIONS = 15;   // Die after 15 sessions in dormant
const DORMANT_REVALIDATE_SESSIONS = 10; // Die if REVALIDATE for 10 sessions

// ===================== Keywords =====================

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
  'if', 'while', 'that', 'this', 'these', 'those', 'it', 'its',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their', 'what', 'which', 'who', 'whom',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '個', '上', '也', '很', '到', '說', '要', '去', '你', '會', '著', '沒有',
  '看', '好', '自己', '這', '他', '她', '們', '吧', '被', '把', '讓', '用',
  '那', '什麼', '怎麼', '如果', '可以', '因為', '所以', '但是', '還是',
  '或者', '而且', '嗎', '呢', '啊', '喔', '欸', '對',
]);

function extractKeywords(text) {
  if (!text) return [];
  const normalized = text.toLowerCase()
    .replace(/[`*#\[\](){}|><!,;:.?!，。；：？！、「」『』（）【】]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const tokens = [];
  for (const part of normalized.split(/\s+/)) {
    if (/[\u4e00-\u9fff]/.test(part)) {
      const runs = part.match(/[\u4e00-\u9fff]+/g) || [];
      for (const run of runs) {
        if (run.length >= 2 && run.length <= 4) tokens.push(run);
        for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
      }
      tokens.push(...part.replace(/[\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(Boolean));
    } else if (part.length > 1) {
      tokens.push(part);
    }
  }
  return [...new Set(tokens.filter(t => t.length > 1 && !STOP_WORDS.has(t)))];
}

function jaccardSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) { if (setB.has(x)) inter++; }
  return inter / (setA.size + setB.size - inter);
}

// ===================== Data I/O =====================

// brain-evolve: Memory cache to reduce file I/O
let _popCache = null;

function loadPopulation() {
  if (_popCache) return _popCache; // Return cached version
  try {
    const data = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    if (data.version === 1 && Array.isArray(data.rules)) {
      // Migrate v1 → v2
      _popCache = {
        version: 2, session_count: 0,
        population: data.rules.map(r => ({
          ...r,
          score: r.fitness || 0,
          relevance_count: r.sessions_evaluated || 0,
          dormant_since_session: 0,
        })),
      };
      return _popCache;
    }
    // Migrate: backfill complexity tracking fields + decay state for existing rules
    for (const rule of data.population || []) {
      if (!rule.complexity) rule.complexity = 'simple';
      if (!('content_hash' in rule)) rule.content_hash = null;
      if (!('skill_path' in rule)) rule.skill_path = null;
      // Decay model fields (brain-evolve)
      if (!rule.knowledge_type) rule.knowledge_type = 'session_lesson'; // default for old rules
      if (rule.c0 === undefined) rule.c0 = 1.0;
      if (rule.alpha === undefined) rule.alpha = 0;
      if (rule.beta === undefined) rule.beta = 0;
      if (!rule.confirmed_at) rule.confirmed_at = rule.created || new Date().toISOString().slice(0, 10);
      if (rule.stability === undefined) rule.stability = 5; // brain-evolve: stability migration
    }
    _popCache = data;
    return _popCache;
  } catch {
    _popCache = { version: 2, session_count: 0, population: [] };
    return _popCache;
  }
}

function savePopulation(data) {
  _popCache = data; // Update cache
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = RULES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, RULES_PATH);
}

function loadRules() { return loadPopulation(); }
function saveRules(data) { savePopulation(data); }

function loadConflicts() {
  try { return JSON.parse(fs.readFileSync(CONFLICTS_PATH, 'utf8')); }
  catch { return { version: 1, pending: [] }; }
}

function saveConflicts(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFLICTS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, CONFLICTS_PATH);
}

function generateId() {
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

const MAX_LOG_LINES = 500;

function logChange(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(CHANGELOG_PATH, line, 'utf8');
  if (Math.random() < 0.02) {
    try {
      const lines = fs.readFileSync(CHANGELOG_PATH, 'utf8').trim().split('\n');
      if (lines.length > MAX_LOG_LINES) {
        fs.writeFileSync(CHANGELOG_PATH + '.tmp', lines.slice(-MAX_LOG_LINES).join('\n') + '\n', 'utf8');
        fs.renameSync(CHANGELOG_PATH + '.tmp', CHANGELOG_PATH);
      }
    } catch {}
  }
}

// ===================== Population queries =====================

function getByStatus(project, status) {
  return loadPopulation().population.filter(r => r.project === project && r.status === status);
}
function getActiveRules(project) { return getByStatus(project, 'active'); }
function getDormant(project) { return getByStatus(project, 'dormant'); }

function incrementSession(project) {
  const data = loadPopulation();
  data.session_count = (data.session_count || 0) + 1;
  savePopulation(data);
  return data.session_count;
}

// ===================== Add rule =====================

/**
 * Add a new rule to the population.
 * @param {string} project
 * @param {string} content - Rule text
 * @param {string} source - Where this rule came from
 * @param {Array} keywords - Optional keywords (auto-extracted if omitted)
 * @param {string} status - 'active' or 'candidate'
 * @param {string} complexity - 'simple'|'compound'|'workflow'|'methodology'
 * @param {string} knowledgeType - Knowledge type for decay model (optional)
 * @param {number} stability - Stability score 1-10 (optional, default 5)
 */
function addRule(project, content, source, keywords, status, complexity, knowledgeType, stability) {
  const data = loadPopulation();

  // Enforce MAX_ACTIVE: if requesting active but at cap, downgrade to candidate
  let effectiveStatus = status || 'active';
  if (effectiveStatus === 'active') {
    const activeCount = data.population.filter(r => r.project === project && r.status === 'active').length;
    if (activeCount >= MAX_ACTIVE) effectiveStatus = 'candidate';
  }

  const id = generateId();
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  const today = new Date().toISOString().slice(0, 10);

  // Decay model initial state (brain-evolve)
  const decayState = decay.createDecayState(knowledgeType || 'session_lesson', stability || 5);

  const rule = {
    id, project, content, source,
    keywords: keywords || extractKeywords(content),
    score: 5,  // Start at neutral (0-10 scale, 5 = untested)
    relevance_count: 0,
    sessions_evaluated: 0,
    created: today,
    status: effectiveStatus,
    dormant_since_session: 0,
    complexity: complexity || 'simple',
    content_hash: contentHash,
    skill_path: null,
    // Decay model fields (brain-evolve)
    knowledge_type: knowledgeType || 'session_lesson',
    stability: stability || 5,  // 新增：稳定性评分
    c0: decayState.c0,
    alpha: decayState.alpha,
    beta: decayState.beta,
    confirmed_at: decayState.confirmed_at,
  };
  data.population.push(rule);
  savePopulation(data);
  logChange({ action: 'born', rule_id: id, project, status: rule.status, source, knowledge_type: rule.knowledge_type, content: content.slice(0, 300) });
  return rule;
}

// ===================== LLM-driven scoring + decay feedback =====================

/**
 * Apply LLM evaluation results to the population.
 * brain-evolve: also applies decay model feedback based on score.
 *
 * @param {string} project
 * @param {Array} evaluations - [{ rule_id, score: 0-10, reason: string }]
 * @param {object} [options]
 * @param {boolean} options.softSignal - Use soft feedback weight (0.3)
 */
function applyScores(project, evaluations, options = {}) {
  const data = loadPopulation();
  const changes = [];

  for (const ev of evaluations) {
    const rule = data.population.find(r => r.id === ev.rule_id);
    if (!rule || rule.project !== project) continue;

    const oldScore = rule.score;
    // Track EMA score (original behavior)
    const emaAlpha = 0.3; // 30% new, 70% old
    rule.score = parseFloat((rule.score * (1 - emaAlpha) + ev.score * emaAlpha).toFixed(1));
    rule.relevance_count = (rule.relevance_count || 0) + 1;
    rule.sessions_evaluated = (rule.sessions_evaluated || 0) + 1;

    // Decay model feedback (brain-evolve)
    // Score >= 7: success → increases α, refreshes confirmed_at
    // Score <= 3: failure → increases β (asymmetric), does NOT refresh confirmed_at
    // Score 4-6: neutral → no decay feedback
    const oldConfidence = decay.calculateConfidence(rule);
    if (ev.score >= 7) {
      decay.recordSuccess(rule, { softSignal: options.softSignal });
    } else if (ev.score <= 3) {
      decay.recordFailure(rule, { softSignal: options.softSignal });
    }
    const newConfidence = decay.calculateConfidence(rule);

    changes.push({
      rule_id: rule.id,
      old_score: oldScore,
      new_score: rule.score,
      llm_score: ev.score,
      reason: ev.reason || '',
      // Decay tracking (brain-evolve)
      old_confidence: parseFloat(oldConfidence.toFixed(4)),
      new_confidence: parseFloat(newConfidence.toFixed(4)),
      confidence_level: decay.classifyConfidence(newConfidence),
      alpha: rule.alpha,
      beta: rule.beta,
    });
  }

  savePopulation(data);
  return changes;
}

/**
 * Apply decay scoring to all active rules (time-based, no LLM needed).
 * Called at session start to refresh confidence levels.
 *
 * @param {string} project
 * @returns {Array} Rules with updated confidence info
 */
function applyDecayScan(project) {
  const data = loadPopulation();
  const results = [];
  const now = new Date();

  for (const rule of data.population) {
    if (rule.project !== project) continue;
    if (rule.status !== 'active' && rule.status !== 'candidate') continue;

    const confidence = decay.calculateConfidence(rule, now);
    const level = decay.classifyConfidence(confidence);

    results.push({
      rule_id: rule.id,
      content: rule.content?.slice(0, 100),
      knowledge_type: rule.knowledge_type,
      confidence: parseFloat(confidence.toFixed(4)),
      level,
      alpha: rule.alpha || 0,
      beta: rule.beta || 0,
      days_since_confirm: decay.daysBetween(
        new Date(rule.confirmed_at || rule.created || now),
        now
      ),
    });
  }

  return results;
}

/**
 * Record manual feedback for a rule (e.g., from user correction or validation).
 *
 * @param {string} project
 * @param {string} ruleId
 * @param {'success'|'failure'} result
 * @param {object} [options]
 * @param {boolean} options.softSignal
 */
function recordFeedback(project, ruleId, result, options = {}) {
  const data = loadPopulation();
  const rule = data.population.find(r => r.id === ruleId && r.project === project);
  if (!rule) return null;

  const oldConfidence = decay.calculateConfidence(rule);

  if (result === 'success') {
    decay.recordSuccess(rule, options);
  } else if (result === 'failure') {
    decay.recordFailure(rule, options);
  }

  const newConfidence = decay.calculateConfidence(rule);
  savePopulation(data);

  logChange({
    action: 'feedback',
    rule_id: ruleId,
    project,
    result,
    old_confidence: parseFloat(oldConfidence.toFixed(4)),
    new_confidence: parseFloat(newConfidence.toFixed(4)),
    soft_signal: !!options.softSignal,
  });

  return {
    rule_id: ruleId,
    result,
    confidence: parseFloat(newConfidence.toFixed(4)),
    level: decay.classifyConfidence(newConfidence),
  };
}

/**
 * Demote low-scoring rules to dormant. Promote high-scoring candidates.
 * Kill long-dormant rules.
 * brain-evolve: dual conditions — EMA score AND decay confidence
 *
 * @param {string} project
 * @param {number} sessionCount - current global session count
 */
const COMPLEXITY_LEVELS = ['simple', 'compound', 'workflow', 'methodology'];

function applyLifecycle(project, sessionCount) {
  const data = loadPopulation();
  const demoted = [];
  const promoted = [];
  const killed = [];
  const now = new Date();

  for (const rule of data.population) {
    if (rule.project !== project) continue;

    // Calculate current decay confidence (brain-evolve)
    const confidence = decay.calculateConfidence(rule, now);
    const confLevel = decay.classifyConfidence(confidence);

    // ── Demote: dual condition ──
    // Original: score < 3 AND relevance_count >= 3
    // brain-evolve: also demote if confidence drops to REVALIDATE
    const emaDemote = rule.status === 'active' && rule.score < 3 && rule.relevance_count >= 3;
    const decayDemote = rule.status === 'active' && confLevel === 'REVALIDATE' && rule.sessions_evaluated >= 3;

    if (emaDemote || decayDemote) {
      rule.status = 'dormant';
      rule.dormant_since_session = sessionCount;

      const hadSkillFile = rule.complexity === 'methodology' && !!rule.skill_path;
      const oldSkillPath = rule.skill_path || null;

      // Downgrade complexity one level
      const currentLevel = COMPLEXITY_LEVELS.indexOf(rule.complexity || 'simple');
      if (currentLevel > 0) {
        rule.complexity = COMPLEXITY_LEVELS[currentLevel - 1];
      }
      // Reset EMA score but keep decay state (brain-evolve)
      rule.score = 5;
      rule.relevance_count = 0;
      rule.sessions_evaluated = 0;
      // Decay state is preserved — it continues to decay from current state

      demoted.push({
        ...rule,
        had_skill_file: hadSkillFile,
        old_skill_path: oldSkillPath,
        demote_reason: emaDemote ? 'ema_low_score' : 'decay_revalidate',
        confidence: parseFloat(confidence.toFixed(4)),
      });
      logChange({
        action: 'demoted', rule_id: rule.id, project,
        score: rule.score, complexity: rule.complexity,
        confidence: parseFloat(confidence.toFixed(4)),
        level: confLevel,
        reason: emaDemote ? 'ema_low_score' : 'decay_revalidate',
        content: rule.content.slice(0, 200),
      });
    }

    // ── Kill: dual condition ──
    // Original: dormant for DORMANT_TTL_SESSIONS
    // brain-evolve: also kill if REVALIDATE for DORMANT_REVALIDATE_SESSIONS
    if (rule.status === 'dormant' && rule.dormant_since_session > 0) {
      const sessionsDormant = sessionCount - rule.dormant_since_session;
      const ttlKill = sessionsDormant >= DORMANT_TTL_SESSIONS;
      const decayKill = confLevel === 'REVALIDATE' && sessionsDormant >= DORMANT_REVALIDATE_SESSIONS;

      if (ttlKill || decayKill) {
        rule.status = 'dead';
        killed.push(rule);
        logChange({
          action: 'dead', rule_id: rule.id, project,
          confidence: parseFloat(confidence.toFixed(4)),
          level: confLevel,
          sessions_dormant: sessionsDormant,
          reason: ttlKill ? 'ttl_expired' : 'decay_revalidate_prolonged',
          content: rule.content.slice(0, 200),
        });
      }
    }
  }

  // Promote: if active count < MAX_ACTIVE, promote top-scoring candidates
  // brain-evolve: also consider confidence in ranking
  const activeCount = data.population.filter(r => r.project === project && r.status === 'active').length;
  const slots = MAX_ACTIVE - activeCount;
  if (slots > 0) {
    const candidates = data.population
      .filter(r => r.project === project && r.status === 'candidate')
      .sort((a, b) => {
        // brain-evolve: composite score = EMA × 0.6 + confidence × 10 × 0.4
        const scoreA = (a.score || 5) * 0.6 + decay.calculateConfidence(a, now) * 10 * 0.4;
        const scoreB = (b.score || 5) * 0.6 + decay.calculateConfidence(b, now) * 10 * 0.4;
        return scoreB - scoreA;
      });
    for (const rule of candidates.slice(0, slots)) {
      rule.status = 'active';
      promoted.push(rule);
      logChange({ action: 'promoted', rule_id: rule.id, project, content: rule.content.slice(0, 200) });
    }
  }

  savePopulation(data);
  return { demoted, promoted, killed };
}

// Legacy compat
function evaluateFitness(project) {
  // No-op in v2, scoring is done by applyScores
}

// ===================== Conflict detection =====================

function detectConflict(newContent, handWrittenContent) {
  if (!handWrittenContent) return { hasConflict: false, similarity: 0 };
  const newKw = extractKeywords(newContent);
  const chunks = handWrittenContent
    .split(/\n(?=[-*]|\d+\.)/).map(c => c.trim())
    .filter(c => c.length > 10 && !c.match(/^#{1,4}\s/));
  let maxSim = 0;
  let conflictChunk = '';
  for (const chunk of chunks) {
    const sim = Math.max(
      jaccardSimilarity(newKw, extractKeywords(chunk)),
      semanticOverlap(newContent, chunk)
    );
    if (sim > maxSim) { maxSim = sim; conflictChunk = chunk; }
  }
  return { hasConflict: maxSim > 0.3, similarity: parseFloat(maxSim.toFixed(2)), conflictsWith: conflictChunk.slice(0, 500) };
}

function semanticOverlap(a, b) {
  const ca = extractConcepts(a);
  const cb = extractConcepts(b);
  if (ca.size === 0 || cb.size === 0) return 0;
  let overlap = 0;
  for (const c of ca) { if (cb.has(c)) overlap++; }
  return overlap < 2 ? 0 : overlap / Math.min(ca.size, cb.size);
}

function extractConcepts(text) {
  const lower = text.toLowerCase();
  const concepts = new Set();
  const terms = lower.match(/[a-z][a-z0-9_-]{1,30}/g) || [];
  for (const t of terms) { if (!STOP_WORDS.has(t) && t.length > 2) concepts.add(t); }
  return concepts;
}

function addConflict(project, newContent, conflictsWith, similarity) {
  const data = loadConflicts();
  const id = 'c_' + Date.now().toString(36);
  data.pending.push({ id, project, new_content: newContent, conflicts_with: conflictsWith, similarity, created: new Date().toISOString(), status: 'pending' });
  saveConflicts(data);
  logChange({ action: 'conflict', conflict_id: id, project, new_content: newContent.slice(0, 200) });
  return id;
}

function getPendingConflicts(project) {
  return loadConflicts().pending.filter(c => c.project === project && c.status === 'pending');
}

function resolveConflict(conflictId, resolution) {
  const data = loadConflicts();
  const c = data.pending.find(x => x.id === conflictId);
  if (!c) return null;
  c.status = resolution;
  c.resolved_at = new Date().toISOString();
  saveConflicts(data);
  return c;
}

// ===================== Duplicate check =====================

function isDuplicate(project, keywords) {
  return loadPopulation().population
    .filter(r => r.project === project && (r.status === 'active' || r.status === 'candidate'))
    .some(r => jaccardSimilarity(r.keywords, keywords) > 0.5);
}

// ===================== Stats =====================

function getPopulationStats(project) {
  const data = loadPopulation();
  const pop = data.population.filter(r => r.project === project);
  const active = pop.filter(r => r.status === 'active');
  return {
    session_count: data.session_count || 0,
    total: pop.length,
    active: active.length,
    candidate: pop.filter(r => r.status === 'candidate').length,
    dormant: pop.filter(r => r.status === 'dormant').length,
    dead: pop.filter(r => r.status === 'dead').length,
    avg_score: active.length > 0 ? parseFloat((active.reduce((s, r) => s + r.score, 0) / active.length).toFixed(1)) : 0,
  };
}

// ===================== Complexity management =====================

function updateComplexity(project, ruleId, newComplexity, skillPath) {
  const data = loadPopulation();
  const rule = data.population.find(r => r.id === ruleId && r.project === project);
  if (!rule) return null;
  const oldComplexity = rule.complexity || 'simple';
  rule.complexity = newComplexity;
  if (skillPath !== undefined) rule.skill_path = skillPath;
  savePopulation(data);
  logChange({ action: 'complexity_change', rule_id: ruleId, project, old: oldComplexity, new: newComplexity, skill_path: rule.skill_path });
  return rule;
}

function getRelatedRules(project, rule, threshold) {
  if (threshold === undefined || threshold === null) threshold = 0.3;
  const pop = loadPopulation().population;
  const ruleKw = rule.keywords || extractKeywords(rule.content || '');
  return pop.filter(r => {
    if (r.project !== project || r.id === rule.id) return false;
    const sim = jaccardSimilarity(ruleKw, r.keywords || []);
    return sim > threshold;
  });
}

// brain-evolve: Invalidate cache (call at start of processRules to ensure fresh data)
function invalidateCache() {
  _popCache = null;
}

module.exports = {
  extractKeywords, jaccardSimilarity,
  loadPopulation, savePopulation, loadRules, saveRules,
  loadConflicts, saveConflicts,
  generateId, logChange,
  addRule, getActiveRules, getDormant, getByStatus,
  incrementSession,
  applyScores, applyLifecycle, applyDecayScan, recordFeedback, evaluateFitness,
  detectConflict, addConflict, getPendingConflicts, resolveConflict,
  isDuplicate, getPopulationStats,
  updateComplexity, getRelatedRules,
  invalidateCache, // brain-evolve: cache management
  MAX_ACTIVE, DORMANT_TTL_SESSIONS, DORMANT_REVALIDATE_SESSIONS,
};
