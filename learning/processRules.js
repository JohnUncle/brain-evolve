#!/usr/bin/env node
// processRules.js — Signal-gene learning pipeline
//
// Signal → Gene → LLM Execute → Validate → Solidify
//
// Signal: What happened in this session? (corrections, observations, quiet)
// Gene: What action to take? (repair / innovate / optimize / cleanup / skillify)
//   - repair:   corrections detected → extract new rules from feedback
//   - innovate: patterns/anti-patterns detected → extract rules from observations
//   - optimize: LLM evaluates all active rules, scores them, demotes bad ones
//   - cleanup:  too many rules → LLM merges and simplifies
//   - skillify: 3+ related high-score rules → re-classify complexity, promote to skill files
// Execute: LLM performs the gene's action
// Validate: LLM checks the resulting rule set for conflicts and consistency
// Solidify: Write to CLAUDE.md + session memory

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PENDING_PATH = path.join(DATA_DIR, 'pending.json');
const PROCESS_LOG = path.join(DATA_DIR, 'process.log');

// brain-evolve: LLM call budget tracking
const LLM_BUDGET_PER_SESSION = 10; // Max LLM calls per session
let llmCallsThisSession = 0;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(PROCESS_LOG, line, 'utf8'); } catch {}
}

// brain-evolve: budgeted LLM call wrapper
async function budgetedLLMCall(llmBrain, fn, ...args) {
  if (llmCallsThisSession >= LLM_BUDGET_PER_SESSION) {
    log(`LLM budget exhausted (${llmCallsThisSession}/${LLM_BUDGET_PER_SESSION}), skipping call`);
    return null;
  }
  llmCallsThisSession++;
  log(`LLM call ${llmCallsThisSession}/${LLM_BUDGET_PER_SESSION}: ${fn.name || 'anonymous'}`);
  return fn(...args);
}

// brain-evolve: stability-aware maturity check (P2 optimization)
function isMatureRule(rule, mode) {
  const stability = rule.stability || 5;
  // stability 越高，score 阈值越低（稳定规则更容易"毕业"）
  const scoreThreshold = stability >= 8 ? 6.0 :
                          stability >= 6 ? 6.5 : 7.0;
  const relevanceThreshold = mode === 'aggressive' ? 3 : 5;
  return rule.score >= scoreThreshold &&
         rule.relevance_count >= relevanceThreshold &&
         stability >= 5;  // 硬下限：stability<5 永不生成 skill
}

// brain-evolve: structured pre-clustering (P1 optimization)
// Group by knowledge_type + keyword similarity (deterministic, no LLM)
function clusterByStructure(rules, opts = {}) {
  const minGroupSize = opts.minGroupSize || 3;
  const similarityThreshold = opts.similarityThreshold || 0.4;
  const ruleEngine = require('./ruleEngine');

  // Phase 1: 按 knowledge_type 分桶
  const byType = {};
  for (const r of rules) {
    const type = r.knowledge_type || 'session_lesson';
    if (!byType[type]) byType[type] = [];
    byType[type].push(r);
  }

  // Phase 2: 桶内按 keyword Jaccard 二次聚类（贪心）
  const groups = [];
  for (const bucket of Object.values(byType)) {
    if (bucket.length === 0) continue;

    const clusters = [];
    for (const r of bucket) {
      let added = false;
      // 尝试加入第一个相似度 > threshold 的簇
      for (const c of clusters) {
        const avgSim = c.reduce((sum, x) =>
          sum + ruleEngine.jaccardSimilarity(r.keywords || [], x.keywords || []), 0
        ) / c.length;

        if (avgSim > similarityThreshold) {
          c.push(r);
          added = true;
          break;
        }
      }
      // 没有匹配的簇，创建新簇
      if (!added) {
        clusters.push([r]);
      }
    }
    groups.push(...clusters);
  }

  // 过滤掉太小的组
  return groups.filter(g => g.length >= minGroupSize);
}

// brain-evolve: knowledge type classification via LLM
async function classifyKnowledgeType(source, content, llmBrain) {
  const prompt = `
分类这条规则，返回类型和稳定性评分：

规则内容：${content}
来源：${source}

分类要求：
1. knowledge_type: 任意类型名称（如 "writing_technique", "tool_workflow", "behavioral_pattern", "decision_making" 等）
2. stability: 稳定性评分 1-10
   - 1-3: 临时性知识（单次教训、特定命令）
   - 4-6: 中等稳定性（工具流程、项目规范）
   - 7-10: 极稳定（行为模式、决策偏好、核心原则）
3. reason: 为什么选这个类型和稳定性

返回 JSON（不要 markdown 代码块）:
{
  "knowledge_type": "类型名称",
  "stability": 1-10,
  "reason": "原因"
}
`;

  try {
    const result = await llmBrain.askClaudeWithRetry(prompt, 30000, 'fast', 1);
    // Parse JSON from response (handle potential markdown code blocks)
    let parsed;
    try {
      parsed = JSON.parse(result.content || result);
    } catch {
      // Try to extract JSON from markdown code block
      const jsonMatch = (result.content || result).match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Failed to parse LLM response');
      }
    }
    return {
      knowledge_type: parsed.knowledge_type || 'session_lesson',
      stability: Math.max(1, Math.min(10, parsed.stability || 5)),
      reason: parsed.reason || ''
    };
  } catch (err) {
    log(`[classifyKnowledgeType] LLM failed: ${err.message}, using fallback`);
    // Fallback: simple heuristic
    const text = (content || '').toLowerCase();
    if (/行为|习惯|模式|pattern|habit/i.test(text)) {
      return { knowledge_type: 'behavioral_pattern', stability: 8, reason: 'fallback' };
    }
    if (/命令|工具|安装|配置|command|tool/i.test(text)) {
      return { knowledge_type: 'tool_workflow', stability: 4, reason: 'fallback' };
    }
    return { knowledge_type: 'session_lesson', stability: 3, reason: 'fallback' };
  }
}

