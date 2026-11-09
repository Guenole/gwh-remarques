# Remarques GuenoWasHere

L'outil de remarques des prototypes clients de GuenoWasHere : le même que celui de HWS (pastilles numérotées, liste,
réponses, « traitée »), aux couleurs de GuenoWasHere, sans FlowDesk.

- **`remarques.js`** : l'outil, servi par GitHub Pages à `https://guenole.github.io/gwh-remarques/remarques.js`.
  Généré par `outils/construire_widget.py` à partir de la version HWS ; ne pas le modifier à la main.
- **`relais/`** : un Cloudflare Worker gratuit qui parle comme le serveur HWS et range chaque remarque en issue
  dans le dépôt privé `Guenole/gwh-remarques-donnees` (étiquette `projet:<identifiant>`). Le jeton GitHub reste
  dans le relais.

## Équiper un prototype

Une ligne avant `</body>` dans chaque page :

```html
<script src="https://guenole.github.io/gwh-remarques/remarques.js" data-projet="<identifiant>" data-api="<adresse du relais>" defer></script>
```

L'identifiant (minuscules, chiffres, tirets, 6 à 42 caractères) doit figurer dans `PROJETS` de
`relais/wrangler.toml`, puis `npx wrangler deploy` depuis `relais/`.

## Traiter les remarques

Dans GitHub, dépôt `gwh-remarques-donnees` :
- **lire** : `gh issue list -R Guenole/gwh-remarques-donnees -l "projet:<identifiant>"` ;
- **répondre** : commenter l'issue, le commentaire s'affiche dans l'outil comme « Réponse de l'équipe » ;
- **en cours** : étiquette `en-cours` ; **traitée** : fermer l'issue (`gh issue close <n°>`).

Une remarque supprimée dans l'outil est fermée avec l'étiquette `supprimee` : rien n'est perdu.

## Mise en place (une fois)

1. `cd relais && npx wrangler login` (compte Cloudflare gratuit).
2. Créer un jeton GitHub limité : github.com/settings/personal-access-tokens/new, dépôt `gwh-remarques-donnees`
   seulement, permission « Issues : lecture et écriture ».
3. `npx wrangler secret put GITHUB_TOKEN` et coller le jeton, puis `npx wrangler deploy`.
4. Vérifier : `curl <adresse du relais>/sante` doit renvoyer `"base":true`.
