# AIラジオ「モーニング・シグナル」

毎朝 6:15 に、その日のニュースを2人の出演者（ミオ／タクミ）が約30分語る番組を自動生成する。

| 工程 | 担当 | ファイル |
| --- | --- | --- |
| 台本生成 | Claude スケジュールタスク（毎朝 4:51 JST） | `prompts/daily_script.md` |
| 受け渡し・保管 | Supabase `radio_episodes` テーブル / `radio` バケット | — |
| 音声合成 | GitHub Actions + VOICEVOX ENGINE（CPU） | `.github/workflows/synthesize.yml`, `scripts/synthesize.py` |
| 出演者・声 | 設定 | `cast.json` |
| 再生 | GitHub Pages の PWA | `web/`, `.github/workflows/pages.yml` |

## 必要な Secrets（Settings → Secrets and variables → Actions）

- `SUPABASE_URL`：`https://lvmgfolwipwgyhhzskvj.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`：Supabase の service_role キー（絶対にコードに書かない）

## 工程の連結

- 台本タスクが `radio_episodes` に `pending` で登録すると、DBトリガー `radio_episodes_dispatch` が pg_net で GitHub の `repository_dispatch`（`synthesize`）を送り、合成ジョブが即時に起動する（`supabase/migrations/`）
- 予備として 5:32 / 5:52 JST の定時起動もある。GitHub の定時起動は遅れたり飛ばされたりするので、即時起動が本線
- 台本タスクの日付は必ず SQL の `(now() at time zone 'Asia/Tokyo')::date` で決める。クラウド環境の時計は UTC で、日本時間の早朝は前日になるため（2026-10-27 の取りこぼしの原因）

### 即時起動のトークン（初回だけ）

1. GitHub → Settings → Developer settings → Fine-grained tokens で新規作成。Repository access は `nfukuda56/ai-radio` のみ、Permissions は **Contents: Read and write** だけ（`repository_dispatch` に必要）。有効期限は任意
2. Supabase の SQL Editor で次を実行（トークンはここにだけ貼る。コードやチャットには書かない）

```sql
select vault.create_secret('<トークン>', 'radio_github_token', 'ai-radio repository_dispatch');
-- 更新するとき：select vault.update_secret((select id from vault.secrets where name='radio_github_token'), '<新しいトークン>');
```

未設定でも台本の登録は失敗せず、定時起動で処理される。

## 再生ページ（web/）

最新の `status=ready` の回（【テスト】を除く）を再生する PWA。`?date=YYYY-MM-DD` で日付を指定できる。

- 字幕：再生位置に合わせて行をハイライト。行を押すとその場面から再生。行ごとの開始秒は合成時に `line_starts` 列へ保存する（ない回は文字数から推定）
- 再生速度（0.75〜2倍）と続きからの再生は、端末のブラウザに保存
- 各話題の出典リンクと「この話題から聞く」
- ロック画面の操作（Media Session）、ホーム画面への追加（manifest / Service Worker）
- `config.js` には publishable キーだけを置く。RLS で読めるのは `status=ready` の回のみ
- アイコンの PNG は `pages.yml` が `icon.svg` から生成する

初回だけ、Settings → Pages → Build and deployment の Source を「GitHub Actions」にする。公開先は `https://nfukuda56.github.io/ai-radio/`。

## 保存期間

音声は7日で削除し、`status=archived` にする（台本はDBに残る）。合成ジョブの最初に毎回実行される。

## クレジット

音声：VOICEVOX:冥鳴ひまり、VOICEVOX:白上虎太郎
