# Política de privacidade do TabRunner

_Última atualização: 2026-09-13 · Aplica-se ao TabRunner para navegadores Chromium (Chrome, Brave,
Edge, Arc, Opera, Vivaldi)._

**Em resumo:** o TabRunner é um agente de navegador que você mesmo roda. Não existe servidor do
TabRunner, nem conta, nem telemetria, nem analytics. Tudo o que você digita ou configura fica no seu
dispositivo, no armazenamento local do navegador. Os seus dados só vão para (1) o provedor de IA que
**você** configurou, (2) os sites em que você pede para o TabRunner agir e, só se você usar esses
recursos, (3) uma ponte MCP local na sua própria máquina e (4) a URL de uma habilidade que você
importar.

---

## 1. O que o TabRunner coleta

**Nós não coletamos nada.** O TabRunner não tem backend, sistema de contas nem telemetria. Ele não
se comunica com os desenvolvedores, com servidores de licença nem com nenhum serviço de analytics em
momento algum, inclusive enquanto está em execução. A extensão funciona inteiramente entre o seu
navegador, o provedor que você configurou e os sites em que você a coloca para trabalhar.

**O que você fornece.** O TabRunner guarda no armazenamento local do navegador
(`chrome.storage.local`, no namespace `local:tabrunner:*`):

- **Configuração dos provedores**: os provedores que você adiciona (nome, URL base, formato da API
  e, se quiser, o modelo preferido) e a **chave de API** que você cola. As chaves ficam guardadas
  localmente para que você só precise informá-las uma vez.
- **Histórico de conversas**: as transcrições das suas tarefas, incluindo o texto da tarefa que você
  digitou, as respostas do provedor e um registro das ações que o TabRunner executou. As 50
  conversas mais recentes são mantidas.
- **Documentos de memória**: os arquivos opcionais `AGENTS.md` (as suas instruções permanentes) e
  `MEMORY.md` (o que o TabRunner aprendeu), exibidos no painel Configurações → Memória.
- **Habilidades**: as receitas opcionais exibidas em Configurações → Habilidades (nome, descrição,
  sites, instruções), sejam elas escritas à mão, geradas a partir de uma conversa ou importadas.
- **Preferências**: as escolhas de tema e de idioma.

## 2. O que o TabRunner processa e para onde isso vai

Quando uma tarefa é executada, o TabRunner lê a página em que você está trabalhando e a transforma
num **snapshot compacto da árvore de acessibilidade** (`[ref=e12] button "Submit"`), sem o HTML
bruto, os scripts ou as mídias da página. Esse snapshot, o texto da sua tarefa, a conversa até o
momento e, quando houver, a captura de tela da página são enviados **ao provedor que você
configurou**, com a sua própria chave de API ou o seu login por assinatura, via HTTPS. As respostas
do provedor e as chamadas de ferramenta que ele faz voltam para a extensão, que as executa no seu
navegador como entrada real de usuário. Quando a árvore e a digitação não bastam, uma chamada de
ferramenta também pode **executar um script curto dentro da página** (para definir o valor de um
campo teimoso ou ler algo que a árvore omite) e ler a **atividade de rede e do console** da aba
(endereços e status, nunca o conteúdo das respostas). Os resultados dos scripts têm tamanho limitado
e, antes de entrarem na conversa, perdem tudo o que pareça uma credencial. Como qualquer outra ação,
os scripts só rodam dentro de uma tarefa cujo plano você aprovou.

**O TabRunner nunca envia os seus dados para nenhum outro lugar.** Esta é a lista completa dos
destinatários na rede:

1. **O provedor que você configurou**: o provedor de modelos (ou endpoint personalizado) que você
   escolheu. Ele recebe a tarefa, os snapshots das páginas, as capturas de tela e a sua chave de API
   ou o token do seu login, para autenticação. A chave ou o token é transmitido somente para esse
   provedor, via TLS, como parte da própria API dele.
2. **Os sites que você pede para ele controlar**: navegar, clicar e digitar num site gera o mesmo
   tráfego que a sua própria sessão do navegador geraria, com os logins que você já tem. O TabRunner
   não redireciona, não registra e não captura esse tráfego além do que o próprio site já vê.
