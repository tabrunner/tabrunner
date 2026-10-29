import type { Locale } from "./en-US";

/** Español (es-ES) — escrito en español, no traducido palabra por palabra del inglés. */
export const esES: Locale = {
  langName: "Español",
  seo: {
    title: "TabRunner: Tú pones la meta. Él pilota tus pestañas.",
    description:
      "Un agente de IA que pilota tu navegador con el proveedor de IA que elijas, usando tus pestañas, sesiones y cuentas en las que ya has iniciado sesión. Solo navegadores Chromium. Sin servidor, sin cuenta, sin telemetría.",
  },
  notFound: {
    title: "Página no encontrada",
    body: "Esa dirección no existe en tabrunner.app. La página principal está aquí abajo: qué hace TabRunner y cómo instalarlo.",
  },
  nav: {
    features: "Funciones",
    install: "Instalar",
    privacy: "Privacidad",
    docs: "Docs",
    download: "Añadir a Chrome",
    github: "GitHub",
    languageLabel: "Idioma",
    sectionsLabel: "Secciones",
    skipToContent: "Saltar al contenido",
  },
  hero: {
    titleA: "Tú pones la meta.",
    titleB: "Él pilota tus pestañas.",
    sub: "Un agente de IA que pilota tu navegador con el proveedor de IA que elijas, usando tus pestañas, sesiones y cuentas en las que ya has iniciado sesión. Describe la tarea en el panel lateral: TabRunner lee las páginas, hace clic, escribe y navega hasta terminar el trabajo.",
    ctaPrimary: "Añadir a tu navegador",
    ctaFor: "Añadir a {{browser}}",
    ctaUnsupported:
      "TabRunner solo funciona en navegadores de escritorio basados en Chrome. Abre esta página en Chrome, Brave, Edge, Arc, Opera o Vivaldi para descargarlo.",
    ctaSecondary: "Cómo instalar",
    missionLabel: "Describe una tarea",
    missionGo: "Lanzar",
    placeholders: [
      "Pasa la factura de mi correo al informe de gastos…",
      "Rellena el formulario de visado con los datos de mi reserva…",
      "Copia los números de esta semana del panel de analytics a mi hoja…",
      "Busca mi número de seguimiento y pégalo en el formulario de la transportista…",
    ],
    demoHint:
      "Lanza una. Lo que pasa aquí es una bandada de cometas cruzando el cielo, y nada más. Para ejecutarla de verdad hace falta la extensión.",
    demoLaunched:
      "Esos cometas son la idea en miniatura. Con la extensión instalada, la tarea se ejecuta en tu navegador de verdad.",
    browsersLabel: "Funciona en",
    chromiumNote:
      "Solo Chromium. Firefox y Safari no tienen la API de entrada confiable. En vez de un botón que no hace nada, recibes una explicación.",
  },
  run: {
    demoBadge: "demo simulada",
    taskLabel: "Tarea",
    task: "Pasar la factura más reciente del correo al informe de gastos",
    planning: "Planificando…",
    planTitle: "Plan",
    plan: [
      "Abrir la bandeja de entrada",
      "Buscar la factura más reciente",
      "Abrir el informe de gastos",
      "Adjuntarla y rellenar los campos",
    ],
    tools: [
      { tool: "navigate", detail: "bandeja del webmail" },
      { tool: "click", detail: 'ref=e21 "factura.pdf"' },
      { tool: "snapshot", detail: "formulario de gastos, 6 campos" },
    ],
    composing: "Rellenando el informe de gastos…",
    done: "Hecho. Informe de gastos listo para revisar",
    elapsed: "transcurrido",
    tokens: "tokens",
    stopNote:
      "Esc detiene cualquier ejecución al instante, incluida esta demo si fuera una tarea real.",
  },
  features: {
    title: "La ventaja es tu navegador",
    sub: "La mayoría de los agentes de navegador se ejecutan en un navegador aislado y sin sesión iniciada. TabRunner se ejecuta en el tuyo, por eso puede actuar en los sitios donde ya has iniciado sesión.",
    providersMore: "+ cualquier endpoint compatible con OpenAI/Anthropic",
    items: [
      {
        title: "Usa el proveedor que quieras",
        body: "Son 15 preajustes para los 12 proveedores de abajo. Anthropic, OpenAI y Kimi aparecen dos veces: inicia sesión con el plan de Claude, ChatGPT o Kimi que ya pagas, o pega una clave de API. Además de cualquier endpoint que hable el formato de OpenAI o Anthropic. Sin lock-in y sin ningún servidor de por medio.",
      },
      {
        title: "Clics y teclas de verdad",
        body: "Los clics y las teclas pasan por el Chrome DevTools Protocol. Son eventos confiables de verdad (trusted events), no eventos sintéticos de JavaScript, que las pantallas de login y los campos de pago ignoran.",
      },
      {
        title: "Ve la página, no el HTML",
        body: "El modelo lee un árbol de accesibilidad compacto, nunca el HTML en bruto. Eso significa prompts más pequeños y refs estables. Las contraseñas y los números de tarjeta nunca salen de la página.",
      },
      {
        title: "Frenos que aguantan",
        body: "Toda acción con consecuencias (pagar, enviar, borrar) pide tu confirmación antes. Reintenta cuando el proveedor falla, un límite de pasos evita que la tarea se descontrole, y Detener detiene al instante.",
      },
      {
        title: "MCP en ambas direcciones",
        body: "Claude Code, Claude Desktop o cualquier cliente MCP le pasa una tarea a TabRunner y la sigue hasta la respuesta, en el mismo navegador, con las mismas sesiones y todo marcado en tu historial. Y al revés también: TabRunner se conecta a servidores MCP remotos cuyas herramientas se suman a cada ejecución, siempre pasando por los frenos, y los eventos de ejecución pueden llegar por POST a un webhook tuyo.",
      },
      {
        title: "Sin servidor. Ninguno en absoluto.",
        body: "Tu clave va directa de la extensión a tu proveedor. Los ajustes y el historial se quedan en chrome.storage, en tu dispositivo. Sin cuenta, sin telemetría, nada que se pueda filtrar.",
      },
    ],
  },
  route: {
    title: "El recorrido de una tarea, de principio a fin",
    you: "tú",
    or: "o",
    mcp: "un cliente MCP",
    extension: "tabrunner",
    provider: "tu proveedor",
    gate: "frenos",
    page: "la página",
    relay: "un servidor intermedio",
    legAsk: "la petición / el plan",
    legAct: "clics y teclas / la página en refs",
  },
  shots: {
    title: "El panel es el producto",
    sub: "No secuestra el navegador. Es un panel lateral que trabaja junto a la página en la que estás.",
    captions: [
      "El panel lateral, antes de empezar una tarea",
      "Una ejecución terminada: plan, acciones, resumen y la marca en la pestaña",
      "Proveedores: preajustes o cualquier endpoint compatible",
      "La píldora de estado: la tarea trabaja mientras sigues leyendo",
    ],
    note: "Capturas de la versión actual, generadas automáticamente, así que nunca se quedan desfasadas tras un rediseño.",
  },
  install: {
    title: "El plan de vuelo",
    sub: "Un clic en la Chrome Web Store y un minuto más para apuntarlo a un proveedor. Sin cuenta, sin nada que contratar.",
    badge: "se actualiza solo",
    storeTitle: "Instálalo desde la Chrome Web Store",
    steps: [
      "Añade TabRunner a tu navegador desde la ficha de la tienda. A partir de ahí las actualizaciones llegan solas.",
      "Fija el cometa en la barra de herramientas y haz clic para abrir el panel lateral.",
      "Elige un proveedor, inicia sesión con la suscripción que ya pagas o pega una clave de API y describe una tarea.",
    ],
    storeCta: "Añadir a Chrome",
    caveatsTitle: "Sin letra pequeña",
    caveats: [
      "Solo navegadores Chromium de escritorio: Chrome, Brave, Edge, Arc, Opera, Vivaldi. En Edge y Opera hay que permitir antes las extensiones de otras tiendas.",
      "La pantalla de instalación pide acceso amplio a tus pestañas. Ese acceso es el producto: es como el agente lee las páginas y escribe de verdad. Lo que hace con él está en la sección de abajo.",
      "El modelo lo pones tú: una suscripción de proveedor que ya pagas, o una clave de API. No hay cuenta de TabRunner ni plan gratuito incluido.",
      "¿Ya tienes instalada la versión descomprimida? Quítala antes. La de la tienda usa el mismo ID de extensión y Chrome no ejecuta las dos. Quitarla borra su almacenamiento: tus proveedores, sesiones y conversaciones no se conservan.",
    ],
    releaseNotes: "Notas de la versión",
    zipTitle: "¿Prefieres no usar la tienda?",
    zipSteps:
      "Descarga el ZIP y descomprímelo en una carpeta que vayas a conservar. Luego: chrome://extensions → Modo de desarrollador → Cargar descomprimida → selecciona esa carpeta. No puede convivir con la instalación de la tienda.",
    zipUpdateTitle: "Cómo actualizar",
    zipUpdateBody:
      "Extrae cada ZIP nuevo sobre esa misma carpeta, reemplazando los archivos, y pulsa ⟳ en chrome://extensions.",
    zipUpdateWarning:
      "Nunca quites la extensión para reinstalarla. Chrome borra su almacenamiento al salir, y tus proveedores, sesiones y conversaciones se van con ella.",
    downloadZip: "Descargar ZIP",
  },
  privacy: {
    title: "Sin estación en tierra",
    sub: "Un agente que pilota tu navegador con la sesión iniciada tiene que responder a la pregunta de los datos antes que a ninguna otra. Esta es la respuesta.",
    points: [
      "De entrada, tus datos van a dos destinos: la web en la que trabaja el agente y el proveedor de IA que hayas configurado. Cualquier otro destino, como Jev, un servidor MCP o un webhook, solo existe si lo añades tú.",
      "No existe ningún servidor de TabRunner, ni cuenta, ni analítica, ni llamadas a nadie que no hayas configurado tú.",
      "Los ajustes de los proveedores y el historial de conversaciones se quedan en chrome.storage, en tu dispositivo.",
    ],
    diagramBrowser: "Tu navegador",
    diagramProvider: "Tu proveedor de IA",
    diagramSites: "Los sitios que usas",
    diagramKeyFlow: "clave de API o inicio de sesión, enviados directamente",
    diagramTaskFlow: "clics y teclas",
    diagramServer: "servidor de TabRunner",
    diagramServerNone: "no existe",
    link: "Lee la política de privacidad completa",
  },
  docs: {
    seo: {
      title: "Docs de TabRunner: conecta tu IA al navegador",
      description:
        "Conecta Claude Code u otro cliente MCP a tu navegador. Prueba tareas, comprueba a qué puede acceder el cliente y aprende a desconectarlo.",
    },
    title: "Usa TabRunner desde tu IA",
    sub: "Pídele a tu IA una tarea en los sitios donde ya has iniciado sesión. TabRunner usa tu navegador, no otro navegador en la nube.",
    installLink: "¿Aún no lo has instalado? Empieza aquí.",
    contentsLabel: "En esta página",
    copy: "Copiar",
    copied: "Copiado",
    copyFailed: "El navegador ha bloqueado la copia. Selecciona el texto y pulsa Ctrl+C o Cmd+C.",
    mcp: {
      title: "Conectar Claude Code (MCP)",
      intro:
        "MCP es la conexión que permite a tu IA usar las herramientas de TabRunner. Se ejecuta en tu ordenador. No hay una URL de servidor público, una cuenta de TabRunner ni un inicio de sesión por OAuth.",
      enable:
        "Instala TabRunner y abre Configuración → MCP. Activa el puente, la conexión local con tu IA. Viene desactivado. Añade un proveedor de IA en TabRunner si quieres que ejecute tareas por ti.",
      install:
        "Instala <bun>Bun</bun>, que ejecuta el proceso MCP local. Después ejecuta este comando en el terminal. El plugin añade el servidor MCP y las instrucciones para usarlo.",
      add: "Si no quieres el plugin, registra solo el servidor MCP con este comando. <code>--scope user</code> lo deja disponible en todos los proyectos. Elige un solo método para no duplicar las herramientas.",
      check:
        "Abre una nueva sesión de Claude Code y pídele que llame a <code>health</code>. La herramienta comprueba la conexión y los ajustes guardados del proveedor, no si el proveedor aceptará la próxima petición.",
      manual:
        "¿Usas Codex, una versión anterior de Claude Code o un archivo del daemon descargado? El <manual>manual completo de MCP</manual> incluye esos pasos y todas las herramientas.",
    },
    examples: {
      title: "Prueba una tarea",
      intro:
        "Inicia sesión primero en los sitios que vas a usar. Después pide a tu IA conectada que use TabRunner. Estos son ejemplos de peticiones, no acciones que ejecute esta página.",
      prompts: [
        "Busca la factura más reciente en mi correo y dime el importe pendiente.",
        "Compara los gastos de envío en las pestañas de compra abiertas. No hagas ningún pedido.",
        "Prepara una respuesta al último mensaje de soporte. No la envíes.",
      ],
      follow:
        "La IA llama a <code>get_status</code> para seguir la tarea. Si TabRunner hace una pregunta, la IA debe mostrártela y devolver tu respuesta. No debe aprobar nada en tu nombre.",
    },
    access: {
      title: "A qué da acceso la conexión",
      browser:
        "Un cliente conectado puede leer páginas y actuar en tu navegador con la sesión iniciada. Las tareas, las lecturas de las páginas y las capturas de pantalla pueden pasar a ese cliente. Las pestañas comparten las cuentas del perfil del navegador, aunque distintos clientes usen pestañas diferentes. Conecta solo clientes a los que confiarías ese acceso.",
      auth: "No tienes que crear ni pegar una clave de API de TabRunner. Un proceso local conecta el cliente con la extensión. Usa un token de acceso guardado en un archivo privado dentro de <code>~/.tabrunner/mcp</code>. Los programas que se ejecutan con tu usuario del sistema pueden leer ese archivo. No lo compartas ni expongas el proceso local a la red.",
      provider:
        "Cuando delegas una tarea, la extensión usa el proveedor de IA que elegiste y se aplican sus tarifas. Las herramientas de control directo no necesitan un proveedor configurado en TabRunner; el cliente MCP usa su propio modelo. Las credenciales del proveedor solo pasan entre la extensión y el proveedor.",
      direct:
        "Las tareas delegadas siguen las reglas de aprobación de TabRunner. Las herramientas directas <code>browser_*</code> no pasan por su modelo, así que el cliente que las llama debe pedirte permiso antes de pagar, enviar, borrar o enviar un formulario.",
    },
    developers: {
      title: "Para desarrolladores",
      intro:
        "Usa este comando y argumento en un cliente que admita servidores MCP locales por stdio, la entrada y la salida estándar del proceso. Necesita Bun y la extensión TabRunner en el mismo ordenador. Un cliente que solo admita URL remotas no puede conectarse así.",
      example: "Una llamada inicia la tarea y devuelve el ID de la ejecución:",
      status:
        "Llama a <code>get_status()</code> hasta que la tarea termine, falle o haga una pregunta. Por defecto, espera a que algo cambie. No la consultes con un temporizador. Usa <code>answer(text)</code> solo después de la respuesta de la persona y <code>stop()</code> para detener la tarea actual de este cliente.",
      reconnect:
        "Si una llamada agota el tiempo de espera, la acción en el navegador puede haberse realizado. Restablece la conexión y comprueba el estado o la página antes de intentarlo de nuevo. Las acciones del navegador no se repiten automáticamente.",
      reference: "Referencia para programas",
      discovery: "Datos de instalación MCP local (JSON)",
      index: "Índice de documentación (llms.txt)",
      full: "Guía completa de conexión (llms-full.txt)",
    },
    remove: {
      title: "Desconectar o actualizar",
      disable:
        "Para desconectar todos los clientes MCP de este navegador, desactiva el puente en Configuración → MCP de TabRunner. Para detener solo la tarea actual, pide primero a su cliente que llame a <code>stop</code>. Las tareas de los demás clientes son independientes.",
      plugin: "Si instalaste el plugin, desinstálalo con:",
      remove:
        "Si registraste el servidor a mano con <code>--scope user</code>, elimina ese registro con:",
      file: "Si usaste la descarga antigua de un único archivo, <code>~/.tabrunner-mcp.js</code> sigue en el disco después de eliminar el registro. Puedes borrar el archivo por separado:",
      update:
        "Actualiza el plugin desde el gestor de plugins de tu cliente. Con la configuración manual por npm, <code>@latest</code> busca una versión nueva al iniciarse. Actualiza todos los clientes que comparten el puente y, si sus versiones difieren, ciérralos y vuelve a abrirlos. Si descargaste el archivo, repite el comando de descarga del manual completo.",
    },
    faq: {
      otherFolders: {
        q: "Claude Code no encuentra TabRunner en otra carpeta",
        a1: "Sin <code>--scope user</code>, Claude Code guarda el servidor solo para la carpeta donde lo añadiste. Añádelo otra vez, para todas las carpetas:",
        a2: "Si también tienes un registro solo para una carpeta, elimínalo desde esa carpeta para no duplicar las herramientas:",
      },
      notConnected: {
        q: "La herramienta health dice que la extensión no está conectada",
        lead: "Revisa esto, en orden:",
        items: [
          "El puente está activado en TabRunner, en Configuración → MCP. Abre el panel lateral una vez para activar la extensión y vuelve a probar health al cabo de unos 30 segundos.",
          "El puerto coincide. Si cambiaste el puerto del daemon con <code>TABRUNNER_BRIDGE_PORT</code>, escribe el mismo número en Configuración → MCP. El predeterminado es 17836.",
          "Tu navegador está abierto, con TabRunner instalado y activado.",
          "Claude Code muestra el servidor. Ejecuta <code>claude mcp list</code>. Si tabrunner no aparece, añádelo otra vez y abre una sesión nueva.",
        ],
        tail: "El daemon se inicia junto con Claude Code, así que no hay nada que dejar en marcha.",
      },
      browsers: {
        q: "¿En qué navegadores funciona?",
        a: "Navegadores Chromium de escritorio: Chrome, Brave, Edge, Arc, Opera y Vivaldi. Firefox y Safari no tienen la API de entrada confiable, así que TabRunner no puede hacer clic ni escribir de verdad en ellos.",
      },
      account: {
        q: "¿Necesito una cuenta de TabRunner?",
        a: "No. No hay cuenta de TabRunner ni plan gratuito. Tú pones el modelo: inicia sesión con un plan de Claude, ChatGPT o Kimi que ya pagas, o pega una clave de API. Cualquier endpoint compatible con el formato de OpenAI o de Anthropic también sirve.",
      },
      data: {
        q: "¿A dónde van mis datos?",
        a: "La web en la que trabaja TabRunner y el proveedor de IA que elijas reciben los datos necesarios para la tarea. Tu inicio de sesión o clave de API va directo de la extensión al proveedor. Un cliente MCP conectado también recibe tareas, lecturas de las páginas y capturas de pantalla. Los ajustes y el historial se quedan en el almacenamiento del navegador. No hay un servidor de TabRunner en la nube, analítica ni intermediarios. Los servidores MCP remotos y los webhooks solo reciben datos si los añades. La <privacy>política de privacidad</privacy> da los detalles.",
      },
      confirm: {
        q: "¿Paga, envía o borra sin preguntar?",
        a: "Cuando delegas una tarea, las reglas de TabRunner indican al modelo que pregunte antes de pagar, enviar, borrar o enviar un formulario. El cliente debe mostrarte cada pregunta y devolver tu respuesta, nunca aprobar en tu nombre. Las herramientas de control directo no pasan por ese modelo, así que el propio cliente debe pedirte permiso. Conecta solo clientes de confianza y revisa su trabajo.",
      },
      stop: {
        q: "¿Cómo detengo una ejecución?",
        a: "Haz clic en Detener en el panel lateral. Cerrar la pestaña que controla también termina la ejecución. Desde un cliente MCP, llama a la herramienta <code>stop</code>.",
      },
      update: {
        q: "¿Cómo actualizo la extensión?",
        a: "Con la Chrome Web Store, las actualizaciones llegan solas. Si instalaste el ZIP, descomprime cada versión nueva sobre la misma carpeta y haz clic en el icono de recargar en <code>chrome://extensions</code>. Nunca quites la extensión para reinstalarla. Chrome borra su almacenamiento, y tus proveedores, sesiones y conversaciones se van con ella.",
      },
    },
  },
  legal: {
    back: "Volver a tabrunner.app",
    source: "Fuente oficial:",
  },
  footer: {
    tagline: "Tú pones la meta. Él pilota tus pestañas.",
    chromium: "Solo Chromium: Chrome, Brave, Edge, Arc, Opera, Vivaldi.",
    openSource: "Código abierto en GitHub",
    license: "Código abierto, licencia MIT.",
    productHeading: "Producto",
    projectHeading: "Proyecto",
    store: "Chrome Web Store",
    downloadZip: "Descargar ZIP",
    issues: "Issues",
    privacyLink: "Política de privacidad",
    termsLink: "Términos de uso",
    docs: "Docs",
    copyright: "© 2026 Gus",
  },
};
