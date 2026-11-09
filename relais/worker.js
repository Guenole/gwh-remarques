// Relais des remarques GuenoWasHere (Cloudflare Worker).
// Il parle comme le serveur des remarques HWS (/api/prototypes/remarques), mais range tout dans GitHub :
// une remarque = une issue du dépôt privé DEPOT, étiquetée « projet:<identifiant> » ; une réponse = un commentaire.
// Le jeton GitHub (secret GITHUB_TOKEN) ne quitte jamais ce relais.
//
// Dans GitHub, Guénolé peut aussi :
//   - répondre en commentant l'issue (le commentaire apparaît comme « Réponse de l'équipe ») ;
//   - fermer l'issue (remarque traitée) ou poser l'étiquette « en-cours ».

const CHEMIN = '/api/prototypes/remarques';
const MARQUE = 'gwh-remarque';
const SUPPRIMEE = 'supprimee';
const EN_COURS = 'en-cours';
const LIMITE_CORPS = 20000;
const MEMOIRE_MS = 8000;

const memoire = new Map(); // projet -> { t, remarques } : partagée entre visiteurs d'une même instance
const etiquettesPretes = new Set();
// GitHub met une à deux secondes à indexer une issue créée ou modifiée : les dernières écritures
// sont gardées une minute et fusionnées dans la liste, pour qu'une remarque ne disparaisse pas entre-temps.
const RECENT_MS = 60000;
const recents = new Map(); // projet -> Map(id -> { t, remarque | null si supprimée })
function noterRecent(projet, id, r) {
  if (!recents.has(projet)) recents.set(projet, new Map());
  recents.get(projet).set(String(id), { t: Date.now(), r });
}
function fusionner(projet, liste) {
  const lot = recents.get(projet);
  if (!lot) return liste;
  const parId = new Map(liste.map((r) => [r.id, r]));
  for (const [id, { t, r }] of lot) {
    if (Date.now() - t > RECENT_MS) { lot.delete(id); continue; }
    if (r === null) parId.delete(id); else parId.set(id, r);
  }
  return [...parId.values()].sort((a, b) => a.numero - b.numero);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    try {
      return await router(req, env);
    } catch (err) {
      if (err instanceof Refus) return json({ erreur: err.message }, err.statut);
      console.error(err && err.stack || err);
      return json({ erreur: 'Le serveur des remarques a rencontré un problème. Réessayez dans un instant.' }, 502);
    }
  },
};

class Refus extends Error {
  constructor(statut, message) { super(message); this.statut = statut; }
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(donnees, statut = 200) {
  return new Response(JSON.stringify(donnees), {
    status: statut,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors() },
  });
}

async function router(req, env) {
  const url = new URL(req.url);
  if (url.pathname === '/sante') {
    let base = false;
    try { await gh(env, 'GET', `/repos/${env.DEPOT}`); base = true; } catch (_) { /* jeton ou dépôt absent */ }
    return json({ ok: true, base, depot: env.DEPOT });
  }
  if (!url.pathname.startsWith(CHEMIN)) throw new Refus(404, 'Adresse inconnue.');

  const projet = (url.searchParams.get('projet') || '').trim();
  const autorises = (env.PROJETS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!autorises.includes(projet)) throw new Refus(404, 'Ce lien de relecture n’est plus valide.');

  const morceaux = url.pathname.slice(CHEMIN.length).split('/').filter(Boolean);
  const id = morceaux[0] ? decodeURIComponent(morceaux[0]) : null;
  const suite = morceaux[1] || null;
  if (id && !/^\d+$/.test(id)) throw new Refus(404, 'Cette remarque n’existe plus.');

  if (req.method === 'GET' && !id) return json({ remarques: await lister(env, projet) });
  if (req.method === 'POST' && !id) return json(await creer(env, projet, await lireCorps(req)), 201);
  if (req.method === 'PATCH' && id && !suite) return json(await modifier(env, projet, id, await lireCorps(req)));
  if (req.method === 'DELETE' && id && !suite) return json(await supprimer(env, projet, id, url.searchParams.get('par') || ''));
  if (req.method === 'POST' && id && suite === 'reponses') return json(await repondre(env, projet, id, await lireCorps(req)));
  throw new Refus(405, 'Demande non prise en charge.');
}

async function lireCorps(req) {
  const texte = await req.text();
  if (texte.length > LIMITE_CORPS) throw new Refus(413, 'La remarque est trop volumineuse pour être envoyée.');
  try { return texte ? JSON.parse(texte) : {}; } catch (_) { throw new Refus(400, 'Demande illisible.'); }
}

/* ------------------------------------------------------------------ GitHub */

