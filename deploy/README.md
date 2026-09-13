# VPSへの設置

systemd timer を使う。cron でも動くが、`Persistent=true`（VPS停止中に時刻を跨いだ場合の取りこぼし回復）が使えるので systemd を推奨。

## 前提

- リポジトリを `/opt/note` に配置
- `node` 20以上
- **`claude` CLI がVPSにインストール済みで、認証が通っていること**（ここが無いと生成段階で止まる）
- `note` ユーザーを作成し `/opt/note` の所有者にする

## 設置

```bash
sudo cp deploy/weekly-note.service deploy/weekly-note.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now weekly-note.timer
systemctl list-timers weekly-note.timer
```

## 手動で1回だけ流す（dry-run）

```bash
cd /opt/note && ./scripts/weekly-run.sh
```

## cron を使う場合

```cron
TZ=Asia/Tokyo
0 6 * * 0 cd /opt/note && ./scripts/weekly-run.sh >> note/logs/cron.log 2>&1
```

## 動作の止まり方

| 状況 | 挙動 |
|---|---|
| 実体験ストックが不足 | 記事を生成せずに正常終了（exit 0）。架空の記事は作らない |
| 成立した枠が2本未満 | 同上。週ごと見送り |
| `claude` CLI が無い/認証切れ | 生成段階で停止（exit 1）。投稿へ進まない |
| `pipeline.config.json` の `runner.command` が null | 変換・投稿を行わず停止。**現在はここで止まる** |
| runner が1本でも失敗 | その時点で停止。残りの記事は処理しない |

`Restart=no` にしてあるのは、失敗後に自動再試行すると二重生成・二重投稿の恐れがあるため。
