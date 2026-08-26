# TabRunner — Chrome Web Store listing

Source of truth for the store submission. Every block below is pasted verbatim into
`chrome.google.com/webstore/devconsole` → TabRunner. Sections are grouped the way the dashboard
groups them: **Store listing** (§1–§3) and **Privacy practices** (§4). When a feature lands, update
the matching block here first.

> ### Status — approved 2026-08-15 🎉
>
> **The listing is live** at the store URL in §1. Two follow-ups came out of it:
>
> - **The description renders raw markup.** The prior draft assumed CWS renders a Markdown subset
>   and pasted `##`, `**bold**` and `-` lists — the live page shows those characters literally.
>   §2 is now plain text, and the store description must stay that way. Paste the corrected §2
>   blocks and resubmit (a description edit needs no new package).
> - **`LINKS.store` flips from plain text to an _Add to Chrome_ button** on the site, and the
>   install instructions that said "until the store listing is approved" stop being true —
>   [`docs/website-brief.md`](website-brief.md) is the contract to update in the same sitting.
> - **2026-08-18 — memory, schedules and skills landed after approval.** §2 (all three locales)
>   and §4 (single purpose, storage, alarms, notifications, host permissions) are updated below —
>   paste them into the dashboard. Listing edit only: no package, no review.
> - **2026-08-20 — walkthroughs landed, and the run/conversation vocabulary retired.** §2 (all
>   three locales) gains the walkthroughs paragraph, and §2–§4 now say task/chat where the
>   shipped UI does. Listing edit only: no package, no review.
> - **2026-08-20 — `unlimitedStorage` had shipped undocumented.** It entered the manifest with
>   walkthroughs (a516dfa, in v0.5.2) and never got a §4 block, so the dashboard has been a
>   permission short since that upload. Its justification is below — paste it. The package
>   already requests it, so this is a listing edit, not a new package.
> - **2026-08-25 — two-way MCP and webhooks landed after approval.** §2 (all three locales)
>   gains the two-way-MCP paragraph, and §4's host-permissions justification now covers requests
>   to the remote servers and webhook URLs the user configures. Listing edit only: no package,
>   no review.

---

## 1. Identity

| Field                | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| **Name**             | TabRunner                                                                 |
| **Category**         | Productivity                                                              |
| **Default language** | English (listing localized: en / pt-BR / es)                              |
| **Visibility**       | Public                                                                    |
| **Homepage URL**     | https://tabrunner.app                                                     |
| **Support URL**      | https://github.com/tabrunner/tabrunner/issues                             |
| **Privacy policy**   | https://tabrunner.app/privacy                                             |
| **Extension ID**     | `ilnohobdcigbmlikjbkdpbkhciephdle`                                        |
| **Store URL**        | https://chromewebstore.google.com/detail/ilnohobdcigbmlikjbkdpbkhciephdle |

**There is no short-description field.** The one-line summary the store shows in search results is
the manifest's `description`, which ships from `public/_locales/<lang>/messages.json` (`extDescription`).
Changing it means a new package upload — it cannot be edited from the dashboard.

| Locale | Shipped summary                                 |
| ------ | ----------------------------------------------- |
| en     | Provider-agnostic browser agent                 |
| pt-BR  | Agente de navegador independente de provedor    |
| es     | Agente de navegador independiente del proveedor |

<details>
<summary>Longer summaries, ready for the next version bump (cap is 132 chars)</summary>

The shipped strings are terse and jargon-forward. These read better in store search, and fit the
cap — swap them into `public/_locales/*/messages.json` whenever a version ships for another reason.

```
An AI agent that drives your real browser — your tabs, sessions and logins — through any provider you choose.
```

```
Um agente de IA que dirige seu navegador de verdade — abas, sessões e logins — com qualquer provedor que você escolher.
```

```
Un agente de IA que maneja tu navegador real — pestañas, sesiones y accesos — con el proveedor que elijas.
```

</details>

---

## 2. Full description

One per listing locale. **Plain text — no Markdown at all.** The store's description field renders
nothing: `##`, `**bold**`, `-` lists, and backticks all display as literal characters (this bit
the approved listing). Section lines are ALL CAPS, items are whole sentences on their own line —
the structure reads without any markup.

