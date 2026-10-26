# AIラジオ「モーニング・シグナル」

毎朝 6:15 に、その日のニュースを2人の出演者（ミオ／タクミ）が約30分語る番組を自動生成する。

| 工程 | 担当 | ファイル |
| --- | --- | --- |
| 台本生成 | Claude スケジュールタスク（毎朝 4:51 JST） | `prompts/daily_script.md` |
| 受け渡し・保管 | Supabase `radio_episodes` テーブル / `radio` バケット | — |
| 音声合成 | GitHub Actions + VOICEVOX ENGINE（CPU） | `.github/workflows/synthesize.yml`, `scripts/synthesize.py` |
| 出演者・声 | 設定 | `cast.json` |
| 再生 | GitHub Pages の PWA | （フェーズ5） |

## 必要な Secrets（Settings → Secrets and variables → Actions）

- `SUPABASE_URL`：`https://lvmgfolwipwgyhhzskvj.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY`：Supabase の service_role キー（絶対にコードに書かない）

## 保存期間

音声は7日で削除し、`status=archived` にする（台本はDBに残る）。合成ジョブの最初に毎回実行される。

## クレジット

音声：VOICEVOX:冥鳴ひまり、VOICEVOX:白上虎太郎
