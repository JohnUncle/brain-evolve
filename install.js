#!/usr/bin/env node
/**
 * brain-evolve install — 注册 hooks 到 Claude Code settings
 *
 * Usage: node install.js [--uninstall]
 *
 * 与 claude-mem 共存：
 *   - brain-evolve 使用 SessionStart + PostToolUse + Stop
 *   - claude-mem 使用 PostToolUse + Stop + SessionEnd
 *   - 两者可以共存于同一 hook 事件，Claude Code 会依次执行
 */

const fs = require('fs');
const path = require('path');

const BRAIN_EVOLVE_ROOT = path.join(__dirname);
const HOOKS_ROOT = path.join(BRAIN_EVOLVE_ROOT, 'learning', 'hooks');
const SETTINGS_PATH = path.join(process.env.HOME, '.claude', 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  const dir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

function makeHookCommand(scriptName) {
  return `node "${path.join(HOOKS_ROOT, scriptName)}"`;
}

const HOOK_DEFINITIONS = {
  SessionStart: {
    matcher: 'startup|clear|compact|resume',
    script: 'session-start.js',
    timeout: 10,
  },
  PostToolUse: {
    matcher: '*',
    script: 'post-tool.js',
    timeout: 2,
  },
  Stop: {
    matcher: '',
    script: 'session-end.js',
    timeout: 15,
  },
};

function install() {
  const settings = loadSettings();
  if (!settings.hooks) settings.hooks = {};

  let hooksAdded = 0;

  for (const [event, def] of Object.entries(HOOK_DEFINITIONS)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Check if brain-evolve hook already exists
    const existing = settings.hooks[event].find(h =>
      h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('brain-evolve'))
    );
    if (existing) {
      console.log(`  ⚠️  ${event}: already installed, skipping`);
      continue;
    }

    // Find existing matcher group or create new one
    let matcherGroup = def.matcher
      ? settings.hooks[event].find(h => h.matcher === def.matcher)
      : settings.hooks[event].find(h => !h.matcher || h.matcher === '*');

    if (!matcherGroup) {
      matcherGroup = { hooks: [] };
      if (def.matcher) matcherGroup.matcher = def.matcher;
      settings.hooks[event].push(matcherGroup);
    }

    const hookEntry = {
      type: 'command',
      command: makeHookCommand(def.script),
      timeout: def.timeout,
    };

    matcherGroup.hooks.push(hookEntry);
    hooksAdded++;
    console.log(`  ✅ ${event}: added ${def.script}`);
  }

  saveSettings(settings);
  console.log(`\n✅ brain-evolve installed (${hooksAdded} hooks added)`);
  console.log(`   Settings: ${SETTINGS_PATH}`);
  console.log(`   Restart Claude Code to activate.`);

  if (hooksAdded === 0) {
    console.log('\n⚠️  No new hooks added — already installed.');
  }
}

function uninstall() {
  const settings = loadSettings();
  if (!settings.hooks) {
    console.log('No hooks to uninstall.');
    return;
  }

  let hooksRemoved = 0;

  for (const event of Object.keys(HOOK_DEFINITIONS)) {
    if (!settings.hooks[event]) continue;

    // Remove brain-evolve hooks
    settings.hooks[event] = settings.hooks[event].map(group => {
      if (!group.hooks) return group;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter(h =>
        !(h.command && h.command.includes('brain-evolve'))
      );
      hooksRemoved += before - group.hooks.length;
      return group;
    }).filter(group => group.hooks && group.hooks.length > 0);

    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }

  saveSettings(settings);
  console.log(`✅ brain-evolve uninstalled (${hooksRemoved} hooks removed)`);
  console.log(`   Restart Claude Code to deactivate.`);
}

// ─── Main ───────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--uninstall')) {
  console.log('Uninstalling brain-evolve hooks...');
  uninstall();
} else {
  console.log('Installing brain-evolve hooks...');
  install();
}