<details open>
<summary><strong>English</strong> (default listing language)</summary>

```text
You give the goal. It runs the tabs.

TabRunner is a browser agent that lives in your browser and works in it — not in a sandbox. It
works the tab you're already on, uses your logged-in sessions, and reads, clicks and types on the
sites you already use, until the task you described is done.

Works in your real browser — your existing logins are its sessions. No setup on every site, no
fake profile, no separate account.

Bring your own provider — sign in with an AI subscription you already pay for, or paste an API
key: 15 presets cover the major cloud and local providers, and a custom endpoint accepts anything
speaking a standard API format. No vendor lock-in, no relay, no TabRunner server.

Your credentials stay yours — a key or a sign-in goes straight from the extension to your
provider. Nothing is stored outside Chrome. No account, no telemetry.

Trusted input — clicks and keystrokes go through the Chrome DevTools Protocol, so they are
genuine trusted events, not synthetic dispatches sites can ignore.

See the work — a live plan, current action, token spend and elapsed time while the agent runs.
Every step is logged in the chat.

It remembers how you work — your standing instructions and the facts it learns along the way load
into every task, per site or globally. Review, edit or delete all of it in Settings, or turn memory
off entirely.

Skills are saved recipes — turn a finished chat into a reusable skill, write one by hand,
or import one as markdown from a URL. A skill tied to a site is offered automatically when a task
starts there, and every skill is yours to edit, export, disable or delete in Settings.

Set it on a schedule — a task can run once at a time you pick, daily, or every few minutes within
the hours you allow. Each schedule keeps its own chat, so a recurring run can see what it
did last time.

Turn a task into a walkthrough — ask "and document it" and the finished task becomes a
shareable, step-by-step guide with a screenshot of each step. Those screenshots stay on this
computer and never enter the chat sent to the model, so a recording cannot reach your
provider. If one comes out incomplete, the guide says so in its own introduction. On by
default; switch it off in Settings.

Two-way MCP — TabRunner speaks MCP in both directions. An AI client on your machine can hand it
tasks through the local bridge, and TabRunner connects out to remote MCP servers you add: their
tools join every task behind plan approval, and when a server needs your input it asks right in
the panel. Run events — started, finished, errors, questions — can also POST to your own webhook
URL, so tasks plug into your automations.

HOW IT WORKS

1. Describe a task in the side panel — e.g. "pull the invoice from my inbox into the expense
   report".
2. Approve the plan it comes back with. TabRunner then works the tab like you would — reading the
   page, clicking, typing, scrolling — with real user input.
3. Watch it work step by step, or send it to the background and get a notification when it's done.

PRIVATE BY DESIGN

No TabRunner server exists. The extension speaks to your provider directly.

Provider configs and chat history live in chrome.storage on this device.

The model never receives raw HTML — it works from a compact semantic tree of the page, and
sensitive fields (passwords, one-time codes, card numbers) never leave the page.

Works on Chrome and other Chromium-based browsers.

GUARDRAILS

You approve the plan — TabRunner cannot click, type or navigate until you've okayed what it
intends to do.

Ask before acting — consequential actions (paying, sending, deleting) come back for your
confirmation in the panel before they happen.

Stop is real — Esc or the Stop button ends the task on the spot; anything you've already typed
becomes the next task.

Reasoning effort — pin none to max per task, or leave Auto and TabRunner runs the newest model
your endpoint lists.

LANGUAGES

English · Português (Brasil) · Español. Light and dark theme, or follow your OS.
```

</details>

<details>
<summary><strong>Português (Brasil)</strong></summary>

