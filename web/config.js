// 公開してよい値のみ（publishable キーは RLS で「status=ready の回の読み取り」だけが許可されている）
window.RADIO_CONFIG = {
  supabaseUrl: "https://lvmgfolwipwgyhhzskvj.supabase.co",
  publishableKey: "sb_publishable_q1QSXYVIMPtuf5D7pYmcnw_oijyIXYx",
  bucket: "radio",
  // cast.json の audio と合わせる（行ごとの開始時刻がない回の推定に使う）
  gapSec: 0.35,
  sectionGapSec: 1.2,
  cast: { navi: "ミオ", host: "タクミ" },
};
