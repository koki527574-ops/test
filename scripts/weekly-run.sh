#!/usr/bin/env bash
# VPSから毎週自動実行される入口。人間の「今週分を作って」を置き換える。
#
# 設計上の原則:
#   - 各段階で失敗したら、その場で止める。次の段階へ進まない。
#   - 材料不足なら記事を生成しない（架空の体験で埋めない）。
#   - 投稿系の処理は既存runnerに委譲する。ここでは新しい投稿処理を持たない。
#
# 使い方:
#   scripts/weekly-run.sh            # dry-run（既定）
#   scripts/weekly-run.sh --publish  # 本番。runner設定が済むまで拒否される

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="dry-run"
SKIP_GENERATE=0
for arg in "$@"; do
  case "$arg" in
    --publish) MODE="publish" ;;
    # 生成を飛ばして配管だけ検証する（Claude呼び出しのコストをかけずに経路確認する用）
    --skip-generate) SKIP_GENERATE=1 ;;
  esac
done

STAMP="$(TZ=Asia/Tokyo date +%Y%m%d-%H%M%S)"
LOG_DIR="$ROOT/note/logs"
RUN_DIR="$ROOT/note/runs/$STAMP"
mkdir -p "$LOG_DIR" "$RUN_DIR"
LOG="$LOG_DIR/$STAMP.log"

log() { echo "[$(TZ=Asia/Tokyo date +%H:%M:%S)] $*" | tee -a "$LOG"; }
fail() { log "STOP: $*"; log "結果: 失敗（以降の処理は実行しない）"; exit 1; }

log "=== weekly-note 自動実行 (mode=$MODE) ==="

# --- 1. 材料ゲート ------------------------------------------------------
# ここで枠が立たなければ生成そのものをさせない。
log "1) 実体験ストックを検査"
set +e
node scripts/check-stock.mjs > "$RUN_DIR/plan.json" 2> "$RUN_DIR/plan.txt"
GATE=$?
set -e
cat "$RUN_DIR/plan.txt" | tee -a "$LOG"

case $GATE in
  0) log "   → 生成可能" ;;
  2) log "   → 材料不足。今週は生成しない。架空の記事は作らない。"
     log "結果: 生成なしで正常終了"
     exit 0 ;;
  *) fail "ストック検査でエラー" ;;
esac

COUNT=$(node -e "process.stdout.write(String(require('$RUN_DIR/plan.json').articleCount))")
log "   成立した枠: ${COUNT}本"

# --- 2. 記事生成（Claude Code ヘッドレス） -------------------------------
# weekly-note スキルは Claude が実行する。ここではCLIを無人で叩く。
log "2) weekly-note を実行して本文を生成"
if [[ $SKIP_GENERATE -eq 1 ]]; then
  log "   → --skip-generate のため生成を省略（配管検証モード）"
else
command -v claude >/dev/null 2>&1 || fail "claude CLI が見つからない（VPSに未インストール／未認証）"

PROMPT="週次の自動実行です。$RUN_DIR/plan.json に今週成立した枠が入っています。\
この枠だけを使って weekly-note スキルを実行し、各記事の本文を生成してください。\
plan.json の candidateExpIds に無いストックは使わないでください。\
実体験ストックに無いことは書かないでください。材料が足りない枠は飛ばしてください。\
生成結果は $RUN_DIR/ に記事ごとのファイルとして保存してください。"

if ! claude -p "$PROMPT" >> "$LOG" 2>&1; then
  fail "記事生成に失敗"
fi
log "   → 生成完了: $RUN_DIR"
fi

# --- 3. Article JSON へ変換し既存runnerへ渡す ---------------------------
# ここは既存システム側の schema / CLI に合わせる箇所。
# 未設定のまま投稿へ進むことは許さない（誤った形式で本番投稿させないため）。
log "3) Article JSON へ変換して既存runnerへ引き渡し"
CONFIG="$ROOT/note/pipeline.config.json"
[[ -f "$CONFIG" ]] || fail "pipeline.config.json が無い"

RUNNER=$(node -e "process.stdout.write(require('$CONFIG').runner.command ?? '')")
if [[ -z "$RUNNER" ]]; then
  log "   既存runnerが未設定（note/pipeline.config.json の runner.command が null）"
  log "   Article JSON の schema が不明なため、変換と引き渡しは行わない。"
  log "   生成済みの記事は $RUN_DIR に残してある。"
  fail "runner未接続のため、ここで停止"
fi

# 以降は runner.command が設定済みの場合のみ到達する。
DRY_FLAG=$(node -e "process.stdout.write(require('$CONFIG').runner.dryRunFlag ?? '')")
ARGS=()
[[ "$MODE" == "dry-run" && -n "$DRY_FLAG" ]] && ARGS+=("$DRY_FLAG")

for f in "$ROOT"/articles/*.json; do
  [[ -e "$f" ]] || continue
  log "   runner: $(basename "$f")"
  if ! $RUNNER "${ARGS[@]}" "$f" >> "$LOG" 2>&1; then
    fail "runner が $(basename "$f") で失敗。残りの記事は処理しない。"
  fi
done

log "結果: 成功 (mode=$MODE)"