```text
Você dá o objetivo. Ele pilota as abas.

O TabRunner é um agente que vive no seu navegador e trabalha dentro dele — não em um sandbox. Ele
usa a aba que você já está vendo, aproveita suas sessões logadas e lê, clica e digita nos sites que
você já usa, até concluir a tarefa que você descreveu.

Funciona no seu navegador de verdade — seus logins atuais são as sessões dele. Sem configurar
cada site, sem perfil falso, sem conta separada.

Traga o seu provedor — entre com uma assinatura de IA que você já paga, ou cole uma chave de API:
15 presets cobrem os principais provedores em nuvem e locais, e um endpoint personalizado aceita
qualquer serviço em um formato de API padrão. Sem lock-in, sem relay, sem servidor do TabRunner.

Suas credenciais continuam suas — a chave ou o login vai direto da extensão para o seu provedor.
Nada é guardado fora do Chrome. Sem conta, sem telemetria.

Entrada confiável — cliques e teclas passam pelo Chrome DevTools Protocol, então são eventos
confiáveis de verdade, não disparos sintéticos que os sites podem ignorar.

Veja o trabalho acontecer — plano ao vivo, ação atual, tokens gastos e tempo decorrido enquanto o
agente trabalha. Cada passo fica registrado na conversa.

Ele lembra como você trabalha — suas instruções fixas e os fatos que ele aprende pelo caminho
entram em cada tarefa, por site ou globais. Revise, edite ou apague tudo nas Configurações, ou
desligue a memória por completo.

Habilidades são receitas salvas — transforme uma conversa concluída em uma habilidade
reutilizável, escreva uma à mão, ou importe uma em markdown a partir de uma URL. Uma habilidade
ligada a um site é oferecida automaticamente quando uma tarefa começa nele, e cada uma pode ser
editada, exportada, desativada ou excluída nas Configurações.

Agende — uma tarefa pode rodar uma única vez no horário que você escolher, todo dia, ou a cada
poucos minutos dentro das horas que você permitir. Cada agendamento mantém a própria conversa,
então uma execução recorrente vê o que fez da última vez.

Guias passo a passo — peça "e documente isso" e a tarefa terminada vira um passo a passo
compartilhável, com uma captura de cada passo. Essas capturas ficam neste computador e nunca
entram na conversa enviada ao modelo, então não têm como chegar ao seu provedor. Se a gravação
ficar incompleta, o guia diz isso na introdução. Vem ligado; desligue nas Configurações.

MCP nos dois sentidos — o TabRunner fala MCP nas duas direções. Um cliente de IA na sua máquina
pode passar tarefas pela ponte local, e o TabRunner também se conecta a servidores MCP remotos
que você adiciona: as ferramentas deles entram em toda tarefa atrás da aprovação do plano, e
quando um servidor precisa da sua resposta ele pergunta ali mesmo no painel. Eventos de execução
— início, término, erros, perguntas — também podem ir por POST para uma URL de webhook sua, então
as tarefas se encaixam nas suas automações.

COMO FUNCIONA

1. Descreva uma tarefa no painel lateral — por exemplo: "pegue a nota fiscal no meu e-mail e lance
   no relatório de despesas".
2. Aprove o plano que ele propõe. O TabRunner então usa a aba como você faria — lendo a página,
   clicando, digitando, rolando — com entrada real do usuário.
3. Acompanhe passo a passo, ou mande a tarefa para segundo plano e receba uma notificação quando
   terminar.

PRIVACIDADE POR PADRÃO

Não existe servidor do TabRunner. A extensão fala direto com o seu provedor.

Configurações de provedor e histórico de conversas ficam no chrome.storage, neste dispositivo.

O modelo nunca recebe o HTML bruto — ele trabalha com uma árvore semântica compacta da página, e
campos sensíveis (senhas, códigos de uso único, números de cartão) não saem da página.

Funciona no Chrome e em outros navegadores baseados em Chromium.

LIMITES E CONTROLE

Você aprova o plano — o TabRunner não clica, não digita e não navega antes de você aprovar o que
ele pretende fazer.

Pergunta antes de agir — ações com consequência (pagar, enviar, excluir) voltam para você
confirmar no painel antes de acontecerem.

Parar é parar mesmo — Esc ou o botão Parar encerra a tarefa na hora; o que você já tiver
digitado vira a próxima tarefa.

Esforço de raciocínio — fixe de none a max por tarefa, ou deixe em Auto e o TabRunner usa o
modelo mais recente que o seu endpoint listar.

IDIOMAS

English · Português (Brasil) · Español. Tema claro e escuro, ou seguindo o sistema.
```

</details>

<details>
<summary><strong>Español</strong></summary>

