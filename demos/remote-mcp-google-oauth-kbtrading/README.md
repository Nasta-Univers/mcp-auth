# Serveur MCP KB Trading : Google OAuth et liste blanche (Cloudflare Worker)

Ce Worker expose le serveur MCP Odoo de **KB Trading** (Odoo Online 19, `https://kbtrading.odoo.com`, lecture seule) aux connecteurs MCP distants de Claude. Chaque utilisateur s'authentifie individuellement avec Google. Seuls cinq comptes peuvent obtenir un accès :

- `dg@nasta-univers.com`
- `taliby@nasta-univers.com`
- `tdiakhaby@nasta-univers.com`
- `aminatou@nasta-univers.com`
- `mbalde@nasta-univers.com`

C'est une application **indépendante** du Worker AMAT (`demos/remote-mcp-google-oauth`), qui est en production. Elle n'en partage ni le code, ni la configuration, ni les données, ni les secrets.

## 1. Architecture générale

```
Claude ──OAuth 2.1 + PKCE──▶ Worker kbtrading-mcp-oauth (/authorize, /token, /register)
                               │  page de consentement, puis Google (OIDC + PKCE)
                               │  e-mail vérifié + liste blanche KB Trading ─▶ jeton MCP
Claude ──Bearer <jeton MCP>──▶ Worker /mcp
                               │  liste blanche revérifiée, politique de lecture seule
                               └─X-Access-Token: Bearer <secret>──▶ Nginx mcp-kbtrading.nasta-univers.com
                                                                     ▶ 127.0.0.1:8025 (mcp-odoo-kbtrading)
                                                                     ▶ Odoo kbtrading.odoo.com (JSON-2)
```

|                           | AMAT (inchangé)                                 | KB Trading                                              |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| Dossier                   | `demos/remote-mcp-google-oauth`                 | `demos/remote-mcp-google-oauth-kbtrading`               |
| Worker                    | `amat-mcp-oauth`                                | `kbtrading-mcp-oauth`                                   |
| URL MCP (ressource OAuth) | `https://amat-mcp-oauth.mbalde.workers.dev/mcp` | `https://kbtrading-mcp-oauth.mbalde.workers.dev/mcp`    |
| Nom de la ressource       | Amat Odoo MCP                                   | KB Trading Odoo MCP                                     |
| Namespace KV              | celui d'AMAT                                    | un namespace dédié (section 5)                          |
| Serveur amont             | `AMAT_MCP_URL` → `mcp-amat.nasta-univers.com`   | `KBTRADING_MCP_URL` → `mcp-kbtrading.nasta-univers.com` |
| Secret amont              | `AMAT_ACCESS_TOKEN`                             | `KBTRADING_ACCESS_TOKEN`                                |
| En-tête envoyé à Nginx    | `X-Access-Token: <secret>`                      | `X-Access-Token: Bearer <secret>`                       |
| Liste blanche             | `src/access.ts` d'AMAT                          | `src/access.ts` de ce dossier                           |

La liaison KV s'appelle `OAUTH_KV` dans les deux Workers, car la bibliothèque OAuth impose ce nom. Ce sont pourtant deux namespaces distincts : un jeton émis par un Worker n'existe pas pour l'autre. Être autorisé sur AMAT ne donne aucun accès à KB Trading.

**Fichiers**

| Fichier                  | Rôle                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`           | Assemble le fournisseur OAuth (`@cloudflare/workers-oauth-provider`), le relais sur `/mcp` et le gestionnaire Google    |
| `src/google-handler.ts`  | `/authorize` (consentement) et `/callback` (Google, puis vérification de la liste blanche)                              |
| `src/access.ts`          | Liste blanche KB Trading et URI de rappel Claude autorisées                                                             |
| `src/kbtrading-relay.ts` | Relais Streamable HTTP vers le serveur MCP KB Trading                                                                   |
| `src/mcp-policy.ts`      | Politique de lecture seule : outils, méthodes, filtrage de `tools/list`                                                 |
| `src/pages.ts`           | Pages HTML de consentement, de refus et d'erreur                                                                        |
| `src/utils.ts`           | Échanges avec Google (PKCE, jeton, userinfo) et lecture bornée des corps de requête                                     |
| `test/`                  | 152 tests Vitest exécutés dans workerd, dont `test/isolation.test.ts` qui compare les configurations AMAT et KB Trading |

**Contrôles de sécurité** (identiques à AMAT, sauf la destination, le secret et la liste)

- **Authentification Google** :
    - Google OpenID Connect avec PKCE ; l'identité est lue sur l'endpoint `userinfo` de Google, jamais dans des données venant du navigateur ;
    - `email_verified` doit valoir exactement `true` ;
    - l'adresse est normalisée (espaces retirés, minuscules) puis comparée **exactement** à la liste. Ce contrôle a lieu avant `completeAuthorization` : un refus ne crée aucun grant ni jeton ;
    - seuls `https://claude.ai/api/mcp/auth_callback` et `https://claude.com/api/mcp/auth_callback` sont acceptés comme `redirect_uri`.
