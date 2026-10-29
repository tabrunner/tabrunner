import type { Locale } from "./en-US";

/** Português (Brasil) — escrito em pt-BR, não traduzido do inglês palavra por palavra. */
export const ptBR: Locale = {
  langName: "Português (Brasil)",
  seo: {
    title: "TabRunner: Você dá o objetivo. Ele pilota as abas.",
    description:
      "Um agente de IA que pilota o seu navegador com o provedor de IA que você escolher, usando suas abas, sessões e contas já logadas. Só em navegadores Chromium. Sem servidor, sem conta, sem telemetria.",
  },
  notFound: {
    title: "Página não encontrada",
    body: "Esse endereço não existe no tabrunner.app. A página principal está logo abaixo: o que o TabRunner faz e como instalar.",
  },
  nav: {
    features: "Recursos",
    install: "Instalar",
    privacy: "Privacidade",
    docs: "Docs",
    download: "Instalar no Chrome",
    github: "GitHub",
    languageLabel: "Idioma",
    sectionsLabel: "Seções",
    skipToContent: "Pular para o conteúdo",
  },
  hero: {
    titleA: "Você dá o objetivo.",
    titleB: "Ele pilota as abas.",
    sub: "Um agente de IA que pilota o seu navegador com o provedor de IA que você escolher, usando as suas abas, sessões e contas em que você já está logado. Descreva a tarefa no painel lateral: o TabRunner lê as páginas, clica, digita e navega até terminar o serviço.",
    ctaPrimary: "Instalar no seu navegador",
    ctaFor: "Instalar no {{browser}}",
    ctaUnsupported:
      "O TabRunner só funciona em navegadores de desktop baseados no Chrome. Abra esta página no Chrome, Brave, Edge, Arc, Opera ou Vivaldi para baixar.",
    ctaSecondary: "Como instalar",
    missionLabel: "Descreva uma tarefa",
    missionGo: "Lançar",
    placeholders: [
      "Pegue a nota fiscal no meu e-mail e lance no relatório de despesas…",
      "Preencha o formulário de visto com os dados da minha reserva…",
      "Copie os números desta semana do painel de analytics para a minha planilha…",
      "Ache o meu código de rastreio e cole no formulário da transportadora…",
    ],
    demoHint:
      "Lance uma. O que acontece aqui é um bando de cometas cruzando o céu, e mais nada. Para rodar de verdade, precisa da extensão.",
    demoLaunched:
      "Esses cometas são a ideia em miniatura. Com a extensão instalada, a tarefa roda no seu navegador mesmo.",
    browsersLabel: "Funciona em",
    chromiumNote:
      "Só Chromium. Firefox e Safari não têm a API de entrada confiável. Em vez de um botão que não funciona, você recebe uma explicação.",
  },
  run: {
    demoBadge: "demo simulada",
    taskLabel: "Tarefa",
    task: "Pegar a nota fiscal mais recente do e-mail e lançar no relatório de despesas",
    planning: "Planejando…",
    planTitle: "Plano",
    plan: [
      "Abrir a caixa de entrada",
      "Achar a nota fiscal mais recente",
      "Abrir o relatório de despesas",
      "Anexar e preencher os campos",
    ],
    tools: [
      { tool: "navigate", detail: "caixa de entrada do webmail" },
      { tool: "click", detail: 'ref=e21 "nota-fiscal.pdf"' },
      { tool: "snapshot", detail: "formulário de despesas, 6 campos" },
    ],
    composing: "Preenchendo o relatório de despesas…",
    done: "Concluído. Relatório de despesas pronto para revisão",
    elapsed: "decorrido",
    tokens: "tokens",
    stopNote:
      "O Esc interrompe qualquer execução na hora, inclusive esta demo se fosse uma tarefa real.",
  },
  features: {
    title: "A vantagem é o seu navegador",
    sub: "A maioria dos agentes de navegador roda num navegador isolado e sem nenhum login. O TabRunner roda no seu, por isso ele consegue agir nos sites em que você já está logado.",
    providersMore: "+ qualquer endpoint compatível com OpenAI/Anthropic",
    items: [
      {
        title: "Use o provedor que quiser",
        body: "São 15 presets para os 12 provedores abaixo. Anthropic, OpenAI e Kimi aparecem duas vezes: faça login com o plano do Claude, do ChatGPT ou da Kimi que você já paga, ou cole uma chave de API. Além de qualquer endpoint que fale o formato da OpenAI ou da Anthropic. Sem lock-in e sem servidor no meio do caminho.",
      },
      {
        title: "Cliques e teclas de verdade",
        body: "Os cliques e as teclas passam pelo Chrome DevTools Protocol. São eventos confiáveis de verdade (trusted events), não eventos sintéticos de JavaScript, que telas de login e campos de pagamento ignoram.",
      },
      {
        title: "Enxerga a página, não o HTML",
        body: "O modelo lê uma árvore de acessibilidade compacta, nunca o HTML bruto. Isso significa prompts menores e refs estáveis. Senhas e números de cartão nunca saem da página.",
      },
      {
        title: "Travas que seguram",
        body: "Toda ação com consequência (pagar, enviar, excluir) pede a sua confirmação antes. Ele tenta de novo quando o provedor falha, um limite de passos evita que a tarefa saia do controle, e o Parar para na hora.",
      },
      {
        title: "MCP nos dois sentidos",
        body: "Claude Code, Claude Desktop ou qualquer cliente MCP passa uma tarefa para o TabRunner e acompanha até a resposta, no mesmo navegador, com os mesmos logins e tudo marcado no seu histórico. E no sentido contrário também: o TabRunner se conecta a servidores MCP remotos cujas ferramentas entram em toda execução, sempre passando pelas travas, e eventos de execução podem ir por POST para um webhook seu.",
      },
      {
        title: "Sem servidor. Nenhum mesmo.",
        body: "A sua chave vai direto da extensão para o provedor. As configurações e o histórico ficam no chrome.storage, no seu dispositivo. Sem cadastro, sem telemetria, nada que possa vazar.",
      },
    ],
  },
  route: {
    title: "O trajeto de uma tarefa, do começo ao fim",
    you: "você",
    or: "ou",
    mcp: "um cliente MCP",
    extension: "tabrunner",
    provider: "seu provedor",
    gate: "travas",
    page: "a página",
    relay: "um servidor intermediário",
    legAsk: "o pedido / o plano",
    legAct: "cliques e teclas / a página em refs",
  },
  shots: {
    title: "O painel é o produto",
    sub: "Ele não toma conta do navegador. É um painel lateral que trabalha ao lado da página em que você está.",
    captions: [
      "O painel lateral, antes de começar uma tarefa",
      "Uma execução concluída: plano, ações, resumo e a marca na aba",
      "Provedores: presets ou qualquer endpoint compatível",
      "A pílula de status: a tarefa trabalha enquanto você continua lendo",
    ],
    note: "Capturas da versão atual, geradas automaticamente, então nunca ficam desatualizadas depois de um redesign.",
  },
  install: {
    title: "O plano de voo",
    sub: "Um clique na Chrome Web Store e mais um minuto para apontar para um provedor. Sem cadastro, sem nada para assinar.",
    badge: "atualiza sozinho",
    storeTitle: "Instale pela Chrome Web Store",
    steps: [
      "Instale o TabRunner no seu navegador pela página da loja. Dali em diante as atualizações chegam sozinhas.",
      "Fixe o cometa na barra de ferramentas e clique nele para abrir o painel lateral.",
      "Escolha um provedor, faça login com a assinatura que você já paga ou cole uma chave de API e descreva uma tarefa.",
    ],
    storeCta: "Instalar no Chrome",
    caveatsTitle: "Sem letras miúdas",
    caveats: [
      "Só navegadores Chromium de desktop: Chrome, Brave, Edge, Arc, Opera, Vivaldi. No Edge e no Opera é preciso permitir extensões de outras lojas antes.",
      "A tela de instalação pede acesso amplo às suas abas. Esse acesso é o produto: é assim que o agente lê as páginas e digita de verdade. O que ele faz com isso está na seção logo abaixo.",
      "O modelo é por sua conta: uma assinatura de provedor que você já paga, ou uma chave de API. Não existe conta TabRunner nem plano gratuito incluído.",
      "Já está com a versão descompactada instalada? Remova antes. A da loja usa o mesmo ID de extensão e o Chrome não roda as duas. Remover apaga o armazenamento dela: seus provedores, logins e conversas não vão junto.",
    ],
    releaseNotes: "Notas da versão",
    zipTitle: "Prefere não usar a loja?",
    zipSteps:
      "Baixe o ZIP e descompacte numa pasta que você vá manter. Depois: chrome://extensions → Modo do desenvolvedor → Carregar sem compactação → selecione essa pasta. Ela não pode conviver com a instalação da loja.",
    zipUpdateTitle: "Como atualizar",
    zipUpdateBody:
      "Extraia cada ZIP novo por cima dessa mesma pasta, substituindo os arquivos, e clique em ⟳ na página chrome://extensions.",
    zipUpdateWarning:
      "Nunca remova a extensão para instalar de novo. O Chrome apaga o armazenamento dela na saída, e seus provedores, logins e conversas vão junto.",
    downloadZip: "Baixar ZIP",
  },
  privacy: {
    title: "Sem estação em terra",
    sub: "Um agente que pilota o seu navegador logado precisa responder à pergunta sobre os dados antes de qualquer outra. A resposta é esta.",
    points: [
      "Por padrão, os seus dados vão para dois lugares: o site em que o agente está trabalhando e o provedor de IA que você configurou. Qualquer outro destino, como o Jev, um servidor MCP ou um webhook, só existe se você adicionar.",
      "Não existe servidor do TabRunner, nem cadastro, nem analytics, nem chamada para ninguém que você não tenha configurado.",
      "As configurações dos provedores e o histórico das conversas ficam no chrome.storage, no seu dispositivo.",
    ],
    diagramBrowser: "Seu navegador",
    diagramProvider: "Seu provedor de IA",
    diagramSites: "Os sites que você usa",
    diagramKeyFlow: "chave de API ou login, enviados diretamente",
    diagramTaskFlow: "cliques e teclas",
    diagramServer: "servidor do TabRunner",
    diagramServerNone: "não existe",
    link: "Leia a política de privacidade completa",
  },
  docs: {
    seo: {
      title: "Docs do TabRunner: conecte sua IA ao navegador",
      description:
        "Conecte o Claude Code ou outro cliente MCP ao seu navegador. Experimente tarefas, veja a que o cliente tem acesso e saiba como desconectar.",
    },
    title: "Use o TabRunner pela sua IA",
    sub: "Peça à sua IA uma tarefa nos sites em que você já está logado. O TabRunner usa o seu navegador, não um navegador separado na nuvem.",
    installLink: "Ainda não instalou? Comece aqui.",
    contentsLabel: "Nesta página",
    copy: "Copiar",
    copied: "Copiado",
    copyFailed: "O navegador bloqueou a cópia. Selecione o texto e pressione Ctrl+C ou Cmd+C.",
    mcp: {
      title: "Conectar o Claude Code (MCP)",
      intro:
        "MCP é a conexão que permite à sua IA usar as ferramentas do TabRunner. Ela roda no seu computador. Não há endereço de servidor público, conta TabRunner ou login por OAuth.",
      enable:
        "Instale o TabRunner e abra Configurações → MCP. Ative a ponte, a conexão local com a sua IA. Ela vem desligada. Adicione um provedor de IA no TabRunner se quiser que ele execute tarefas por você.",
      install:
        "Instale o <bun>Bun</bun>, que executa o processo MCP local. Depois, rode o comando abaixo no terminal. O plugin adiciona o servidor MCP e as instruções para usá-lo.",
      add: "Se não quiser o plugin, cadastre só o servidor MCP com este comando. Com <code>--scope user</code>, ele fica disponível em todos os projetos. Escolha apenas uma forma para não duplicar as ferramentas.",
      check:
        "Abra uma nova sessão do Claude Code e peça para chamar <code>health</code>. A ferramenta verifica a conexão e as configurações salvas do provedor, não se o provedor vai aceitar a próxima chamada.",
      manual:
        "Usa Codex, uma versão mais antiga do Claude Code ou um arquivo do daemon baixado? O <manual>manual completo do MCP</manual> tem esses passos e todas as ferramentas.",
    },
    examples: {
      title: "Experimente uma tarefa",
      intro:
        "Entre primeiro nos sites que vai usar. Depois, peça à sua IA conectada para usar o TabRunner. Estes são exemplos de pedidos, não ações que esta página executa.",
      prompts: [
        "Encontre a nota fiscal mais recente no meu e-mail e me diga o valor a pagar.",
        "Compare o frete nas abas de checkout abertas. Não finalize nenhuma compra.",
        "Prepare uma resposta para a última mensagem de suporte. Não envie.",
      ],
      follow:
        "A IA chama <code>get_status</code> para acompanhar a tarefa. Se o TabRunner fizer uma pergunta, a IA deve mostrá-la a você e devolver a sua resposta. Ela não deve aprovar por você.",
    },
    access: {
      title: "A que a conexão dá acesso",
      browser:
        "Um cliente conectado pode ler páginas e agir no seu navegador logado. Tarefas, leituras das páginas e capturas de tela podem passar para esse cliente. As abas compartilham as contas do perfil do navegador, mesmo quando clientes diferentes usam abas diferentes. Conecte só clientes em que você confia para dar esse acesso.",
      auth: "Você não precisa criar nem colar uma chave de API do TabRunner. Um processo local conecta o cliente à extensão. Ele usa um token de acesso salvo em um arquivo privado em <code>~/.tabrunner/mcp</code>. Programas rodando com o seu usuário do sistema podem ler esse arquivo. Não compartilhe o arquivo nem exponha o processo local à rede.",
      provider:
        "Quando você delega uma tarefa, a extensão usa o provedor de IA escolhido por você, com os custos desse provedor. As ferramentas de controle direto não precisam de um provedor no TabRunner; o cliente MCP usa o próprio modelo. As credenciais do provedor ficam entre a extensão e o provedor.",
      direct:
        "Tarefas delegadas seguem as regras de aprovação do TabRunner. As ferramentas diretas <code>browser_*</code> não passam pelo modelo dele. Por isso, o cliente que as chama deve pedir sua autorização antes de pagar, enviar, excluir ou enviar um formulário.",
    },
    developers: {
      title: "Para quem desenvolve",
      intro:
        "Use este comando e argumento em um cliente que aceite servidores MCP locais por stdio, a entrada e a saída padrão do processo. O Bun e a extensão TabRunner precisam estar no mesmo computador. Um cliente que só aceita endereços remotos não consegue se conectar dessa forma.",
      example: "Uma chamada inicia a tarefa e devolve o ID da execução:",
      status:
        "Chame <code>get_status()</code> até a tarefa terminar, falhar ou fazer uma pergunta. Por padrão, a chamada espera algo mudar. Não consulte em um temporizador. Use <code>answer(text)</code> só depois da resposta da pessoa e <code>stop()</code> para parar a tarefa atual deste cliente.",
      reconnect:
        "Se uma chamada exceder o tempo de espera, a ação no navegador pode já ter acontecido. Restabeleça a conexão e confira o estado ou a página antes de tentar de novo. As ações no navegador não são repetidas automaticamente.",
      reference: "Referência para programas",
      discovery: "Dados da instalação MCP local (JSON)",
      index: "Índice da documentação (llms.txt)",
      full: "Guia completo da conexão (llms-full.txt)",
    },
    remove: {
      title: "Desconectar ou atualizar",
      disable:
        "Para desconectar todos os clientes MCP deste navegador, desative a ponte em Configurações → MCP do TabRunner. Para parar só a tarefa atual, peça primeiro ao cliente dela para chamar <code>stop</code>. As tarefas dos outros clientes são separadas.",
      plugin: "Se instalou o plugin, remova com:",
      remove: "Se cadastrou o servidor à mão com <code>--scope user</code>, remova o cadastro com:",
      file: "Se usou o download antigo de arquivo único, <code>~/.tabrunner-mcp.js</code> continua no disco depois de remover o cadastro. Você pode apagar o arquivo separadamente:",
      update:
        "Atualize o plugin pelo gerenciador de plugins do seu cliente. Na configuração manual por npm, <code>@latest</code> procura uma versão nova ao iniciar. Atualize todos os clientes que compartilham a ponte e, se as versões forem diferentes, feche e abra os clientes. Para um arquivo baixado, use novamente o comando de download do manual completo.",
    },
    faq: {
      otherFolders: {
        q: "O Claude Code não encontra o TabRunner em outra pasta",
        a1: "Sem <code>--scope user</code>, o Claude Code guarda o servidor só para a pasta onde você o adicionou. Adicione de novo, para todas as pastas:",
        a2: "Se também houver um cadastro só para uma pasta, remova dentro dela para não duplicar as ferramentas:",
      },
      notConnected: {
        q: "A ferramenta health diz que a extensão não está conectada",
        lead: "Confira, nesta ordem:",
        items: [
          "A ponte está ativada no TabRunner, em Configurações → MCP. Abra o painel lateral uma vez para ativar a extensão e tente health de novo após cerca de 30 segundos.",
          "A porta é a mesma. Se você mudou a porta do daemon com <code>TABRUNNER_BRIDGE_PORT</code>, digite o mesmo número em Configurações → MCP. O padrão é 17836.",
          "O navegador está aberto, com o TabRunner instalado e ativado.",
          "O Claude Code lista o servidor. Rode <code>claude mcp list</code>. Se o tabrunner não aparecer, adicione de novo e abra uma nova sessão.",
        ],
        tail: "O daemon inicia junto com o Claude Code, então não há nada para deixar rodando.",
      },
      browsers: {
        q: "Em quais navegadores ele funciona?",
        a: "Navegadores Chromium de desktop: Chrome, Brave, Edge, Arc, Opera e Vivaldi. Firefox e Safari não têm a API de entrada confiável, então o TabRunner não consegue clicar e digitar de verdade neles.",
      },
      account: {
        q: "Preciso de uma conta no TabRunner?",
        a: "Não. Não existe conta no TabRunner nem plano gratuito. Você traz o modelo: entre com um plano do Claude, do ChatGPT ou do Kimi que você já paga, ou cole uma chave de API. Qualquer endpoint compatível com o formato da OpenAI ou da Anthropic também funciona.",
      },
      data: {
        q: "Para onde vão os meus dados?",
        a: "O site em que o TabRunner está trabalhando e o provedor de IA escolhido recebem os dados necessários para a tarefa. Seu login ou sua chave de API vai direto da extensão para o provedor. Um cliente MCP conectado também recebe tarefas, leituras das páginas e capturas de tela. As configurações e o histórico ficam no armazenamento do navegador. Não há servidor do TabRunner na nuvem, analytics ou intermediário. Servidores MCP remotos e webhooks só recebem dados se você adicionar. A <privacy>política de privacidade</privacy> tem os detalhes.",
      },
      confirm: {
        q: "Ele paga, envia ou apaga sem perguntar?",
        a: "Quando você delega uma tarefa, as regras do TabRunner orientam o modelo a perguntar antes de pagar, enviar, excluir ou enviar um formulário. O cliente deve mostrar cada pergunta e devolver a sua resposta, nunca aprovar por você. As ferramentas de controle direto não passam por esse modelo. Nesse caso, o próprio cliente deve pedir sua autorização. Conecte só clientes em que você confia e confira o trabalho deles.",
      },
      stop: {
        q: "Como paro uma execução?",
        a: "Clique em Parar no painel lateral. Fechar a aba que ele está controlando também encerra a execução. Num cliente MCP, chame a ferramenta <code>stop</code>.",
      },
      update: {
        q: "Como atualizo a extensão?",
        a: "Pela Chrome Web Store, as atualizações chegam sozinhas. Se você instalou o ZIP, extraia cada versão nova por cima da mesma pasta e clique no ícone de recarregar em <code>chrome://extensions</code>. Nunca remova a extensão para reinstalar. O Chrome apaga o armazenamento dela, e seus provedores, logins e conversas vão junto.",
      },
    },
  },
  legal: {
    back: "Voltar para tabrunner.app",
    source: "Fonte oficial:",
  },
  footer: {
    tagline: "Você dá o objetivo. Ele pilota as abas.",
    chromium: "Só Chromium: Chrome, Brave, Edge, Arc, Opera, Vivaldi.",
    openSource: "Código aberto no GitHub",
    license: "Código aberto, licença MIT.",
    productHeading: "Produto",
    projectHeading: "Projeto",
    store: "Chrome Web Store",
    downloadZip: "Baixar ZIP",
    issues: "Issues",
    privacyLink: "Política de privacidade",
    termsLink: "Termos de uso",
    docs: "Docs",
    copyright: "© 2026 Gus",
  },
};