3. **Uma ponte MCP local na sua própria máquina, se você rodar uma**: um cliente de IA que você
   mesmo roda (Claude Code, Claude Desktop) pode controlar o TabRunner por meio de um daemon que
   escuta em `127.0.0.1`. Nada fora da sua máquina consegue acessá-lo, e o daemon não armazena nada:
   ele repassa as tarefas que chegam e o andamento das execuções que sai. Ele só existe enquanto
   você o mantém rodando; sem ele, o TabRunner não se conecta a nada. Veja
   [docs/mcp.md](docs/mcp.md).
4. **A URL de uma habilidade, só quando você importa uma**: Configurações → Habilidades → Importar
   busca apenas o endereço https que você digitou (uma requisição GET; nada seu vai junto além da
   própria requisição), no momento em que você pede. O TabRunner nunca busca nem atualiza
   habilidades por conta própria.

Mais ninguém (nenhum servidor intermediário, nenhum proxy, nenhum serviço de analytics, nenhum
servidor dos desenvolvedores) recebe os seus dados, em momento algum.

## 3. O que continua privado

- **Campos sensíveis nunca saem da página.** Campos de senha, de número de cartão e outros campos
  `password` ou sensíveis ficam de fora da árvore de acessibilidade, então não são enviados ao
  modelo. E, antes que qualquer resultado de script entre na conversa, os valores que parecem
  credenciais (tokens, chaves de API, cookies) são removidos.
- **As capturas de tela feitas para o modelo são temporárias.** Uma captura de tela feita para o
  contexto do modelo é comprimida (JPEG q80) e removida antes de a transcrição ser salva no
  armazenamento. As imagens que você mesmo anexa, quando o modelo aceita imagens, são guardadas como
  parte dessa transcrição.
- **As gravações dos guias passo a passo ficam no dispositivo.** Se você pedir que uma tarefa seja
  documentada, as capturas de tela de cada etapa ficam guardadas no banco de dados local deste
  navegador. Elas nunca entram no que é enviado ao modelo, então uma gravação não tem como chegar ao
  seu provedor. Elas são excluídas junto com a conversa a que pertencem, e o recurso inteiro pode
  ser desativado em Configurações → Guias passo a passo.
- **Armazenamento só local.** Todas as configurações e todo o histórico ficam no armazenamento local
  do navegador, neste dispositivo. Desinstalar a extensão apaga tudo isso.

## 4. O que você controla

- **Excluir uma conversa**: Histórico → ⋯ → Excluir. Remove essa transcrição deste dispositivo.
- **Limpar a memória**: Configurações → Memória. Exclua qualquer fato lembrado na própria linha
  dele, ou desative "Lembrar o que aprende" para que novos fatos deixem de ser salvos. Isso impede
  que esse conteúdo seja enviado com as próximas tarefas.
- **Remover um provedor**: Configurações → Provedores → Remover. Apaga a chave de API guardada; você
  pode adicioná-la de novo quando quiser.
- **Excluir uma habilidade**: Configurações → Habilidades. O interruptor pausa uma habilidade sem
  excluí-la; ao excluir, ela sai de todas as próximas tarefas.
- **Parar quando quiser**: aperte Esc ou o botão Parar no painel, use o botão de parar na lista da
  faixa Tarefas ou feche a aba que a tarefa está controlando. Qualquer uma dessas opções interrompe
  a tarefa. Fechar o painel NÃO interrompe a tarefa: ela assume a aba em que você está (ou abre uma
  própria, quando não há página para trabalhar) e continua trabalhando depois que o painel fecha. A
  ideia é justamente essa: você manda a tarefa e pode esquecê-la. Nada é enviado depois que a tarefa
  é interrompida.
- **Desinstalar**: remover a extensão em `chrome://extensions` apaga todo o armazenamento local
  dela.

## 5. Para que serve cada permissão