- **Consentement et flux OAuth** :
    - consentement demandé à chaque autorisation, avec un avertissement contre les liens transmis par un tiers ;
    - protections CSRF et état OAuth assurées par la bibliothèque : transactions chiffrées, à usage unique et liées au navigateur ;
    - enregistrement dynamique des clients (`/register`) ouvert comme sur AMAT, mais inutilisable sans `redirect_uri` Claude. CIMD n'est pas activé.
- **Jetons et relais** :
    - jetons MCP liés à `https://kbtrading-mcp-oauth.mbalde.workers.dev/mcp` : un jeton absent, inconnu, expiré ou destiné à une autre ressource (y compris le Worker AMAT) reçoit 401 ;
    - liste blanche revérifiée à chaque requête du relais ;
    - destination fixe : `KBTRADING_MCP_URL` doit valoir exactement `https://mcp-kbtrading.nasta-univers.com/mcp` ou la même URL avec `/` final. Toute autre valeur, y compris l'URL AMAT, est refusée et rien n'est envoyé ;
    - le secret est ajouté côté serveur en `X-Access-Token: Bearer <secret>`. `Authorization`, `Cookie` et les autres en-têtes du client ne sont jamais transmis. Le jeton Google n'est pas conservé ;
    - redirections jamais suivies (502). Un 401 ou 403 de Nginx devient un 502 ;
    - limites : 1 Mio par requête, 10 Mio par réponse, 120 s par POST/DELETE, 300 s par flux GET.
- **Lecture seule** :
    - seuls les 9 outils de lecture de `READ_ONLY_TOOLS` passent ;
    - les outils d'écriture (`create_record(s)`, `update_record(s)`, `delete_record`, `post_message`, `upload_attachment`, `call_model_method`) et tout outil inconnu sont bloqués, et masqués dans `tools/list` ;
    - seules les méthodes MCP de `ALLOWED_RPC_METHODS` passent ;
    - le corps transmis est le JSON vérifié. Cette politique ne dépend pas de `ODOO_YOLO=read`.
- **Journaux** : aucun jeton, code ou secret dans les journaux. Les « invocation logs » sont désactivés.

## 2. Prérequis

