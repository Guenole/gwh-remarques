#!/usr/bin/env python3
"""Fabrique remarques.js (GuenoWasHere) à partir de l'outil de remarques HWS (outils/remarques-hws-source.js).
Même outil, mêmes écrans : seules la marque, les couleurs, l'identifiant de projet et le serveur changent.
Pour reprendre une nouvelle version HWS : remplacer remarques-hws-source.js puis relancer ce script."""
import pathlib, re, sys
ici = pathlib.Path(__file__).resolve().parent
t = (ici / 'remarques-hws-source.js').read_text(encoding='utf-8')
version_hws = re.search(r"const VERSION = '([^']+)'", t).group(1)

def R(a, b, n=None):
    global t
    c = t.count(a)
    if c == 0 or (n is not None and c != n):
        sys.exit('Motif introuvable ou inattendu (%d) : %r' % (c, a[:70]))
    t = t.replace(a, b)

# En-tête
R(t[:t.index('(() => {')], '''/*!
 * Remarques GuenoWasHere v%s : l'outil de remarques des prototypes clients de GuenoWasHere (Guénolé Savary),
 * repris de l'outil HWS v%s, même fonctionnement et mêmes écrans.
 *
 * Une ligne par page :
 *   <script src="https://guenole.github.io/gwh-remarques/remarques.js" data-projet="<identifiant>" data-api="<adresse du relais>" defer></script>
 * data-projet : identifiant du prototype (minuscules, chiffres, tirets), autorisé dans le relais.
 * data-api : adresse du relais Cloudflare (sans « /api » final). Il range chaque remarque en issue GitHub dans un dépôt privé.
 * Option : data-position="bas-gauche" (par défaut, en bas à droite).
 *
 * Aucune dépendance. L'interface vit dans un Shadow DOM : elle ne touche pas au CSS du prototype,
 * et le CSS du prototype ne la touche pas.
 */
''' % (version_hws, version_hws))

# Identité
R('window.__hwsRemarques', 'window.__gwhRemarques')
R("'hws-remarques:", "'gwh-remarques:")
R("document.createElement('hws-remarques')", "document.createElement('gwh-remarques')")
R("'data-remarques-hws'", "'data-remarques-gwh'")
R("includes('__hwsRemarques')", "includes('__gwhRemarques')")
R('[Remarques HWS]', '[Remarques GuenoWasHere]')
R("if (!/^pr-[0-9a-f]{32}$/.test(PROJET)) {", "if (!/^[a-z0-9][a-z0-9-]{5,41}$/.test(PROJET)) {")
R("Attribut data-projet absent ou invalide (jeton « pr- » + 32 caractères hexadécimaux, créé dans FlowDesk)",
  "Attribut data-projet absent ou invalide (minuscules, chiffres et tirets, 6 à 42 caractères)")
R("(adresse de l’API FlowDesk)", "(adresse du relais des remarques)")
t = re.sub(r'FlowDesk', 'le relais', t)  # commentaires restants

# Couleurs : encre et orange GuenoWasHere à la place du marine et du bleu HWS
R('--marine: #16172C; --bleu: #2560E0; --bleu-fonce: #1D4CB8; --bleu-clair: #EEF3FE; --bleu-vif: #5B8CFF;',
  '--marine: #121110; --bleu: #B5400F; --bleu-fonce: #8F320B; --bleu-clair: #F7E7DD; --bleu-vif: #FF6B2C;')
R('--texte: #181B21; --texte-2: #4F5460; --texte-3: #686E7B; --bord: #E4E6EA; --bord-2: #D1D4DA; --fond-2: #F4F5F7;',
  '--texte: #121110; --texte-2: #3A3630; --texte-3: #6B655C; --bord: #E4DED3; --bord-2: #D2CABD; --fond-2: #F4F1EA;')
R('--ambre: #B45309; --ambre-clair: #FEF3E2; --ardoise: #475569; --ardoise-clair: #EEF2F7;',
  '--ambre: #B45309; --ambre-clair: #FEF3E2; --ardoise: #4F4A43; --ardoise-clair: #EFEBE4;')
t = t.replace('rgba(37,96,224,', 'rgba(181,64,15,').replace('rgba(22,23,44,', 'rgba(18,17,16,')
# Police de la charte GuenoWasHere (Satoshi), chargée une fois dans la page
R('font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif;',
  'font: 14px/1.45 "Satoshi", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;')
R("  window.__gwhRemarques = { version: VERSION, projet: PROJET, api: API };",
  "  window.__gwhRemarques = { version: VERSION, projet: PROJET, api: API };\n"
  "  if (!document.querySelector('link[data-gwh-police]')) {\n"
  "    const police = document.createElement('link');\n"
  "    police.rel = 'stylesheet'; police.href = 'https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap';\n"
  "    police.setAttribute('data-gwh-police', '');\n"
  "    document.head.appendChild(police);\n"
  "  }")

reste = [t[max(0,m.start()-40):m.end()+20] for m in re.finditer(r'HWS|hws|2560E0|16172C', t) if 'outil HWS v' not in t[max(0,m.start()-12):m.end()+3]]
if reste: sys.exit('Restes HWS : %r' % reste[:5])
(ici.parent / 'remarques.js').write_text(t, encoding='utf-8')
print('remarques.js écrit (%d Ko), repris de HWS v%s' % (len(t.encode()) // 1024, version_hws))
