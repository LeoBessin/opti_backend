# Optimisation de `main.js` : de la mesure à `main.fast.js`

Ce document compare le programme de départ [`main.js`](./main.js) à la version
optimisée [`main.fast.js`](./main.fast.js), et surtout **explique comment les
goulots d'étranglement ont été trouvés** — car en optimisation, la mesure passe
toujours avant la modification.

## 1. Le problème

Les deux programmes résolvent la même tâche : retrouver, par force brute, les
mots dont on ne connaît que l'empreinte SHA-256. On essaie toutes les
combinaisons de l'alphabet (`data/characters.txt`, 62 caractères) par longueur
croissante jusqu'à retrouver chaque cible.

Trois empreintes sont recherchées. Les mots correspondants se sont révélés
être :

| Mot     | Longueur | Empreinte (début)  |
| ------- | -------- | ------------------ |
| `z3D`   | 3        | `a532ca5e…`        |
| `Sh3n`  | 4        | `bd7d0ea8…`        |
| `Ak4l1` | 5        | `b53fa215…`        |

Le coût est dominé par `Ak4l1` : l'espace de longueur 5 compte
62⁵ = **916 132 832** combinaisons, contre ~15 M pour les longueurs 1 à 4
réunies. C'est donc là que se joue la performance.

## 2. La méthode : mesurer avant de toucher au code

Impossible de profiler `main.js` tel quel : il tourne sans limite jusqu'à tout
trouver (~6-7 min sur une seule cible longue). On a donc écrit un **harnais de
profilage borné**, [`profile.js`](./profile.js), qui exécute *exactement* la
même boucle chaude mais sur un budget fixe de hachages, puis produit :

1. un **rapport de débit** dans le terminal (hachages/s, temps passé dans le
   hachage vs l'incrément du compteur) ;
2. un **profil CPU V8** (`.cpuprofile`) ouvrable dans Chrome DevTools ou
   speedscope ;
3. un **flamegraph HTML interactif autonome**, généré directement à partir des
   échantillons du profil (aucune dépendance, aucun envoi de fichier).

```bash
node profile.js               # 20 M de hachages, longueur 4
node profile.js --budget 5e7 --length 5
```

### Découverte n°1 — le ramasse-miettes domine

Le rapport terminal, trié par temps propre (*self time*), a immédiatement
désigné le coupable :

```
=== hot path (top self time from CPU profile) ===
 40.9%    1273 ms  (garbage collector)  (native)
 23.0%     714 ms  digest  hash:152
 12.1%     377 ms  digest  (native)
 11.1%     344 ms  Hash    (native)
  5.0%     156 ms  Hash    hash:90
  1.8%      55 ms  createHash  node:crypto
```

**~40 % du temps part dans le ramasse-miettes (GC).** Le flamegraph le confirme
visuellement : un large bloc `(garbage collector)`, frère de la pile
`run → digest / createHash / Hash`.

La cause est dans la boucle de `main.js` :

```js
const hash = crypto.createHash('sha256').update(word).digest('hex');
```

À **chaque** itération (916 M fois pour la longueur 5), `createHash()` alloue un
nouvel objet `Hash`. Ces millions d'objets à courte durée de vie saturent le
GC : on passe plus de temps à ramasser des objets qu'à calculer du SHA-256.

Cela valide la piste du README (« réutiliser les objets ») — mais l'objet `Hash`
de Node n'est pas réinitialisable. La vraie solution est l'API **en un seul
appel** `crypto.hash()`, qui calcule l'empreinte sans créer d'objet `Hash` en
JavaScript.

### Découverte n°2 — l'encodage de sortie change tout

Avant de remplacer l'appel, on a **mesuré** les variantes disponibles (5 M de
hachages, avec préchauffage) — un réflexe qui a évité une fausse bonne idée :

| Appel                                  | Débit        |
| -------------------------------------- | ------------ |
| `createHash().digest('hex')` (départ)  | 2,64 M/s     |
| `createHash().digest()` (Buffer)       | 0,96 M/s     |
| **`crypto.hash('sha256', w)` (hex)**   | **6,77 M/s** |
| `crypto.hash('sha256', w, 'buffer')`   | 1,45 M/s     |

Résultat contre-intuitif : dans cette version de Node, la **sortie hexadécimale
est la plus rapide**, et de loin. La première idée « naturelle » — renvoyer un
`Buffer` et comparer les octets (voire seulement les 4 premiers) — s'est révélée
**~4x plus lente**, car l'allocation du `Buffer` de sortie coûte ici très cher.

Sans cette mesure, on aurait « optimisé » dans le mauvais sens. La bonne
solution : garder la sortie **hex** et tester l'appartenance à un `Set` de
cibles (une simple recherche de chaîne).

### Découverte n°3 — un seul cœur sur seize

