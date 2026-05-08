---
title: "Claude Code — Canaux (Channels) : Bible"
sources:
  - https://code.claude.com/docs/fr/channels
  - https://code.claude.com/docs/fr/channels-reference
fetched: 2026-05-08
status: research preview
min_version: "Claude Code v2.1.80 (relais permission >= v2.1.81)"
auth: "claude.ai uniquement (pas console / pas API key)"
---

# Claude Code — Canaux (Channels) : Bible

Bible interne pour implementer et utiliser des **canaux** Claude Code. Un canal est un **serveur MCP local** (stdio) qui pousse des evenements dans la session Claude Code active. Cette bible sert de reference pour batir un canal `claude-simplex-channel`.

## Sommaire

1. [TL;DR — Antiseche](#tldr--antiseche)
2. [Concepts de base](#concepts-de-base)
3. [Pre-requis](#pre-requis)
4. [Cycle de vie & flag `--channels`](#cycle-de-vie--flag---channels)
5. [Tester pendant la research preview](#tester-pendant-la-research-preview)
6. [Anatomie d'un serveur de canal](#anatomie-dun-serveur-de-canal)
7. [Options du constructeur `Server`](#options-du-constructeur-server)
8. [Format de notification (`notifications/claude/channel`)](#format-de-notification-notificationsclaudechannel)
9. [Exemple minimal — recepteur webhook unidirectionnel](#exemple-minimal--recepteur-webhook-unidirectionnel)
10. [Exposer un outil de reponse (bidirectionnel)](#exposer-un-outil-de-reponse-bidirectionnel)
11. [Controler les messages entrants (anti-injection)](#controler-les-messages-entrants-anti-injection)
12. [Relayer les invites de permission](#relayer-les-invites-de-permission)
13. [Exemple complet — webhook + outil reply + relais permission](#exemple-complet--webhook--outil-reply--relais-permission)
14. [Empaqueter en plugin & marketplace](#empaqueter-en-plugin--marketplace)
15. [Canaux officiels (Telegram, Discord, iMessage, fakechat)](#canaux-officiels-telegram-discord-imessage-fakechat)
16. [Securite](#securite)
17. [Controles Team / Enterprise](#controles-team--enterprise)
18. [Comparaison vs autres mecanismes (Web, Slack, MCP, Remote Control)](#comparaison-vs-autres-mecanismes-web-slack-mcp-remote-control)
19. [Checklist d'implementation](#checklist-dimplementation)
20. [Diagnostic & depannage](#diagnostic--depannage)
21. [References](#references)

---

## TL;DR — Antiseche

> Un canal = un serveur MCP stdio + une capacite speciale.

```ts
// Capacites a declarer cote serveur MCP :
capabilities: {
  experimental: {
    'claude/channel': {},               // OBLIGATOIRE : enregistre l'ecouteur
    'claude/channel/permission': {},    // OPTIONNEL : recevoir les demandes de permission relayees
  },
  tools: {},                            // OPTIONNEL : necessaire pour exposer un outil de reponse (bidirectionnel)
}

// Evenement entrant (canal -> Claude) :
mcp.notification({
  method: 'notifications/claude/channel',
  params: { content: 'corps du message', meta: { chat_id: '42', severity: 'high' } },
})

// Verdict sortant pour le relais de permission :
mcp.notification({
  method: 'notifications/claude/channel/permission',
  params: { request_id: 'abcde', behavior: 'allow' /* | 'deny' */ },
})
```

Lancement :

```bash
# Plugin deja sur la whitelist Anthropic
claude --channels plugin:<name>@<marketplace>

# Plugin dev / serveur .mcp.json bare
claude --dangerously-load-development-channels server:<server-name>
claude --dangerously-load-development-channels plugin:<name>@<marketplace>
```

Format de l'evenement injecte dans le contexte de Claude :

```text
<channel source="<server-name>" key1="value1" key2="value2">
contenu du message
</channel>
```

Regles d'or :
- Les **cles `meta` doivent etre des identifiants** (lettres / chiffres / underscore). Tirets & autres -> silencieusement supprimes.
- L'attribut `source` est pose automatiquement a partir du nom du serveur MCP — **ne pas chercher a le forcer**.
- `instructions` du `Server` est ajoute a l'invite systeme de Claude -> indispensable pour expliquer a Claude comment reagir et **quel attribut renvoyer** (par ex. `chat_id`).
- Pour le relais permission : **ne declarer la capacite que si l'expediteur est authentifie** (sinon n'importe qui peut approuver Bash).

---

## Concepts de base

Un **canal** est un serveur [MCP](https://modelcontextprotocol.io) lance localement par Claude Code en tant que sous-processus, communiquant via **stdio**. Il sert de pont entre des systemes externes et la session Claude Code active :

- **Plateformes de chat** (Telegram, Discord, iMessage, ...) : le plugin tourne en local, interroge l'API de la plateforme et transmet les DMs recus a Claude. Aucune URL publique a exposer.
- **Webhooks** (CI, monitoring, alertes) : le serveur ecoute sur un port HTTP local, et chaque POST devient un evenement de canal.

Un canal peut etre :
- **Unidirectionnel** : alertes / webhooks / monitoring pousses vers Claude qui reagit (lit, ecrit, lance des commandes).
- **Bidirectionnel** : passerelle de chat ou Claude peut renvoyer des messages via un **outil de reponse** MCP standard (`tools: {}`).
- **Avec relais permission** : le canal opte pour recevoir les invites d'approbation d'outils (Bash, Write, Edit, ...) en parallele de la boite locale.

> Lorsque Claude repond via un canal, le terminal n'affiche **pas le texte** de la reponse, seulement l'appel d'outil (`reply`) et un retour type "sent". La vraie reponse apparait cote plateforme.

---

## Pre-requis

| Item | Detail |
|---|---|
| Version | Claude Code **v2.1.80+** (canaux), **v2.1.81+** (relais permission) |
| Authentification | **claude.ai uniquement**. Pas console, pas API key. |
| SDK | `@modelcontextprotocol/sdk` (npm) |
| Runtime | Node.js, Bun, ou Deno (les plugins officiels utilisent Bun, mais c'est libre) |
| Org Team/Enterprise | Doit avoir `channelsEnabled: true` (reglage admin) |

Pendant la research preview, les canaux **personnalises** ne sont pas sur la whitelist Anthropic -> utiliser `--dangerously-load-development-channels` pour le dev local.

---

## Cycle de vie & flag `--channels`

1. Claude Code lit la config MCP au demarrage (`.mcp.json` projet et/ou `~/.claude.json` utilisateur).
2. Il lance chaque serveur en sous-processus stdio.
3. Si un serveur declare `capabilities.experimental['claude/channel']`, Claude Code **enregistre un listener** pour `notifications/claude/channel` (sinon le serveur fonctionne en MCP normal mais ses evenements n'arriveront pas).
4. Pour qu'un canal **delivre vraiment des messages**, il faut le passer a `--channels` au lancement. Etre seulement dans `.mcp.json` ne suffit pas.

```bash
# Plusieurs canaux separes par espaces
claude --channels plugin:telegram@claude-plugins-official plugin:fakechat@claude-plugins-official
```

Formats acceptes :
- `plugin:<plugin>@<marketplace>` — plugin installe via `/plugin install`
- `server:<server-name>` — entree brute de `mcpServers` dans un `.mcp.json` (mode dev uniquement)

---

## Tester pendant la research preview

```bash
# Tester un plugin dev
claude --dangerously-load-development-channels plugin:yourplugin@yourmarketplace

# Tester un serveur .mcp.json brut (sans wrapper plugin)
claude --dangerously-load-development-channels server:webhook
```

Notes :
- Le contournement est **par entree** : combiner avec `--channels` n'etend **pas** le contournement aux entrees `--channels`.
- Le flag ne contourne **que la whitelist** : la politique d'organisation `channelsEnabled` reste appliquee.
- Demande une confirmation interactive au demarrage.

---

## Anatomie d'un serveur de canal

Au minimum, un serveur de canal doit :

1. **Declarer la capacite** `claude/channel` (presence = enregistrement du listener).
2. **Emettre des notifications** `notifications/claude/channel` quand quelque chose se passe.
3. **Se connecter via transport stdio** (Claude Code lance le processus).

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const mcp = new Server(
  { name: 'my-channel', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'Les evenements arrivent sous forme <channel source="my-channel" ...>.',
  },
)

await mcp.connect(new StdioServerTransport())
```

---

## Options du constructeur `Server`

| Champ | Type | Description |
|---|---|---|
| `capabilities.experimental['claude/channel']` | `object` | **Requis.** Toujours `{}`. Sa presence enregistre l'ecouteur de notifications cote Claude Code. |
| `capabilities.experimental['claude/channel/permission']` | `object` | Optionnel. Toujours `{}`. Declare que le canal peut recevoir des **demandes de relais de permission**. |
| `capabilities.tools` | `object` | Bidirectionnel uniquement. Toujours `{}`. Capacite MCP standard pour exposer un outil de reponse. |
| `instructions` | `string` | **Recommande.** Ajoute a l'invite systeme de Claude. Doit expliquer : quels evenements attendre, ce que les attributs de la balise `<channel>` signifient, s'il faut repondre, et comment (quel outil + quel attribut repasser, ex. `chat_id`). |

Configuration bidirectionnelle complete :

```ts
const mcp = new Server(
  { name: 'your-channel', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},                                // omettre si unidirectionnel
    },
    instructions: 'Les messages arrivent sous la forme <channel source="your-channel" ...>. Reponds avec l\'outil reply.',
  },
)
```

---

## Format de notification (`notifications/claude/channel`)

| Champ | Type | Description |
|---|---|---|
| `content` | `string` | Le corps de l'evenement. Devient le **contenu textuel** de la balise `<channel>`. |
| `meta` | `Record<string, string>` | Optionnel. Chaque entree devient un **attribut** de la balise `<channel>`. **Cles = identifiants uniquement** (lettres/chiffres/underscore). Les cles avec tirets ou autres caracteres sont **silencieusement supprimees**. |

Emission :

```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'build failed on main: https://ci.example.com/run/1234',
    meta: { severity: 'high', run_id: '1234' },
  },
})
```

Forme injectee dans le contexte de Claude :

```text
<channel source="your-channel" severity="high" run_id="1234">
build failed on main: https://ci.example.com/run/1234
</channel>
```

`source` est pose automatiquement par Claude Code a partir du `name` du `Server`.

---

## Exemple minimal — recepteur webhook unidirectionnel

### 1. Creer le projet

```bash
mkdir webhook-channel && cd webhook-channel
bun add @modelcontextprotocol/sdk
```

### 2. `webhook.ts`

```ts
#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const mcp = new Server(
  { name: 'webhook', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Les evenements du canal webhook arrivent sous la forme <channel source="webhook" ...>. ' +
      'Ils sont unidirectionnels : lis-les et agis, aucune reponse attendue.',
  },
)

await mcp.connect(new StdioServerTransport())

Bun.serve({
  port: 8788,
  hostname: '127.0.0.1',           // localhost only
  async fetch(req) {
    const body = await req.text()
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: body,
        meta: { path: new URL(req.url).pathname, method: req.method },
      },
    })
    return new Response('ok')
  },
})
```

### 3. `.mcp.json` (chemin relatif au projet) ou `~/.claude.json` (chemin absolu)

```json
{
  "mcpServers": {
    "webhook": { "command": "bun", "args": ["./webhook.ts"] }
  }
}
```

### 4. Lancer & tester

```bash
claude --dangerously-load-development-channels server:webhook
```

```bash
curl -X POST localhost:8788 -d "build failed on main: https://ci.example.com/run/1234"
```

Cote Claude :

```text
<channel source="webhook" path="/" method="POST">build failed on main: https://ci.example.com/run/1234</channel>
```

---

## Exposer un outil de reponse (bidirectionnel)

Trois elements a ajouter :

1. `tools: {}` dans les capacites (declenche la decouverte d'outils).
2. Handlers `ListTools` + `CallTool` qui definissent le schema et la logique d'envoi.
3. Mettre a jour `instructions` pour dire a Claude **quand** appeler l'outil et **quel attribut repasser**.

```ts
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Envoyer un message en retour sur ce canal',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'La conversation dans laquelle repondre' },
        text:    { type: 'string', description: 'Le message a envoyer' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    send(`Reply to ${chat_id}: ${text}`)         // POST plateforme, ou SSE pour les tests
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})
```

Et dans `instructions` :

```ts
instructions:
  'Les messages arrivent sous la forme <channel source="webhook" chat_id="...">. ' +
  'Reponds avec l\'outil reply en passant le chat_id de la balise.',
```

### Webhook bidirectionnel complet (avec SSE pour debug)

```ts
#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const listeners = new Set<(chunk: string) => void>()
function send(text: string) {
  const chunk = text.split('\n').map(l => `data: ${l}\n`).join('') + '\n'
  for (const emit of listeners) emit(chunk)
}

const mcp = new Server(
  { name: 'webhook', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'Les messages arrivent sous la forme <channel source="webhook" chat_id="...">. ' +
      'Reponds avec l\'outil reply, en passant le chat_id de la balise.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Envoyer un message en retour sur ce canal',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'La conversation dans laquelle repondre' },
        text:    { type: 'string', description: 'Le message a envoyer' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    send(`Reply to ${chat_id}: ${text}`)
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

await mcp.connect(new StdioServerTransport())

let nextId = 1
Bun.serve({
  port: 8788,
  hostname: '127.0.0.1',
  idleTimeout: 0,                 // ne pas couper les SSE
  async fetch(req) {
    const url = new URL(req.url)

    // GET /events : flux SSE pour observer les sorties via curl -N
    if (req.method === 'GET' && url.pathname === '/events') {
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(': connected\n\n')
          const emit = (chunk: string) => ctrl.enqueue(chunk)
          listeners.add(emit)
          req.signal.addEventListener('abort', () => listeners.delete(emit))
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      })
    }

    // POST : forward vers Claude
    const body = await req.text()
    const chat_id = String(nextId++)
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: body, meta: { chat_id, path: url.pathname, method: req.method } },
    })
    return new Response('ok')
  },
})
```

---

## Controler les messages entrants (anti-injection)

> Un canal non controle est un **vecteur d'injection de prompt**. Quiconque peut atteindre l'endpoint peut mettre du texte devant Claude.

Regles :
- **Toujours verifier l'expediteur** (pas la salle/le chat) avant d'appeler `mcp.notification()`.
- Drop **silencieux** sur non-match (pas de feedback exploitable).
- Pour les chats de groupe : controler sur `message.from.id`, **jamais** sur `message.chat.id`.

```ts
const allowed = new Set(loadAllowlist())   // ex. depuis access.json

async function onIncoming(message) {
  if (!allowed.has(message.from.id)) return  // drop silencieux
  await mcp.notification({ /* ... */ })
}
```

Modeles d'amorcage de l'allowlist :
- **Telegram / Discord** -> flux d'**appairage** : DM au bot -> bot repond avec un code -> user approuve via slash-command -> ID ajoute.
- **iMessage** -> detection auto des adresses propres de l'utilisateur depuis la base Messages, autres ajoutes manuellement.

---

## Relayer les invites de permission

> Necessite Claude Code **v2.1.81+**. Les versions anterieures ignorent `claude/channel/permission`.

### Concept

Quand Claude veut appeler un outil sensible (`Bash`, `Write`, `Edit`, ...), une boite de dialogue d'approbation s'ouvre dans le terminal local. Un canal bidirectionnel peut **opter pour** recevoir la meme invite en parallele et l'envoyer a un appareil distant. Les deux restent actives : la **premiere reponse gagne**, l'autre est fermee.

Couvert : approbations d'outils (Bash/Write/Edit/etc).
**Non couvert** : confiance projet, consentement serveur MCP — toujours dans le terminal local uniquement.

### Boucle en 4 etapes

1. Claude Code genere un `request_id` court et notifie le serveur de canal.
2. Le serveur formate l'invite et l'envoie sur la plateforme distante.
3. L'utilisateur distant repond `yes <id>` ou `no <id>`.
4. Le gestionnaire entrant parse en verdict, et Claude Code l'applique **uniquement** si l'ID matche une demande ouverte.

### Schema de la demande (`notifications/claude/channel/permission_request`)

| Champ | Description |
|---|---|
| `request_id` | **5 lettres minuscules** tirees de `a-z` **sans `l`** (jamais confondu avec `1` ou `I`). A inclure verbatim dans l'invite distante. La boite locale **ne l'affiche pas** — c'est ton handler qui doit le pousser. |
| `tool_name` | Nom de l'outil que Claude veut utiliser (`Bash`, `Write`, ...). |
| `description` | Resume human-readable de l'appel — meme texte que la boite locale. Pour Bash : la description Claude de la commande, ou la commande elle-meme a defaut. |
| `input_preview` | Arguments de l'outil en JSON, **tronques a 200 caracteres**. A omettre si l'invite distante est tres contrainte. |

### Schema du verdict (`notifications/claude/channel/permission`)

| Champ | Description |
|---|---|
| `request_id` | Doit reprendre exactement l'ID emis. |
| `behavior` | `'allow'` ou `'deny'`. Allow laisse l'appel passer ; deny le rejette comme un Non local. **N'affecte pas les appels futurs.** |

### Implementation cote serveur de canal

#### 1. Declarer la capacite

```ts
capabilities: {
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},
  },
  tools: {},
},
```

> **N'opte que si l'expediteur est authentifie** : quiconque peut repondre via le canal pourra approuver l'usage d'outils dans ta session.

#### 2. Handler de demande entrante

```ts
import { z } from 'zod'

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id:    z.string(),
    tool_name:     z.string(),
    description:   z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  send(
    `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
    `Reply "yes ${params.request_id}" or "no ${params.request_id}"`,
  )
})
```

#### 3. Intercepter le verdict cote entrant

```ts
// "y abcde", "yes abcde", "n abcde", "no abcde"
// [a-km-z] = alphabet d'IDs (minuscules sans 'l')
// /i tolere l'autocorrect mobile ; on lowercase l'ID capture.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

async function onInbound(message) {
  if (!allowed.has(message.from.id)) return    // gating expediteur d'abord

  const m = PERMISSION_REPLY_RE.exec(message.text)
  if (m) {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: m[2].toLowerCase(),
        behavior:   m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
      },
    })
    return    // c'etait un verdict, ne pas forwarder en chat
  }

  // chat normal
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: message.text, meta: { chat_id: String(message.chat.id) } },
  })
}
```

### Modes d'echec

- **Format different** (ex. `approve it`, `yes` sans ID) -> la regex ne matche pas -> forward en chat normal, la boite locale **reste ouverte**.
- **Format correct mais ID inconnu** -> Claude Code drop silencieusement, la boite locale **reste ouverte**.

---

## Exemple complet — webhook + outil reply + relais permission

```ts
#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

// --- Sortant : SSE (debug local). En prod : POST plateforme. ---
const listeners = new Set<(chunk: string) => void>()
function send(text: string) {
  const chunk = text.split('\n').map(l => `data: ${l}\n`).join('') + '\n'
  for (const emit of listeners) emit(chunk)
}

// Allowlist expediteur. Demo : header X-Sender = "dev".
const allowed = new Set(['dev'])

const mcp = new Server(
  { name: 'webhook', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'Les messages arrivent sous la forme <channel source="webhook" chat_id="...">. ' +
      'Reponds avec l\'outil reply, en passant le chat_id de la balise.',
  },
)

// --- Outil reply ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Envoyer un message en retour sur ce canal',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'La conversation dans laquelle repondre' },
        text:    { type: 'string', description: 'Le message a envoyer' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    send(`Reply to ${chat_id}: ${text}`)
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// --- Relais permission : Claude Code -> serveur ---
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id:    z.string(),
    tool_name:     z.string(),
    description:   z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  send(
    `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
    `Reply "yes ${params.request_id}" or "no ${params.request_id}"`,
  )
})

await mcp.connect(new StdioServerTransport())

// --- HTTP :8788 ---
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
let nextId = 1

Bun.serve({
  port: 8788,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    // GET /events : SSE de debug
    if (req.method === 'GET' && url.pathname === '/events') {
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(': connected\n\n')
          const emit = (chunk: string) => ctrl.enqueue(chunk)
          listeners.add(emit)
          req.signal.addEventListener('abort', () => listeners.delete(emit))
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      })
    }

    // Inbound : gate sender d'abord
    const body = await req.text()
    const sender = req.headers.get('X-Sender') ?? ''
    if (!allowed.has(sender)) return new Response('forbidden', { status: 403 })

    // Verdict permission ?
    const m = PERMISSION_REPLY_RE.exec(body)
    if (m) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: m[2].toLowerCase(),
          behavior:   m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      })
      return new Response('verdict recorded')
    }

    // Chat normal
    const chat_id = String(nextId++)
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: body, meta: { chat_id, path: url.pathname } },
    })
    return new Response('ok')
  },
})
```

### Tester (3 terminaux)

```bash
# 1. Lancer Claude Code avec le canal dev
claude --dangerously-load-development-channels server:webhook