```text
Tú pones la meta. Él pilota tus pestañas.

TabRunner es un agente que vive en tu navegador y trabaja dentro de él — no en un sandbox. Usa la
pestaña que ya tienes delante, aprovecha tus sesiones iniciadas y lee, hace clic y escribe en los
sitios que ya usas, hasta terminar la tarea que describiste.

Funciona en tu navegador real — tus accesos actuales son sus sesiones. Sin configurar cada sitio,
sin perfil falso, sin cuenta aparte.

Trae tu propio proveedor — inicia sesión con una suscripción de IA que ya pagas, o pega una clave
de API: 15 preajustes cubren los principales proveedores en la nube y locales, y un endpoint
personalizado acepta cualquier servicio con un formato de API estándar. Sin dependencia de un
proveedor, sin relay, sin servidor de TabRunner.

Tus credenciales siguen siendo tuyas — la clave o el inicio de sesión va directo de la extensión a
tu proveedor. Nada se guarda fuera de Chrome. Sin cuenta, sin telemetría.

Entrada confiable — los clics y las teclas pasan por el Chrome DevTools Protocol, así que son
eventos confiables de verdad, no disparos sintéticos que los sitios pueden ignorar.

Mira el trabajo — plan en vivo, acción actual, tokens gastados y tiempo transcurrido mientras el
agente trabaja. Cada paso queda registrado en el chat.

Recuerda cómo trabajas — tus instrucciones fijas y los datos que aprende por el camino entran en
cada tarea, por sitio o globales. Revisa, edita o borra todo en la Configuración, o apaga la
memoria por completo.

Las habilidades son recetas guardadas — convierte un chat terminado en una habilidad
reutilizable, escribe una a mano, o importa una en markdown desde una URL. Una habilidad ligada a
un sitio se ofrece automáticamente cuando una tarea empieza allí, y cada una se puede editar,
exportar, desactivar o eliminar en la Configuración.

Prográmalo — una tarea puede ejecutarse una sola vez a la hora que elijas, cada día, o cada pocos
minutos dentro de las horas que permitas. Cada programación conserva su propio chat, así
que una ejecución recurrente ve lo que hizo la última vez.

Guías paso a paso — añade "y documéntalo" a cualquier tarea y obtendrás una guía para
compartir, con una captura de cada paso. Esas capturas se guardan en este equipo y nunca
entran en el chat que se envía al modelo, así que una grabación no puede llegar a tu
proveedor. Si la grabación queda incompleta, la guía lo dice en su propia introducción.
Vienen activadas; apágalas en la Configuración.

MCP en ambas direcciones — TabRunner habla MCP en los dos sentidos. Un cliente de IA en tu
máquina le pasa tareas por el puente local, y TabRunner también se conecta a servidores MCP
remotos que tú añades: sus herramientas entran en cada tarea tras la aprobación del plan, y
cuando un servidor necesita tu respuesta te pregunta allí mismo en el panel. Los eventos de
ejecución — inicio, fin, errores, preguntas — también pueden llegar por POST a una URL de
webhook tuya, así las tareas se enchufan a tus automatizaciones.

CÓMO FUNCIONA

1. Describe una tarea en el panel lateral — por ejemplo: "pasa la factura de mi correo al informe
   de gastos".
2. Aprueba el plan que propone. TabRunner entonces usa la pestaña como lo harías tú — leyendo la
   página, haciendo clic, escribiendo, desplazando — con entrada real del usuario.
3. Míralo paso a paso, o envía la tarea al segundo plano y recibe una notificación cuando termine.

PRIVADO POR DISEÑO

No existe ningún servidor de TabRunner. La extensión habla directamente con tu proveedor.

La configuración del proveedor y el historial de chats viven en chrome.storage, en este
dispositivo.

El modelo nunca recibe el HTML crudo — trabaja con un árbol semántico compacto de la página, y los
campos sensibles (contraseñas, códigos de un solo uso, números de tarjeta) no salen de la página.

Funciona en Chrome y otros navegadores basados en Chromium.

LÍMITES Y CONTROL

Tú apruebas el plan — TabRunner no hace clic, no escribe ni navega antes de que apruebes lo que
pretende hacer.

Pregunta antes de actuar — las acciones con consecuencias (pagar, enviar, eliminar) vuelven a ti
para confirmarlas en el panel antes de ocurrir.

Detener es detener — Esc o el botón Detener termina la tarea al instante; lo que ya hayas
escrito se convierte en la siguiente tarea.

Esfuerzo de razonamiento — fíjalo de none a max por tarea, o déjalo en Auto y TabRunner usa el
modelo más reciente que liste tu endpoint.

IDIOMAS

English · Português (Brasil) · Español. Tema claro y oscuro, o el del sistema.
```

