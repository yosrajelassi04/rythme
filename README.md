# Écouter le rythme

Page web statique qui explique le rythme des langues, ses corrélats acoustiques (%V, ΔC, Varco, PVI) et leur usage pour ancrer un attribut de BA-Lang. Les mesures sont calculées en direct dans le navigateur, sur des enregistrements FLEURS.

Le site ne dépend d'aucun service : de simples fichiers HTML, CSS, JavaScript, JSON et MP3. Seules les polices viennent de Google Fonts ; sans connexion, le navigateur utilise des polices de remplacement.

## Contenu du dossier

| Fichier | Rôle | À modifier pour… |
|---|---|---|
| `index.html` | Tout le texte de la page | changer le texte, ajouter ou retirer une section |
| `data/clips.json` | Langues, phrases et enregistrements | ajouter une langue, changer sa classe rythmique |
| `audio/*.mp3` | Les enregistrements | — (gérés par le script ci-dessous) |
| `assets/style.css` | Couleurs, polices, mise en page | changer l'apparence |
| `assets/app.js` | Segmentation, mesures, lecture, graphiques | changer l'algorithme ou les mesures |
| `tools/fetch_fleurs.py` | Récupère des phrases FLEURS | changer les langues ou le nombre de phrases |

## Voir la page sur sa machine

Le navigateur refuse de lire `data/clips.json` et les MP3 si l'on ouvre `index.html` par un double-clic. Il faut un petit serveur local. Depuis ce dossier :

```bash
python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000 dans le navigateur. Après chaque modification, il suffit de recharger la page.

## Modifier le texte

Ouvrir `index.html` dans un éditeur. Le texte est en HTML simple, les sections sont repérées par des commentaires (`<!-- 1. Le rythme -->`, etc.).

- Paragraphe : `<p>…</p>` ; gras : `<b>…</b>` ; italique : `<i>…</i>`.
- Ne pas changer les attributs `id="…"` : le code s'en sert pour placer le laboratoire et le graphique.
- Couleurs de mots-clés déjà prêtes : `<span class="tag-v">` (vocalique), `tag-c` (consonantique), `tag-syl` (iso-syllabique), `tag-str` (iso-accentuelle).

## Enregistrements choisis

Les 60 enregistrements actuels ont été **choisis d'après leurs mesures** pour illustrer les classes rythmiques (voir la section 5 de la page et la clé `_selection` de `data/clips.json`, où chaque enregistrement garde les mesures qui ont servi au choix). Ils ne sont pas représentatifs de leur langue. Relancer `tools/fetch_fleurs.py` remplace cette sélection par des phrases non choisies.

## Changer les langues ou les enregistrements

**Changer la classe ou le nom d'une langue** : modifier son entrée dans `languages` de `data/clips.json`. `cls` vaut `"syl"` (iso-syllabique) ou `"str"` (iso-accentuelle).

**Ajouter une langue ou changer le nombre de phrases** : relancer le script (ffmpeg doit être installé). Exemple avec le portugais en plus et 15 phrases par langue (l'arabe marocain, qui ne vient pas de FLEURS, est conservé) :

```bash
python3 tools/fetch_fleurs.py --langs fr_fr es_419 it_it pt_br en_us de_de --n 15
```

Le script choisit des phrases présentes dans toutes les langues demandées, n'extrait que les fichiers utiles (sans garder les archives) et réécrit `data/clips.json`. Une nouvelle langue arrive avec `"cls": "?"` : compléter `name`, `short` et `cls` à la main. Les codes de langue sont ceux de FLEURS (`fr_fr`, `pt_br`, `ru_ru`, `th_th`…).

**Enlever une langue** : supprimer son entrée dans `languages` ; ses enregistrements sont alors ignorés.

**Langue hors FLEURS** (comme l'arabe marocain, tiré de DVoice) : ses phrases ne sont pas celles des autres langues. Le menu « Phrase » liste les phrases de la langue choisie. Dans `data/clips.json`, une telle langue porte `"source": "dvoice"` (ou tout autre nom que `fleurs`) : `tools/fetch_fleurs.py` la conserve alors avec ses enregistrements.

## Héberger la page

N'importe quel hébergement de fichiers statiques convient : copier le dossier tel quel.

- **GitLab Pages** (par exemple sur gitlab.inria.fr) : le fichier `.gitlab-ci.yml` de ce dossier publie le site à chaque push sur la branche par défaut. Si l'instance le permet, l'accès peut être limité aux membres du projet (Paramètres → Général → Visibilité → Pages).
- **GitHub Pages** : pousser le dossier dans un dépôt, puis Settings → Pages → « Deploy from a branch ».
- **Serveur web de l'équipe** : copier le dossier dans un répertoire servi par Apache ou Nginx.

## Sources

- Audio : FLEURS (Conneau et al., 2022, Google) et DVoice v2.0 pour l'arabe marocain (Naira, Allak & Benelallam, 2022), licences CC BY 4.0. Fichiers convertis en MP3 mono 16 kHz.
- Ramus, Nespor & Mehler (1999) ; Grabe & Low (2002) ; Dellwo (2006) ; Arvaniti (2012) ; Dey & Saha (2024).
