#!/usr/bin/env python3
"""Récupère des phrases FLEURS pour la page « Écouter le rythme ».

Le script :
  1. télécharge les métadonnées (fichiers .tsv) de chaque langue demandée ;
  2. choisit N phrases présentes dans toutes ces langues, les plus courtes en priorité ;
  3. lit l'archive audio de chaque langue en flux et n'en extrait que les fichiers choisis ;
  4. convertit chaque fichier en MP3 mono 16 kHz (ffmpeg doit être installé) ;
  5. réécrit data/clips.json.

Les langues déjà décrites dans data/clips.json gardent leur nom et leur classe.
Les langues d'un autre corpus ("source" différente de "fleurs", comme l'arabe
marocain de DVoice) sont conservées telles quelles, avec leurs enregistrements.
Une nouvelle langue est ajoutée avec cls = "?" : complétez-la à la main
("syl" = iso-syllabique, "str" = iso-accentuelle).

Exemple, depuis le dossier du site :
    python3 tools/fetch_fleurs.py --langs fr_fr es_419 it_it en_us de_de nl_nl ar_eg --n 10

Codes de langue FLEURS : https://huggingface.co/datasets/google/fleurs
Licence des données : CC BY 4.0 (citer Conneau et al., 2022).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import statistics
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

BASE = "https://huggingface.co/datasets/google/fleurs/resolve/main/data"


def read_tsv(lang: str, split: str) -> dict[str, list[dict]]:
    url = f"{BASE}/{lang}/{split}.tsv"
    raw = urllib.request.urlopen(url, timeout=120).read().decode("utf-8")
    rows: dict[str, list[dict]] = {}
    for r in csv.reader(io.StringIO(raw), delimiter="\t", quoting=csv.QUOTE_NONE):
        rows.setdefault(r[0], []).append(
            {"file": r[1], "text": r[2], "dur": int(r[5]) / 16000, "gender": r[6]}
        )
    return rows


def pick(recs: list[dict]) -> dict:
    """Enregistrement de durée médiane (le plus court en cas d'égalité)."""
    med = statistics.median(r["dur"] for r in recs)
    return min(recs, key=lambda r: (abs(r["dur"] - med), r["dur"]))


def extract(lang: str, split: str, wanted: dict[str, str], tmp: Path) -> None:
    """Lit l'archive en flux et n'écrit que les fichiers voulus (nom -> id de phrase)."""
    url = f"{BASE}/{lang}/audio/{split}.tar.gz"
    found = 0
    with urllib.request.urlopen(url, timeout=300) as resp, tarfile.open(fileobj=resp, mode="r|gz") as tf:
        for m in tf:
            name = os.path.basename(m.name)
            if m.isfile() and name in wanted:
                (tmp / f"{lang}_{wanted[name]}.wav").write_bytes(tf.extractfile(m).read())
                found += 1
                if found == len(wanted):
                    break
    print(f"  {lang} : {found}/{len(wanted)} fichiers extraits")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--langs", nargs="+", required=True, help="codes FLEURS, ex. fr_fr en_us ar_eg")
    ap.add_argument("--n", type=int, default=10, help="nombre de phrases par langue")
    ap.add_argument("--split", default="dev", choices=["dev", "test", "train"], help="partition FLEURS (dev = la plus petite)")
    ap.add_argument("--min-dur", type=float, default=3.5, help="durée minimale d'un enregistrement (s)")
    ap.add_argument("--site", default=".", help="dossier du site (contient audio/ et data/)")
    args = ap.parse_args()

    site = Path(args.site)
    audio_dir, cat_path = site / "audio", site / "data" / "clips.json"
    audio_dir.mkdir(parents=True, exist_ok=True)
    old = json.loads(cat_path.read_text(encoding="utf-8")) if cat_path.exists() else {}
    known = {l["code"]: l for l in old.get("languages", [])}

    print("Métadonnées…")
    meta = {l: read_tsv(l, args.split) for l in args.langs}
    common = set.intersection(*(set(m) for m in meta.values()))
    cands = []
    for sid in common:
        chosen = {l: pick(meta[l][sid]) for l in args.langs}
        durs = [c["dur"] for c in chosen.values()]
        if min(durs) >= args.min_dur:
            cands.append((max(durs), sid, chosen))
    cands.sort(key=lambda t: t[0])
    sel = cands[: args.n]
    if len(sel) < args.n:
        print(f"Attention : seulement {len(sel)} phrases communes trouvées.", file=sys.stderr)

    print(f"{len(sel)} phrases choisies. Extraction audio (peut prendre quelques minutes)…")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for lang in args.langs:
            wanted = {ch[lang]["file"]: sid for _, sid, ch in sel}
            extract(lang, args.split, wanted, tmp)
        for wav in sorted(tmp.glob("*.wav")):
            out = audio_dir / (wav.stem + ".mp3")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-ac", "1", "-ar", "16000", "-b:a", "48k", str(out)], check=True)

    languages = [known.get(l, {"code": l, "name": l, "short": l[:2].upper(), "cls": "?", "source": "fleurs"}) for l in args.langs]
    kept = [l for l in old.get("languages", []) if l.get("source", "fleurs") != "fleurs" and l["code"] not in args.langs]
    kept_codes = {l["code"] for l in kept}
    languages += kept
    sentences = [{"id": sid, "en": ch.get("en_us", next(iter(ch.values())))["text"]} for _, sid, ch in sel]
    clips = [
        {"id": f"{l}_{sid}", "lang": l, "sent": sid, "text": ch[l]["text"], "gender": ch[l]["gender"], "file": f"audio/{l}_{sid}.mp3"}
        for _, sid, ch in sel for l in args.langs
    ] + [c for c in old.get("clips", []) if c["lang"] in kept_codes]
    cat = {"_aide": old.get("_aide", ""), "languages": languages, "sentences": sentences, "clips": clips}
    cat_path.parent.mkdir(parents=True, exist_ok=True)
    cat_path.write_text(json.dumps(cat, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Écrit : {cat_path} ({len(clips)} enregistrements).")
    todo = [l["code"] for l in languages if l["cls"] == "?"]
    if todo:
        print("À compléter dans data/clips.json (name, short, cls) pour :", ", ".join(todo))
    print("Les anciens MP3 qui ne sont plus listés restent dans audio/ : supprimez-les si besoin.")


if __name__ == "__main__":
    main()
