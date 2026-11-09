/*!
 * Remarques GuenoWasHere v2.0.0 : l'outil de remarques des prototypes clients de GuenoWasHere (Guénolé Savary),
 * repris de l'outil HWS v2.0.0, même fonctionnement et mêmes écrans.
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
(() => {
  'use strict';
  if (window.__gwhRemarques) return;

  const script = document.currentScript;
  if (!script) return;
  const PROJET = (script.getAttribute('data-projet') || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{5,41}$/.test(PROJET)) {
    console.warn('[Remarques GuenoWasHere] Attribut data-projet absent ou invalide (minuscules, chiffres et tirets, 6 à 42 caractères) : l’outil ne démarre pas.');
    return;
  }
  const API = ((script.getAttribute('data-api') || '').trim() || new URL(script.src, location.href).origin).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s"<>]+$/.test(API)) {
    console.warn('[Remarques GuenoWasHere] Attribut data-api absent ou invalide (adresse du relais des remarques) : l’outil ne démarre pas.');
    return;
  }
  const COTE = script.getAttribute('data-position') === 'bas-gauche' ? 'gauche' : 'droite';
  const VERSION = '2.0.0';
  window.__gwhRemarques = { version: VERSION, projet: PROJET, api: API };
  if (!document.querySelector('link[data-gwh-police]')) {
    const police = document.createElement('link');
    police.rel = 'stylesheet'; police.href = 'https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap';
    police.setAttribute('data-gwh-police', '');
    document.head.appendChild(police);
  }

  const CLE_NOM = 'gwh-remarques:nom';
  const CLE_RELECTEUR = 'gwh-remarques:relecteur'; // identifiant de ce navigateur, à part du nom (homonymes)
  const CLE_FOCUS = 'gwh-remarques:focus:' + PROJET;
  const CLE_PASTILLES = 'gwh-remarques:pastilles:' + PROJET;
  const CLE_FILTRE = 'gwh-remarques:filtre:' + PROJET;
  const FILTRES = ['ouvertes', 'en_cours', 'traitees', 'toutes'];
  const CLE_LUES = 'gwh-remarques:lues:' + PROJET; // { id de remarque : reponse_le vue }
  const CLE_SONDE = 'gwh-remarques:sonde';
  const CLE_BROUILLON = 'gwh-remarques:brouillon:' + PROJET; // texte en cours du formulaire, par onglet
  const PARAM_LIEN = 'remarque';
  const SYNCHRO_MS = 15000;
  const REESSAI_MS = 5000;
  const VERSION_MS = 10 * 60000;
  const MESSAGE_COUPURE = 'Mise à jour en cours, votre texte est gardé.';
  const LIBELLE_REPONSE = 'Envoyer la réponse';
  const TAILLE_PIN = 28;
  const LARGEUR_PANNEAU = 380;
  const LARGEUR_MOBILE = 640;
  const reduit = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------ état */

  const etat = {
    remarques: [],
    signature: '',
    charge: false,
    erreur: '',
    placement: false,
    panneau: false,
    filtre: lireFiltre(), // ouvertes (à traiter) | en_cours | traitees | toutes
    portee: 'tout', // tout | page
    pastilles: lire(CLE_PASTILLES) !== 'masquees',
    lues: lireLues(), // null : stockage indisponible, aucun signal de nouvelle réponse
    popover: null, // { type: 'detail' | 'formulaire', id?, confirmer?, sig? }
    brouillon: null, // { el, ancre } : pastille posée, remarque pas encore publiée (ou nouvel endroit à confirmer)
    deplacement: null, // id de la Remarque qu'on déplace, pendant le placement
  };

  function lire(cle, session) {
    try { return (session ? sessionStorage : localStorage).getItem(cle); } catch (_) { return null; }
  }
  function ecrire(cle, valeur, session) {
    try { (session ? sessionStorage : localStorage).setItem(cle, valeur); } catch (_) { /* navigation privée */ }
  }
  function effacer(cle, session) {
    try { (session ? sessionStorage : localStorage).removeItem(cle); } catch (_) { /* navigation privée */ }
  }

  // Filtre de la liste retenu par projet dans ce navigateur ; illisible ou inconnu : « À traiter ».
  function lireFiltre() {
    const f = lire(CLE_FILTRE);
    return FILTRES.includes(f) ? f : 'ouvertes';
  }

  // Réponses lues, retenues par navigateur (le client n'a pas de compte). Stockage bloqué ou
  // illisible : null, et plus aucun signal (ni erreur) plutôt qu'un signal impossible à éteindre.
  function lireLues() {
    ecrire(CLE_SONDE, '1');
    if (lire(CLE_SONDE) !== '1') return null;
    effacer(CLE_SONDE);
    try {
      const v = JSON.parse(lire(CLE_LUES) || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch (_) { return {}; }
  }

  const horodatage = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? 0 : t; };
  // Non lue : une réponse de l'équipe plus récente que celle déjà vue (ou jamais vue).
  const nonLue = (r) => !!etat.lues && !!r.reponse_le && horodatage(r.reponse_le) > horodatage(etat.lues[r.id]);
  const nbNonLues = () => etat.remarques.filter(nonLue).length;
  // État visible : a_traiter, en_cours (l'équipe l'a prise en charge) ou traitee ; repli pour un serveur sans « etat ».
  const etatDe = (r) => r.etat || (r.traitee ? 'traitee' : 'a_traiter');
  const enCours = (r) => etatDe(r) === 'en_cours';
  const classeNum = (r) => 'num' + (r.traitee ? ' traitee' : enCours(r) ? ' en-cours' : '');
  // « À traiter » compte aussi les remarques En cours (pas encore traitées) : barre, résumé et filtre disent la même chose.
  const comptes = (liste) => ({ aTraiter: liste.filter((r) => !r.traitee).length, enCours: liste.filter(enCours).length, traitees: liste.filter((r) => r.traitee).length });
  const dansLeFiltre = (r) => (etat.filtre === 'ouvertes' ? !r.traitee : etat.filtre === 'en_cours' ? enCours(r)
    : etat.filtre === 'traitees' ? r.traitee : true);
  const libelleATraiter = (c) => c.aTraiter + ' à traiter' + (c.enCours ? ' dont ' + c.enCours + ' en cours' : '');

  // Texte en cours, gardé par onglet : il survit à un rechargement pendant une mise en ligne.
  // { id?, numero? (modification) | ancre? (création), page, titre, description, auteur, envoi? }.
  // Navigation privée sans stockage : rien n'est gardé, l'outil marche quand même.
  function lireTexte() {
    try {
      const t = JSON.parse(lire(CLE_BROUILLON, true) || 'null');
      return t && typeof t === 'object' && !Array.isArray(t) ? t : null;
    } catch (_) { return null; }
  }
  const garderTexte = (t) => ecrire(CLE_BROUILLON, JSON.stringify(t), true);
  const oublierTexte = () => effacer(CLE_BROUILLON, true);

  function marquerLue(r) {
    if (!nonLue(r)) return false;
    etat.lues[r.id] = r.reponse_le;
    ecrire(CLE_LUES, JSON.stringify(etat.lues));
    return true;
  }

  /* ------------------------------------------------------------------ pages */

  // Une page = son chemin, sans « .html » ni « index » (Netlify sert les deux formes),
  // plus la route après « #/ » pour les prototypes qui changent d'écran par l'ancre.
  const routeDiese = () => (/^#!?\//.test(location.hash) ? location.hash : '');
  const cheminCourant = () => location.pathname + routeDiese();
  const pageCourante = () => cleDePage(cheminCourant());

  function cleDePage(chemin) {
    let p = chemin || '/';
    let route = '';
    const diese = p.indexOf('#');
    if (diese >= 0) { route = p.slice(diese); p = p.slice(0, diese); }
    try { p = decodeURI(p); } catch (_) { /* chemin déjà décodé */ }
    p = p.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    return (p || '/') + route;
  }

  function urlDe(r) {
    const u = new URL(location.href);
    const c = r.chemin || '/';
    const i = c.indexOf('#');
    u.pathname = i >= 0 ? c.slice(0, i) : c;
    u.search = '';
    u.hash = i >= 0 ? c.slice(i) : '';
    return u.href;
  }

  /* ------------------------------------------------------------------ serveur */

  const CHEMIN = '/api/prototypes/remarques';

  // Le jeton part dans l'adresse de TOUS les appels (GET, POST, PATCH, DELETE) : c'est lui qui
  // désigne le projet côté le relais. `extra` : paramètres d'adresse en plus (DELETE : par). `suite` : sous-route (reponses).
  function adresse(id, extra, suite) {
    const q = new URLSearchParams({ projet: PROJET, ...(extra || {}) });
    return API + CHEMIN + (id ? '/' + encodeURIComponent(id) : '') + (suite ? '/' + suite : '') + '?' + q.toString();
  }

  async function api(methode, id, corps, extra, suite) {
    let reponse;
    try {
      reponse = await fetch(adresse(id, extra, suite), {
        method: methode,
        headers: corps ? { 'Content-Type': 'application/json' } : undefined,
        body: corps ? JSON.stringify(corps) : undefined,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (_) {
      throw erreurServeur('Le serveur des remarques ne répond pas. Vérifiez votre connexion puis réessayez.', true);
    }
    const texte = await reponse.text();
    let donnees = null;
    try { donnees = texte ? JSON.parse(texte) : null; } catch (_) { /* réponse non JSON */ }
    if (!reponse.ok) throw erreurServeur(messageErreur(reponse.status, donnees), [502, 503, 504].includes(reponse.status));
    return donnees;
  }

  // coupure : serveur injoignable ou en redémarrage (mise en ligne), l'envoi peut être refait tel quel.
  function erreurServeur(message, coupure) {
    const e = new Error(message);
    e.coupure = !!coupure;
    return e;
  }

  // Le message du serveur (`erreur`, en français) est montré tel quel ; à défaut, un message par code.
  function messageErreur(statut, donnees) {
    const message = donnees && typeof donnees.erreur === 'string' ? donnees.erreur.trim() : '';
    if (message) return message;
    if (statut === 429) return 'Trop de demandes en peu de temps. Réessayez dans quelques minutes.';
    if (statut === 413) return 'La remarque est trop volumineuse pour être envoyée.';
    if (statut === 404) return 'Ce lien de relecture n’est plus valide, ou cette remarque n’existe plus.';
    return 'Le serveur des remarques a refusé la demande (' + statut + ').';
  }

  function preparer(r) {
    r._page = cleDePage(r.chemin);
    return r;
  }
  const trouver = (id) => etat.remarques.find((r) => r.id === id) || null;

  function ajouterOuRemplacer(r) {
    preparer(r);
    const i = etat.remarques.findIndex((x) => x.id === r.id);
    if (i >= 0) etat.remarques[i] = r; else etat.remarques.push(r);
    etat.remarques.sort((a, b) => a.numero - b.numero);
    etat.signature = '';
  }

  async function charger() {
    try {
      const donnees = await api('GET');
      const liste = (donnees && donnees.remarques) || [];
      const signature = JSON.stringify(liste);
      const avaitErreur = !!etat.erreur;
      etat.charge = true;
      etat.erreur = '';
      if (avaitErreur) verifierVersion(); // retour après une coupure : souvent une mise en ligne
      if (signature === etat.signature && !avaitErreur) return;
      etat.signature = signature;
      etat.remarques = liste.map(preparer).sort((a, b) => a.numero - b.numero);
      for (const id of cache.keys()) if (!trouver(id)) cache.delete(id);
      rendre();
    } catch (err) {
      etat.erreur = err.message;
      rendre();
    }
  }

  /* ------------------------------------------------------------------ ancrage des pastilles */

  // La pastille est accrochée à l'élément cliqué (sélecteur CSS + texte de secours) et à une
  // position relative dans cet élément : elle suit la mise en page, sur ordinateur comme sur mobile.

  const espaces = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // Le nom du relecteur, gardé dans ce navigateur dès qu'il le tape (création ou réponse), même sans envoi.
  // Jamais depuis une modification : le nom affiché y est celui de l'auteur, peut-être un collègue.
  const garderNom = (valeur) => { const v = espaces(valeur); if (v) ecrire(CLE_NOM, v); };
  // Identifiant tiré au hasard une fois par navigateur et envoyé avec chaque Remarque et réponse : le relais distingue
  // ainsi deux relecteurs du même nom. Stockage indisponible : rien n'est envoyé plutôt qu'un identifiant qui change.
  function identifiantRelecteur() {
    const garde = lire(CLE_RELECTEUR);
    if (garde && /^[A-Za-z0-9-]{8,64}$/.test(garde)) return garde;
    const tire = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    ecrire(CLE_RELECTEUR, tire);
    return lire(CLE_RELECTEUR) === tire ? tire : undefined;
  }

  function empreinteTexte(el) {
    const t = espaces(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || el.textContent);
    return t.length <= 120 ? t : '';
  }

  // Enveloppe d'épinglage (GSAP : div.pin-spacer, présente ou non selon la largeur de la fenêtre) : transparente dans le chemin,
  // pour que le sélecteur soit le même avec et sans elle.
  const estEnveloppe = (e) => !!(e.classList && e.classList.contains('pin-spacer'));
  function parentUtile(n) {
    let p = n.parentElement;
    while (p && estEnveloppe(p)) p = p.parentElement;
    return p;
  }
  function enfantsUtiles(p) {
    const liste = [];
    for (const c of p.children) {
      if (estEnveloppe(c)) liste.push(...enfantsUtiles(c)); else liste.push(c);
    }
    return liste;
  }

  function selecteurDe(el) {
    const parties = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body && n !== document.documentElement) {
      if (n.id && !/\d{4,}/.test(n.id)) {
        const sel = '#' + CSS.escape(n.id);
        let unique = false;
        try { unique = document.querySelectorAll(sel).length === 1; } catch (_) { /* id exotique */ }
        if (unique) { parties.unshift(sel); return parties.join(' > '); }
      }
      let partie = CSS.escape(n.localName);
      const parent = parentUtile(n);
      if (parent) {
        const memes = enfantsUtiles(parent).filter((c) => c.localName === n.localName);
        if (memes.length > 1) partie += ':nth-of-type(' + (memes.indexOf(n) + 1) + ')';
      }
      parties.unshift(partie);
      n = parent;
    }
    parties.unshift('body');
    return parties.join(' > ');
  }

  function cibleDe(e) {
    let el = e.target;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || el === document.documentElement || !document.body.contains(el)) return document.body;
    const svg = el.closest('svg');
    return svg || el;
  }

  // Fenêtre (<dialog> natif, rôle dialog, popover) : une pastille posée dedans n'existe à l'écran que
  // fenêtre ouverte. On retient donc le dernier contrôle cliqué hors de la fenêtre (l'ouvreur) ;
  // focaliser() le recliquera pour rouvrir la fenêtre. Un simple lien n'est jamais un ouvreur : il quitterait la page.
  const SEL_FENETRE = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], [popover]';
  // Cartes cliquables en div comprises ([onclick], [tabindex] focalisable).
  const SEL_OUVREUR = 'button, [role="button"], [role="tab"], [role="menuitem"], summary, [aria-haspopup], [aria-controls], a:not([href]), a[href^="#"], [onclick], [tabindex]:not([tabindex="-1"])';
  const derniersClics = [];

  function noterClic(e) {
    if (!e.isTrusted || etat.placement || estDansOutil(e)) return;
    const t = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    const c = t && t.closest(SEL_OUVREUR);
    if (c) retenirOuvreur(c);
  }

  function retenirOuvreur(c) {
    const i = derniersClics.indexOf(c);
    if (i >= 0) derniersClics.splice(i, 1);
    derniersClics.push(c);
    if (derniersClics.length > 8) derniersClics.shift();
  }

  // { selecteur, tag, texte, fenetre? } de l'ouvreur de la fenêtre qui contient el, ou null. Le nom de la fenêtre
  // sert à la fiche quand le framework a retiré la fenêtre du DOM. Un conteneur qui englobe la fenêtre n'est pas un ouvreur.
  function ouvreurDe(el) {
    const f = el && el.closest && el.closest(SEL_FENETRE);
    if (!f) return null;
    for (let i = derniersClics.length - 1; i >= 0; i--) {
      const c = derniersClics[i];
      if (!c.isConnected || f.contains(c) || c.contains(f) || c === document.body || !estVisible(c)) continue;
      const fenetre = nomFenetre(f).slice(0, 160);
      return { selecteur: selecteurDe(c), tag: c.localName, texte: empreinteTexte(c), ...(fenetre ? { fenetre } : {}) };
    }
    return null;
  }

  function nomFenetre(f) {
    const label = f.getAttribute('aria-label');
    if (label && espaces(label)) return espaces(label);
    for (const id of (f.getAttribute('aria-labelledby') || '').split(/\s+/)) {
      const t = id && document.getElementById(id);
      if (t && espaces(t.textContent)) return espaces(t.textContent);
    }
    const titre = f.querySelector('h1, h2, h3, h4');
    return titre ? espaces(titre.textContent) : '';
  }

  // L'endroit d'une Remarque sur la page affichée : { c, visible } ; c null = élément introuvable dans le DOM.
  function endroit(r) {
    const c = elementDe(r);
    return { c, visible: !!(c && estVisible(c.el, false)) };
  }

  // Repli : la fiche dit où est l'endroit quand la pastille n'est pas à l'écran (fenêtre fermée, ouvreur inconnu).
  // Élément absent du DOM (fenêtre retirée par le framework) : le nom de fenêtre noté à la pose.
  function ligneCible(r) {
    if (r._page !== pageCourante()) return null;
    const { c, visible } = endroit(r);
    if (visible) return null;
    let ligne = 'Sur : ' + libelleCible(r.ancre);
    const f = c && c.el.closest(SEL_FENETRE);
    const ouvreur = r.ancre && r.ancre.ouvreur;
    const nom = f ? nomFenetre(f) : !c && ouvreur && typeof ouvreur.fenetre === 'string' ? ouvreur.fenetre : '';
    if (nom) ligne += ', fenêtre « ' + nom + ' »';
    return ligne;
  }

  // Longueur de l'extrait HTML noté dans l'ancre (le serveur borne l'ancre entière à 4000 caractères).
  const EXTRAIT_MAX = 300;

  function ancreDe(el, x, y) {
    const r = el.getBoundingClientRect();
    const borne = (v) => Math.min(1, Math.max(0, Math.round(v * 10000) / 10000));
    const classes = typeof el.className === 'string' ? el.className : el.getAttribute('class');
    const ouvreur = ouvreurDe(el);
    return {
      selecteur: selecteurDe(el),
      tag: el.localName,
      texte: empreinteTexte(el),
      classes: espaces(classes).slice(0, 160),
      extrait: el === document.body ? '' : el.outerHTML.slice(0, EXTRAIT_MAX),
      rx: r.width ? borne((x - r.left) / r.width) : 0.5,
      ry: r.height ? borne((y - r.top) / r.height) : 0.5,
      largeur_ecran: window.innerWidth,
      // Position dans la page : si l'élément disparaît un jour, la pastille garde un endroit approximatif.
      page_rx: borne((x + window.scrollX) / Math.max(1, document.documentElement.clientWidth)),
      page_y: Math.round(y + window.scrollY),
      hauteur_page: hauteurPage(),
      ...(ouvreur ? { ouvreur } : {}),
    };
  }

  const classesDe = (e) => espaces(typeof e.className === 'string' ? e.className : e.getAttribute('class'));
  // Les classes notées doivent toutes être là ; une classe d'état ajoutée depuis (question--ouverte, is-visible) ne compte pas.
  const classesCompatibles = (a, e) => !a.classes || a.classes.split(' ').every((c) => c === '' || classesDe(e).split(' ').includes(c));
  // Un candidat convient s'il a le tag, les classes (sous-ensemble) et, quand l'ancre note un texte, ce texte.
  const convient = (a, e) => !!e && (!a.tag || e.localName === a.tag) && classesCompatibles(a, e) && (!a.texte || empreinteTexte(e) === a.texte);

  function trouverElement(a) {
    let brut = null;
    try { brut = document.querySelector(a.selecteur); } catch (_) { /* sélecteur cassé */ }
    const propre = chercherParChemin(a.selecteur);
    // Le chemin brut (ancre posée avec ou sans enveloppe d'épinglage) et le chemin qui saute l'enveloppe : on ne garde qu'un
    // résultat qui convient ; deux éléments différents qui conviennent tous deux, on ne devine pas.
    let el = null;
    if (convient(a, brut) && convient(a, propre) && brut !== propre) el = null;
    else el = convient(a, propre) ? propre : convient(a, brut) ? brut : null;
    if (!el && a.texte) el = chercherParTexte(a);
    // Sélecteur muet ou tombé ailleurs : le tag + les classes notées retrouvent l'élément, à condition qu'il soit le seul.
    if (!el && a.classes) el = chercherParClasses(a);
    return el;
  }

  // Seul candidat de même tag, classes (sous-ensemble) et texte (si noté) ; plusieurs : l'extrait noté les départage s'il n'en laisse qu'un ; sinon on ne devine pas.
  function chercherParClasses(a) {
    if (!a.tag || !a.classes) return null;
    const candidats = Array.prototype.filter.call(document.getElementsByTagName(a.tag), (e) => convient(a, e));
    if (candidats.length === 1) return candidats[0];
    if (candidats.length > 1 && a.extrait) {
      const memes = candidats.filter((e) => e.outerHTML.slice(0, EXTRAIT_MAX) === a.extrait);
      if (memes.length === 1) return memes[0];
    }
    return null;
  }

  // Résolution du chemin en ignorant les enveloppes d'épinglage : le chemin posé sans enveloppe vise le bon élément avec ou sans elle.
  function chercherParChemin(selecteur) {
    if (typeof selecteur !== 'string') return null;
    const parties = selecteur.split(' > ');
    let cur = null;
    for (let i = 0; i < parties.length; i++) {
      const partie = parties[i];
      if (partie === 'body' && i === 0) { cur = document.body; continue; }
      if (partie[0] === '#') {
        try { cur = document.querySelector(partie); } catch (_) { return null; }
        if (!cur) return null;
        continue;
      }
      const m = /^(.+?)(?::nth-of-type\((\d+)\))?$/.exec(partie);
      if (!m || !cur) return null;
      const tag = m[1].replace(/\\/g, '');
      const memes = enfantsUtiles(cur).filter((c) => c.localName === tag);
      cur = m[2] ? memes[Number(m[2]) - 1] : memes.length === 1 ? memes[0] : null;
      if (!cur) return null;
    }
    return cur;
  }

  function chercherParTexte(a) {
    if (!a.tag || !a.texte || a.texte.length < 2) return null;
    const candidats = document.getElementsByTagName(a.tag);
    if (candidats.length > 3000) return null;
    let trouve = null;
    for (const el of candidats) {
      if (empreinteTexte(el) !== a.texte) continue;
      if (trouve) return null; // ambigu : on ne devine pas
      trouve = el;
    }
    return trouve;
  }

  function ancetresQuiCoupent(el) {
    const liste = [];
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') liste.push(p);
    }
    return liste;
  }

  // Visible à l'écran. avecOpacite = false : seulement « présent » (dans la page, avec une taille, ni display:none ni
  // visibility:hidden), l'opacité ne compte pas (bloc en fondu au défilement, réponse de FAQ fermée à opacity 0).
  // « Présent » décide de « Endroit à préciser » et sert au clic ; une pastille ne se dessine, au chargement, que sur du visible.
  function estVisible(el, avecOpacite = true) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    if (el.checkVisibility) {
      return el.checkVisibility({ checkOpacity: avecOpacite, checkVisibilityCSS: true, opacityProperty: avecOpacite, visibilityProperty: true });
    }
    return true;
  }

  // presenceSuffit : la pastille ouverte (clic sur la Remarque) se pose sur l'élément même s'il est encore transparent.
  function pointDe(el, a, clips, presenceSuffit = false) {
    if (!estVisible(el, !presenceSuffit)) return null;
    const r = el.getBoundingClientRect();
    const x = r.left + a.rx * r.width;
    const y = r.top + a.ry * r.height;
    for (const p of clips || []) {
      const c = p.getBoundingClientRect();
      if (x < c.left - 1 || x > c.right + 1 || y < c.top - 1 || y > c.bottom + 1) return null;
    }
    return { x, y };
  }

  const cache = new Map(); // id → { el, clips } ou { el: null, reessai }
  function elementDe(r) {
    let c = cache.get(r.id);
    if (c && c.el && c.el.isConnected) return c;
    if (c && !c.el && Date.now() < c.reessai) return null;
    const el = trouverElement(r.ancre || {});
    c = el ? { el, clips: ancetresQuiCoupent(el) } : { el: null, reessai: Date.now() + 1200 };
    cache.set(r.id, c);
    return el ? c : null;
  }

  /* ------------------------------------------------------------------ interface */

  const ICONES = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    liste: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    crayon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    poubelle: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    deplacer: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
    lien: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    rouvrir: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  };

  function h(tag, attrs, ...enfants) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of enfants.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }
  function icone(nom) {
    const s = h('span', { class: 'ico', 'aria-hidden': 'true' });
    s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONES[nom] + '</svg>';
    return s;
  }
  const boutonIcone = (nom, libelle, action) =>
    h('button', { class: 'btn-icone', type: 'button', 'aria-label': libelle, title: libelle, onclick: action }, icone(nom));

  const NOMS = {
    a: 'lien', button: 'bouton', img: 'image', input: 'champ', textarea: 'champ', select: 'liste déroulante',
    h1: 'titre', h2: 'titre', h3: 'titre', h4: 'titre', h5: 'titre', h6: 'titre', p: 'paragraphe',
    li: 'élément de liste', label: 'libellé', svg: 'illustration', video: 'vidéo', table: 'tableau',
    td: 'cellule', th: 'en-tête de colonne', nav: 'menu', header: 'en-tête', footer: 'pied de page',
    form: 'formulaire', span: 'texte', strong: 'texte', em: 'texte', small: 'texte', section: 'section',
    main: 'contenu', aside: 'encadré', body: 'page',
  };
  function libelleCible(a) {
    const nom = NOMS[a.tag] || 'zone';
    if (!a.texte) return nom;
    return nom + ' « ' + (a.texte.length > 48 ? a.texte.slice(0, 47) + '…' : a.texte) + ' »';
  }

  const fmtHeure = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const fmtJour = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  const fmtJourAn = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  function jourDe(d) {
    const auj = new Date();
    const hier = new Date(auj.getFullYear(), auj.getMonth(), auj.getDate() - 1);
    if (d.toDateString() === auj.toDateString()) return 'aujourd’hui';
    if (d.toDateString() === hier.toDateString()) return 'hier';
    return (d.getFullYear() === auj.getFullYear() ? fmtJour : fmtJourAn).format(d);
  }
  function dateCourte(iso) {
    const d = new Date(iso);
    const s = (Date.now() - d) / 1000;
    if (s < 60) return 'à l’instant';
    if (s < 3600) return 'il y a ' + Math.floor(s / 60) + ' min';
    const jour = jourDe(d);
    return jour === 'aujourd’hui' || jour === 'hier' ? jour + ', ' + fmtHeure.format(d) : jour;
  }
  function dateLongue(iso) {
    const d = new Date(iso);
    const jour = jourDe(d);
    return (jour === 'aujourd’hui' || jour === 'hier' ? jour : 'le ' + jour) + ' à ' + fmtHeure.format(d);
  }

  let hote, racine, calque, survol, pinBrouillon, barre, barreNormale, barrePlacement, consigne, boutonListe, compteurBarre, nouvellesBarre;
  let panneau, panneauSous, segments, choixPortee, interrupteur, liste, popover, toast, maj;
  const pins = new Map();

  function construire() {
    hote = document.createElement('gwh-remarques');
    hote.setAttribute('style', 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483000!important;pointer-events:none!important;display:block!important;');
    const ombre = hote.attachShadow({ mode: 'open' });
    ombre.append(h('style', { text: STYLES }));
    // Défilement fluide de la page (Lenis, Locomotive Scroll ou un simple `wheel` en preventDefault) : ces bibliothèques
    // laissent tranquille un élément qui porte data-lenis-prevent (ou data-scroll-lock) sur le chemin de l'événement.
    // En plus, la molette et le toucher qui partent du panneau ou de la fiche ne remontent pas jusqu'au défilement de la page.
    hote.setAttribute('data-lenis-prevent', '');
    hote.setAttribute('data-scroll-lock', '');
    const retenir = (e) => { if (e.composedPath().some((n) => n === panneau || n === popover)) e.stopPropagation(); };
    for (const type of ['wheel', 'touchmove']) hote.addEventListener(type, retenir, { passive: true });

    calque = h('div', { class: 'calque' });
    pinBrouillon = h('span', { class: 'pin brouillon', hidden: true, 'aria-hidden': 'true' }, icone('plus'));
    calque.append(pinBrouillon);
    survol = h('div', { class: 'survol', hidden: true });

    compteurBarre = h('span', { class: 'compteur', text: '…' });
    // Bouton à part (pas dans « Remarques », qui ouvre la liste comme avant) : il mène aux nouvelles réponses.
    nouvellesBarre = h('button', { class: 'nouvelles', type: 'button', hidden: true, onclick: allerAuxNouvelles });
    boutonListe = h('button', { class: 'btn-barre', type: 'button', 'aria-expanded': 'false', onclick: basculerPanneau },
      icone('liste'), h('span', { class: 'libelle', text: 'Remarques' }), compteurBarre);
    barreNormale = h('div', { class: 'barre-groupe' },
      h('button', { class: 'btn-barre principal', type: 'button', 'aria-label': 'Ajouter une remarque', onclick: demarrerPlacement },
        icone('plus'), h('span', { class: 'libelle', text: 'Remarque' })),
      boutonListe, nouvellesBarre);
    barrePlacement = h('div', { class: 'barre-groupe', hidden: true },
      h('span', { class: 'consigne' }, h('span', { class: 'point' }), consigne = h('span', { text: 'Cliquez à l’endroit à commenter' }), h('kbd', { class: 'touche', text: 'Échap' })),
      h('button', { class: 'btn-barre', type: 'button', onclick: arreterPlacement, text: 'Annuler' }));
    barre = h('div', { class: 'barre', role: 'toolbar', 'aria-label': 'Remarques sur le prototype' }, barreNormale, barrePlacement);

    panneauSous = h('p', { class: 'p-sous' });
    segments = h('div', { class: 'segments', role: 'group', 'aria-label': 'Filtrer les remarques' },
      FILTRES.map((f) => h('button', { type: 'button', 'data-filtre': f, onclick: () => choisirFiltre(f) })));
    choixPortee = h('select', { class: 'select', 'aria-label': 'Pages affichées', onchange: () => { etat.portee = choixPortee.value; rendrePanneau(); } },
      h('option', { value: 'tout', text: 'Tout le prototype' }), h('option', { value: 'page', text: 'Cette page' }));
    interrupteur = h('button', { class: 'interrupteur', type: 'button', role: 'switch', onclick: basculerPastilles },
      h('span', { class: 'piste' }, h('span', { class: 'curseur' })), h('span', { text: 'Pastilles' }));
    liste = h('div', { class: 'liste' });
    panneau = h('aside', { class: 'panneau', 'aria-label': 'Liste des remarques', 'aria-hidden': 'true' },
      h('div', { class: 'p-tete' },
        h('div', null, h('h2', { class: 'p-titre', text: 'Remarques' }), panneauSous),
        boutonIcone('x', 'Fermer la liste', fermerPanneau)),
      h('div', { class: 'p-outils' }, segments, h('div', { class: 'ligne-options' }, choixPortee, interrupteur)),
      liste,
      h('div', { class: 'p-pied' },
        h('button', { class: 'btn btn-principal btn-large', type: 'button', onclick: demarrerPlacement }, icone('plus'), 'Ajouter une remarque')));

    popover = h('div', { class: 'popover', role: 'dialog', 'aria-label': 'Remarque', hidden: true });
    toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    maj = h('div', { class: 'maj', role: 'status', hidden: true },
      h('span', { text: 'Une nouvelle version de l’outil de remarques est disponible.' }),
      h('button', { class: 'btn btn-principal', type: 'button', text: 'Recharger', onclick: () => location.reload() }));

    racine = h('div', { class: 'racine', 'data-cote': COTE }, calque, survol, barre, panneau, popover, toast, maj);
    ombre.append(racine);
    document.documentElement.append(hote);

    // Le prototype ne voit ni les clics ni les frappes faits dans l'outil.
    for (const t of ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'keypress', 'input', 'focusin', 'focusout']) {
      hote.addEventListener(t, (e) => e.stopPropagation());
    }
    ombre.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (etat.popover) { e.preventDefault(); fermerPopover(); } else if (etat.panneau) { e.preventDefault(); fermerPanneau(); }
    });
  }

  const estDansOutil = (e) => !!hote && e.composedPath().includes(hote);
  const estMobile = () => window.innerWidth <= LARGEUR_MOBILE;

  function rendre() {
    rendreBarre();
    rendrePins();
    rendrePanneau();
    const pop = etat.popover;
    if (pop && pop.type === 'detail') {
      const r = trouver(pop.id);
      if (!r) fermerPopover();
      else if (JSON.stringify(r) !== pop.sig) rendrePopover();
    }
    planifier();
  }

  function rendreBarre() {
    barreNormale.hidden = etat.placement;
    barrePlacement.hidden = !etat.placement;
    racine.classList.toggle('en-placement', etat.placement);
    rendreMaj();
    const c = comptes(etat.remarques);
    compteurBarre.textContent = etat.charge ? String(c.aTraiter) : etat.erreur ? '!' : '…';
    boutonListe.setAttribute('aria-expanded', String(etat.panneau));
    const nouvelles = etat.charge ? nbNonLues() : 0;
    nouvellesBarre.hidden = !nouvelles;
    nouvellesBarre.textContent = nouvelles ? nouvelles + (nouvelles > 1 ? ' nouvelles réponses' : ' nouvelle réponse') : '';
    boutonListe.setAttribute('aria-label', 'Afficher toutes les remarques' + (etat.charge ? ' (' + libelleATraiter(c) + ')' : '')
      + (nouvelles ? ', ' + nouvellesBarre.textContent : ''));
  }

  function rendrePins() {
    for (const [id, b] of pins) if (!trouver(id)) { b.remove(); pins.delete(id); }
    for (const r of etat.remarques) {
      let b = pins.get(r.id);
      if (!b) {
        const id = r.id;
        // Masquée jusqu'au prochain calcul de position, pour ne pas apparaître en haut à gauche.
        b = h('button', { class: 'pin', type: 'button', hidden: true, onclick: () => basculerDetail(id) });
        calque.append(b);
        pins.set(id, b);
      }
      b.textContent = String(r.numero);
      b.classList.toggle('traitee', !!r.traitee);
      b.classList.toggle('en-cours', enCours(r));
      b.classList.toggle('non-lue', nonLue(r));
      b.title = r.titre;
      b.setAttribute('aria-label', 'Remarque n°' + r.numero + ' : ' + r.titre + (r.traitee ? ' (traitée)' : enCours(r) ? ' (en cours)' : '') + (nonLue(r) ? ' (nouvelle réponse)' : ''));
    }
  }

  function rendrePanneau() {
    racine.classList.toggle('panneau-ouvert', etat.panneau);
    panneau.classList.toggle('ouvert', etat.panneau);
    panneau.setAttribute('aria-hidden', String(!etat.panneau));
    if ('inert' in panneau) panneau.inert = !etat.panneau;

    const page = pageCourante();
    const dansPortee = etat.remarques.filter((r) => etat.portee === 'tout' || r._page === page);
    const c = comptes(dansPortee);
    panneauSous.textContent = etat.charge
      ? libelleATraiter(c) + ' · ' + c.traitees + (c.traitees > 1 ? ' traitées' : ' traitée')
      : etat.erreur ? 'Remarques indisponibles' : 'Chargement…';
    const libelles = { ouvertes: ['À traiter', c.aTraiter], en_cours: ['En cours', c.enCours], traitees: ['Traitées', c.traitees], toutes: ['Toutes', dansPortee.length] };
    for (const b of segments.children) {
      const [libelle, n] = libelles[b.dataset.filtre];
      b.replaceChildren(libelle, h('span', { class: 'seg-n', text: String(n) }));
      b.setAttribute('aria-pressed', String(etat.filtre === b.dataset.filtre));
    }
    choixPortee.value = etat.portee;
    interrupteur.setAttribute('aria-checked', String(etat.pastilles));
    if (!etat.panneau) return;

    if (!etat.charge) {
      liste.replaceChildren(etat.erreur
        ? h('div', { class: 'vide' }, h('p', { text: etat.erreur }), h('button', { class: 'btn btn-secondaire', type: 'button', text: 'Réessayer', onclick: charger }))
        : h('div', { class: 'vide' }, h('p', { text: 'Chargement des remarques…' })));
      return;
    }
    const choisies = dansPortee.filter(dansLeFiltre);
    if (!choisies.length) {
      const message = !etat.remarques.length
        ? 'Aucune remarque pour l’instant. Cliquez sur « Remarque », puis à l’endroit concerné du prototype.'
        : etat.portee === 'page' && !dansPortee.length ? 'Aucune remarque sur cette page.'
          : etat.filtre === 'ouvertes' ? 'Aucune remarque à traiter.'
            : etat.filtre === 'en_cours' ? 'Aucune remarque en cours.'
            : etat.filtre === 'traitees' ? 'Aucune remarque traitée pour l’instant.' : 'Aucune remarque.';
      liste.replaceChildren(h('div', { class: 'vide' }, h('p', { text: message })));
      return;
    }

    // Les nouvelles réponses en tête, toutes pages confondues ; le reste regroupé par page quand le prototype en a
    // plusieurs, la page affichée en premier.
    const nouvelles = choisies.filter(nonLue);
    const contenu = nouvelles.length
      ? [h('p', { class: 'groupe', text: 'Nouvelles réponses' }), h('ul', { class: 'items' }, nouvelles.map(item))]
      : [];
    const groupes = new Map();
    for (const r of choisies.filter((x) => !nonLue(x))) {
      if (!groupes.has(r._page)) groupes.set(r._page, []);
      groupes.get(r._page).push(r);
    }
    const ordre = [...groupes.keys()].sort((a, b) => (b === page) - (a === page) || groupes.get(a)[0].numero - groupes.get(b)[0].numero);
    for (const cle of ordre) {
      const items = groupes.get(cle);
      if (groupes.size > 1 || cle !== page || nouvelles.length) {
        const nom = items[0].page_titre || items[0].chemin;
        contenu.push(h('p', { class: 'groupe', text: (cle === page ? 'Cette page · ' : '') + nom }));
      }
      contenu.push(h('ul', { class: 'items' }, items.map(item)));
    }
    liste.replaceChildren(...contenu);
  }

  function item(r) {
    return h('li', { class: 'item' + (r.traitee ? ' traitee' : '') },
      h('button', { class: 'item-corps', type: 'button', onclick: () => allerA(r.id), 'aria-label': 'Aller à la remarque n°' + r.numero + ' : ' + r.titre + (nonLue(r) ? ' (nouvelle réponse)' : '') },
        h('span', { class: classeNum(r), text: String(r.numero) }),
        h('span', { class: 'item-texte' },
          h('span', { class: 'item-titre', text: r.titre }),
          enCours(r) ? h('span', { class: 'item-etat', text: 'En cours' }) : null,
          nonLue(r) ? h('span', { class: 'item-nouvelle', text: 'Nouvelle réponse' }) : null,
          approximatif(r) ? h('span', { class: 'item-replacer item-approx', title: 'L’élément n’existe plus : la pastille est à l’endroit approximatif où vous l’aviez posée. Ouvrez-la puis « Déplacer » pour la replacer.' }, icone('deplacer'), 'Endroit approximatif') : null,
          aReplacer(r) ? h('span', { class: 'item-replacer', title: 'Nous ne retrouvons plus l’endroit de cette remarque. Ouvrez-la puis « Déplacer » pour nous le montrer.' }, icone('deplacer'), 'Endroit à préciser') : null,
          r.description ? h('span', { class: 'item-desc', text: r.description }) : null,
          h('span', { class: 'item-meta', text: r.auteur + ' · ' + dateCourte(r.cree_le) }))),
      h('button', {
        class: 'item-check', type: 'button', 'aria-pressed': String(!!r.traitee),
        'aria-label': r.traitee ? 'Rouvrir la remarque n°' + r.numero : 'Marquer la remarque n°' + r.numero + ' comme traitée',
        title: r.traitee ? 'Rouvrir' : 'Marquer comme traitée', onclick: () => basculerTraitee(r.id),
      }, icone('check')));
  }

  const hauteurPage = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);

  // Élément disparu de la page, mais l'ancre garde sa position dans la page (posée par un widget récent) : endroit approximatif.
  // Une ancre d'avant, sans ces clés, garde « Endroit à préciser ».
  function approximatif(r) {
    const a = r.ancre;
    if (!a || a.ouvreur || r._page !== pageCourante()) return false;
    return Number.isFinite(a.page_y) && a.hauteur_page > 0 && !endroit(r).c;
  }

  // Point de la pastille approximative, en coordonnées d'écran : la position notée suit la hauteur actuelle de la page.
  function pointApproche(r) {
    const a = r.ancre;
    const rx = Number.isFinite(a.page_rx) ? a.page_rx : 0.5;
    return { x: rx * document.documentElement.clientWidth - window.scrollX, y: (a.page_y / a.hauteur_page) * hauteurPage() - window.scrollY };
  }

  // Remarques dont l'élément est dans la page mais n'a pu être révélé au clic (display:none, aucun ouvreur trouvé, rien après les essais).
  const introuvables = new Set();
  const TEXTE_A_PRECISER = 'Nous ne retrouvons plus l’endroit de cette remarque. Utilisez « Déplacer » pour nous le montrer.';

  // Sans ouvreur, « Endroit à préciser » vaut pour un élément absent de la page sans position notée, et pour un élément présent
  // que le clic n'a pas réussi à révéler (display:none ou visibility:hidden, aucun ouvreur trouvé). Un élément seulement caché
  // au chargement (onglet, menu, FAQ fermés, fondu) n'est pas « à préciser » : le clic le rouvre.
  function aReplacer(r) {
    if (r._page !== pageCourante() || (r.ancre && r.ancre.ouvreur)) return false;
    return (!endroit(r).c && !approximatif(r)) || introuvables.has(r.id);
  }

  /* ------------------------------------------------------------------ popover : détail et formulaire */

  function rendrePopover() {
    const pop = etat.popover;
    popover.replaceChildren();
    popover.hidden = !pop;
    // Le texte gardé ne vit qu'avec son formulaire : publié, annulé ou quitté, il est oublié.
    if (!pop || pop.type !== 'formulaire') oublierTexte();
    rendreMaj();
    if (!pop) { planifier(); return; }
    if (pop.type === 'detail') {
      const r = trouver(pop.id);
      if (!r) { etat.popover = null; popover.hidden = true; return; }
      pop.sig = JSON.stringify(r);
      if (marquerLue(r)) { rendreBarre(); rendrePins(); rendrePanneau(); }
      popover.append(...vueDetail(r, pop).filter(Boolean));
    } else if (pop.type === 'deplacer') {
      const r = trouver(pop.id);
      if (!r || !etat.brouillon) { etat.popover = null; etat.brouillon = null; popover.hidden = true; planifier(); return; }
      popover.append(vueDeplacer(r));
    } else if (pop.type === 'repondre') {
      const r = trouver(pop.id);
      if (!r) { etat.popover = null; popover.hidden = true; planifier(); return; }
      popover.append(vueRepondre(r, pop));
    } else {
      // Modification reprise après un rechargement, liste pas encore chargée : le numéro gardé suffit au formulaire.
      popover.append(vueFormulaire(pop.id ? trouver(pop.id) || { id: pop.id, numero: pop.numero } : null, pop));
    }
    placerPopover();
    planifier();
  }

  // Durée réelle depuis un message du fil : « il y a 2 h », puis la date au-delà d'une semaine.
  function depuis(iso) {
    const d = new Date(iso);
    const s = (Date.now() - d) / 1000;
    if (s < 60) return 'à l’instant';
    if (s < 3600) return 'il y a ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'il y a ' + Math.floor(s / 3600) + ' h';
    if (s < 7 * 86400) return 'il y a ' + Math.floor(s / 86400) + ' j';
    return 'le ' + jourDe(d);
  }
  // Le fil de la Remarque, du plus ancien au plus récent : { type: 'equipe' | 'client', texte, le, modifie, auteur }.
  // Sans `fil` (réponse d'un serveur d'avant le fil), la réponse unique `reponse` en tient lieu. Texte vide : rien d'affiché.
  function filDe(r) {
    if (Array.isArray(r.fil)) return r.fil.filter((m) => m && typeof m.texte === 'string' && m.texte.trim());
    const reponse = typeof r.reponse === 'string' ? r.reponse.trim() : '';
    return reponse ? [{ type: 'equipe', texte: reponse, le: r.reponse_le, modifie: false }] : [];
  }
  function vueFil(r) {
    const fil = filDe(r);
    if (!fil.length) return null;
    return h('div', { class: 'pop-fil' }, fil.map((m) => {
      const equipe = m.type !== 'client';
      const tete = (equipe ? 'Réponse de l’équipe' : m.auteur || 'Relecteur') + (m.le ? ' · ' + depuis(m.le) : '');
      return h('div', { class: 'pop-reponse' + (equipe ? '' : ' client') },
        h('p', { class: 'pop-reponse-label' }, tete, m.modifie ? h('span', { class: 'pop-modifie', text: ' · modifié' }) : null),
        h('p', { class: 'pop-reponse-texte', text: m.texte.trim() }));
    }));
  }
  // « modifiée par X » dès qu'un autre nom que l'auteur a modifié (X = nom saisi dans son navigateur), sinon « modifiée »
  // après la première minute ; rien sinon.
  function mentionModifiee(r) {
    const par = espaces(r.modifiee_par);
    if (par && par !== espaces(r.auteur)) return ' · modifiée par ' + par;
    return new Date(r.modifie_le) - new Date(r.cree_le) > 60000 ? ' · modifiée' : '';
  }

  function vueDetail(r, pop) {
    const ligne = ligneCible(r);
    const enfants = [
      h('div', { class: 'pop-tete' },
        h('span', { class: classeNum(r), text: String(r.numero) }),
        h('span', { class: 'statut' + (r.traitee ? ' ok' : enCours(r) ? ' en-cours' : ''), text: r.traitee ? 'Traitée' : enCours(r) ? 'En cours' : 'À traiter' }),
        boutonIcone('x', 'Fermer', fermerPopover)),
      h('h3', { class: 'pop-titre' + (r.traitee ? ' raye' : ''), text: r.titre }),
      r.description ? h('p', { class: 'pop-desc', text: r.description }) : null,
      vueFil(r),
      // Répondre au fil, sans modifier la Remarque : sur toutes, même celle d'un collègue que l'équipe n'a pas encore lue.
      !pop.confirmer
        ? h('button', { class: 'btn btn-secondaire btn-repondre', type: 'button', onclick: () => { etat.popover = { type: 'repondre', id: r.id }; rendrePopover(); } }, icone('liste'), 'Répondre')
        : null,
      h('p', { class: 'pop-meta', text: r.auteur + ', ' + dateLongue(r.cree_le) + mentionModifiee(r) }),
      ligne ? h('p', { class: 'pop-meta', text: ligne }) : null,
      // Au toucher, l'infobulle de la liste ne s'affiche pas : la fiche le dit en clair.
      approximatif(r) ? h('p', { class: 'pop-a-preciser pop-approx' }, icone('deplacer'), 'L’élément de cette remarque n’existe plus : la pastille est à l’endroit approximatif où elle a été posée. Cliquez sur « Déplacer » pour la replacer.') : null,
      aReplacer(r) ? h('p', { class: 'pop-a-preciser' }, icone('deplacer'), TEXTE_A_PRECISER) : null,
      r._page !== pageCourante() ? h('p', { class: 'pop-meta', text: 'Page : ' + (r.page_titre || r.chemin) }) : null,
      r.traitee ? h('p', { class: 'pop-meta ok' }, icone('check'), 'Traitée ' + dateLongue(r.traitee_le) + (r.traitee_par ? ' par ' + r.traitee_par : '')) : null,
    ];
    if (pop.confirmer) {
      enfants.push(h('div', { class: 'confirmer' },
        h('p', { text: 'Supprimer la remarque n°' + r.numero + ' pour tout le monde ?' }),
        h('div', { class: 'form-actions' },
          h('button', { class: 'btn btn-fantome', type: 'button', text: 'Annuler', onclick: () => { pop.confirmer = false; rendrePopover(); } }),
          h('button', { class: 'btn btn-danger-plein', type: 'button', text: 'Supprimer', onclick: () => supprimer(r.id) }))));
    } else {
      enfants.push(h('div', { class: 'pop-actions' },
        // C'est l'équipe qui traite : le client n'a pas à se croire chargé de fermer sa Remarque, d'où un bouton secondaire.
        h('button', { class: 'btn btn-large btn-secondaire', type: 'button', onclick: () => basculerTraitee(r.id, true) },
          icone(r.traitee ? 'rouvrir' : 'check'), r.traitee ? 'Rouvrir la remarque' : 'Marquer comme traitée'),
        h('div', { class: 'pop-secondaires' },
          h('button', { class: 'btn btn-fantome', type: 'button', onclick: () => { etat.popover = { type: 'formulaire', id: r.id }; rendrePopover(); } }, icone('crayon'), 'Modifier'),
          r._page === pageCourante() ? h('button', { class: 'btn btn-fantome', type: 'button', onclick: () => demarrerDeplacement(r.id) }, icone('deplacer'), 'Déplacer') : null,
          h('button', { class: 'btn btn-fantome', type: 'button', onclick: () => copierLien(r.id) }, icone('lien'), 'Copier le lien'),
          h('button', { class: 'btn btn-fantome btn-danger', type: 'button', onclick: () => { pop.confirmer = true; rendrePopover(); } }, icone('poubelle'), 'Supprimer'))));
    }
    return enfants;
  }

  // Confirmation du nouvel endroit : rien ne part avant « Déplacer ici » ; Échap ou Annuler laissent la Pastille en place.
  function vueDeplacer(r) {
    const erreur = h('p', { class: 'erreur', role: 'alert', hidden: true });
    const ok = h('button', { class: 'btn btn-principal', type: 'button', text: 'Déplacer ici' });
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        await confirmerDeplacement(r);
      } catch (err) {
        erreur.textContent = err.message;
        erreur.hidden = false;
        ok.disabled = false;
      }
    });
    setTimeout(() => ok.focus({ preventScroll: true }), 30);
    return h('div', { class: 'formulaire' },
      h('div', { class: 'pop-tete' },
        h('span', { class: 'num', text: String(r.numero) }),
        h('strong', { class: 'pop-label', text: 'Déplacer la remarque n°' + r.numero }),
        boutonIcone('x', 'Annuler', fermerPopover)),
      h('p', { class: 'cible', text: 'Nouvel endroit : ' + libelleCible(etat.brouillon.ancre) }),
      erreur,
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn btn-fantome', type: 'button', text: 'Annuler', onclick: fermerPopover }),
        ok));
  }

  async function confirmerDeplacement(r) {
    const b = etat.brouillon;
    // L'écran a pu changer (route, retour) depuis « Déplacer » : jamais d'ancre prise sur une autre page.
    if (r._page !== pageCourante()) throw new Error('Une remarque ne peut pas changer de page : revenez sur sa page pour la déplacer.');
    ajouterOuRemplacer(await api('PATCH', r.id, { ancre: b.ancre, par: lire(CLE_NOM) || '' }));
    cache.set(r.id, { el: b.el, clips: ancetresQuiCoupent(b.el) });
    etat.brouillon = null;
    etat.popover = { type: 'detail', id: r.id };
    rendrePopover();
    rendre();
    pulser(r.id);
    afficherToast('Remarque n°' + r.numero + ' déplacée.');
  }

  // Réponse au fil : un message client, au nom saisi dans ce navigateur (demandé ici s'il manque).
  // Pas de renvoi automatique : une réponse perdue renvoyée seule ferait un doublon dans le fil.
  function vueRepondre(r, pop) {
    const zone = h('textarea', { id: 'f-reponse', maxlength: '5000', rows: '4' });
    zone.value = pop.texte || '';
    const nomGarde = espaces(lire(CLE_NOM) || '');
    // Décidé à l'ouverture : le nom se garde dès la frappe, le champ ne doit pas disparaître au rendu suivant.
    if (pop.demanderNom === undefined) pop.demanderNom = !nomGarde;
    const nom = pop.demanderNom ? h('input', { id: 'f-reponse-nom', type: 'text', maxlength: '80', autocomplete: 'name', required: true }) : null;
    if (nom) nom.value = pop.nom || '';
    const erreur = h('p', { class: 'erreur', role: 'alert', hidden: true });
    const envoi = h('button', { class: 'btn btn-principal', type: 'submit', text: LIBELLE_REPONSE });
    const retour = () => { etat.popover = { type: 'detail', id: r.id }; rendrePopover(); };
    const form = h('form', { class: 'formulaire', novalidate: true },
      h('div', { class: 'pop-tete' },
        h('span', { class: 'num', text: String(r.numero) }),
        h('strong', { class: 'pop-label', text: 'Répondre' }),
        boutonIcone('x', 'Annuler', retour)),
      vueFil(r),
      champ('Votre réponse', zone),
      nom ? champ('Votre nom', nom) : null,
      erreur,
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn btn-fantome', type: 'button', text: 'Annuler', onclick: retour }),
        envoi));
    form.addEventListener('input', (e) => {
      e.target.classList && e.target.classList.remove('invalide');
      erreur.hidden = true;
      pop.texte = zone.value;
      if (nom) { pop.nom = nom.value; garderNom(nom.value); }
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
    });
    const envoiReponse = { r, zone, nom, nomGarde, erreur, envoi, enVol: false };
    form.addEventListener('submit', (e) => { e.preventDefault(); envoyerReponse(envoiReponse); });
    setTimeout(() => zone.focus({ preventScroll: true }), 30);
    return form;
  }

  // Un seul envoi à la fois ; refus du serveur (400, 404, 429) ou coupure : son message, le texte reste dans le champ.
  async function envoyerReponse(f) {
    if (f.enVol) return;
    const texte = f.zone.value.trim();
    const par = f.nom ? espaces(f.nom.value) : f.nomGarde;
    const manquant = !texte ? f.zone : !par ? f.nom : null;
    if (manquant) {
      f.erreur.textContent = manquant === f.zone ? 'Écrivez votre réponse.' : 'Indiquez votre nom : il s’affiche avec votre réponse.';
      f.erreur.hidden = false;
      manquant.classList.add('invalide');
      manquant.focus();
      return;
    }
    f.enVol = true;
    f.envoi.disabled = true;
    f.envoi.textContent = 'Envoi…';
    try {
      const vue = await api('POST', f.r.id, { texte, par, relecteur: identifiantRelecteur() }, null, 'reponses');
      if (f.nom) ecrire(CLE_NOM, par);
      ajouterOuRemplacer(vue);
      etat.popover = { type: 'detail', id: f.r.id };
      rendrePopover();
      rendre();
      afficherToast('Réponse envoyée. Elle est visible par tout le monde.');
    } catch (err) {
      f.erreur.textContent = err.message;
      f.erreur.hidden = false;
      f.envoi.disabled = false;
      f.envoi.textContent = LIBELLE_REPONSE;
    } finally {
      f.enVol = false;
    }
  }

  function champ(libelle, controle, aide) {
    return h('div', { class: 'champ' },
      h('label', { for: controle.id }, libelle, aide ? h('span', { class: 'aide', text: ' · ' + aide }) : null),
      controle);
  }

  // Une Remarque ouverte (pas traitée) sur le même élément de la même page : on le dit avant un doublon ; un clic l'ouvre.
  function ligneDejaSignale() {
    const a = etat.brouillon && etat.brouillon.ancre;
    if (!a || !a.selecteur) return null;
    const meme = etat.remarques.find((x) => !x.traitee && x._page === pageCourante() && x.ancre && x.ancre.selecteur === a.selecteur);
    if (!meme) return null;
    return h('button', { class: 'deja-signale', type: 'button', text: 'Déjà signalé ici : n°' + meme.numero + ' « ' + meme.titre + ' »', onclick: () => basculerDetail(meme.id) });
  }

  function vueFormulaire(r, pop) {
    const creation = !r;
    const texte = pop.texte;
    const titre = h('input', { id: 'f-titre', type: 'text', maxlength: '200', autocomplete: 'off', required: true });
    const description = h('textarea', { id: 'f-description', maxlength: '3000', rows: '4' });
    const nom = h('input', { id: 'f-nom', type: 'text', maxlength: '80', autocomplete: 'name', required: true });
    titre.value = texte ? texte.titre : r ? r.titre || '' : '';
    description.value = texte ? texte.description : r ? r.description || '' : '';
    nom.value = texte ? texte.auteur : r ? r.auteur || '' : lire(CLE_NOM) || '';
    const erreur = h('p', { class: 'erreur', role: 'alert', hidden: true });
    const attente = h('p', { class: 'attente', role: 'status', hidden: true, text: MESSAGE_COUPURE });

    // À chaque frappe : en mémoire (un nouveau rendu du formulaire le reprend) et dans l'onglet (un rechargement aussi).
    const garder = (enAttente) => {
      pop.texte = { ...(pop.texte || {}), titre: titre.value, description: description.value, auteur: nom.value, ...(enAttente ? { envoi: enAttente } : {}) };
      garderTexte({ ...pop.texte, page: pageCourante(), ...(r ? { id: r.id, numero: r.numero } : { ancre: etat.brouillon && etat.brouillon.ancre }) });
    };
    const libelleEnvoi = creation ? 'Publier la remarque' : 'Enregistrer';
    const envoi = h('button', { class: 'btn btn-principal', type: 'submit', text: libelleEnvoi });

    const form = h('form', { class: 'formulaire', novalidate: true },
      h('div', { class: 'pop-tete' },
        creation ? h('span', { class: 'num brouillon' }, icone('plus')) : h('span', { class: 'num', text: String(r.numero) }),
        h('strong', { class: 'pop-label', text: creation ? 'Nouvelle remarque' : 'Modifier la remarque n°' + r.numero }),
        boutonIcone('x', 'Annuler', fermerPopover)),
      creation && etat.brouillon ? h('p', { class: 'cible', text: 'Sur : ' + libelleCible(etat.brouillon.ancre) }) : null,
      creation ? ligneDejaSignale() : null,
      champ('Votre remarque, en une phrase', titre),
      champ('Détails (facultatif)', description),
      // Plusieurs relecteurs partagent le lien : en modification, le nom de l'auteur ne se change pas.
      creation ? champ('Votre nom', nom) : null,
      erreur,
      attente,
      h('div', { class: 'form-actions' },
        h('button', { class: 'btn btn-fantome', type: 'button', text: 'Annuler', onclick: fermerPopover }),
        envoi));

    form.addEventListener('input', (e) => {
      e.target.classList && e.target.classList.remove('invalide');
      erreur.hidden = true;
      garder();
      if (e.target === nom) garderNom(nom.value);
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
    });

    // Envoi raté pendant une mise en ligne : le texte reste gardé, et l'envoi repart seul toutes les 5 s jusqu'au retour
    // du serveur, avec les valeurs du moment. Formulaire fermé : on arrête.
    let enVol = false;
    let minuteur = 0;
    // Un seul renvoi programmé à la fois, même si la personne renvoie elle-même entre deux essais.
    const relancer = (ms) => {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => { if (form.isConnected) form.requestSubmit(); }, ms);
    };
    const attendreServeur = () => {
      attente.hidden = false;
      envoi.disabled = true;
      envoi.textContent = 'En attente…';
      relancer(REESSAI_MS);
    };

    // Réponse perdue pendant l'arrêt alors que la remarque était enregistrée : on la retrouve plutôt que d'en créer une deuxième.
    async function dejaPubliee(valeurs, connues) {
      const donnees = await api('GET');
      return ((donnees && donnees.remarques) || []).find((x) => !connues.includes(x.id) && x.titre === valeurs.titre
        && x.auteur === valeurs.auteur && (x.description || '') === valeurs.description && x.chemin === cheminCourant()) || null;
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (enVol) return;
      const valeurs = { titre: espaces(titre.value), description: description.value.trim(), auteur: espaces(nom.value) };
      const manquant = !valeurs.titre ? titre : creation && !valeurs.auteur ? nom : null;
      if (manquant) {
        erreur.textContent = manquant === titre ? 'Écrivez votre remarque en une phrase.' : 'Indiquez votre nom : il s’affiche avec la remarque.';
        erreur.hidden = false;
        manquant.classList.add('invalide');
        manquant.focus();
        // Champ vidé pendant l'attente du serveur : le renvoi s'arrête, la personne renverra elle-même.
        attente.hidden = true;
        envoi.disabled = false;
        envoi.textContent = libelleEnvoi;
        return;
      }
      envoi.disabled = true;
      if (attente.hidden) envoi.textContent = 'Enregistrement…';
      enVol = true;
      // Remarques déjà là avant le premier essai : gardées avec le texte, elles survivent à un rechargement.
      // Liste jamais chargée : inconnues (null), et on ne cherche pas de doublon plutôt que d'en deviner un.
      const connues = pop.texte && pop.texte.envoi ? pop.texte.envoi.connues : etat.charge ? etat.remarques.map((x) => x.id) : null;
      try {
        if (creation) {
          const b = etat.brouillon;
          const nouvelle = (connues && pop.texte && pop.texte.envoi && await dejaPubliee(valeurs, connues)) || await api('POST', null, {
            ...valeurs,
            relecteur: identifiantRelecteur(),
            // Adresse complète : le relais en tire le lien « ?remarque=N » de la note (absent si la page n'est pas en http).
            page: (/^https?:/.test(location.protocol) ? location.origin + cheminCourant() : pageCourante()).slice(0, 2048),
            chemin: cheminCourant(), page_titre: espaces(document.title).slice(0, 200),
            ancre: b.ancre,
          });
          ecrire(CLE_NOM, valeurs.auteur);
          ajouterOuRemplacer(nouvelle);
          if (b.el) cache.set(nouvelle.id, { el: b.el, clips: ancetresQuiCoupent(b.el) });
          etat.brouillon = null;
          etat.popover = null;
          rendrePopover();
          rendre();
          pulser(nouvelle.id);
          afficherToast('Remarque n°' + nouvelle.numero + ' publiée. Elle est visible par tout le monde.');
        } else {
          // Qui modifie = le nom saisi dans ce navigateur ; l'auteur reste celui de la Remarque.
          ajouterOuRemplacer(await api('PATCH', r.id, { titre: valeurs.titre, description: valeurs.description, par: lire(CLE_NOM) || '' }));
          etat.popover = { type: 'detail', id: r.id };
          rendrePopover();
          rendre();
          afficherToast('Remarque n°' + r.numero + ' modifiée.');
        }
      } catch (err) {
        if (err.coupure) {
          garder({ connues });
          attendreServeur();
          return;
        }
        // Refus du serveur : plus de renvoi automatique, la personne corrige et renvoie elle-même.
        if (pop.texte && pop.texte.envoi) { delete pop.texte.envoi; garder(); }
        attente.hidden = true;
        erreur.textContent = err.message;
        erreur.hidden = false;
        envoi.disabled = false;
        envoi.textContent = libelleEnvoi;
      } finally {
        enVol = false;
      }
    });
    // Repris après un rechargement alors qu'un envoi attendait le serveur : il repart seul.
    if (texte && texte.envoi) relancer(30);
    setTimeout(() => (r ? description : titre).focus({ preventScroll: true }), 30);
    return form;
  }

  function placerPopover() {
    const pop = etat.popover;
    if (!pop || popover.hidden) return;
    if (estMobile()) { popover.classList.add('feuille'); popover.style.transform = ''; return; }
    popover.classList.remove('feuille');
    let p = null;
    if (pop.id && pop.type !== 'deplacer') {
      const r = trouver(pop.id);
      const c = r && r._page === pageCourante() ? elementDe(r) : null;
      if (c) p = pointDe(c.el, r.ancre, c.clips, true);
      else if (r && approximatif(r)) p = pointApproche(r);
    } else if (etat.brouillon && etat.brouillon.el) {
      p = pointDe(etat.brouillon.el, etat.brouillon.ancre);
    }
    const l = popover.offsetWidth;
    const ht = popover.offsetHeight;
    const gauche = 12 + (etat.panneau && COTE === 'gauche' ? LARGEUR_PANNEAU : 0);
    const droite = window.innerWidth - 12 - (etat.panneau && COTE === 'droite' ? LARGEUR_PANNEAU : 0);
    let x;
    let y;
    if (p) {
      x = p.x + TAILLE_PIN / 2 + 14;
      if (x + l > droite) x = p.x - l - 14;
      y = p.y - TAILLE_PIN - 6;
    } else {
      x = (gauche + droite - l) / 2;
      y = (window.innerHeight - ht) / 2;
    }
    x = Math.max(gauche, Math.min(droite - l, x));
    y = Math.max(12, Math.min(window.innerHeight - ht - 76, y));
    popover.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }

  /* ------------------------------------------------------------------ positions (à chaque défilement et 3 fois par seconde) */

  let planifie = false;
  let dernierePage = null;
  function planifier() {
    if (planifie) return;
    planifie = true;
    requestAnimationFrame(positionner);
  }

  // Règle unique des Pastilles : « À traiter » cache celles des Remarques traitées ; la Remarque ouverte garde la sienne ;
  // l'interrupteur « Pastilles » éteint prime sur tout le reste.
  const pastilleVisible = (r, actif) => r.id === actif || (etat.pastilles && !(etat.filtre === 'ouvertes' && r.traitee));

  // Un <dialog> ouvert par showModal() passe dans la couche supérieure du navigateur : il recouvre tout z-index
  // et rend le reste de la page inerte, l'outil compris. Tant qu'il est ouvert, l'outil se loge donc dedans.
  function heberger() {
    let modale = null;
    // Plusieurs modales empilées : la dernière ouverte est au-dessus, l'outil va dans celle-là.
    try { const modales = document.querySelectorAll('dialog:modal'); modale = modales[modales.length - 1] || null; } catch (_) { /* navigateur sans :modal */ }
    const cible = modale || document.documentElement;
    if (hote.parentNode !== cible) cible.append(hote);
  }

  function positionner() {
    planifie = false;
    heberger();
    const page = pageCourante();
    if (page !== dernierePage) {
      // Changement d'écran sans rechargement (routeur, ancre) : on recherche les éléments.
      if (dernierePage !== null) { cache.clear(); rendrePanneau(); }
      dernierePage = page;
    }
    const actif = etat.popover && etat.popover.type === 'detail' ? etat.popover.id : null;
    for (const r of etat.remarques) {
      const b = pins.get(r.id);
      if (!b) continue;
      let p = null;
      let approx = false;
      if (r._page === page && pastilleVisible(r, actif)) {
        const c = elementDe(r);
        if (c) p = pointDe(c.el, r.ancre, c.clips, r.id === actif);
        else if (approximatif(r)) { p = pointApproche(r); approx = true; }
      }
      if (!p) { b.hidden = true; continue; }
      b.hidden = false;
      b.classList.toggle('approx', approx);
      b.style.transform = 'translate(' + Math.round(p.x) + 'px,' + Math.round(p.y - TAILLE_PIN) + 'px)';
      b.classList.toggle('actif', r.id === actif);
    }
    // Texte repris après un rechargement : l'élément de la pose peut n'apparaître qu'après le rendu du prototype.
    if (etat.brouillon && !etat.brouillon.el) etat.brouillon.el = trouverElement(etat.brouillon.ancre);
    const p = etat.brouillon && etat.brouillon.el && pointDe(etat.brouillon.el, etat.brouillon.ancre);
    pinBrouillon.hidden = !p;
    if (p) pinBrouillon.style.transform = 'translate(' + Math.round(p.x) + 'px,' + Math.round(p.y - TAILLE_PIN) + 'px)';
    placerPopover();
  }

  /* ------------------------------------------------------------------ coin de la barre */

  // La barre monte au-dessus des éléments fixes du prototype qui occupent son coin
  // (sélecteur de démo, bulle de chat, bandeau cookies…) au lieu de les recouvrir.
  let decalage = 0;
  function ancetreFixe(el) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).position === 'fixed') return n;
    }
    return null;
  }
  function eviterLeCoin() {
    if (!barre || etat.panneau) return;
    const l = barre.offsetWidth;
    const ht = barre.offsetHeight;
    if (!l) return;
    const marge = estMobile() ? 14 : 20;
    const x0 = COTE === 'droite' ? window.innerWidth - marge - l : marge;
    const y0 = window.innerHeight - marge - ht;
    const fixes = new Set();
    for (let i = 0; i <= 4; i += 1) {
      for (const y of [y0 + 3, y0 + ht - 3]) {
        const x = Math.min(window.innerWidth - 1, Math.max(0, x0 + (l * i) / 4));
        for (const el of document.elementsFromPoint(x, Math.min(window.innerHeight - 1, y))) {
          if (el === hote || el === document.body || el === document.documentElement) continue;
          const f = ancetreFixe(el);
          if (f) fixes.add(f);
        }
      }
    }
    let hauteur = 0;
    for (const f of fixes) {
      const r = f.getBoundingClientRect();
      if (r.height > window.innerHeight * 0.4) continue; // fenêtre ou voile plein écran : on ne fuit pas
      hauteur = Math.max(hauteur, window.innerHeight - r.top);
    }
    const nouveau = hauteur ? Math.round(hauteur + 12 - marge) : 0;
    if (nouveau !== decalage) {
      decalage = nouveau;
      racine.style.setProperty('--decalage', decalage + 'px');
    }
  }

  /* ------------------------------------------------------------------ actions */

  const EVENEMENTS_BLOQUES = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];
  let styleCurseur = null;

  function demarrerPlacement() {
    if (etat.placement) return;
    fermerPopover();
    if (estMobile()) fermerPanneau();
    etat.placement = true;
    etat.deplacement = null;
    consigne.textContent = 'Cliquez à l’endroit à commenter';
    styleCurseur = document.createElement('style');
    styleCurseur.setAttribute('data-remarques-gwh', '');
    styleCurseur.textContent = 'html, html * { cursor: crosshair !important; }';
    (document.head || document.documentElement).append(styleCurseur);
    for (const t of EVENEMENTS_BLOQUES) window.addEventListener(t, intercepter, true);
    window.addEventListener('pointermove', suivreSurvol, true);
    rendreBarre();
  }

  // Même mécanique que la pose ; la cible est une Remarque de cette page, jamais une autre page.
  function demarrerDeplacement(id) {
    const r = trouver(id);
    if (!r || r._page !== pageCourante()) return;
    demarrerPlacement();
    etat.deplacement = id;
    consigne.textContent = 'Cliquez le nouvel endroit de la remarque n°' + r.numero;
  }

  function arreterPlacement() {
    if (!etat.placement) return;
    etat.placement = false;
    etat.deplacement = null;
    if (styleCurseur) styleCurseur.remove();
    styleCurseur = null;
    for (const t of EVENEMENTS_BLOQUES) window.removeEventListener(t, intercepter, true);
    window.removeEventListener('pointermove', suivreSurvol, true);
    survol.hidden = true;
    rendreBarre();
  }

  // En mode placement, le prototype ne reçoit aucun clic : on ne déclenche ni lien ni bouton.
  function intercepter(e) {
    if (estDansOutil(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e.button === 0) placer(e);
  }

  function suivreSurvol(e) {
    if (estDansOutil(e)) { survol.hidden = true; return; }
    const r = cibleDe(e).getBoundingClientRect();
    survol.hidden = false;
    survol.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
    survol.style.width = r.width + 'px';
    survol.style.height = r.height + 'px';
  }

  function placer(e) {
    const el = cibleDe(e);
    const ancre = ancreDe(el, e.clientX, e.clientY);
    const deplacee = etat.deplacement;
    arreterPlacement();
    etat.brouillon = { el, ancre };
    etat.popover = deplacee ? { type: 'deplacer', id: deplacee } : { type: 'formulaire' };
    rendrePopover();
  }

  function fermerPopover() {
    if (!etat.popover) return;
    if (sansBrouillon(etat.popover)) etat.brouillon = null;
    etat.popover = null;
    rendrePopover();
  }

  // Le brouillon (pose ou nouvel endroit) meurt avec la vue qui l'utilise.
  const sansBrouillon = (pop) => pop.type === 'deplacer' || (pop.type === 'formulaire' && !pop.id);

  function basculerDetail(id) {
    if (etat.popover && etat.popover.type === 'detail' && etat.popover.id === id) { fermerPopover(); return; }
    if (etat.popover && sansBrouillon(etat.popover)) etat.brouillon = null;
    etat.popover = { type: 'detail', id };
    rendrePopover();
  }

  function ouvrirPanneau() { etat.panneau = true; rendrePanneau(); rendreBarre(); charger(); planifier(); }
  function fermerPanneau() { if (!etat.panneau) return; etat.panneau = false; rendrePanneau(); rendreBarre(); planifier(); }
  function basculerPanneau() { if (etat.panneau) fermerPanneau(); else ouvrirPanneau(); }
  function choisirFiltre(f) { etat.filtre = f; ecrire(CLE_FILTRE, f); rendrePanneau(); planifier(); }

  // La notification « nouvelle réponse » : une seule, on va droit sur sa Remarque (sur « Toutes » si le filtre la cachait) ;
  // plusieurs, la liste s'ouvre sur « Toutes » et toutes les pages, les nouvelles réponses en tête.
  function allerAuxNouvelles() {
    const nouvelles = etat.remarques.filter(nonLue);
    if (!nouvelles.length) return;
    if (nouvelles.length === 1) {
      if (!dansLeFiltre(nouvelles[0])) choisirFiltre('toutes');
      allerA(nouvelles[0].id);
      return;
    }
    etat.portee = 'tout';
    choisirFiltre('toutes');
    if (!etat.panneau) ouvrirPanneau();
  }

  function basculerPastilles() {
    etat.pastilles = !etat.pastilles;
    ecrire(CLE_PASTILLES, etat.pastilles ? 'visibles' : 'masquees');
    rendrePanneau();
    planifier();
  }

  // Depuis la fiche, sous « À traiter » : marquer traitée ferme la fiche, sa Pastille disparaît aussitôt.
  async function basculerTraitee(id, depuisFiche) {
    const r = trouver(id);
    if (!r) return;
    const traitee = !r.traitee;
    try {
      ajouterOuRemplacer(await api('PATCH', id, { traitee, par: lire(CLE_NOM) || '' }));
      const fiche = etat.popover && etat.popover.type === 'detail' && etat.popover.id === id;
      if (depuisFiche && traitee && etat.filtre === 'ouvertes' && fiche) fermerPopover();
      rendre();
      // « Annuler » ne rouvre que si la Remarque est encore traitée (elle a pu être rouverte entre-temps).
      afficherToast(traitee ? 'Remarque n°' + r.numero + ' marquée comme traitée.' : 'Remarque n°' + r.numero + ' rouverte.', false,
        traitee ? { texte: 'Annuler', agir: () => { const x = trouver(id); if (x && x.traitee) basculerTraitee(id); } } : null);
    } catch (err) {
      afficherToast(err.message, true);
    }
  }

  async function supprimer(id) {
    const r = trouver(id);
    if (!r) return;
    try {
      await api('DELETE', id, null, { par: lire(CLE_NOM) || '' });
      etat.remarques = etat.remarques.filter((x) => x.id !== id);
      etat.signature = '';
      cache.delete(id);
      etat.popover = null;
      rendrePopover();
      rendre();
      afficherToast('Remarque n°' + r.numero + ' supprimée.');
    } catch (err) {
      afficherToast(err.message, true);
    }
  }

  async function copierLien(id) {
    const r = trouver(id);
    if (!r) return;
    const u = new URL(urlDe(r));
    u.searchParams.set(PARAM_LIEN, String(r.numero));
    try {
      await navigator.clipboard.writeText(u.href);
      afficherToast('Lien copié : il ouvre le prototype directement sur la remarque n°' + r.numero + '.');
    } catch (_) {
      window.prompt('Copiez ce lien :', u.href);
    }
  }

  // Depuis la liste : on change de page si besoin, on fait défiler jusqu'à la pastille et elle clignote.
  function allerA(id) {
    const r = trouver(id);
    if (!r) return;
    if (r._page === pageCourante()) { focaliser(id); return; }
    const cible = new URL(urlDe(r));
    const memeDocument = cible.pathname === location.pathname && cible.search === location.search;
    if (memeDocument) {
      location.hash = cible.hash;
      setTimeout(() => focaliser(id), 120);
      return;
    }
    ecrire(CLE_FOCUS, id, true);
    location.href = cible.href;
  }

  function focaliser(id) {
    if (estMobile()) fermerPanneau();
    let debut = Date.now();
    let rouvert = false;
    let amene = false;
    let clics = 0;
    const cliques = new Set(); // un seul clic par contrôle : s'il ne change rien, on n'insiste pas
    let debutRevelation = Date.now();
    const montrer = () => {
      setTimeout(() => {
        etat.popover = { type: 'detail', id };
        rendrePopover();
        pulser(id);
      }, reduit ? 30 : 450);
    };
    const essayer = () => {
      const r = trouver(id);
      if (!r) return;
      cache.delete(id);
      const c = elementDe(r);
      const present = !!(c && estVisible(c.el, false));
      if (!present && !rouvert) {
        rouvert = rouvrirFenetre(r.ancre);
        if (rouvert) debut = Date.now();
      }
      const revele = !!(present && pointDe(c.el, r.ancre, c.clips));
      if (revele) introuvables.delete(id);
      // Ce qui cache l'élément (onglet, menu, <details>, question de FAQ, diapo) se rouvre tout seul, mais seulement s'il reste
      // caché APRÈS le défilement et l'attente d'apparition : un simple fondu hors écran ne déclenche aucun clic.
      const apresAttente = amene && Date.now() - debutRevelation >= DELAI_AVANT_OUVREUR;
      if (c && !revele && (!present || apresAttente) && clics < 5 && rouvrirCachant(c.el, cliques)) { clics++; debutRevelation = Date.now(); }
      if (present) {
        // Présent : on descend jusqu'à lui, on attend (borné) qu'il apparaisse, puis la pastille s'ouvre sur son rectangle.
        if (!amene) { amene = true; debutRevelation = Date.now(); amenerALecran(c.el, r.ancre, c.clips); }
        if (amene && (revele || Date.now() - debutRevelation >= DELAI_REVELATION)) { montrer(); return; }
        setTimeout(essayer, 100);
        return;
      }
      if (Date.now() - debut < DELAI_DISPARITION) { setTimeout(essayer, 150); return; }
      if (!c && approximatif(r)) {
        // Élément disparu (après l'attente) mais position de la page notée à la pose : on y descend, la pastille est « approximative ».
        const p = pointApproche(r);
        window.scrollTo({ top: Math.max(0, p.y + window.scrollY - window.innerHeight / 2), behavior: reduit ? 'auto' : 'smooth' });
        montrer();
        return;
      }
      // Élément dans une fenêtre fermée (dialog, popover) : la personne peut l'ouvrir elle-même, le message « élément masqué » reste.
      const dansFenetre = !!(c && c.el.closest(SEL_FENETRE));
      if (!(r.ancre && r.ancre.ouvreur) && !dansFenetre) {
        // Aucun ouvreur connu : élément introuvable, ou présent mais impossible à révéler. « Endroit à préciser »,
        // avec le même texte que la fiche ; seul « Déplacer » répare.
        if (c) introuvables.add(id);
        afficherToast(TEXTE_A_PRECISER);
        rendrePanneau();
      } else {
        afficherToast('La pastille n°' + r.numero + ' est sur un élément masqué pour l’instant (fenêtre, onglet ou menu fermé). Ouvrez-le pour la voir.');
      }
      etat.popover = { type: 'detail', id };
      rendrePopover();
    };
    essayer();
  }

  const DELAI_REVELATION = 1500;
  const DELAI_AVANT_OUVREUR = 700; // plus long que le fondu d'apparition d'un bloc
  const DELAI_DISPARITION = 2500; // avant de conclure qu'un élément a disparu (page qui charge, bloc inséré plus tard)

  // Ce qui cache l'élément, déduit du balisage ARIA, sans ouvreur noté à la pose : un <details> fermé, ou le contrôle qui
  // commande un ancêtre porteur d'un id (aria-controls, ou aria-labelledby de la région) et dit « fermé » : aria-expanded="false"
  // (FAQ, menu) ou aria-selected="false" (onglet, point de diaporama), lu juste avant le clic. Jamais un lien, un champ, un bouton
  // d'envoi ou un contrôle de formulaire, jamais un contrôle déjà ouvert (il refermerait), un seul clic par contrôle.
  // Rend true si un geste a été fait.
  function rouvrirCachant(el, cliques) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.localName === 'details' && !n.open) {
        const resume = n.querySelector(':scope > summary');
        if (!(resume && resume.contains(el))) { n.open = true; return true; }
      }
      if (!n.id) continue;
      const controles = [];
      try { controles.push(...document.querySelectorAll('[aria-controls~="' + CSS.escape(n.id) + '"]')); } catch (_) { /* id inattendu */ }
      for (const idb of (n.getAttribute('aria-labelledby') || '').split(/\s+/)) {
        const b = idb && document.getElementById(idb);
        if (b) controles.push(b);
      }
      for (const b of controles) {
        const ferme = b.getAttribute('aria-expanded') === 'false' || b.getAttribute('aria-selected') === 'false';
        if (!ferme || cliques.has(b) || b.localName === 'a' || b.localName === 'input' || b.closest('form') || b.matches('[type="submit"]')) continue;
        cliques.add(b);
        b.click();
        return true;
      }
    }
    return false;
  }

  // Reclique l'ouvreur noté à la pose : la fenêtre se rouvre sans que la personne ait à la chercher.
  // Ne reclique que si l'élément est absent ou si sa fenêtre est fermée : un ouvreur bascule souvent, et refermerait
  // une fenêtre déjà ouverte. Fenêtre ouverte mais élément caché autrement : pas de clic, le repli prend la main.
  function rouvrirFenetre(a) {
    if (!a || !a.ouvreur) return false;
    const el = trouverElement(a);
    const f = el && el.closest(SEL_FENETRE);
    if (el && !(f && fenetreFermee(f))) return false;
    const o = trouverElement(a.ouvreur);
    if (!o || !estVisible(o)) return false;
    retenirOuvreur(o); // un clic programmé échappe à noterClic : sans ça, « Déplacer » perdrait l'ouvreur
    o.click();
    return true;
  }

  const fenetreFermee = (f) => (f.localName === 'dialog' && !f.open) || !estVisible(f);

  function amenerALecran(el, a, clips) {
    const comportement = reduit ? 'auto' : 'smooth';
    const r = el.getBoundingClientRect();
    // Élément coupé par un conteneur (diapo hors de la piste d'un diaporama) : on ne fait défiler que la page, pas le conteneur,
    // dont l'état (point de navigation sélectionné) serait faussé.
    const coupe = clips && clips.length && !pointDe(el, a, clips, true);
    if (r.height <= window.innerHeight * 0.7 && !coupe) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: comportement });
      return;
    }
    // Grand élément (section, page entière) : on centre le point de la pastille, pas l'élément.
    const y = r.top + a.ry * r.height;
    window.scrollBy({ top: y - window.innerHeight / 2, behavior: comportement });
  }

  function pulser(id) {
    const b = pins.get(id);
    if (!b) return;
    b.classList.remove('pulse');
    void b.offsetWidth;
    b.classList.add('pulse');
    setTimeout(() => b.classList.remove('pulse'), 3600);
  }

  let minuteurToast = 0;
  // action : { texte, agir } ajoute un bouton au message (« Annuler ») ; le message reste alors un peu plus longtemps.
  function afficherToast(message, estErreur, action) {
    toast.textContent = message;
    if (action) {
      toast.append(h('button', { class: 'toast-action', type: 'button', text: action.texte,
        onclick: () => { toast.classList.remove('visible'); action.agir(); } }));
    }
    toast.classList.toggle('erreur', !!estErreur);
    toast.classList.toggle('avec-action', !!action);
    toast.classList.add('visible');
    clearTimeout(minuteurToast);
    minuteurToast = setTimeout(() => toast.classList.remove('visible'), estErreur ? 6000 : action ? 8000 : 4200);
  }

  // Lien partagé (?remarque=3) ou retour d'une navigation lancée depuis la liste.
  function focusInitial() {
    const params = new URLSearchParams(location.search);
    const numero = params.get(PARAM_LIEN);
    if (numero) {
      params.delete(PARAM_LIEN);
      const q = params.toString();
      history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash);
      const r = etat.remarques.find((x) => String(x.numero) === numero);
      if (!r) { if (etat.charge) afficherToast('La remarque n°' + numero + ' n’existe plus.'); return; }
      allerA(r.id);
      return;
    }
    const id = lire(CLE_FOCUS, true);
    if (!id) return;
    effacer(CLE_FOCUS, true);
    const r = trouver(id);
    if (r && r._page === pageCourante()) focaliser(id);
  }

  // Rechargement pendant l'écriture (ou pendant une mise en ligne) : le formulaire revient avec son texte, sur sa page.
  function reprendreTexte() {
    const t = lireTexte();
    if (!t || t.page !== pageCourante()) return false;
    if (t.id) {
      etat.popover = { type: 'formulaire', id: t.id, numero: t.numero, texte: t };
    } else {
      if (!t.ancre) return false;
      etat.brouillon = { el: trouverElement(t.ancre), ancre: t.ancre };
      etat.popover = { type: 'formulaire', texte: t };
    }
    rendrePopover();
    return true;
  }

  /* ------------------------------------------------------------------ nouvelle version du widget */

  // Empreinte du widget servi, prise au démarrage puis comparée au retour d'une coupure, au retour sur l'onglet et
  // toutes les 10 minutes. Seule une réponse qui est bien le widget compte : une page d'erreur du proxy n'est pas une version.
  // « no-cache » remet aussi le cache du navigateur à jour : « Recharger » charge alors la nouvelle version.
  let empreinteWidget = null;
  let majDisponible = false;
  async function empreinteDuWidget(cache) {
    try {
      const reponse = await fetch(script.src, { cache, mode: 'cors', credentials: 'omit' });
      if (!reponse.ok) return null;
      const texte = await reponse.text();
      if (!texte.includes('__gwhRemarques')) return null;
      let n = 0;
      for (let i = 0; i < texte.length; i += 1) n = (n * 31 + texte.charCodeAt(i)) | 0;
      return texte.length + ':' + n;
    } catch (_) { return null; }
  }
  async function verifierVersion() {
    if (majDisponible) return;
    const premiere = !empreinteWidget;
    // Première prise : la copie déjà chargée par la page (cache du navigateur), pas une version plus récente.
    const e = await empreinteDuWidget(premiere ? 'force-cache' : 'no-cache');
    if (!e) return;
    if (premiere) { empreinteWidget = e; return; }
    if (e === empreinteWidget) return;
    majDisponible = true;
    rendreMaj();
  }
  // Jamais pendant que la personne écrit, place ou déplace une pastille : la proposition attend la fin.
  function rendreMaj() {
    if (!maj) return;
    const ecrit = etat.placement || (etat.popover && ['formulaire', 'deplacer', 'repondre'].includes(etat.popover.type));
    maj.hidden = !majDisponible || !!ecrit;
  }

  /* ------------------------------------------------------------------ démarrage */

  function demarrer() {
    construire();
    rendre();
    const repris = reprendreTexte();
    charger().then(() => { if (!repris) focusInitial(); });
    verifierVersion();
    setInterval(() => { if (!document.hidden) charger(); }, SYNCHRO_MS);
    setInterval(() => { if (!document.hidden) verifierVersion(); }, VERSION_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { charger(); verifierVersion(); } });
    document.addEventListener('click', noterClic, true);
    document.addEventListener('close', heberger, true);
    window.addEventListener('scroll', planifier, true);
    window.addEventListener('resize', () => { planifier(); eviterLeCoin(); });
    setTimeout(eviterLeCoin, 400);
    setInterval(() => { if (!document.hidden) eviterLeCoin(); }, 2000);
    window.addEventListener('hashchange', planifier);
    window.addEventListener('popstate', planifier);
    setInterval(() => { if (!document.hidden) planifier(); }, 330);
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || estDansOutil(e)) return;
      if (etat.placement) { e.preventDefault(); e.stopImmediatePropagation(); arreterPlacement(); } else if (etat.popover && etat.popover.type !== 'formulaire') fermerPopover();
    }, true);
    window.addEventListener('pointerdown', (e) => {
      if (!etat.placement && !estDansOutil(e) && etat.popover && etat.popover.type === 'detail') fermerPopover();
    }, true);
  }

  /* ------------------------------------------------------------------ styles */

  const STYLES = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.racine {
  --marine: #121110; --bleu: #B5400F; --bleu-fonce: #8F320B; --bleu-clair: #F7E7DD; --bleu-vif: #FF6B2C;
  --texte: #121110; --texte-2: #3A3630; --texte-3: #6B655C; --bord: #E4DED3; --bord-2: #D2CABD; --fond-2: #F4F1EA;
  --vert: #047857; --vert-fonce: #065F46; --vert-clair: #E8F5F2; --rouge: #B91C1C; --rouge-clair: #FDF0EF; --gris-pin: #8A909C;
  --ambre: #B45309; --ambre-clair: #FEF3E2; --ardoise: #4F4A43; --ardoise-clair: #EFEBE4;
  font: 14px/1.45 "Satoshi", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--texte); -webkit-font-smoothing: antialiased; text-align: left; letter-spacing: normal;
}
button, input, textarea, select { font: inherit; color: inherit; letter-spacing: inherit; }
button { cursor: pointer; border: 0; background: none; margin: 0; padding: 0; text-align: inherit; }
button:disabled { cursor: default; opacity: .65; }
:focus-visible { outline: 2px solid var(--bleu); outline-offset: 2px; }
.ico { width: 16px; height: 16px; display: inline-block; flex: none; }
.ico svg { width: 100%; height: 100%; display: block; }

