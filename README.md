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