async function gh(env, methode, chemin, corps) {
  const r = await fetch('https://api.github.com' + chemin, {
    method: methode,
    headers: {
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gwh-remarques',
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  if (r.status === 204) return null;
  const texte = await r.text();
  if (!r.ok) {
    if (r.status === 404 || r.status === 410) throw new Refus(404, 'Cette remarque n’existe plus.');
    if (r.status === 403 || r.status === 429) throw new Refus(429, 'Trop de demandes en peu de temps. Réessayez dans quelques minutes.');
    throw new Error('GitHub ' + r.status + ' ' + texte.slice(0, 300));
  }
  return texte ? JSON.parse(texte) : null;
}

const etiquetteProjet = (projet) => 'projet:' + projet;

async function preparerEtiquettes(env, projet) {
  const noms = [etiquetteProjet(projet), SUPPRIMEE, EN_COURS];
  for (const nom of noms) {
    if (etiquettesPretes.has(nom)) continue;
    try {
      await gh(env, 'POST', `/repos/${env.DEPOT}/labels`, { name: nom, color: nom === SUPPRIMEE ? '6B655C' : nom === EN_COURS ? 'FF6B2C' : 'B5400F' });
    } catch (err) {
      if (!(err instanceof Error) || !/GitHub 422/.test(err.message)) throw err; // 422 : existe déjà
    }
    etiquettesPretes.add(nom);
  }
}

// Métadonnées rangées dans un commentaire HTML invisible, sous le texte lisible dans GitHub.
const RE_META = new RegExp('\\n*<!-- ' + MARQUE + '\\n([\\s\\S]*?)\\n-->\\s*$');
function lireMeta(corps) {
  const m = (corps || '').match(RE_META);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}
const texteVisible = (corps) => (corps || '').replace(RE_META, '').trim();
function avecMeta(texte, meta) {
  const brut = JSON.stringify(meta).replace(/--/g, '-\\u002d');
  return (texte ? texte.trim() + '\n\n' : '') + '<!-- ' + MARQUE + '\n' + brut + '\n-->';
}

const etiquettes = (issue) => (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));

async function issuesDuProjet(env, projet) {
  const toutes = [];
  for (let page = 1; page <= 10; page++) {
    const lot = await gh(env, 'GET', `/repos/${env.DEPOT}/issues?labels=${encodeURIComponent(etiquetteProjet(projet))}&state=all&per_page=100&page=${page}`);
    toutes.push(...lot.filter((i) => !i.pull_request));
    if (lot.length < 100) break;
  }
  return toutes;
}

const commentaires = (env, issue) => (issue.comments ? gh(env, 'GET', `/repos/${env.DEPOT}/issues/${issue.number}/comments?per_page=100`) : Promise.resolve([]));

function versRemarque(issue, coms, env) {
  const m = lireMeta(issue.body);
  if (!m) return null;
  const ets = etiquettes(issue);
  if (ets.includes(SUPPRIMEE)) return null;
  const traitee = issue.state === 'closed';
  const equipe = env.EQUIPE || 'Guénolé';
  const fil = (coms || []).map((c) => {
    const cm = lireMeta(c.body);
    return cm
      ? { type: 'client', auteur: cm.par || 'Relecteur', texte: texteVisible(c.body), le: c.created_at, modifie: false }
      : { type: 'equipe', auteur: equipe, texte: (c.body || '').trim(), le: c.created_at, modifie: c.updated_at !== c.created_at };
  }).filter((x) => x.texte);
  const dernier = fil.length ? fil[fil.length - 1].le : null;
  return {
    id: String(issue.number),
    numero: m.numero,
    titre: issue.title,
    description: texteVisible(issue.body),
    auteur: m.auteur || '',
    page: m.page || '',
    chemin: m.chemin || '/',
    page_titre: m.page_titre || '',
    ancre: m.ancre || null,
    traitee,
    traitee_le: traitee ? issue.closed_at : null,
    traitee_par: traitee ? (m.traitee_par || equipe) : null,
    etat: traitee ? 'traitee' : ets.includes(EN_COURS) ? 'en_cours' : 'a_traiter',
    cree_le: issue.created_at,
    modifie_le: m.modifie_le || issue.created_at,
    modifiee_par: m.modifiee_par || null,
    reponse_le: dernier,
    fil,
  };
}

async function remarque(env, projet, id) {
  const issue = await gh(env, 'GET', `/repos/${env.DEPOT}/issues/${id}`);
  if (issue.pull_request || !etiquettes(issue).includes(etiquetteProjet(projet)) || etiquettes(issue).includes(SUPPRIMEE) || !lireMeta(issue.body)) {
    throw new Refus(404, 'Cette remarque n’existe plus.');
  }
  return issue;
}

/* ------------------------------------------------------------------ opérations */

async function lister(env, projet) {
  const vu = memoire.get(projet);
  if (vu && Date.now() - vu.t < MEMOIRE_MS) return fusionner(projet, vu.remarques);
  const issues = await issuesDuProjet(env, projet);
  const paires = await Promise.all(issues.map(async (i) => [i, await commentaires(env, i)]));
  const remarques = paires.map(([i, c]) => versRemarque(i, c, env)).filter(Boolean).sort((a, b) => a.numero - b.numero);
  memoire.set(projet, { t: Date.now(), remarques });
  return fusionner(projet, remarques);
}

const nettoyer = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function creer(env, projet, c) {
  const titre = nettoyer(c.titre, 200);
  const auteur = nettoyer(c.auteur, 80);
  if (!titre) throw new Refus(400, 'Le titre de la remarque est obligatoire.');
  if (!auteur) throw new Refus(400, 'Votre nom est obligatoire.');
  await preparerEtiquettes(env, projet);
  const existantes = await issuesDuProjet(env, projet);
  const numero = existantes.reduce((max, i) => Math.max(max, (lireMeta(i.body) || {}).numero || 0), 0) + 1;
  const maintenant = new Date().toISOString();
  const meta = {
    v: 1, projet, numero, auteur,
    relecteur: nettoyer(c.relecteur, 80),
    page: nettoyer(c.page, 2048), chemin: nettoyer(c.chemin, 2048) || '/', page_titre: nettoyer(c.page_titre, 200),
    ancre: c.ancre && typeof c.ancre === 'object' ? c.ancre : null,
    modifie_le: maintenant,
  };
  const issue = await gh(env, 'POST', `/repos/${env.DEPOT}/issues`, {
    title: titre,
    body: avecMeta(nettoyer(c.description, 5000), meta),
    labels: [etiquetteProjet(projet)],
  });
  memoire.delete(projet);
  const nouvelle = versRemarque(issue, [], env);
  noterRecent(projet, nouvelle.id, nouvelle);
  return nouvelle;
}

async function modifier(env, projet, id, c) {
  const issue = await remarque(env, projet, id);
  const meta = lireMeta(issue.body);
  const par = nettoyer(c.par, 80);
  const patch = {};
  let description = texteVisible(issue.body);
  if (typeof c.traitee === 'boolean') {
    patch.state = c.traitee ? 'closed' : 'open';
    if (c.traitee) { patch.state_reason = 'completed'; meta.traitee_par = par || null; } else { patch.state_reason = 'reopened'; delete meta.traitee_par; }
  }
  if (typeof c.titre === 'string') {
    const titre = nettoyer(c.titre, 200);
    if (!titre) throw new Refus(400, 'Le titre de la remarque est obligatoire.');
    patch.title = titre;
    description = nettoyer(c.description, 5000);
    meta.modifie_le = new Date().toISOString();
    meta.modifiee_par = par || null;
  }
  if (c.ancre && typeof c.ancre === 'object') meta.ancre = c.ancre;
  patch.body = avecMeta(description, meta);
  const maj = await gh(env, 'PATCH', `/repos/${env.DEPOT}/issues/${id}`, patch);
  memoire.delete(projet);
  const r = versRemarque(maj, await commentaires(env, maj), env);
  noterRecent(projet, id, r);
  return r;
}

async function supprimer(env, projet, id, par) {
  const issue = await remarque(env, projet, id);
  await preparerEtiquettes(env, projet);
  const meta = lireMeta(issue.body);
  meta.supprimee_par = nettoyer(par, 80) || null;
  await gh(env, 'PATCH', `/repos/${env.DEPOT}/issues/${id}`, {
    state: 'closed', state_reason: 'not_planned', body: avecMeta(texteVisible(issue.body), meta),
    labels: [...etiquettes(issue), SUPPRIMEE],
  });
  memoire.delete(projet);
  noterRecent(projet, id, null);
  return { ok: true };
}

async function repondre(env, projet, id, c) {
  const issue = await remarque(env, projet, id);
  const texte = nettoyer(c.texte, 5000);
  const par = nettoyer(c.par, 80);
  if (!texte) throw new Refus(400, 'La réponse est vide.');
  if (!par) throw new Refus(400, 'Votre nom est obligatoire.');
  await gh(env, 'POST', `/repos/${env.DEPOT}/issues/${id}/comments`, {
    body: avecMeta(texte, { v: 1, par, relecteur: nettoyer(c.relecteur, 80) }),
  });
  memoire.delete(projet);
  const maj = await gh(env, 'GET', `/repos/${env.DEPOT}/issues/${id}`);
  const r = versRemarque(maj, await commentaires(env, maj), env);
  noterRecent(projet, id, r);
  return r;
}