Le rapport donnait un débit mono-thread d'environ **0,97 M/s** pour `main.js`.
La machine dispose de 8 cœurs / 16 threads : 15 cœurs restaient inutilisés.
`main.js` est purement séquentiel. La parallélisation via `worker_threads`
s'imposait.

### Découverte n°4 (au moment de l'exécution) — la répartition du travail

En profilant *l'exécution parallèle*, un défaut algorithmique est apparu.
Découper l'espace en **blocs contigus** (worker 0 → premier seizième, etc.) est
inefficace pour trouver **une** aiguille : seul le worker qui « possède »
l'index de la cible progresse vers elle ; les 15 autres balaient des zones où la
réponse n'est pas.

La cible `Ak4l1` est à l'index global ≈ 386,8 M sur 916 M. En blocs contigus, le
worker propriétaire doit d'abord traverser ~43 M d'indices. En **round-robin**
(le worker `i` prend les indices `i, i+N, i+2N, …`), il l'atteint en
`index / N` ≈ 24 M étapes. Mesure à l'appui : **49,9 s → 27,6 s**.

### Découverte n°5 — hyperthreading ≠ accélération

SHA-256 sature les unités de calcul du cœur. Sur une machine SMT
(8 cœurs / 16 threads), les 8 threads supplémentaires n'ajoutent que de la
contention :

| Workers                    | Temps total |
| -------------------------- | ----------- |
| 16 (threads logiques)      | 27,6 s      |
| **8 (cœurs physiques)**    | **17,5 s**  |

D'où la variable d'environnement `WORKERS` pour ajuster selon la machine.

## 3. Comparaison du code

### Boucle chaude

**`main.js` (départ)**

```js
const hash = crypto.createHash('sha256').update(word).digest('hex'); // objet + GC
if (remaining.has(hash) && remaining.get(hash) === null) {           // double lookup Map
  const found = word.toString('latin1');
  remaining.set(hash, found);
  console.log(`found "${found}" -> ${hash} (${Date.now() - start} ms)`);
}
```

**`main.fast.js` (optimisé)**

```js
const digest = crypto.hash('sha256', word); // un seul appel, pas d'objet Hash
if (targetSet.has(digest)) {                 // un seul Set.has()
  parentPort.postMessage({ type: 'found', hash: digest, word: word.toString('latin1') });
}
```

### Tableau récapitulatif

| Aspect              | `main.js`                              | `main.fast.js`                                  |
| ------------------- | -------------------------------------- | ----------------------------------------------- |
| Calcul du hachage   | `createHash().update().digest('hex')`  | `crypto.hash('sha256', word)` (un appel)        |
| Objets par itération| 1 objet `Hash` (→ ~40 % de GC)         | aucun objet `Hash`                              |
| Vérification        | `Map.has()` + `Map.get()`              | `Set.has()`                                     |
| Parallélisme        | 1 thread                               | `worker_threads`, N cœurs                       |
| Répartition         | —                                      | round-robin (index `i, i+N, i+2N, …`)           |
| Réglage             | —                                      | `WORKERS` (défaut : tous les cœurs logiques)    |

## 4. Résultats

| Version                                   | Temps        | Gain          |
| ----------------------------------------- | ------------ | ------------- |
| `main.js` (référence, 0,97 M/s, 1 thread) | ~6-7 min\*   | 1x            |
| Optimisé, boucle mono-thread              | 6,25 M/s     | **6,4x** / hachage |
| Optimisé, 16 workers, blocs contigus      | 49,9 s       | —             |
| Optimisé, 16 workers, round-robin         | 27,6 s       | —             |
| **Optimisé, 8 workers, round-robin**      | **17,5 s**   | **~22x**      |

\* extrapolé à partir du débit mesuré de 0,97 M/s (la référence n'a pas été
exécutée jusqu'au bout).

Les trois mots sont retrouvés à l'identique et vérifiés :
`z3D`, `Sh3n`, `Ak4l1`.

## 5. Ce qu'il faut retenir

1. **Mesurer d'abord.** Le vrai coût de `main.js` n'était pas le SHA-256 mais le
   GC provoqué par l'allocation d'un objet par itération — invisible à la simple
   lecture du code.
2. **Re-mesurer chaque idée.** La comparaison par `Buffer` semblait plus maligne
   mais était 4x plus lente : seul le banc d'essai l'a montré.
3. **Le bon algorithme de répartition compte** autant que le code bas niveau :
   le round-robin a apporté un 1,8x « gratuit ».
4. **Connaître son matériel.** Pour une tâche saturant le CPU, s'en tenir aux
   cœurs physiques bat l'usage naïf de tous les threads logiques.

### Pistes suivantes

Le prochain goulot est le SHA-256 natif d'OpenSSL lui-même — proche du plafond
sans changer d'approche. Pour aller plus loin, il faudrait **élaguer l'espace de
recherche** (dernière piste du README) plutôt que d'accélérer le hachage.