</details>

---

## 3. Screenshots

Four **1280×800 PNGs**, uploaded in this order — the first is the card image.

| #   | Image                                                                                                                             | What it shows                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [![Side panel beside a Wikipedia article, task typed but not sent](screenshots/01-side-panel.png)](screenshots/01-side-panel.png) | **Card image.** Wikipedia's "Web browser" article with the side panel beside it, pre-task: the task typed but not yet sent. The panel is the product, not a browser takeover. |
| 2   | [![A finished task in the panel: plan card, tool trace and summary](screenshots/02-chat.png)](screenshots/02-chat.png)            | A finished task: user bubble, plan card, tool trace, the agent's summary — with the "controlling this tab" badge on the page.                                                 |
| 3   | [![Options page Providers tab with subscription and API-key rows](screenshots/03-providers.png)](screenshots/03-providers.png)    | The options page's Providers tab: subscription rows (Claude, ChatGPT) and an API-key row (DeepSeek), active provider highlighted.                                             |
| 4   | [![Hacker News with a second chat and the floating status widget](screenshots/04-chat-2.png)](screenshots/04-chat-2.png)          | Hacker News with a second chat and the floating status pill bottom-right (task · +1 queued · Hide — the pill itself is the way back to the task).                             |

Regenerate with `bun run build && bun run shots` — it rewrites all four in place and refreshes the
site's webp derivatives when `../site` is checked out. Rerun after any UI rebrand and eyeball them
before committing.

---

## 4. Privacy practices

The dashboard's **Privacy practices** tab: one textarea per permission, plus single purpose and the
policy URL.

### Single purpose

```
TabRunner lets an AI model the user chooses carry out tasks in their own browser: reading a page,
clicking, typing and filling forms on the sites they are already signed in to, until the task they
described is done. Data goes to exactly two places — the site being worked on, and the AI provider
the user configured with their own credentials. There is no TabRunner server, no account, and no
analytics; the only other request the extension ever makes is fetching the single https URL the
user types when importing a skill recipe — user-initiated, once, with nothing of theirs attached.
```

### Privacy policy URL

```
https://tabrunner.app/privacy
```