# 2. Suivre les sorties SSE
curl -N localhost:8788/events

# 3. Envoyer un message qui declenchera Bash
curl -d "list the files in this directory" -H "X-Sender: dev" localhost:8788

# Approuver a distance (l'ID arrive dans le flux SSE)
curl -d "yes <id>" -H "X-Sender: dev" localhost:8788
```

---

## Empaqueter en plugin & marketplace

Pour rendre un canal **installable et partageable**, l'envelopper dans un [plugin](https://code.claude.com/docs/fr/plugins) et le publier sur un [marketplace](https://code.claude.com/docs/fr/plugin-marketplaces).

```bash
# Cote utilisateur :
/plugin install <name>@<marketplace>
claude --channels plugin:<name>@<marketplace>
```

Pendant la research preview :
- Un plugin sur **ton propre marketplace** necessite toujours `--dangerously-load-development-channels`.
- Pour rejoindre la whitelist Anthropic : [soumettre au marketplace officiel](https://code.claude.com/docs/fr/plugins#submit-your-plugin-to-the-official-marketplace) (review secu).
- Sur Team/Enterprise, l'admin peut whitelister a la place via [`allowedChannelPlugins`](#controles-team--enterprise).

---

## Canaux officiels (Telegram, Discord, iMessage, fakechat)

Tous les plugins officiels sont des **scripts Bun**. Source : [`anthropics/claude-plugins-official/external_plugins`](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins).

### Telegram

```bash
# 1. Creer un bot via @BotFather -> /newbot -> copier le token
# 2. Installer
/plugin install telegram@claude-plugins-official
/reload-plugins

