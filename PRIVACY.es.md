# Política de privacidad de TabRunner

_Última actualización: 2026-09-13 · Se aplica a TabRunner para navegadores Chromium (Chrome, Brave,
Edge, Arc, Opera, Vivaldi)._

Este documento también existe en [inglés](PRIVACY.md). Si la traducción y el texto en inglés
difieren, prevalece el texto en inglés.

**En resumen:** TabRunner es un agente de navegador que ejecutas tú. No hay servidor de TabRunner,
ni cuenta, ni telemetría, ni servicios de analítica. Todo lo que escribes o configuras se queda en
tu dispositivo, en el almacenamiento local de tu navegador. Los únicos destinos de tus datos son (1)
el proveedor de IA que **tú** hayas configurado, (2) los sitios web en los que le pidas a TabRunner
que actúe y, solo si los usas, (3) un puente MCP local en tu propio equipo y (4) la URL de una
habilidad que importes.

---

## 1. Qué recopila TabRunner

**No recopilamos nada.** TabRunner no tiene backend, ni sistema de cuentas, ni telemetría. En ningún
momento se comunica con los desarrolladores, con un servidor de licencias ni con ningún servicio de
analítica, tampoco mientras se ejecuta. La extensión funciona íntegramente entre tu navegador, el
proveedor que hayas configurado y los sitios en los que la pongas a trabajar.

**Lo que tú aportas.** TabRunner guarda en el almacenamiento local de tu navegador
(`chrome.storage.local`, en el namespace `local:tabrunner:*`):

- **Configuración de proveedores**: los proveedores que configuras (nombre, URL base, formato de la
  API y, de forma opcional, el modelo preferido) y la **clave de API** que pegas o el **token de
  inicio de sesión** de una suscripción. Las claves y los tokens se guardan localmente para que solo
  tengas que escribirlos una vez.
- **Historial de chats**: las transcripciones de tus tareas, incluidos el texto que escribes para
  cada tarea, las respuestas del proveedor y un registro de las acciones de TabRunner. Se conservan
  los 50 chats más recientes.
- **Documentos de memoria**: los archivos opcionales `AGENTS.md` (tus instrucciones permanentes) y
  `MEMORY.md` (lo que TabRunner ha aprendido), que aparecen en el panel Configuración → Memoria.
- **Habilidades**: las recetas opcionales que aparecen en Configuración → Habilidades (nombre,
  descripción, sitios, instrucciones), ya estén escritas a mano, extraídas de un chat o importadas.
- **Preferencias**: el tema y el idioma que elijas.

## 2. Qué procesa TabRunner y adónde van los datos

Cuando se ejecuta una tarea, TabRunner lee la página en la que estás trabajando y la convierte en
una **instantánea compacta del árbol de accesibilidad** (`[ref=e12] button "Submit"`), que no
incluye el HTML en bruto ni los scripts o archivos multimedia de la página. Esa instantánea, el
texto de tu tarea, el chat hasta ese momento y la captura de pantalla de la página, si se toma, se
envían **al proveedor que hayas configurado**, con tu propia clave de API o tu inicio de sesión con
suscripción, a través de HTTPS. Las respuestas del proveedor y sus llamadas a herramientas vuelven a
la extensión, que las ejecuta en tu navegador como entrada real de usuario. Cuando el árbol y las
pulsaciones de teclas no bastan, una llamada a herramienta también puede **ejecutar un script breve
dentro de la página** (para fijar el valor de un campo rebelde o leer algo que el árbol omite) y
leer la **actividad de red y de consola** de la pestaña (direcciones y códigos de estado, nunca el
contenido de las respuestas). Los resultados de los scripts tienen un tamaño limitado y, antes de
sumarse al chat, se les quita todo lo que parezca una credencial. Como cualquier otra acción, los
scripts solo se ejecutan dentro de una tarea cuyo plan hayas aprobado.

**TabRunner nunca envía tus datos a ningún otro lugar.** Esta es la lista completa de destinatarios
en la red:

1. **El proveedor que hayas configurado**: el proveedor de modelos (o el endpoint personalizado) que
   hayas elegido. Recibe la tarea, las instantáneas de las páginas, las capturas de pantalla y tu
   clave de API o el token de tu inicio de sesión para la autenticación. La clave o el token se
   transmite solo a ese proveedor, mediante TLS, como parte de la propia API del proveedor.