// =====================================================================
// TRIAGE FALLBACK (if LLM triage fails, use simple heuristics)
// =====================================================================

function fallbackTriage(newMemories, observations, activeRuleCount, sessionCount, highScoreGroups, cognitiveSignals) {
  let gene = 'observe';
  if ((newMemories || []).length > 0) gene = 'repair';
  else if ((observations || []).length >= 3 && activeRuleCount === 0) gene = 'innovate'; // Fix 2: learn from session 1
  else if ((observations || []).length >= 3) gene = 'innovate'; // Fix 2: lower threshold from 5 to 3
  else if ((highScoreGroups || 0) > 0) gene = 'skillify';
  else if (activeRuleCount >= 8) gene = 'cleanup';
  else if (sessionCount > 0 && sessionCount % 3 === 0) gene = 'optimize';
  // brain-evolve: harvest if cognitive patterns detected, or every 5 sessions
  else if ((cognitiveSignals || []).length > 0) gene = 'harvest';
  else if (sessionCount > 0 && sessionCount % 5 === 0 && (observations || []).length >= 2) gene = 'harvest';
  return { gene, complexity: 'routine', reason: 'fallback heuristic' };
}

// =====================================================================
// GENE EXECUTION (LLM calls)
// =====================================================================

async function main() {
  const pendingFile = process.argv[2] || PENDING_PATH;
  log('processRules started');

  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch (err) {
    log('No pending data: ' + (err.message || err));
    return;
  }
  if (!pending || !pending.project) { log('Invalid pending'); return; }

  const { project, newMemories, observations, handWrittenContent, cognitiveSignals } = pending;
  log(`Project: ${path.basename(project)}, memories: ${(newMemories || []).length}, obs: ${(observations || []).length}, cognitive: ${(cognitiveSignals || []).length}`);

  const ruleEngine = require('./ruleEngine');
  const claudeMdWriter = require('./claudeMdWriter');
  const llmBrain = require('./llmBrain');

  // brain-evolve: Invalidate cache at start to ensure fresh data
  ruleEngine.invalidateCache();

  const sessionCount = ruleEngine.incrementSession(project);
  const activeRules = ruleEngine.getActiveRules(project);
  const stats = ruleEngine.getPopulationStats(project);
  log(`Session #${sessionCount} | active=${stats.active} dormant=${stats.dormant} dead=${stats.dead}`);

  // --- Count high-score rules for skillify (group by project type, not keyword) ---
  const highScoreRules = activeRules.filter(r => (r.score || 0) > 7 && (r.relevance_count || 0) >= 5);
  const highScoreGroups = highScoreRules.length >= 3 ? 1 : 0;

  // --- Triage: LLM decides gene + complexity ---
  let gene = 'observe';
  let complexity = 'routine';
  try {
    const triageResult = llmBrain.triage(observations, newMemories, stats.active, sessionCount, highScoreGroups);
    if (triageResult && triageResult.gene) {
      gene = triageResult.gene;
      complexity = triageResult.complexity || 'routine';
      log(`Triage (LLM): gene=${gene} complexity=${complexity} — ${triageResult.reason || ''}`);
    } else {
      const fb = fallbackTriage(newMemories, observations, stats.active, sessionCount, highScoreGroups, cognitiveSignals);
      gene = fb.gene; complexity = fb.complexity;
      log(`Triage (fallback): gene=${gene}`);
    }
  } catch (err) {
    const fb = fallbackTriage(newMemories, observations, stats.active, sessionCount, highScoreGroups, cognitiveSignals);
    gene = fb.gene; complexity = fb.complexity;
    log(`Triage error, using fallback: gene=${gene} — ${err.message || err}`);
  }

  // Model tier for gene execution: routine → haiku, complex → sonnet
  const tier = complexity === 'complex' ? 'smart' : 'fast';
  log(`Model tier: ${tier} (${complexity})`);

  let rulesAdded = 0;
  let conflictsFound = 0;
  let optimizeRanThisSession = false; // Track if optimize gene ran (to avoid double scoring)
  const sessionRuleIds = new Set(); // Track rule IDs born/modified this session

  // --- Execute gene ---
  if (gene === 'repair') {
    // Extract rules from corrections
    for (const mem of (newMemories || [])) {
      try {
        const extracted = llmBrain.extractRule(mem);
        if (!extracted || !extracted.rule) continue;

        const ruleContent = extracted.rule;
        const keywords = extracted.keywords || [];
        log(`  Extracted: "${ruleContent.slice(0, 80)}"`);

        if (ruleEngine.isDuplicate(project, keywords)) { log('  Skip (dup)'); continue; }

        // Conflict check
        const conflict = llmBrain.checkConflict(ruleContent, handWrittenContent || '');
        if (conflict && conflict.decision === 'duplicate') { log('  Skip (dup of hand-written)'); continue; }
        if (conflict && conflict.decision === 'conflict') {
          ruleEngine.addConflict(project, ruleContent, conflict.conflicts_with || '', 1.0);
          conflictsFound++;
          log('  Conflict saved');
          continue;
        }

        const classification = await classifyKnowledgeType('correction', ruleContent, llmBrain);
        const added = ruleEngine.addRule(project, ruleContent, 'correction', keywords, 'active', undefined, classification.knowledge_type, classification.stability);
        sessionRuleIds.add(added.id);
        rulesAdded++;
        log(`  Added [correction] (${added.knowledge_type}, stability=${classification.stability}): "${ruleContent.slice(0, 60)}"`);
      } catch (err) { log(`  Error: ${err.message}`); }
    }

    // Also extract from observations during repair if population is small
    if (stats.active < 3 && observations && observations.length >= 3) {
      try {
        const obsResult = llmBrain.analyzeObservations(observations, ruleEngine.getActiveRules(project), handWrittenContent);
        if (obsResult) {
          for (const p of [...(obsResult.patterns || []), ...(obsResult.anti_patterns || [])]) {
            if (!p.rule || p.confidence === 'low') continue;
            if (ruleEngine.isDuplicate(project, p.keywords || [])) continue;
            const src = (obsResult.anti_patterns || []).includes(p) ? 'anti_pattern' : 'observation';
            const added = ruleEngine.addRule(project, p.rule, src, p.keywords, 'active');
            sessionRuleIds.add(added.id);
            rulesAdded++;
            log(`  Added [${src}]: "${p.rule.slice(0, 60)}"`);
          }
        }
      } catch (err) { log(`  Observation error: ${err.message}`); }
    }
  }

  if (gene === 'innovate') {
    // Extract patterns and anti-patterns from observations
    if (observations && observations.length >= 3) {
      try {
        log('Analyzing observations for patterns...');
        const obsResult = llmBrain.analyzeObservations(observations, activeRules, handWrittenContent);
        if (obsResult) {
          for (const p of (obsResult.patterns || [])) {
            if (!p.rule || p.confidence === 'low') continue;
            if (ruleEngine.isDuplicate(project, p.keywords || [])) continue;
            const status = stats.active < ruleEngine.MAX_ACTIVE ? 'active' : 'candidate';
            const classification = await classifyKnowledgeType('observation', p.rule, llmBrain);
            const added = ruleEngine.addRule(project, p.rule, 'observation', p.keywords, status, undefined, classification.knowledge_type, classification.stability);
            sessionRuleIds.add(added.id);
            rulesAdded++;
            log(`  Added [observation] (${added.knowledge_type}, stability=${classification.stability}) as ${status}: "${p.rule.slice(0, 60)}"`);
          }
          for (const p of (obsResult.anti_patterns || [])) {
            if (!p.rule || p.confidence === 'low') continue;
            if (ruleEngine.isDuplicate(project, p.keywords || [])) continue;
            const status = stats.active < ruleEngine.MAX_ACTIVE ? 'active' : 'candidate';
            const classification = await classifyKnowledgeType('anti_pattern', p.rule, llmBrain);
            const added = ruleEngine.addRule(project, p.rule, 'anti_pattern', p.keywords, status, undefined, classification.knowledge_type, classification.stability);
            sessionRuleIds.add(added.id);
            rulesAdded++;
            log(`  Added [anti_pattern] (${added.knowledge_type}, stability=${classification.stability}) as ${status}: "${p.rule.slice(0, 60)}"`);
          }
        }
      } catch (err) { log(`  Innovation error: ${err.message}`); }
    }
  }

  if (gene === 'optimize') {
    optimizeRanThisSession = true; // Mark that optimize ran (to skip heuristic scoring later)

    // brain-evolve: decay scan first (refreshes confidence for all active rules)
    const decayScan = ruleEngine.applyDecayScan(project);
    const revalidateRules = decayScan.filter(r => r.level === 'REVALIDATE');
    if (revalidateRules.length > 0) {
      log(`  Decay: ${revalidateRules.length} rules at REVALIDATE`);
      for (const r of revalidateRules) {
        log(`    ${r.rule_id}: ${(r.confidence * 100).toFixed(1)}% (${r.knowledge_type}, ${r.days_since_confirm}d)`);
      }
    }

    // LLM evaluates all active rules: score 0-10, suggest changes
    const currentActive = ruleEngine.getActiveRules(project);
    if (currentActive.length > 0) {
      try {
        log(`Optimizing ${currentActive.length} active rules...`);
        const evalResult = llmBrain.evaluateRuleSet(currentActive, observations, newMemories);

        if (evalResult && Array.isArray(evalResult.evaluations)) {
          const changes = ruleEngine.applyScores(project, evalResult.evaluations);
          for (const c of changes) {
            log(`  ${c.rule_id.slice(0, 12)}: ${c.old_score} → ${c.new_score} (LLM: ${c.llm_score}) C:${c.old_confidence}→${c.new_confidence} [${c.confidence_level}] ${c.reason}`);
          }

          // Re-evaluate complexity for rules whose score just crossed the >7 threshold
          for (const change of changes) {
            if (change.new_score > 7 && change.old_score <= 7) {
              const rule = currentActive.find(r => r.id === change.rule_id);
              if (rule && (rule.relevance_count || 0) >= 5) {
                const related = ruleEngine.getRelatedRules(project, rule, 0.2)
                  .filter(r => (r.score || 0) > 7);
                if (related.length >= 2) {
                  try {
                    const group = [rule, ...related];
                    const newComplexity = llmBrain.classifyComplexity(
                      { content: group.map(r => r.content).join('\n'), keywords: [...new Set(group.flatMap(r => r.keywords || []))] },
                      currentActive,
                      pending.projectType || ''
                    );
                    const levels = ['simple', 'compound', 'workflow', 'methodology'];
                    const currentLevel = levels.indexOf(rule.complexity || 'simple');
                    const newLevel = levels.indexOf(newComplexity);
                    if (newLevel > currentLevel) {
                      ruleEngine.updateComplexity(project, rule.id, newComplexity);
                      sessionRuleIds.add(rule.id);
                      log(`  Optimize-promote ${rule.id.slice(0,12)}: ${rule.complexity || 'simple'} → ${newComplexity}`);
                    }
                  } catch (err) {
                    log(`  Optimize-promote error: ${err.message}`);
                  }
                }
              }
            }
          }
        }

        // Apply lifecycle: demote low, promote candidates, kill old dormant
        const lifecycle = ruleEngine.applyLifecycle(project, sessionCount);
        if (lifecycle.demoted.length) log(`  Demoted: ${lifecycle.demoted.length}`);
        if (lifecycle.promoted.length) log(`  Promoted: ${lifecycle.promoted.length}`);
        if (lifecycle.killed.length) log(`  Killed: ${lifecycle.killed.length}`);

        // Revive dormant rules if LLM suggests
        if (evalResult && Array.isArray(evalResult.revive)) {
          const data = ruleEngine.loadPopulation();
          for (const id of evalResult.revive) {
            const r = data.population.find(x => x.id === id && x.status === 'dormant');
            if (r) {
              r.status = 'active';
              r.score = 5; // Reset to neutral
              ruleEngine.logChange({ action: 'revived', rule_id: id, project });
              log(`  Revived: ${r.content.slice(0, 40)}`);
            }
          }
          ruleEngine.savePopulation(data);
        }
      } catch (err) { log(`  Optimize error: ${err.message}`); }
    }
  }

  if (gene === 'cleanup') {
    // LLM merges and simplifies the rule set
    const currentActive = ruleEngine.getActiveRules(project);
    if (currentActive.length >= 5) {
      try {
        log(`Cleaning up ${currentActive.length} rules...`);
        const cleanResult = llmBrain.cleanupRules(currentActive);

        if (cleanResult && Array.isArray(cleanResult.actions)) {
          const data = ruleEngine.loadPopulation();
          for (const action of cleanResult.actions) {
            if (action.type === 'merge' && action.merged_rule && action.source_ids) {
              // Demote sources, add merged
              for (const id of action.source_ids) {
                const r = data.population.find(x => x.id === id);
                if (r) r.status = 'dormant';
              }
              ruleEngine.savePopulation(data);
              const added = ruleEngine.addRule(project, action.merged_rule, 'cleanup', action.keywords, 'active');
              sessionRuleIds.add(added.id);
              log(`  Merged ${action.source_ids.length} → "${action.merged_rule.slice(0, 60)}"`);
            }
            if (action.type === 'rewrite' && action.rule_id && action.new_content) {
              const r = data.population.find(x => x.id === action.rule_id);
              if (r) {
                r.content = action.new_content;
                r.keywords = ruleEngine.extractKeywords(action.new_content);
                sessionRuleIds.add(r.id); // Rewritten counts as modified
                log(`  Rewritten: "${action.new_content.slice(0, 60)}"`);
              }
            }
            if (action.type === 'remove' && action.rule_id) {
              const r = data.population.find(x => x.id === action.rule_id);
              if (r) { r.status = 'dormant'; log(`  Removed: "${r.content.slice(0, 40)}"`); }
            }
          }
          ruleEngine.savePopulation(data);
        }
      } catch (err) { log(`  Cleanup error: ${err.message}`); }
    }
  }

  if (gene === 'skillify') {
    // brain-evolve: LLM decides whether to generate skills and how to group
    const currentActive = ruleEngine.getActiveRules(project);

    // Read skill mode from config (default: conservative)
    let skillMode = 'conservative';
    let skillPolicy = {
      min_rules: 5,
      min_score: 7,
      min_stability: 5,
    };
    try {
      const configPath = path.join(DATA_DIR, 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        skillMode = config.skill_mode || 'conservative';
        if (config.skill_policy) {
          skillPolicy = { ...skillPolicy, ...config.skill_policy };
        }
      }
    } catch {}

    // P2: stability-aware maturity check
    const matureRules = currentActive.filter(r => isMatureRule(r, skillMode));

    const minRulesForSkill = skillMode === 'aggressive' ? 3 : skillPolicy.min_rules;

    if (matureRules.length < minRulesForSkill) {
      log(`  Skillify: ${matureRules.length} mature rules < ${minRulesForSkill} (${skillMode} mode), skipping`);
    } else {
      log(`  Skillify: ${matureRules.length} mature rules, using structured pre-clustering...`);

      // P1: Structured pre-clustering (deterministic, no LLM)
      const preliminaryGroups = clusterByStructure(matureRules, {
        minGroupSize: skillMode === 'aggressive' ? 2 : 3,
        similarityThreshold: 0.4,
      });

      log(`  Skillify: ${preliminaryGroups.length} preliminary groups from clustering`);

      if (preliminaryGroups.length === 0) {
        log(`  Skillify: no groups meet minimum size, skipping`);
      } else {
        try {
          // For each preliminary group, call LLM to refine (validate + name)
          const data = ruleEngine.loadPopulation();
          let skillsGenerated = 0;

          for (let i = 0; i < preliminaryGroups.length; i++) {
            const group = preliminaryGroups[i];
            if (group.length < minRulesForSkill) {
              log(`  Skillify group ${i+1}: ${group.length} rules < ${minRulesForSkill}, skipping`);
              continue;
            }

            log(`  Skillify group ${i+1}: ${group.length} rules, asking LLM to refine...`);

            // Build enriched summary with keywords, source, etc.
            const rulesSummary = group.map(r => {
              const source = r.source || 'unknown';
              const keywords = (r.keywords || []).slice(0, 5).join(', ');
              return `- [${r.id.slice(0,8)}] ${r.content}\n  source=${source}, score=${r.score}, stability=${r.stability || 5}, keywords=[${keywords}]`;
            }).join('\n');

            const prompt = `
这组规则已经通过结构化预聚类（同 knowledge_type + keyword 相似度 > 0.4）。
请验证分组是否合理，并生成 skill 名称和描述。

规则列表：
${rulesSummary}

当前模式：${skillMode}

任务：
1. 验证这些规则是否适合同一 skill（如果不适合，返回 should_generate=false）
2. 如果适合，生成 skill 名称（英文，用于文件名）和描述（中文）
3. 确认 rule_ids 列表

返回 JSON（不要 markdown 代码块）:
{
  "should_generate": true/false,
  "skill": {
    "name": "skill 名称（英文，如 writing-methodology）",
    "description": "描述（中文）",
    "rule_ids": ["rule_id_1", "rule_id_2"]
  },
  "reason": "验证理由"
}
`;

            const result = await llmBrain.askClaudeWithRetry(prompt, 30000, 'smart', 1);
            let parsed;
            try {
              parsed = JSON.parse(result.content || result);
            } catch {
              const jsonMatch = (result.content || result).match(/\{[\s\S]*?\}/);
              if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
              } else {
                throw new Error('Failed to parse LLM response');
              }
            }

            if (parsed.should_generate && parsed.skill && parsed.skill.rule_ids) {
              const skill = parsed.skill;
              const skillRuleIds = skill.rule_ids || [];

              // P7: Validate rule_ids
              const validRuleIds = skillRuleIds.filter(id => {
                const exists = group.find(r => r.id === id);
                if (!exists) {
                  log(`    Drop unknown id ${id}`);
                  return false;
                }
                return true;
              });

              if (validRuleIds.length < minRulesForSkill) {
                log(`    Skill "${skill.name}": ${validRuleIds.length} valid rules < ${minRulesForSkill}, skipping`);
                continue;
              }

              log(`  Skill "${skill.name}": ${validRuleIds.length} rules → methodology`);
              log(`    Reason: ${parsed.reason || 'no reason given'}`);

              for (const ruleId of validRuleIds) {
                const popRule = data.population.find(x => x.id === ruleId);
                if (popRule) {
                  const oldComplexity = popRule.complexity || 'simple';
                  popRule.complexity = 'methodology';
                  popRule.skill_name = skill.name;
                  popRule.skill_description = skill.description;
                  sessionRuleIds.add(ruleId);
                  log(`    Promoted ${ruleId.slice(0,12)}: ${oldComplexity} → methodology (${skill.name})`);
                }
              }
              skillsGenerated++;
            } else {
              log(`    LLM decided not to generate skill for this group`);
              log(`    Reason: ${parsed.reason || 'no reason given'}`);
            }
          }

          ruleEngine.savePopulation(data);
          log(`  Skillify: ${skillsGenerated} skill(s) generated from ${preliminaryGroups.length} groups`);
        } catch (err) {
          log(`  Skillify LLM error: ${err.message}, using deterministic fallback`);

          // P5: Deterministic fallback using clusterByStructure
          const data = ruleEngine.loadPopulation();
          for (const group of preliminaryGroups) {
            if (group.length < minRulesForSkill) continue;
            const skillName = group[0].knowledge_type || 'methodology';
            log(`  Fallback skill "${skillName}": ${group.length} rules`);
            for (const r of group) {
              const popRule = data.population.find(x => x.id === r.id);
              if (popRule) {
                popRule.complexity = 'methodology';
                popRule.skill_name = skillName;
                popRule.skill_description = `Auto-generated from ${group.length} rules`;
                sessionRuleIds.add(r.id);
              }
            }
          }
          ruleEngine.savePopulation(data);
        }
      }
    }
  }

  // --- Fix 4: Auto-dedup when rules pile up, regardless of which gene ran ---
  if (gene !== 'cleanup') {
    const postGeneActive = ruleEngine.getActiveRules(project);
    if (postGeneActive.length >= 6) {
      // Quick keyword-based dedup: if two rules share >50% keywords, demote the lower-scored one
      const data = ruleEngine.loadPopulation();
      let deduped = 0;
      const seen = new Set();
      for (let i = 0; i < postGeneActive.length; i++) {
        if (seen.has(postGeneActive[i].id)) continue;
        for (let j = i + 1; j < postGeneActive.length; j++) {
          if (seen.has(postGeneActive[j].id)) continue;
          const sim = ruleEngine.jaccardSimilarity(
            postGeneActive[i].keywords || [], postGeneActive[j].keywords || []
          );
          if (sim > 0.5) {
            // Demote the lower-scored duplicate
            const loser = (postGeneActive[i].score || 0) >= (postGeneActive[j].score || 0)
              ? postGeneActive[j] : postGeneActive[i];
            const pop = data.population.find(x => x.id === loser.id);
            if (pop && pop.status === 'active') {
              pop.status = 'dormant';
              pop.dormant_since_session = ruleEngine.loadPopulation().session_count || 0;
              seen.add(loser.id);
              deduped++;
              log(`  Auto-dedup: demoted "${loser.content.slice(0, 40)}" (sim=${sim.toFixed(2)})`);
            }
          }
        }
      }
      if (deduped > 0) ruleEngine.savePopulation(data);
    }
  }

  // gene === 'observe' → no LLM calls, just record

  // --- brain-evolve: harvest gene (cognitive model detection) ---
  if (gene === 'harvest') {
    try {
      const cognitiveModel = require('./cognitiveModel');
      const userTranscript = (observations || []).map(o => o.input || '').join(' ');
      const detected = cognitiveModel.detectPatterns(observations || [], userTranscript);

      // Track match quality for vector DB alert
      const allPatterns = cognitiveModel.getAllPatterns();
      for (const [pid, pdef] of Object.entries(allPatterns)) {
        const wasDetected = detected.find(d => d.pattern_id === pid);
        cognitiveModel.recordMatchQuality({
          detected: !!wasDetected,
          signalCount: wasDetected ? wasDetected.signal_count : 0,
          totalSignals: pdef.signals.length,
          patternId: pid,
        });
      }

      // Log match quality report
      const report = cognitiveModel.getMatchQualityReport();
      if (report.totalSessions >= 3) {
        log(`  Match quality: detection=${(report.detectionRate * 100).toFixed(0)}% signal=${(report.signalHitRate * 100).toFixed(0)}% → ${report.recommendation}`);
      }

      if (detected.length > 0) {
        log(`  Harvest: detected ${detected.length} behavioral patterns`);
        for (const p of detected) {
          const ruleContent = `${p.pattern_name}: ${p.matched_signals.join(', ')}`;
          const keywords = p.matched_signals || [];

          if (ruleEngine.isDuplicate(project, keywords)) {
            log(`  Skip pattern (dup): ${p.pattern_name}`);
            // But still record feedback — pattern was observed again (success for existing rule)
            const data = ruleEngine.loadPopulation();
            const existing = data.population.find(r =>
              r.project === project &&
              r.knowledge_type === 'behavioral_pattern' &&
              r.content && r.content.includes(p.pattern_name)
            );
            if (existing) {
              ruleEngine.recordFeedback(project, existing.id, 'success', { softSignal: true });
              log(`  Feedback: success for ${existing.id.slice(0, 12)} (${p.pattern_name})`);
            }
            continue;
          }

          const status = stats.active < ruleEngine.MAX_ACTIVE ? 'active' : 'candidate';
          const added = ruleEngine.addRule(
            project, ruleContent, 'cognitive_model', keywords, status, 'compound', 'behavioral_pattern'
          );
          sessionRuleIds.add(added.id);
          rulesAdded++;
          log(`  Harvested [${p.pattern_name}] signals=${p.signal_count} as ${status}: "${ruleContent.slice(0, 60)}"`);
        }
      } else {
        log('  Harvest: no patterns detected');
      }
    } catch (err) { log(`  Harvest error: ${err.message}`); }
  }

  // --- Validate (only if we changed something) ---
  if (rulesAdded > 0 || gene === 'optimize' || gene === 'cleanup' || gene === 'skillify' || gene === 'harvest') {
    // Quick validation: check the final active set isn't self-contradictory
    const finalActive = ruleEngine.getActiveRules(project);
    if (finalActive.length > 0 && handWrittenContent) {
      for (const rule of finalActive) {
        const conflict = ruleEngine.detectConflict(rule.content, handWrittenContent);
        if (conflict.hasConflict) {
          log(`  Validate: conflict detected for ${rule.id}, demoting`);
          const data = ruleEngine.loadPopulation();
          const r = data.population.find(x => x.id === rule.id);
          if (r) {
            r.status = 'dormant';
            ruleEngine.addConflict(project, rule.content, conflict.conflictsWith, conflict.similarity);
          }
          ruleEngine.savePopulation(data);
        }
      }
    }
  }

  // --- P2 fix: Heuristic scoring every session (no LLM call, no timeout risk) ---
  // For each active rule, check if any observation's input/output contains rule keywords.
  // If keywords appear in this session's observations → score up. If absent → neutral.
  // This is fast (pure JS, no LLM) and ensures scores accumulate naturally.
  // Skip if optimize gene already ran this session (to avoid double scoring)
  if (!optimizeRanThisSession && observations && observations.length >= 3) {
    const scorableRules = ruleEngine.getActiveRules(project);
    if (scorableRules.length > 0) {
      const obsText = observations.map(o => `${o.input || ''} ${o.output || ''}`).join(' ').toLowerCase();
      const data = ruleEngine.loadPopulation();
      let scored = 0;

      for (const rule of scorableRules) {
        const pop = data.population.find(x => x.id === rule.id);
        if (!pop) continue;

        // Count how many of the rule's keywords appear in session observations
        const kw = (rule.keywords || []);
        const hits = kw.filter(k => obsText.includes(k.toLowerCase())).length;
        const hitRatio = kw.length > 0 ? hits / kw.length : 0;

        // Score: 8 if strong match (>60% keywords), 6 if partial (>30%), 5 if no match
        let sessionScore = 5;
        if (hitRatio > 0.6) sessionScore = 8;
        else if (hitRatio > 0.3) sessionScore = 6;

        // EMA: 30% new, 70% old
        const alpha = 0.3;
        const oldScore = pop.score || 5;
        pop.score = parseFloat((oldScore * (1 - alpha) + sessionScore * alpha).toFixed(1));
        pop.relevance_count = (pop.relevance_count || 0) + 1;
        pop.sessions_evaluated = (pop.sessions_evaluated || 0) + 1;

        if (Math.abs(pop.score - oldScore) > 0.2) scored++;
      }

      ruleEngine.savePopulation(data);
      if (scored > 0) log(`Heuristic-score: ${scored} rules updated`);
    }
  }

  // --- Solidify: classify complexity + route output ---
  const finalActive = ruleEngine.getActiveRules(project);

  // Classify complexity for rules born/modified this session only
  if (sessionRuleIds.size > 0) {
    const data = ruleEngine.loadPopulation();
    let classified = 0;
    for (const rule of data.population) {
      if (!sessionRuleIds.has(rule.id)) continue;
      // Skip rules that already have a complexity field
      if (rule.complexity) continue;
      try {
        rule.complexity = llmBrain.classifyComplexity(rule, finalActive, pending.projectType || '');
        classified++;
        log(`  Classified ${rule.id.slice(0, 12)}: ${rule.complexity}`);
      } catch (err) {
        rule.complexity = 'simple'; // safe fallback
        log(`  Classify error for ${rule.id.slice(0, 12)}: ${err.message}, defaulting to simple`);
      }
    }
    if (classified > 0) ruleEngine.savePopulation(data);
  }

  // Partition rules: methodology → skillWriter, others → claudeMdWriter
  let skillWriter;
  try { skillWriter = require('./skillWriter'); } catch { skillWriter = null; }

  const methodologyRules = finalActive.filter(r => r.complexity === 'methodology');
  const otherRules = finalActive.filter(r => r.complexity !== 'methodology');

  // brain-evolve: Group methodology rules by skill_name for separate skill files
  const methodologyBySkill = {};
  for (const r of methodologyRules) {
    const skillName = r.skill_name || 'general-methodology';
    if (!methodologyBySkill[skillName]) methodologyBySkill[skillName] = [];
    methodologyBySkill[skillName].push(r);
  }

  // P4: Auto-learn — regenerate skill when rules change (new rules born, scores shift)
  // A skill should always reflect the LATEST state of the methodology.
  // P3: Track which skills need regeneration (only those whose rules changed)
  const changedSkillNames = new Set();
  for (const id of sessionRuleIds) {
    const r = finalActive.find(x => x.id === id);
    if (r && r.skill_name) changedSkillNames.add(r.skill_name);
  }
  // New methodology rules (no skill_name yet) also trigger skillify (already ran above)
  const newMethodologyRules = methodologyRules.filter(r => !r.skill_name);
  const shouldRunSkillify = gene === 'skillify' || newMethodologyRules.length > 0;

  if (skillWriter && Object.keys(methodologyBySkill).length > 0) {
    try {
      let allMemories = [];
      let sessionNarratives = [];
      try {
        const memoryReader = require('./memoryReader');
        allMemories = memoryReader.getAllMemories(project);
      } catch {}
      try {
        const narrativePath = path.join(DATA_DIR, 'narrative.jsonl');
        if (fs.existsSync(narrativePath)) {
          sessionNarratives = fs.readFileSync(narrativePath, 'utf8').trim().split('\n')
            .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        }
      } catch {}

      // Regenerate only affected skills
      let skillsRegenerated = 0;
      for (const [skillName, rules] of Object.entries(methodologyBySkill)) {
        if (rules.length === 0) continue;

        // P3: Skip if this skill's rules didn't change and skillify didn't run
        const skillChanged = changedSkillNames.has(skillName);
        if (!skillChanged && !shouldRunSkillify && rulesAdded === 0) {
          log(`  Skill "${skillName}": no change, skipping regen`);
          continue;
        }

        // P4: Separate patterns from anti_patterns for better skill generation
        const patterns = rules.filter(r => r.source !== 'anti_pattern');
        const antiPatterns = rules.filter(r => r.source === 'anti_pattern');

        const primary = patterns[0] || rules[0];
        const related = patterns.slice(1);
        const description = primary.skill_description || '';
        log(`  Skill "${skillName}": ${patterns.length} patterns + ${antiPatterns.length} anti-patterns, regenerating...`);
        const result = skillWriter.writeSkill(project, primary, related, pending.projectType || '', allMemories, sessionNarratives, description, antiPatterns);
        if (result && result.written) {
          log(`    Skill file: ${result.path}`);
          skillsRegenerated++;
        } else if (result) {
          log(`    Skill skipped: ${result.reason || 'unknown'}`);
        }
      }

      if (skillsRegenerated > 0) {
        log(`Skill auto-update: regenerated ${skillsRegenerated}/${Object.keys(methodologyBySkill).length} skill(s)`);
      } else {
        log(`Skills unchanged (no affected skills this session)`);
      }
      log(`Solidified: ${methodologyRules.length} methodology rules → ${Object.keys(methodologyBySkill).length} skill(s)`);
    } catch (err) {
      log(`skillWriter error: ${err.message}, falling back to claudeMdWriter`);
      otherRules.push(...methodologyRules);
    }
    // Build skill routes for CLAUDE.md so Claude Code knows when to use the skill
    const skillRoutes = [];
    const skillDir = path.join(project, '.claude', 'skills');
    if (fs.existsSync(skillDir)) {
      for (const f of fs.readdirSync(skillDir).filter(f => f.startsWith('auto-') && f.endsWith('.md'))) {
        const skillContent = fs.readFileSync(path.join(skillDir, f), 'utf8');
        const nameMatch = skillContent.match(/name:\s*"?([^"\n]+)"?/);
        const descMatch = skillContent.match(/description:\s*\|?\s*\n?\s*([^\n]+)/);
        const triggerMatches = [...skillContent.matchAll(/^\s+-\s*"?([^"\n]+)"?\s*$/gm)];
        skillRoutes.push({
          name: f.replace('.md', ''),
          description: (descMatch ? descMatch[1].trim() : 'Auto-generated skill'),
          triggers: triggerMatches.slice(0, 5).map(m => m[1].trim()),
        });
      }
    }
    const writtenPath = claudeMdWriter.writeRulesToClaudeMd(project, otherRules, skillRoutes);
    log(`Solidified: ${otherRules.length} rules + ${skillRoutes.length} skill routes → ${writtenPath || 'CLAUDE.md'}`);
  } else {
    const writtenPath = claudeMdWriter.writeRulesToClaudeMd(project, finalActive);
    log(`Solidified: ${finalActive.length} rules → ${writtenPath || 'CLAUDE.md'}`);
  }

  // --- Skill hints + cross-project store (extracted to modules) ---
  const skillHints = require('./skillHints');
  const crossProjectStore = require('./crossProjectStore');
  skillHints.updateHints(methodologyRules, log);
  crossProjectStore.savePatterns(project, finalActive, (pending && pending.projectType) || 'general', log);

  // --- Session memory ---
  try {
    const sessionMemory = require('./sessionMemory');
    const sessionId = sessionMemory.generateSessionId();

    if (observations && observations.length >= 3) {
      const compressResult = llmBrain.compressSession(observations, newMemories, []);
      if (compressResult && compressResult.summary) {
        sessionMemory.writeSession(sessionId, compressResult, observations, {
          project, toolCalls: observations.length, strategy: gene, rulesAdded, rulesPruned: 0,
        });
        sessionMemory.appendIndex(sessionId,
          compressResult.index_line || compressResult.summary.split('\n')[0].slice(0, 100),
          observations.length, path.basename(project));
        log(`Memory: ${sessionId}`);
      }
    }
  } catch (err) { log(`Memory error: ${err.message}`); }

  // --- Log ---
  const finalStats = ruleEngine.getPopulationStats(project);
  ruleEngine.logChange({
    action: 'session_complete', project, gene, complexity,
    session: sessionCount,
    rules_born: rulesAdded, conflicts: conflictsFound,
    population: finalStats,
  });

  try { fs.unlinkSync(pendingFile); } catch {}

  log(`Done [${gene}]: session=${sessionCount} born=${rulesAdded} active=${finalStats.active} dormant=${finalStats.dormant}`);
}

main().catch(err => { log(`FATAL: ${err.stack || err.message || err}`); });