# 3. Configurer
/telegram:configure <token>
# (ecrit dans ~/.claude/channels/telegram/.env, ou TELEGRAM_BOT_TOKEN dans l'env shell)

# 4. Activer le canal
claude --channels plugin:telegram@claude-plugins-official

# 5. Appairer
# DM au bot -> bot repond avec un code
/telegram:access pair <code>
/telegram:access policy allowlist
```

### Discord

```bash
# 1. Discord Developer Portal -> New Application -> Bot -> Reset Token
# 2. Activer Privileged Gateway Intents > Message Content Intent
# 3. OAuth2 > URL Generator : scope `bot` + permissions :
#    View Channels, Send Messages, Send Messages in Threads,
#    Read Message History, Attach Files, Add Reactions
# 4. Inviter le bot via l'URL generee

/plugin install discord@claude-plugins-official
/reload-plugins
/discord:configure <token>
# (DISCORD_BOT_TOKEN aussi possible)

claude --channels plugin:discord@claude-plugins-official

# DM au bot -> code
/discord:access pair <code>
/discord:access policy allowlist
```

### iMessage (macOS uniquement)

Lit `~/Library/Messages/chat.db` et envoie via AppleScript.

```bash
# 1. Accorder Full Disk Access au terminal hote (macOS Settings > Privacy & Security)
/plugin install imessage@claude-plugins-official
claude --channels plugin:imessage@claude-plugins-official

