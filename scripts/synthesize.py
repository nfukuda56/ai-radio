#!/usr/bin/env python3
"""
AIラジオ 音声合成ジョブ（GitHub Actions 用）

1. 保存期間を過ぎた回の音声を削除し status=archived にする
2. status=pending の回を1件ずつ取り出し（radio_claim_next）、VOICEVOX で合成
3. ffmpeg で MP3 に連結して Supabase Storage へ上げ、status=ready にする
   失敗した回は status=failed と error を記録する

環境変数:
  SUPABASE_URL                 例: https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY    サービスキー（GitHub Secrets から渡す）
  VOICEVOX_URL                 既定: http://localhost:50021
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
import wave
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CAST = json.loads((ROOT / "cast.json").read_text(encoding="utf-8"))

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
VOICEVOX_URL = os.environ.get("VOICEVOX_URL", "http://localhost:50021").rstrip("/")
BUCKET = "radio"
JST = timezone(timedelta(hours=9))

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
}


# ── Supabase ────────────────────────────────────────────────
def rest(method, path, **kw):
    r = requests.request(method, f"{SUPABASE_URL}/rest/v1/{path}", headers=HEADERS, timeout=60, **kw)
    r.raise_for_status()
    return r.json() if r.text else None


def update_episode(ep_id, fields):
    requests.patch(
        f"{SUPABASE_URL}/rest/v1/radio_episodes",
        params={"id": f"eq.{ep_id}"},
        headers={**HEADERS, "Prefer": "return=minimal"},
        json=fields, timeout=60,
    ).raise_for_status()


def upload_audio(path_in_bucket, mp3_path):
    with open(mp3_path, "rb") as f:
        r = requests.post(
            f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path_in_bucket}",
            headers={"apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY,
                     "Content-Type": "audio/mpeg", "x-upsert": "true"},
            data=f, timeout=300,
        )
    r.raise_for_status()


def archive_old():
    """保存期間を過ぎた回の音声を消し、status=archived にする（台本はDBに残す）。"""
    days = CAST["program"]["retention_days"]
    cutoff = (datetime.now(JST).date() - timedelta(days=days)).isoformat()
    old = rest("GET", "radio_episodes", params={
        "select": "id,audio_path", "status": "eq.ready", "air_date": f"lt.{cutoff}"})
    paths = [e["audio_path"] for e in old if e.get("audio_path")]
    if paths:
        requests.delete(
            f"{SUPABASE_URL}/storage/v1/object/{BUCKET}",
            headers=HEADERS, json={"prefixes": paths}, timeout=60,
        ).raise_for_status()
    for e in old:
        update_episode(e["id"], {"status": "archived", "audio_path": None})
    print(f"archive: {len(old)}件（{cutoff} より前）")


# ── VOICEVOX ────────────────────────────────────────────────
def wait_engine(timeout_sec=300):
    start = time.time()
    while time.time() - start < timeout_sec:
        try:
            if requests.get(f"{VOICEVOX_URL}/version", timeout=5).ok:
                return
        except requests.RequestException:
            pass
        time.sleep(3)
    raise RuntimeError("VOICEVOX ENGINE が起動しません")


def resolve_speakers():
    """cast.json のキャラ名・スタイル名から話者IDを引く。"""
    speakers = requests.get(f"{VOICEVOX_URL}/speakers", timeout=30).json()
    table = {}
    for member in CAST["cast"]:
        want = member["voicevox"]
        sid = next((st["id"] for sp in speakers if sp["name"] == want["speaker"]
                    for st in sp["styles"] if st["name"] == want["style"]), None)
        if sid is None:
            names = ", ".join(sp["name"] for sp in speakers)
            raise RuntimeError(f"話者が見つかりません: {want}（利用可能: {names}）")
        table[member["id"]] = (sid, member.get("tuning", {}))
        print(f"speaker {member['id']}: {want['speaker']}/{want['style']} → id {sid}")
    return table


def synth_line(text, speaker_id, tuning, sr):
    q = requests.post(f"{VOICEVOX_URL}/audio_query",
                      params={"text": text, "speaker": speaker_id}, timeout=120)
    q.raise_for_status()
    query = q.json()
    query.update(tuning)
    query["outputSamplingRate"] = sr
    query["outputStereo"] = False
    s = requests.post(f"{VOICEVOX_URL}/synthesis", params={"speaker": speaker_id},
                      json=query, timeout=300)
    s.raise_for_status()
    return s.content


def write_silence(path, sec, sr):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00" * int(sr * sec))


def wav_seconds(path):
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


# ── 1回分の処理 ─────────────────────────────────────────────
def process(ep, speakers):
    audio = CAST["audio"]
    sr = audio["sampling_rate"]
    lines = ep["script"]["lines"]
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gap, sgap = tmp / "gap.wav", tmp / "sgap.wav"
        write_silence(gap, audio["gap_sec"], sr)
        write_silence(sgap, audio["section_gap_sec"], sr)

        parts, total = [], 0.0
        t0 = time.time()
        for i, line in enumerate(lines):
            if line["speaker"] not in speakers:
                raise RuntimeError(f"{i}行目: 未知の話者 {line['speaker']}")
            text = line["text"].strip()
            if not text:
                continue
            sid, tuning = speakers[line["speaker"]]
            wav = tmp / f"{i:04d}.wav"
            wav.write_bytes(synth_line(text, sid, tuning, sr))
            if parts:
                pad = sgap if line.get("section") else gap
                parts.append(pad)
                total += wav_seconds(pad)
            parts.append(wav)
            total += wav_seconds(wav)
            if i % 20 == 0:
                print(f"  {i + 1}/{len(lines)} 行（{time.time() - t0:.0f}秒経過）", flush=True)

        listing = tmp / "list.txt"
        listing.write_text("".join(f"file '{p}'\n" for p in parts), encoding="utf-8")
        mp3 = tmp / "out.mp3"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "concat", "-safe", "0", "-i", str(listing),
             "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", str(sr),
             "-ac", "1", "-c:a", "libmp3lame", "-b:a", audio["bitrate"], str(mp3)],
            check=True,
        )
        air = ep["air_date"]
        path = f"{air[:4]}/{air}-{ep['id'][:8]}.mp3"
        upload_audio(path, mp3)
        size_mb = mp3.stat().st_size / 1048576
        print(f"  合成 {time.time() - t0:.0f}秒 / 長さ {total / 60:.1f}分 / {size_mb:.1f}MB → {path}")

    update_episode(ep["id"], {"status": "ready", "audio_path": path,
                              "duration_sec": round(total), "error": None})


def main():
    archive_old()
    wait_engine()
    speakers = resolve_speakers()
    done = failed = 0
    while True:
        claimed = rest("POST", "rpc/radio_claim_next", json={})
        if not claimed:
            break
        ep = claimed[0]
        print(f"処理開始: {ep['air_date']} {ep['title']} ({len(ep['script']['lines'])}行)")
        try:
            process(ep, speakers)
            done += 1
        except Exception as e:
            traceback.print_exc()
            update_episode(ep["id"], {"status": "failed", "error": f"{type(e).__name__}: {e}"[:2000]})
            failed += 1
    print(f"完了: 成功 {done} / 失敗 {failed}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