/* Pastilles */
.calque { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
.pin {
  position: absolute; left: 0; top: 0; width: ${TAILLE_PIN}px; height: ${TAILLE_PIN}px;
  border-radius: 14px 14px 14px 3px; background: var(--marine); color: #fff;
  font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1;
  display: grid; place-items: center; pointer-events: auto; will-change: transform;
  box-shadow: 0 0 0 2px #fff, 0 4px 12px rgba(18,17,16,.35);
  transition: background-color .15s, box-shadow .15s;
}
.pin:hover, .pin.actif { box-shadow: 0 0 0 2px #fff, 0 0 0 4.5px var(--bleu), 0 6px 16px rgba(18,17,16,.4); z-index: 2; }
.pin.traitee { background: var(--gris-pin); }
.pin.traitee:hover, .pin.traitee.actif { background: #6F7582; }
.pin.en-cours { background: var(--ambre); }
.pin.en-cours:hover, .pin.en-cours.actif { background: #92400E; }
.pin.brouillon { background: var(--bleu); pointer-events: none; z-index: 3; }
.pin.brouillon .ico { width: 14px; height: 14px; }
.pin.approx { opacity: .8; outline: 2px dashed var(--bleu); outline-offset: 3px; }
.pin.pulse { z-index: 4; }
.pin.pulse::after { content: ""; position: absolute; inset: -2px; border-radius: inherit; animation: onde 1.15s ease-out 3; }
@keyframes onde { from { box-shadow: 0 0 0 0 rgba(181,64,15,.65); } to { box-shadow: 0 0 0 20px rgba(181,64,15,0); } }
.survol { position: fixed; left: 0; top: 0; border: 2px solid var(--bleu); background: rgba(181,64,15,.07); border-radius: 4px; pointer-events: none; }

/* Barre */
.barre {
  position: fixed; bottom: calc(20px + var(--decalage, 0px)); right: 20px; display: flex; padding: 4px; border-radius: 999px;
  background: var(--marine); color: #fff; pointer-events: auto;
  box-shadow: 0 10px 30px rgba(18,17,16,.32), inset 0 0 0 1px rgba(255,255,255,.07);
  transition: right .24s cubic-bezier(.2,.8,.2,1), left .24s cubic-bezier(.2,.8,.2,1), bottom .2s ease;
}
[data-cote="gauche"] .barre { right: auto; left: 20px; }
.panneau-ouvert[data-cote="droite"] .barre { right: ${LARGEUR_PANNEAU + 20}px; }
.panneau-ouvert[data-cote="gauche"] .barre { left: ${LARGEUR_PANNEAU + 20}px; }
.barre-groupe { display: flex; align-items: center; gap: 4px; }
.btn-barre { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 16px; border-radius: 999px; font-size: 13.5px; font-weight: 600; color: #fff; white-space: nowrap; }
.btn-barre:hover { background: rgba(255,255,255,.1); }
.btn-barre.principal { background: var(--bleu); }
.btn-barre.principal:hover { background: var(--bleu-fonce); }
.btn-barre[aria-expanded="true"] { background: rgba(255,255,255,.14); }
.nouvelles { cursor: pointer; padding: 0 8px; height: 22px; border-radius: 11px; background: var(--bleu-vif); color: var(--marine); font-size: 12px; font-weight: 700; display: inline-grid; place-items: center; white-space: nowrap; }
.nouvelles[hidden] { display: none; }
.pin.non-lue::before { content: ""; position: absolute; top: -5px; right: -5px; width: 11px; height: 11px; border-radius: 50%; background: var(--bleu-vif); box-shadow: 0 0 0 2px #fff; }
.item-etat { align-self: flex-start; padding: 1px 7px; border-radius: 999px; background: var(--ambre-clair); color: var(--ambre); font-size: 11px; font-weight: 700; }
/* Endroit à préciser : gris-bleu, ni rouge (pas une erreur) ni ambre (« En cours ») ni bleu vif (nouvelle réponse). */
.item-replacer { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border-radius: 999px; background: var(--ardoise-clair); color: var(--ardoise); font-size: 11px; font-weight: 700; }
.item-replacer .ico { width: 12px; height: 12px; }
.item-nouvelle { align-self: flex-start; padding: 1px 7px; border-radius: 999px; background: var(--bleu-clair); color: var(--bleu); font-size: 11px; font-weight: 700; }
.compteur { min-width: 22px; height: 22px; padding: 0 7px; border-radius: 11px; background: rgba(255,255,255,.16); font-size: 12px; font-variant-numeric: tabular-nums; display: inline-grid; place-items: center; }
.consigne { display: inline-flex; align-items: center; gap: 10px; padding: 0 6px 0 14px; font-size: 13.5px; font-weight: 500; white-space: nowrap; }
.point { width: 8px; height: 8px; border-radius: 50%; background: var(--bleu-vif); animation: point 1.4s ease-out infinite; }
@keyframes point { from { box-shadow: 0 0 0 0 rgba(91,140,255,.7); } to { box-shadow: 0 0 0 9px rgba(91,140,255,0); } }
.touche { font-family: inherit; font-size: 11px; font-weight: 600; line-height: 1; color: rgba(255,255,255,.62); border: 1px solid rgba(255,255,255,.22); border-radius: 5px; padding: 3px 5px; }

/* Panneau */
.panneau {
  position: fixed; top: 0; bottom: 0; right: 0; width: ${LARGEUR_PANNEAU}px; max-width: 100%;
  display: flex; flex-direction: column; background: #fff; pointer-events: auto;
  border-left: 1px solid var(--bord); box-shadow: -16px 0 40px rgba(18,17,16,.13);
  transform: translateX(100%); visibility: hidden;
  transition: transform .26s cubic-bezier(.2,.8,.2,1), visibility 0s linear .26s;
}
[data-cote="gauche"] .panneau { right: auto; left: 0; border-left: 0; border-right: 1px solid var(--bord); box-shadow: 16px 0 40px rgba(18,17,16,.13); transform: translateX(-100%); }
.panneau.ouvert { transform: none; visibility: visible; transition: transform .26s cubic-bezier(.2,.8,.2,1); }
.p-tete { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 14px 14px 20px; }
.p-titre { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -.01em; line-height: 1.25; }
.p-sous { margin: 3px 0 0; font-size: 12.5px; color: var(--texte-3); }
.p-outils { display: flex; flex-direction: column; gap: 10px; padding: 0 20px 14px; border-bottom: 1px solid var(--bord); }
.segments { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2px; padding: 3px; border-radius: 9px; background: var(--fond-2); }
.segments button { min-width: 0; overflow: hidden; text-overflow: ellipsis; height: 30px; border-radius: 7px; font-size: 12px; font-weight: 600; color: var(--texte-2); text-align: center; white-space: nowrap; }
.segments button:hover { color: var(--texte); }
.segments button[aria-pressed="true"] { background: #fff; color: var(--texte); box-shadow: 0 1px 2px rgba(18,17,16,.12), 0 0 0 1px rgba(18,17,16,.04); }
.seg-n { margin-left: 4px; font-variant-numeric: tabular-nums; color: var(--texte-3); font-weight: 500; }
.ligne-options { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.select {
  appearance: none; -webkit-appearance: none; height: 30px; padding: 0 28px 0 10px; border-radius: 7px;
  border: 1px solid var(--bord); background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23686E7B' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 8px center / 13px;
  font-size: 12.5px; font-weight: 500; color: var(--texte-2); cursor: pointer;
}
.interrupteur { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 500; color: var(--texte-2); }
.piste { width: 30px; height: 18px; border-radius: 9px; background: var(--bord-2); position: relative; transition: background-color .15s; }
.curseur { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(18,17,16,.25); transition: transform .15s; }
.interrupteur[aria-checked="true"] .piste { background: var(--bleu); }
.interrupteur[aria-checked="true"] .curseur { transform: translateX(12px); }
.liste { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 6px 0 14px; }
.groupe { margin: 0; padding: 14px 20px 6px; font-size: 11.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--texte-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.items { list-style: none; margin: 0; padding: 0; }
.item { display: flex; align-items: flex-start; gap: 2px; padding: 0 12px 0 8px; }
.item-corps { flex: 1; min-width: 0; display: flex; gap: 12px; padding: 10px 8px 10px 12px; border-radius: 10px; }
.item-corps:hover { background: var(--fond-2); }
.num {
  flex: none; width: 24px; height: 24px; margin-top: 1px; border-radius: 12px 12px 12px 3px;
  background: var(--marine); color: #fff; font-size: 11.5px; font-weight: 700; font-variant-numeric: tabular-nums;
  display: grid; place-items: center; line-height: 1;
}
.num.traitee { background: var(--gris-pin); }
.num.en-cours { background: var(--ambre); }
.num.brouillon { background: var(--bleu); }
.num .ico { width: 13px; height: 13px; }
.item-texte { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.item-titre { font-weight: 600; overflow-wrap: anywhere; }
.item-desc { font-size: 13px; color: var(--texte-2); overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.item-meta { font-size: 12px; color: var(--texte-3); }
.item.traitee .item-corps { opacity: .6; }
.item.traitee .item-titre { text-decoration: line-through; text-decoration-color: rgba(24,27,33,.45); }
.item-check {
  flex: none; width: 30px; height: 30px; margin-top: 8px; border-radius: 50%;
  display: grid; place-items: center; color: var(--texte-3); border: 1.5px solid var(--bord-2);
  transition: background-color .15s, border-color .15s, color .15s;
}
.item-check .ico { width: 14px; height: 14px; }
.item-check:hover { border-color: var(--vert); color: var(--vert); background: var(--vert-clair); }
.item-check[aria-pressed="true"] { background: var(--vert); border-color: var(--vert); color: #fff; }
.vide { padding: 48px 32px; text-align: center; color: var(--texte-3); }
.vide p { margin: 0 0 14px; }
.p-pied { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); border-top: 1px solid var(--bord); }

/* Boutons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 36px; padding: 0 14px; border-radius: 8px; font-size: 13.5px; font-weight: 600; white-space: nowrap; transition: background-color .15s, color .15s; }
.btn-large { width: 100%; }
.btn-principal { background: var(--bleu); color: #fff; }
.btn-principal:hover:not(:disabled) { background: var(--bleu-fonce); }
.btn-secondaire { background: #fff; color: var(--texte); box-shadow: inset 0 0 0 1px var(--bord-2); }
.btn-secondaire:hover { background: var(--fond-2); }
.btn-fantome { color: var(--texte-2); padding: 0 10px; }
.btn-fantome:hover { background: var(--fond-2); color: var(--texte); }
.btn-danger { color: var(--rouge); }
.btn-danger:hover { background: var(--rouge-clair); color: var(--rouge); }
.btn-danger-plein { background: var(--rouge); color: #fff; }
.btn-danger-plein:hover { background: #991B1B; }
.btn-icone { width: 32px; height: 32px; flex: none; border-radius: 8px; display: grid; place-items: center; color: var(--texte-3); }
.btn-icone:hover { background: var(--fond-2); color: var(--texte); }

/* Popover */
.popover {
  position: fixed; left: 0; top: 0; width: 344px; max-width: calc(100vw - 24px); max-height: calc(100vh - 100px); overflow-y: auto;
  padding: 14px 16px 16px; border-radius: 14px; background: #fff; pointer-events: auto;
  box-shadow: 0 22px 50px rgba(18,17,16,.24), 0 0 0 1px rgba(18,17,16,.07);
}
.popover.feuille {
  top: auto; right: 0; bottom: 0; width: auto; max-width: none; max-height: 86vh;
  border-radius: 16px 16px 0 0; padding-bottom: calc(18px + env(safe-area-inset-bottom));
}
.pop-tete { display: flex; align-items: center; gap: 8px; margin: 0 -6px 10px 0; }
.pop-tete .btn-icone { margin-left: auto; }
.pop-label { font-size: 14px; }
.statut { padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 700; background: var(--bleu-clair); color: var(--bleu); }
.statut.ok { background: var(--vert-clair); color: var(--vert); }
.statut.en-cours { background: var(--ambre-clair); color: var(--ambre); }
.pop-titre { margin: 0 0 6px; font-size: 16px; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
.pop-titre.raye { text-decoration: line-through; text-decoration-color: rgba(24,27,33,.4); color: var(--texte-2); }
.pop-desc { margin: 0 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--texte-2); }
.pop-reponse { margin: 0 0 10px; padding: 8px 10px; border-left: 3px solid var(--bleu); border-radius: 0 6px 6px 0; background: var(--bleu-clair); }
.pop-reponse-label { margin: 0 0 2px; font-size: 12px; font-weight: 700; color: var(--bleu-fonce); }
.pop-reponse-texte { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--texte); }
.pop-fil { margin: 0 0 10px; display: flex; flex-direction: column; gap: 6px; }
.pop-fil .pop-reponse { margin: 0; }
.btn-repondre { height: 32px; margin: 0 0 10px; font-size: 13px; }
.pop-reponse.client { border-left-color: var(--bord-2); background: var(--fond-2); }
.pop-reponse.client .pop-reponse-label { color: var(--texte-2); }
.pop-modifie { font-weight: 400; color: var(--texte-3); }
.pop-meta { margin: 2px 0 0; font-size: 12.5px; color: var(--texte-3); display: flex; align-items: center; gap: 5px; }
.pop-meta.ok { color: var(--vert); font-weight: 600; }
.pop-meta .ico { width: 13px; height: 13px; }
.pop-a-preciser { margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; background: var(--ardoise-clair); color: var(--ardoise); font-size: 12.5px; display: flex; align-items: flex-start; gap: 7px; }
.pop-a-preciser .ico { width: 14px; height: 14px; margin-top: 1px; }
.pop-actions { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--bord); display: flex; flex-direction: column; gap: 8px; }
/* Jusqu'à 4 actions : deux colonnes égales, aucune ne passe seule à la ligne. */
.pop-secondaires { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px; margin: 0 -6px; }
.pop-secondaires .btn { height: 32px; font-size: 13px; justify-content: flex-start; min-width: 0; }
.confirmer { margin-top: 14px; padding: 12px; border-radius: 10px; background: var(--rouge-clair); }
.confirmer p { margin: 0 0 10px; font-weight: 600; color: #7F1D1D; }
.cible { margin: -4px 0 12px; font-size: 12.5px; color: var(--texte-3); overflow-wrap: anywhere; }
.deja-signale { display: block; width: 100%; margin: -4px 0 12px; padding: 7px 10px; border: 0; border-radius: 8px; background: var(--bleu-clair); color: var(--bleu-fonce); font: inherit; font-size: 12.5px; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.deja-signale:hover { text-decoration: underline; }
.champ { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.champ label { font-size: 12.5px; font-weight: 600; color: var(--texte-2); }
.aide { font-weight: 400; color: var(--texte-3); }
.champ input, .champ textarea {
  width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--bord-2); background: #fff; color: var(--texte);
  font-size: 14px; line-height: 1.4; transition: border-color .15s, box-shadow .15s;
}
.champ textarea { min-height: 92px; resize: vertical; }
.champ input:focus, .champ textarea:focus { outline: none; border-color: var(--bleu); box-shadow: 0 0 0 3px rgba(181,64,15,.18); }
.champ .invalide { border-color: var(--rouge); }
.erreur { margin: -2px 0 12px; font-size: 12.5px; color: var(--rouge); }
.attente { margin: -2px 0 12px; padding: 8px 10px; border-radius: 8px; background: var(--fond-2); font-size: 12.5px; color: var(--texte-2); }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* Messages */
.toast {
  position: fixed; left: 50%; bottom: calc(82px + var(--decalage, 0px)); max-width: min(460px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 10px;
  background: var(--marine); color: #fff; font-size: 13.5px; box-shadow: 0 10px 30px rgba(18,17,16,.3);
  opacity: 0; transform: translate(-50%, 8px); transition: opacity .2s, transform .2s; pointer-events: none;
}
.toast.visible { opacity: 1; transform: translate(-50%, 0); }
/* Seul un message qui porte « Annuler » reçoit la souris ; les autres laissent passer les clics. */
.toast.visible.avec-action { pointer-events: auto; }
.toast-action { margin-left: 12px; padding: 2px 4px; font-weight: 700; color: #fff; text-decoration: underline; }
/* Panneau ouvert : le message se centre dans la partie libre de l'écran, il ne passe plus dessous. */
.panneau-ouvert[data-cote="droite"] .toast { left: calc((100% - ${LARGEUR_PANNEAU}px) / 2); max-width: min(460px, calc(100vw - ${LARGEUR_PANNEAU}px - 32px)); }
.panneau-ouvert[data-cote="gauche"] .toast { left: calc(${LARGEUR_PANNEAU}px + (100% - ${LARGEUR_PANNEAU}px) / 2); max-width: min(460px, calc(100vw - ${LARGEUR_PANNEAU}px - 32px)); }
.toast.erreur { background: var(--rouge); }
.maj {
  position: fixed; right: 20px; bottom: calc(76px + var(--decalage, 0px)); max-width: min(380px, calc(100vw - 40px));
  display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 14px; border-radius: 12px; background: #fff;
  font-size: 13px; color: var(--texte); pointer-events: auto; box-shadow: 0 10px 30px rgba(18,17,16,.22), 0 0 0 1px rgba(18,17,16,.07);
}
.maj .btn { flex: none; height: 32px; }
[data-cote="gauche"] .maj { right: auto; left: 20px; }
.panneau-ouvert[data-cote="droite"] .maj { right: ${LARGEUR_PANNEAU + 20}px; }
.panneau-ouvert[data-cote="gauche"] .maj { left: ${LARGEUR_PANNEAU + 20}px; }

@media (max-width: ${LARGEUR_MOBILE}px) {
  .panneau { width: 100%; }
  .panneau-ouvert .barre { display: none; }
  .barre { bottom: calc(14px + var(--decalage, 0px)); right: 14px; }
  [data-cote="gauche"] .barre { left: 14px; }
  .btn-barre { height: 42px; padding: 0 14px; }
  .btn-barre.principal .libelle, .touche { display: none; }
  .consigne { padding-left: 10px; }
  .toast { bottom: calc(76px + var(--decalage, 0px)); }
  .maj, [data-cote="gauche"] .maj { left: 14px; right: 14px; bottom: calc(70px + var(--decalage, 0px)); max-width: none; }
  .panneau-ouvert .maj { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
@media print { .racine { display: none; } }
`;

  if (document.body) demarrer();
  else document.addEventListener('DOMContentLoaded', demarrer, { once: true });
})();