# 2. T'envoyer un message -> contournement automatique de l'allowlist (auto-chat)
# 3. Premiere reponse -> invite d'automation macOS pour Messages -> OK

# Autoriser un autre contact :
/imessage:access allow +15551234567
/imessage:access allow user@example.com
```

### fakechat (demo localhost)

Pas d'API externe, sert une UI web sur localhost.

```bash
/plugin install fakechat@claude-plugins-official
claude --channels plugin:fakechat@claude-plugins-official
# UI : http://localhost:8787
```

---

## Securite

- Chaque plugin officiel maintient une **allowlist d'expediteurs** ; les autres sont **silencieusement droppes**.
- Telegram/Discord : amorcage par appairage. iMessage : auto-chat de l'utilisateur autorise d'office.
- `--channels` opt-in **par session** : un serveur dans `.mcp.json` mais absent de `--channels` ne recoit pas les events.
- Sur Team/Enterprise, `channelsEnabled` est un commutateur maitre admin.
- L'allowlist controle **aussi le relais permission** : qui peut repondre = qui peut approuver Bash. **N'allowliste que des expediteurs de confiance pour ce niveau.**

---

## Controles Team / Enterprise

Desactives par defaut sur Team/Enterprise. Deux managed settings non modifiables par l'utilisateur :

| Parametre | Role | Si non defini |
|---|---|---|
| `channelsEnabled` | Commutateur maitre. Doit etre `true` pour qu'un canal delivre. Bloque **tout**, y compris `--dangerously-load-development-channels`. | Canaux bloques |
| `allowedChannelPlugins` | Liste des plugins whitelistes. Override la liste maintenue par Anthropic. Ne s'applique que si `channelsEnabled: true`. | Whitelist Anthropic par defaut |

Activer via [claude.ai -> Admin settings -> Claude Code -> Channels](https://claude.ai/admin-settings/claude-code) ou managed settings :

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-plugins-official", "plugin": "telegram" },
    { "marketplace": "claude-plugins-official", "plugin": "discord" },
    { "marketplace": "acme-corp-plugins",       "plugin": "internal-alerts" }
  ]
}
```

