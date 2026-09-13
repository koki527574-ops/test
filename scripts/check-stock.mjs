#!/usr/bin/env node
// 実体験ストックを解析し、その週に実際に書ける記事だけを枠として確定する。
// 記事生成の前に必ず走らせる。ここで枠が立たなければ生成させない。
//
// 判定は「本数の閾値」ではなく「枠ごとに必要な材料が実在するか」で行う。
// 材料が無い枠は落とす。落とした結果が0〜1本なら週ごと停止する。
//
// 出力: 週プラン JSON (stdout) / 人間向けサマリ (stderr)
// 終了コード: 0=生成へ進む  2=材料不足で停止  1=エラー

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JST_OFFSET_MIN = 9 * 60;
const MIN_ARTICLES = 2;          // これを下回る週は生成しない
const SATURDAY_MIN_PUBLISHED = 3; // 回遊記事に必要な過去記事数

// 割り当て優先順。上から材料を取っていき、取れなければその枠を落とす。
const SLOTS = [
  { day: 'monday',    offset: 0, role: '主軸記録',     time: '21:00', needs: '大',   tier: 'base' },
  { day: 'tuesday',   offset: 1, role: '失敗記録',     time: '21:00', needs: '大',   tier: 'base' },
  { day: 'friday',    offset: 4, role: '有料本体',     time: '21:00', needs: '大',   tier: 'base', paid: true },
  { day: 'thursday',  offset: 3, role: '実践記録',     time: '21:00', needs: '中',   tier: 'base' },
  { day: 'saturday',  offset: 5, role: '再編集・回遊', time: '08:00', needs: 'なし', tier: 'base' },
  { day: 'wednesday', offset: 2, role: '短い観察',     time: '12:00', needs: '小',   tier: 'extra' },
  { day: 'sunday',    offset: 6, role: '問い',         time: '08:00', needs: '小',   tier: 'extra' },
];

const isBlank = (v) =>
  !v || /^[（(]?\s*空欄\s*[)）]?$/.test(v) || /^[-—–]$/.test(v.trim());

function parseStock(md) {
  const entries = [];
  for (const block of md.split(/^### /m).slice(1)) {
    const [head, ...rest] = block.split('\n');
    const id = (head.match(/^(EXP-\d+)/) || [])[1];
    if (!id) continue;
    const f = {};
    for (const line of rest) {
      const m = line.match(/^-\s*([^:：]+)[:：]\s*(.*)$/);
      if (m) f[m[1].trim()] = m[2].trim();
    }
    entries.push({
      id,
      label: head.replace(/^EXP-\d+\s*/, '').trim(),
      density: (f['濃さ'] || '').replace(/[^大中小]/g, ''),
      feeling: f['その時どう思ったか'] || '',
      numbers: f['数字・固有名詞'] || '',
      tags: (f['主題タグ'] || '').match(/`([^`]+)`/g)?.map((t) => t.replace(/`/g, '')) ?? [],
      used: !/未使用/.test(f['使用状況'] || '未使用'),
    });
  }
  return entries;
}

function countPublished(md) {
  return md
    .split('\n')
    .filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l)).length;
}