| Permissão                             | Para que serve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debugger`                            | Entrada real e confiável: cliques e teclas são enviados pelo Chrome DevTools Protocol, para que os sites não possam ignorá-los. É também o canal da ferramenta de script na página e do registro de rede e console, sempre dentro da tarefa que você aprovou.                                                                                                                                                                                                                                         |
| `scripting`                           | Injeta, na aba que o TabRunner lê, o script que gera o snapshot da árvore de acessibilidade e também o script que define o valor de um campo quando a digitação não funciona.                                                                                                                                                                                                                                                                                                                         |
| `sidePanel`                           | Exibe a interface de conversa em que você escreve as tarefas e acompanha a execução.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tabs`                                | Assume a aba em que você está ou abre uma aba própria para a tarefa, lê a URL e o título, e troca de aba quando uma tarefa faz referência a outra aba aberta.                                                                                                                                                                                                                                                                                                                                         |
| `activeTab`                           | Dá acesso à aba de onde você envia uma tarefa, a cada ação.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tabGroups`                           | Agrupa a aba de cada tarefa e dá ao grupo o nome da tarefa (✓/✗/? quando ela termina, e depois recolhe o grupo).                                                                                                                                                                                                                                                                                                                                                                                      |
| `storage`                             | Guarda localmente as configurações dos provedores, o histórico e a memória.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `unlimitedStorage`                    | Evita que o navegador descarte as gravações dos guias passo a passo. Uma tarefa documentada salva uma captura de tela de cada etapa no banco de dados local deste navegador, e uma única gravação pode chegar a dezenas de megabytes. As imagens ficam no dispositivo e nunca são enviadas ao modelo.                                                                                                                                                                                                 |
| `notifications`                       | Avisa quando uma tarefa em segundo plano termina, dá erro ou pausa para perguntar algo a você enquanto o painel está fechado.                                                                                                                                                                                                                                                                                                                                                                         |
| `alarms`                              | Acionamentos periódicos: reconecta a ponte MCP local e mantém o worker ativo durante uma tarefa longa com o painel fechado. Não executa nenhuma tarefa e não mexe em nenhuma página.                                                                                                                                                                                                                                                                                                                  |
| `declarativeNetRequestWithHostAccess` | Remove o cabeçalho `Origin` das chamadas que o próprio TabRunner faz ao provedor que você configurou. Um login por assinatura (em vez de uma chave de API colada) é recusado quando a requisição chega com uma origem de navegador. A regra vale para uma lista fixa de hosts de API de provedores e só altera cabeçalhos de requisição nesses hosts, nunca nas páginas que você visita nem no site que está sendo automatizado. Ela não bloqueia nada, não redireciona nada e não lê nenhuma página. |
| Permissões de host (`<all_urls>`)     | O TabRunner precisa conseguir navegar, ler e interagir com qualquer site que você pedir para ele usar. Ele só usa essa permissão enquanto há uma tarefa em execução.                                                                                                                                                                                                                                                                                                                                  |

## 6. Travas de segurança

- **Pedir antes de agir.** Quando é o próprio modelo do TabRunner que está no controle, ações que
  têm consequências (pagar, enviar, excluir) interrompem a execução e pedem a sua confirmação
  explícita antes de acontecerem: no painel ou por meio do cliente que iniciou a tarefa, que repassa
  o pedido a você.
- **O controle direto é a exceção, e ele fica visível.** Um cliente MCP que você conecta também pode
  controlar o navegador passo a passo, sem o modelo do TabRunner no meio e, portanto, sem essa regra
  de confirmação, que faz parte do prompt do próprio TabRunner. O TabRunner não deixa isso acontecer
  em silêncio: a página controlada exibe o selo "O TabRunner está controlando esta aba", a aba
  mostra o ponto âmbar, e cada ação fica registrada numa conversa do seu histórico, identificada com
  o nome do cliente que a executou.
- **Nenhuma vigilância em segundo plano.** O TabRunner só lê as páginas e age nelas enquanto uma
  tarefa iniciada por você está em execução, e só nas abas que essa tarefa usa.

## 7. Alterações nesta política

Se o tratamento de dados do TabRunner mudar de um jeito que afete esta política, este documento será
atualizado e a mudança de versão será registrada no changelog correspondente. Mudanças relevantes
serão destacadas nas notas da versão da extensão.

## 8. Contato

Este projeto é mantido no GitHub, em [tabrunner/tabrunner](https://github.com/tabrunner/tabrunner).
Dúvidas sobre esta política: abra uma issue
([github.com/tabrunner/tabrunner/issues](https://github.com/tabrunner/tabrunner/issues)).