- `[]` (tableau vide) -> bloque tous les plugins whitelistes, mais `--dangerously-load-development-channels` peut toujours bypasser pour test local.
- Pour tout bloquer y compris dev -> laisser `channelsEnabled` non defini.

Pro/Max sans org : ignorent ces checks, opt-in par session via `--channels`.

---

## Comparaison vs autres mecanismes (Web, Slack, MCP, Remote Control)

| Feature | Ce qu'elle fait | Bonne pour |
|---|---|---|
| **Claude Code on the web** | Taches dans un sandbox cloud, clone depuis GitHub | Delegation async autonome |
| **Claude in Slack** | Lance une session web depuis `@Claude` | Demarrer depuis le contexte d'equipe |
| **Standard MCP server** | Claude l'**interroge** en cours de tache | Acces on-demand en lecture/query |
| **Remote Control** | Pilote ta session locale depuis claude.ai / mobile | Diriger une session active a distance |
| **Channels** | **Pousse des events** dans la session locale active | Pont chat, webhook receiver, monitoring |

Channels = chainon manquant : evenements **pousses** depuis sources non-Claude vers la session locale **deja active**.

---

## Checklist d'implementation

Avant de livrer un canal custom :

- [ ] `name`/`version` dans le constructeur `Server` coherents avec le nom du plugin
- [ ] `capabilities.experimental['claude/channel'] = {}` declare
- [ ] `instructions` explique la forme de la balise `<channel>`, le sens des attributs, et **comment repondre** (outil + cle a repasser)
- [ ] Transport : `StdioServerTransport`
- [ ] Hostname HTTP : `127.0.0.1` (jamais `0.0.0.0` sans raison)
- [ ] Cles `meta` : identifiants uniquement (lettres/chiffres/underscore)
- [ ] **Allowlist d'expediteurs** + drop silencieux sur non-match
- [ ] Gating sur `from.id`, **pas** sur `chat.id`
- [ ] Si bidirectionnel : `tools: {}` + `ListTools` + `CallTool` + `instructions` qui pointe l'outil
- [ ] Si relais permission : `claude/channel/permission: {}` + `setNotificationHandler` + intercepteur regex cote inbound
- [ ] Regex verdict : `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i` (note l'**absence de `l`** dans la classe)
- [ ] Lowercase de l'ID capture avant renvoi (autocorrect mobile)
- [ ] `idleTimeout: 0` si SSE/long-polling pour ne pas couper les flux
- [ ] Plugin marketplace : packagee + soumis si Anthropic-listed vise
- [ ] Pour Team/Enterprise : doc admin sur `channelsEnabled` + `allowedChannelPlugins`

---

## Diagnostic & depannage

| Symptome | Cause probable | Action |
|---|---|---|
| "Bloque par la politique de l'organisation" au demarrage | `channelsEnabled` desactive | Demander a l'admin Team/Enterprise d'activer |
| `curl` repond OK mais rien n'arrive a Claude | Erreur d'import / dependance dans le serveur | `/mcp` dans la session pour voir l'etat ; lire `~/.claude/debug/<session-id>.txt` (stderr) |
| `curl` : "connection refused" | Port pas encore lie OU process zombie d'une ancienne session | `lsof -i :<port>` puis `kill <pid>` ; redemarrer Claude Code |
| Plugin signale "introuvable dans aucune marketplace" | Marketplace pas ajoutee ou obsolete | `/plugin marketplace add anthropics/claude-plugins-official` puis `/plugin marketplace update claude-plugins-official` |
| Bot Telegram/Discord ne repond pas a l'appairage | Claude Code lance sans `--channels` | Relancer avec `--channels plugin:<name>@<marketplace>` |
| iMessage : `authorization denied` au demarrage | Pas de Full Disk Access pour le terminal | System Settings > Privacy & Security > Full Disk Access -> ajouter le terminal |
| Boite de permission locale ne se ferme pas malgre le `yes` distant | Format different OU ID mauvais | Verifier la regex et l'ID exact (5 lettres `[a-km-z]`) |
| Attributs absents dans `<channel ...>` | Cles `meta` avec tirets/caracteres non identifiers | Renommer en snake_case ASCII |

---

## References

- [Channels — guide utilisateur (FR)](https://code.claude.com/docs/fr/channels)
- [Channels reference — implementation (FR)](https://code.claude.com/docs/fr/channels-reference)
- [Plugins officiels (Telegram, Discord, iMessage, fakechat)](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins)
- [Plugin Telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)
- [Plugin Discord](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord)
- [Plugin iMessage](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/imessage)
- [Plugin fakechat](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/fakechat)
- [MCP — Model Context Protocol](https://modelcontextprotocol.io)
- [MCP SDK npm package](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP transports — stdio](https://modelcontextprotocol.io/docs/concepts/transports#standard-io)
- [Bun runtime](https://bun.sh)
- [Issues GitHub Claude Code](https://github.com/anthropics/claude-code/issues)