2. **Los sitios web que le pidas controlar**: navegar, hacer clic y escribir en un sitio produce el
   mismo tráfico que tu propio navegador, con las sesiones que ya tienes iniciadas. TabRunner no
   redirige, no registra ni captura ese tráfico más allá de lo que ya ve el propio sitio.
3. **Un puente MCP local en tu propio equipo, si ejecutas uno**: un cliente de IA que ejecutes tú
   (Claude Code, Claude Desktop) puede controlar TabRunner a través de un daemon que escucha en
   `127.0.0.1`. Nada fuera de tu equipo puede acceder a él, y el daemon no guarda nada: retransmite
   las tareas que entran y el progreso de las ejecuciones que sale. Solo existe mientras lo
   ejecutas; si no, TabRunner no se conecta a nada. Consulta [docs/mcp.md](docs/mcp.md).
4. **La URL de una habilidad, solo cuando importas una**: Configuración → Habilidades → Importar
   accede únicamente a la dirección https que escribas (una sola solicitud GET; no se adjunta nada
   tuyo aparte de la propia solicitud), en el momento en que lo pidas. TabRunner nunca descarga ni
   actualiza habilidades por su cuenta.

Nadie más (ni servidores intermedios, ni proxies, ni servicios de analítica, ni servidores de los
desarrolladores) recibe nunca tus datos.

## 3. Lo que sigue siendo privado

- **Los campos sensibles nunca salen de la página.** Los campos de contraseña, de número de tarjeta
  y otros campos `password` o sensibles se excluyen del árbol de accesibilidad, así que no se envían
  al modelo. Además, antes de que cualquier resultado de script se sume al chat, se eliminan los
  valores que parezcan credenciales (tokens, claves de API, cookies).
- **Las capturas de pantalla para el modelo son temporales.** Una captura tomada para el contexto
  del modelo se comprime (JPEG q80) y se elimina antes de guardar la transcripción en el
  almacenamiento. Las imágenes que adjuntas tú, cuando el modelo admite imágenes, se guardan como
  parte de esa transcripción.
- **Las grabaciones de guías paso a paso se quedan en el dispositivo.** Si pides que se documente
  una tarea, las capturas de cada paso se guardan en la base de datos local de este navegador. Nunca
  se incluyen en lo que se envía al modelo, así que una grabación no puede llegar a tu proveedor. Se
  eliminan junto con el chat al que pertenecen, y toda la función se puede desactivar en
  Configuración → Guías paso a paso.
- **Almacenamiento solo local.** Toda la configuración y todo el historial están en el
  almacenamiento local de tu navegador, en este dispositivo. Al desinstalar la extensión, se borran.

## 4. Lo que puedes controlar

- **Eliminar un chat**: Historial → ⋯ → Eliminar. Borra esa transcripción de este dispositivo.
- **Borrar la memoria**: Configuración → Memoria. Elimina cualquier dato recordado desde su fila, o
  desactiva "Recordar lo que aprende" para que no se guarden datos nuevos. Así ese contenido deja de
  enviarse con las próximas tareas.
- **Quitar un proveedor**: Configuración → Proveedores → Eliminar. Borra la clave de API o el token
  de inicio de sesión guardados; puedes volver a configurarlo cuando quieras.
- **Eliminar una habilidad**: Configuración → Habilidades. El interruptor pausa una habilidad sin
  eliminarla; si la eliminas, deja de usarse en todas las próximas tareas.
- **Detener en cualquier momento**: Esc o el botón Detener del panel, el botón de detener de la
  lista de la franja Tareas, o cerrar la pestaña controlada por la tarea: cualquiera de estas
  opciones detiene esa tarea. Cerrar el panel NO detiene una tarea: la tarea usa tu pestaña actual
  (o abre una propia cuando no hay ninguna página con la que trabajar) y sigue trabajando después de
  cerrar el panel. Esa es precisamente la idea: lanzarla y olvidarte. Cuando una tarea se detiene,
  ya no se envía nada.
- **Desinstalar**: quitar la extensión desde `chrome://extensions` elimina todo su almacenamiento
  local.

## 5. Para qué sirve cada permiso