- Windows 10/11, PowerShell (ou CMD là où c'est indiqué).
- Node.js 20 ou plus récent (testé avec Node 24). pnpm est lancé via `npx pnpm@11.9.0`, la version du dépôt.
- Le compte Cloudflare qui porte le sous-domaine `mbalde.workers.dev`.
- Un client OAuth Google de type « Web application ».
- Un accès au VPS pour lire le jeton `/etc/nginx/secrets/kbtrading-mcp-token`, sans le modifier.

## 3. Installation

Depuis PowerShell :

```powershell
cd C:\Users\Lenovo\Desktop\Nasta-univers\mcp-auth
npx pnpm@11.9.0 install --filter remote-mcp-google-oauth-kbtrading
cd demos\remote-mcp-google-oauth-kbtrading
npx pnpm@11.9.0 test:ci
```

> **Toutes les commandes `wrangler` de ce document se lancent depuis `demos\remote-mcp-google-oauth-kbtrading`.** Wrangler lit le `wrangler.jsonc` du dossier courant. Lancée depuis le dossier AMAT, la même commande viserait le Worker AMAT.

## 4. Configuration Cloudflare

```powershell
cd C:\Users\Lenovo\Desktop\Nasta-univers\mcp-auth\demos\remote-mcp-google-oauth-kbtrading
npx wrangler login
npx wrangler whoami
```

Vérifiez que `whoami` affiche le compte qui porte `mbalde.workers.dev`. Les valeurs non secrètes sont déjà dans `wrangler.jsonc` :

- `name` : `kbtrading-mcp-oauth`
- `MCP_RESOURCE` : `https://kbtrading-mcp-oauth.mbalde.workers.dev/mcp`
- `KBTRADING_MCP_URL` : `https://mcp-kbtrading.nasta-univers.com/mcp`

**Google Cloud Console** (APIs & Services, puis Credentials) :

- **URI de rappel :** dans le client OAuth utilisé, ajoutez l'URI de redirection autorisée `https://kbtrading-mcp-oauth.mbalde.workers.dev/callback`, sans retirer celle d'AMAT.
- **Écran de consentement :** périmètres `openid`, `email`, `profile`. S'il est en mode « Testing » avec des utilisateurs externes, ajoutez les cinq comptes comme utilisateurs de test. En mode « Internal » (Google Workspace), rien à faire.
- **Client dédié ou partagé :** le même client Google qu'AMAT peut servir. Un client **dédié** à KB Trading garde cependant les deux Workers totalement indépendants, notamment lors d'une rotation du secret Google (section 9).

## 5. Création du namespace KV

```powershell
npx wrangler kv namespace create KBTRADING_OAUTH_KV
```

Wrangler affiche un `id`. Dans `wrangler.jsonc`, remplacez `<KBTRADING-OAUTH-KV-ID>` par cet `id`, et **gardez `"binding": "OAUTH_KV"`** même si Wrangler propose un autre nom de liaison. Puis :

```powershell
npx pnpm@11.9.0 test:ci
```

Le test d'isolation échoue si cet `id` est celui du namespace AMAT. Tant que le texte provisoire est en place, `wrangler deploy` échoue : c'est voulu.

## 6. Configuration des secrets

Les trois secrets se définissent avec Wrangler. Ils ne vont jamais dans `wrangler.jsonc`, `.dev.vars.example` ni Git.

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put KBTRADING_ACCESS_TOKEN
```

Wrangler demande la valeur de chaque secret. Pour `KBTRADING_ACCESS_TOKEN` :

- **ne mettez que le jeton, sans `Bearer `** : le Worker construit lui-même `X-Access-Token: Bearer <jeton>`. Un secret vide, contenant un espace ou déjà préfixé par `Bearer` est refusé (erreur 500 `relay_misconfigured` dans les journaux, rien n'est envoyé) ;
- sa source est le fichier `/etc/nginx/secrets/kbtrading-mcp-token` du VPS ;
- pour le transmettre sans l'afficher, depuis **CMD** (CMD transmet les octets tels quels, contrairement à PowerShell 5.1) :

    ```cmd
    cd /d C:\Users\Lenovo\Desktop\Nasta-univers\mcp-auth\demos\remote-mcp-google-oauth-kbtrading
    ssh <utilisateur>@<vps> "sudo cat /etc/nginx/secrets/kbtrading-mcp-token" | npx wrangler secret put KBTRADING_ACCESS_TOKEN
    ```

    Cela suppose que `sudo` ne demande pas de mot de passe pour cette commande. Sinon, utilisez la saisie interactive ci-dessus. Le saut de ligne final éventuel du fichier est ignoré par le Worker.

Pour vérifier la présence des secrets, sans leurs valeurs : `npx wrangler secret list`.

## 7. Déploiement

> À faire seulement après validation. Aucun déploiement n'a été effectué pendant la préparation.

```powershell
cd C:\Users\Lenovo\Desktop\Nasta-univers\mcp-auth\demos\remote-mcp-google-oauth-kbtrading
npx pnpm@11.9.0 test:ci
npx pnpm@11.9.0 type-check
npx pnpm@11.9.0 lint
npx wrangler deploy
```

Vérifiez que la sortie de `wrangler deploy` mentionne **`kbtrading-mcp-oauth`** et `https://kbtrading-mcp-oauth.mbalde.workers.dev`. Si elle mentionne `amat-mcp-oauth`, vous êtes dans le mauvais dossier.

## 8. Configuration du connecteur Claude

Dans Claude (paramètres de l'organisation, puis Connecteurs), ajoutez un connecteur personnalisé :

- **Nom :** KB Trading Odoo (lecture seule)
- **URL :** `https://kbtrading-mcp-oauth.mbalde.workers.dev/mcp`

Chaque utilisateur clique ensuite sur « Connecter ». Il voit la page de consentement « KB Trading Odoo MCP », clique sur « Autoriser », puis choisit son compte Google `@nasta-univers.com`.

## 9. Rotation des secrets

- **`KBTRADING_ACCESS_TOKEN` :**
    1. l'administrateur du VPS remplace le jeton dans `/etc/nginx/secrets/kbtrading-mcp-token` et recharge Nginx ;
    2. immédiatement après, relancez la commande de la section 6. `wrangler secret put` publie aussitôt une nouvelle version du Worker.

    Entre les deux étapes, les requêtes reçoivent un 502 (`shared_secret_refused` dans les journaux). Nginx n'accepte qu'un jeton à la fois ; aucune modification de Nginx n'est prévue ici.

- **`GOOGLE_CLIENT_SECRET` :** créez un nouveau secret dans Google Cloud, lancez `npx wrangler secret put GOOGLE_CLIENT_SECRET`, testez une connexion, puis supprimez l'ancien secret dans Google. Si le client Google est partagé avec AMAT, mettez aussi à jour AMAT **depuis son propre dossier** avant de supprimer l'ancien secret.
- **Révoquer toutes les connexions KB Trading :** créez un nouveau namespace KV (section 5), remplacez l'`id` et redéployez. Tous les jetons deviennent invalides et chaque utilisateur se reconnecte.

## 10. Gestion des utilisateurs autorisés

1. Modifiez `ALLOWED_EMAILS` dans `src/access.ts`.
2. Mettez à jour les tests :
    - `ALLOWED` dans `test/oauth.test.ts` ;
    - la liste attendue dans `test/isolation.test.ts`.
3. Lancez `npx pnpm@11.9.0 test:ci`, committez, puis `npx wrangler deploy` depuis ce dossier.

Un compte retiré perd l'accès à sa requête suivante après le déploiement, car le relais revérifie la liste à chaque requête. Un compte ajouté doit aussi être utilisateur de test Google si l'écran de consentement est en mode « Testing ». Cette liste n'a aucun effet sur AMAT, et inversement.

## 11. Procédure de test

**En local** :

```powershell
Copy-Item .dev.vars.example .dev.vars   # puis renseignez des valeurs de développement
npx pnpm@11.9.0 test:ci                 # tests automatisés (Google et KB Trading simulés)
npx wrangler dev                        # http://localhost:8789
```

`.dev.vars` est ignoré par Git. En local, seuls les `redirect_uri` de Claude sont acceptés.

**Après déploiement**, depuis PowerShell (`curl.exe`, pas l'alias `curl`) :

```powershell
curl.exe -s https://kbtrading-mcp-oauth.mbalde.workers.dev/.well-known/oauth-protected-resource/mcp
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://kbtrading-mcp-oauth.mbalde.workers.dev/mcp
```

La première commande doit afficher `"resource_name":"KB Trading Odoo MCP"`. La seconde doit répondre `401`.

Dans Claude :

- connectez-vous avec chacun des cinq comptes ;
- essayez un compte non autorisé (par exemple `aissata@`, autorisé sur AMAT seulement) : la page « Accès refusé » doit s'afficher ;
- posez une question de lecture ; demandez une création ou une modification, qui doit être refusée.

Journaux en direct : `npx wrangler tail kbtrading-mcp-oauth`. Événements utiles :

- `login_granted`, `login_denied` ;
- `relay_request`, `relay_blocked` ;
- `relay_upstream_failed` : avec `reason: shared_secret_refused`, le jeton ne correspond pas à celui de Nginx ;
- `relay_misconfigured`.

## 12. Procédure de retour arrière

Toujours depuis `demos\remote-mcp-google-oauth-kbtrading` :

- **Revenir à la version précédente :**

    ```powershell
    npx wrangler deployments list
    npx wrangler rollback
    ```

    `rollback` sans argument revient à la version précédente ; on peut aussi lui passer un identifiant de version.

- **Couper l'accès sans supprimer le Worker :** `npx wrangler secret delete KBTRADING_ACCESS_TOKEN`. Le relais répond alors 500 et n'envoie plus rien à Nginx. Retirer aussi le connecteur dans Claude.
- **Supprimer le Worker KB Trading :** `npx wrangler delete`, après avoir vérifié que la confirmation demandée porte bien sur `kbtrading-mcp-oauth`.

Aucune de ces opérations ne touche au Worker AMAT.

## 13. Limites et précautions de sécurité

- **Pas de test réel avant déploiement :** le parcours complet Claude → Google → Worker → Nginx → Odoo n'a pas encore pu être testé. Les tests simulent Google et le serveur KB Trading.
- **Outils de lecture :** la liste `READ_ONLY_TOOLS` reprend les noms d'outils de `mcp-server-odoo`, la même image que pour AMAT. Un outil ajouté par une future version reste bloqué tant qu'il n'est pas ajouté dans `src/mcp-policy.ts`.
- **Format de l'URL amont :** si Nginx ou le serveur redirige entre `/mcp` et `/mcp/`, le relais répond 502. Passez alors `KBTRADING_MCP_URL` à la variante avec `/` final.
- **Google Workspace :** si `nasta-univers.com` est un domaine Google Workspace, exiger aussi la revendication `hd` renforcerait la vérification. Ce contrôle n'est pas activé : il bloquerait tout le monde si le domaine n'est pas sur Workspace.
- **Abus anonymes :** `/register` et `/authorize` écrivent dans KV sans authentification. Sur l'offre Workers Free (1 000 écritures KV par jour), un flot de requêtes peut bloquer les connexions jusqu'au lendemain.
- **Sessions MCP :** elles ne sont pas liées à l'utilisateur OAuth. Les cinq comptes partagent la même identité Odoo côté serveur.
- **Client Google partagé :** s'il est le même qu'AMAT, sa rotation concerne les deux Workers.
- **Secrets :** ne jamais coller de secret dans `wrangler.jsonc`, `.dev.vars.example` ou un commit. `.dev.vars` est ignoré par Git.