The page is client-rendered, so the text appears once JS runs — fine for a reviewer opening it in a
browser. The JS-free mirror, if anyone ever needs one, is
[`PRIVACY.md`](https://github.com/tabrunner/tabrunner/blob/main/PRIVACY.md) on GitHub; the site syncs
from it (`site/ bun run sync:legal`), so the two never drift.

### Permission justifications

Each is written for a reviewer with thirty seconds: what it does here, and why nothing narrower
works.

**`debugger`**

```
TabRunner clicks and types on the user's behalf. Chrome only produces trusted input events through
the DevTools Protocol; events dispatched from a content script are synthetic, and login forms,
payment fields and most modern web apps ignore them. The same channel runs the agent's short
in-page scripts (an approved plan covers every action) and reads the tab's network and console
activity — addresses and statuses, never response bodies. TabRunner attaches to the single tab the
user's task is running in and detaches when the task ends. Chrome's "started debugging" banner
stays visible for the whole task, so the user always knows.
```

**`scripting`**

```
Injects the script that turns the current page into a compact accessibility tree (roles, names and
element references) for the AI model to read. This is what lets the model work without ever
receiving the page's raw HTML. The same mechanism sets a form field's value when trusted
keystrokes don't land on a misbehaving page.
```

**`sidePanel`**

```
Hosts the extension's entire interface: the panel where the user writes a task, watches each step
as it happens, answers the agent's questions, and stops the task.
```

**`tabs`**

```
Reads the title and URL of the tab a task starts from, and switches to another open tab when the
task refers to one ("archive the email I was just reading"). Without it the agent cannot tell
which page it is working on, or return to a page the user already has open.
```

**`activeTab`**

```
Grants access to the tab the user submits a task from, at the moment they submit it.
```

**`tabGroups`**

```
A task adopts the user's current tab, or opens its own when there's no page to work. TabRunner puts
that tab in a labelled tab group named after the task, so the user can see at a glance which tab the
agent is working in and close it in one action.
```

**`storage`**

```
Stores what the user creates, locally in chrome.storage on their own device: AI provider settings,
chat history, standing instructions, remembered facts, scheduled tasks and skill recipes.
Nothing is uploaded — there is no TabRunner server.
```

**`unlimitedStorage`**

```
Walkthroughs. The user can ask for a task to be documented, and TabRunner saves a screenshot of
each step so the finished task can be shared as a step-by-step guide. Those screenshots are held
as images in the browser's own local database on the user's device, and a single recording can
reach tens of megabytes. Without this permission Chrome can evict a recording the user meant to
keep. It grants no new access to anything: nothing is uploaded, there is no TabRunner server, and
these screenshots are never sent to the AI provider.
```

**`notifications`**

```
A task adopts the user's current tab, or opens its own when there's no page to work, and keeps
working after the side panel closes. A notification reports when a task — including one the user
scheduled to run on its own — finishes or fails, and when it pauses to ask the user a question
(for example, before sending something on their behalf). Fired only while the panel is closed —
never for tasks the user stopped themselves.
```

**`alarms`**

```
Two uses. Scheduled tasks: the user can set a task to run on its own — once at a chosen time,
daily, or on an interval — and each schedule arms one alarm that fires it. The local bridge:
TabRunner can optionally accept tasks from a local AI assistant on the user's own machine; Chrome
suspends the extension's service worker when idle, so a periodic alarm wakes it to re-establish
that local connection, and to keep the worker alive through a long task while the side panel is
closed. Alarms exist only for the user's own schedules, while the bridge feature is enabled, or
while a task is in flight.
```

**`declarativeNetRequestWithHostAccess`**

```
Used only on TabRunner's own network requests to the AI provider the user configured — never on
pages the user visits or on the site being automated.

Providers that the user signs in to (rather than pasting an API key) reject requests that arrive
with a browser Origin header. TabRunner removes that header from its own calls so a subscription
sign-in works at all. The rule matches a fixed list of AI provider API hostnames, and modifies
only request headers on those hosts. It blocks nothing, redirects nothing, and reads no page.
```

**Host permissions (`<all_urls>`)**

```
The user decides which site the agent works on by typing a task in the side panel, so the set of
sites cannot be known in advance — it is whatever the user asks for, on the sites they are already
logged in to. The extension acts on a site only while a task is running on it. Beyond that, the
extension's own requests go to the AI provider the user configured — plus, only when the user
imports a skill recipe, one GET of the single https URL they typed. The same holds for what the
user configures themselves: requests go to the remote MCP servers the user added — carrying the
auth headers the user set for each — and run events POST to the webhook URLs the user typed.
```

---

## 5. Maintaining the live listing

The listing is approved and live. Two separate workflows now exist — they are not interchangeable.

**Description / screenshots / privacy answers** are listing edits, not packages: fix the block here,
paste it into the dashboard, and save. No version bump, no zip. The description must stay **plain
text** — the store renders no Markdown in it (see §2).

**The package** is a separate submission. Every new upload goes through review again, so a
feature that must reach store users means: fix the code, then `bun run release patch | minor` and
upload the new `dist/tabrunner-<version>-store.zip` (never `-chrome.zip`; see
[AGENTS.md → Releasing](../AGENTS.md#releasing)). The live listing's text, screenshots and privacy
answers are inherited, not reset, by a package update — correct them above first.

**A rejection on a package update** names the policy clause. Same split as above:

- **Listing/metadata violation** (the wording lives in this file): fix the block, paste it, and
  resubmit the same upload — no new version.
- **Package violation**: fix the code, then `bun run release patch` and upload the new zip.