| Permiso                               | Para qué sirve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debugger`                            | Entrada real y de confianza: los clics y las pulsaciones de teclas se envían a través del Chrome DevTools Protocol para que los sitios no puedan ignorarlos. También es el canal de la herramienta de scripts en la página y del registro de red y consola, siempre dentro de la tarea que hayas aprobado.                                                                                                                                                                                                                                    |
| `scripting`                           | Inyecta en la pestaña que lee TabRunner el script que genera la instantánea del árbol de accesibilidad, y también el que fija el valor de un campo cuando las pulsaciones de teclas no surten efecto.                                                                                                                                                                                                                                                                                                                                         |
| `sidePanel`                           | Aloja la interfaz del chat donde escribes las tareas y sigues la ejecución.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tabs`                                | Usa tu pestaña actual o abre una pestaña propia para la tarea, lee la URL y el título, y cambia de pestaña cuando una tarea hace referencia a otra pestaña abierta.                                                                                                                                                                                                                                                                                                                                                                           |
| `activeTab`                           | Da acceso a la pestaña desde la que envías una tarea, acción por acción.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tabGroups`                           | Agrupa la pestaña de cada tarea y le pone al grupo el nombre de la tarea (✓/✗/? cuando termina, y después lo contrae).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `storage`                             | Guarda localmente la configuración de los proveedores, el historial y la memoria.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `unlimitedStorage`                    | Evita que el navegador descarte las grabaciones de guías paso a paso. Una tarea documentada guarda una captura de cada paso en la base de datos local de este navegador, y una sola grabación puede ocupar decenas de megabytes. Las imágenes se quedan en el dispositivo y nunca se envían al modelo.                                                                                                                                                                                                                                        |
| `notifications`                       | Te avisa cuando una tarea en segundo plano termina, falla o se detiene para preguntarte algo mientras el panel está cerrado.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `alarms`                              | Activaciones periódicas: vuelve a conectar el puente MCP local y mantiene activo el worker durante una tarea larga con el panel cerrado. No ejecuta ninguna tarea ni toca ninguna página.                                                                                                                                                                                                                                                                                                                                                     |
| `declarativeNetRequestWithHostAccess` | Quita el encabezado `Origin` de las llamadas que el propio TabRunner hace al proveedor que hayas configurado. Un inicio de sesión con suscripción (en lugar de una clave de API pegada) se rechaza cuando la solicitud llega con un origen de navegador. La regla solo se aplica a una lista fija de hosts de API de proveedores y solo modifica los encabezados de las solicitudes a esos hosts, nunca los de las páginas que visitas ni los del sitio que se está automatizando. No bloquea nada, no redirige nada y no lee ninguna página. |
| Permisos de host (`<all_urls>`)       | TabRunner necesita poder navegar por cualquier sitio que le pidas usar, leerlo e interactuar con él. Solo usa este permiso mientras hay una tarea en ejecución.                                                                                                                                                                                                                                                                                                                                                                               |

## 6. Protecciones

- **Preguntar antes de actuar.** Cuando es el propio modelo de TabRunner el que controla, las
  acciones con consecuencias (pagar, enviar, eliminar) detienen la ejecución y piden tu confirmación
  explícita antes de realizarse: en el panel, o a través del cliente que haya iniciado la tarea.
- **El control directo es la excepción, y se ve.** Un cliente MCP que conectes también puede
  controlar el navegador paso a paso, sin el modelo de TabRunner de por medio y, por lo tanto, sin
  esa regla de confirmación, que forma parte del propio prompt de TabRunner. TabRunner no deja que
  esto pase desapercibido: la página controlada muestra la insignia "TabRunner está controlando esta
  pestaña", la pestaña muestra el punto ámbar y cada acción queda registrada en un chat de tu
  historial, con el nombre del cliente que la realizó.
- **Nada de vigilancia en segundo plano.** TabRunner solo lee páginas y actúa en ellas mientras se
  ejecuta una tarea que hayas iniciado tú, y solo en las pestañas que usa esa tarea.

## 7. Cambios en esta política

Si la forma en que TabRunner trata los datos cambia de un modo que afecte a esta política, se
actualizará este documento y el cambio de versión se indicará en el registro de cambios de esa
versión. Los cambios sustanciales se destacarán en las notas de la versión de la extensión.

## 8. Contacto

Este proyecto se mantiene en GitHub, en
[tabrunner/tabrunner](https://github.com/tabrunner/tabrunner). Si tienes preguntas sobre esta
política, abre un issue
([github.com/tabrunner/tabrunner/issues](https://github.com/tabrunner/tabrunner/issues)).
