# Optimisation Backend

Cours pratique d'**optimisation backend** en JavaScript (Node.js).

L'objectif : partir d'un programme correct mais lent, mesurer ses performances,
identifier les goulots d'étranglement, puis appliquer des techniques
d'optimisation pour le rendre plus rapide — sans changer son résultat.

## Le problème

Le fichier [`main.js`](./main.js) retrouve les mots dont on ne connaît que
l'empreinte **SHA-256**. Il fait une recherche par force brute : il essaie
toutes les combinaisons possibles de caractères, par longueur croissante,
jusqu'à retrouver chaque empreinte cherchée.

Les caractères autorisés sont listés dans [`data/characters.txt`](./data/characters.txt)
(les lettres minuscules, majuscules et les chiffres).

## Prérequis

- [Node.js](https://nodejs.org/) 18 ou plus récent

## Lancer le programme

```bash
node main.js
```

Le programme affiche chaque mot retrouvé, l'empreinte correspondante et le
temps écoulé (en millisecondes) depuis le démarrage.

## Pistes d'optimisation

Le code de départ fonctionne, mais il est naïf. À vous de l'améliorer :

- **Mesurer d'abord.** Chronométrez le programme avant toute modification pour
  avoir une base de comparaison.
- **Réutiliser les objets.** Recréer un objet de hachage à chaque itération
  coûte cher.
- **Éviter les conversions inutiles.** Chaque `toString`, `split` ou allocation
  dans la boucle chaude pèse sur les performances.
- **Paralléliser.** Un seul thread n'exploite pas tous les cœurs du processeur.
  Regardez du côté des [`worker_threads`](https://nodejs.org/api/worker_threads.html).
- **Élaguer l'espace de recherche.** Peut-on éviter de tester des combinaisons
  qui n'ont aucune chance d'être la solution ?

## Structure du dépôt

```
.
├── data/
│   └── characters.txt   # alphabet des caractères testés
├── main.js              # programme de départ à optimiser
└── README.md
```

## Licence

Distribué sous licence MIT. Voir [`LICENSE`](./LICENSE).