function jstToday() {
  const t = new Date(Date.now() + JST_OFFSET_MIN * 60_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

function nextMonday(from) {
  const d = new Date(from);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 1);
  return d;
}

const ymd = (d) => d.toISOString().slice(0, 10);

function main() {
  const stock = parseStock(readFileSync(resolve(ROOT, 'note/experience-stock.md'), 'utf8'));
  const publishedCount = countPublished(
    readFileSync(resolve(ROOT, 'note/published-index.md'), 'utf8')
  );

  const unused = stock.filter((e) => !e.used);
  // 「その時どう思ったか」が空欄の濃さ大は使えない（感情の捏造になるため）
  const blocked = unused.filter((e) => e.density === '大' && isBlank(e.feeling));
  const pools = {
    大: unused.filter((e) => e.density === '大' && !isBlank(e.feeling)),
    中: unused.filter((e) => e.density === '中'),
    小: unused.filter((e) => e.density === '小'),
  };
  const remaining = { 大: [...pools.大], 中: [...pools.中], 小: [...pools.小] };
  // 有料には「数字・固有名詞」が必須
  const paidReady = pools.大.filter((e) => !isBlank(e.numbers));

  const weekStart = nextMonday(jstToday());
  const filled = [];
  const dropped = [];

  for (const slot of SLOTS) {
    // 増量枠(水・日)は、baseの枠がすべて埋まった週だけ足す
    if (slot.tier === 'extra' && dropped.some((d) => d.tier === 'base')) {
      dropped.push({ ...slot, reason: 'baseの枠が埋まっていないため増量枠は使わない' });
      continue;
    }
    if (slot.needs === 'なし') {
      if (publishedCount < SATURDAY_MIN_PUBLISHED) {
        dropped.push({ ...slot, reason: `回遊記事には過去記事${SATURDAY_MIN_PUBLISHED}本以上が必要（現在${publishedCount}本）` });
        continue;
      }
      filled.push({ slot, candidates: [] });
      continue;
    }
    const pool = remaining[slot.needs];
    if (pool.length === 0) {
      dropped.push({ ...slot, reason: `濃さ「${slot.needs}」の未使用ストックが残っていない` });
      continue;
    }
    // 候補として濃さの合う未使用ストックを渡し、1件ぶんを枠に予約する
    const candidates = pool.map((e) => e.id);
    pool.shift();
    filled.push({ slot, candidates });
  }

  const paidPossible = paidReady.length > 0 && filled.some((f) => f.slot.paid);
  const slots = filled
    .map(({ slot, candidates }) => {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + slot.offset);
      const paid = Boolean(slot.paid) && paidPossible;
      return {
        day: slot.day,
        role: slot.role,
        requiredDensity: slot.needs,
        candidateExpIds: candidates,
        publishAt: `${ymd(d)}T${slot.time}:00+09:00`,
        paid,
        priceYen: paid ? 300 : 0,
        articleFile: `articles/${ymd(d)}-${slot.day}.json`,
      };
    })
    .sort((a, b) => a.publishAt.localeCompare(b.publishAt));

  const missing = [];
  for (const e of blocked) {
    missing.push(`${e.id}（${e.label}）: 「その時どう思ったか」が空欄のため濃さ大の枠に使えない`);
  }
  for (const d of dropped) {
    missing.push(`${d.day}（${d.role}）を見送り: ${d.reason}`);
  }
  if (filled.some((f) => f.slot.paid) && !paidPossible) {
    missing.push('金曜を無料に変更: 「数字・固有名詞」が埋まった濃さ大のストックが無い');
  }

  const stop = slots.length < MIN_ARTICLES;
  if (stop) {
    missing.push(`週の生成を停止: 成立した枠が${slots.length}本（最低${MIN_ARTICLES}本必要）`);
  }

  const plan = {
    generatedAt: new Date().toISOString(),
    weekStart: ymd(weekStart),
    articleCount: slots.length,
    paidArticleAllowed: paidPossible,
    publishedArticleCount: publishedCount,
    pools: {
      大: pools.大.map((e) => e.id),
      中: pools.中.map((e) => e.id),
      小: pools.小.map((e) => e.id),
      paidReady: paidReady.map((e) => e.id),
      blocked: blocked.map((e) => e.id),
    },
    missingMaterial: missing,
    slots,
  };

  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');

  const log = (s) => process.stderr.write(s + '\n');
  log(`週開始: ${plan.weekStart}`);
  log(`未使用ストック: 大${pools.大.length} 中${pools.中.length} 小${pools.小.length} / 有料可${paidReady.length} / 使用不可${blocked.length}`);
  log(`成立した枠: ${slots.length}本 → ${slots.map((s) => s.day).join(', ') || 'なし'}`);
  if (missing.length) {
    log('不足:');
    for (const m of missing) log(`  - ${m}`);
  }

  if (stop) {
    log('材料不足のため生成しない。架空の体験で埋めることはしない。');
    process.exit(2);
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`check-stock 失敗: ${err.message}\n`);
  process.exit(1);
}
