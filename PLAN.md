# scenegrade — Plan de proyecto

Player web profesional de **vídeo e imágenes (EXR y demás)** con gestión de color **ACES**,
herramientas de análisis (histograma, waveform, vectorscopio, falso color, zebra…) y fácil
de integrar en cualquier web.

---

## 1. Decisiones técnicas clave

### 1.1 Render: WebGPU como motor principal, WASM para decodificar

| Pieza                                              | Tecnología                                                                    | Motivo                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render de imagen + pipeline de color               | **WebGPU** (WGSL)                                                             | Texturas float (`rgba16float`/`rgba32float`), **compute shaders** con atómicos → los scopes salen casi gratis en GPU. Canvas HDR (`toneMapping: extended`). |
| Fallback                                           | WebGL2 (fase tardía, opcional)                                                | Solo visualización + falso color/zebra; scopes reducidos.                                                                                                   |
| Decodificación EXR                                 | **OpenEXR (OpenEXRCore) compilado a WASM** con Emscripten, en **Web Workers** | Soporta _todas_ las compresiones (PIZ, ZIP, DWAA/DWAB, PXR24, B44, HTJ2K). tinyexr no cubre DWA/B44, que es lo habitual en producción.                      |
| Demux (MOV/MP4/MKV)                                | **Mediabunny** (TS puro, MPL-2.0)                                             | Lee QuickTime `.mov` con ProRes, MP4 y MKV; también envuelve WebCodecs.                                                                                     |
| Decodificación ProRes                              | **TurboRes** (WASM + SIMD, MPL-2.0) en Web Workers                            | Ningún navegador decodifica ProRes de forma nativa (ni `<video>` ni WebCodecs). TurboRes cubre Proxy/LT/422/HQ/4444 con alfa, 10 y 12 bits.                 |
| Decodificación H.264/HEVC/AV1                      | **WebCodecs**                                                                 | Hardware; planos YUV de 10 bits (P010) sin pasar por `<video>`.                                                                                             |
| YUV → RGB                                          | **WGSL propio**                                                               | La conversión YUV→RGB (matriz, rango, 10/12 bits) la hacemos nosotros con precisión, sea cual sea el decoder.                                               |
| Lógica de color en CPU (tablas ACES 2.0, matrices) | TypeScript                                                                    | Se calcula una vez y se sube a la GPU como uniform/textura.                                                                                                 |

**WASM no sustituye a WebGPU**: WASM sirve para decodificar (CPU), WebGPU para todo lo que
toca píxeles. Hacer los scopes o el color en WASM sería 10–50× más lento.

Soporte de WebGPU (nov 2026): Chrome/Edge estable, Safari 26, Firefox en Windows (otras
plataformas en curso → verificar al empezar). Suficiente para una herramienta profesional.

### 1.2 Color: ACES sin meter OCIO entero en el navegador

OpenColorIO compilado a WASM es pesado (yaml-cpp, expat, minizip…) y no genera WGSL. Plan:

1. **Build-time "OCIO bake"**: script Python con OCIO 2.x que, para cada combinación
   _input → display/view_ del config ACES oficial (ACES 2.0 CG/Studio config), genera el
   shader GPU (GLSL) + sus LUTs/tablas → se transpila a **WGSL** (naga/tint) → se empaqueta
   como módulos JS. Fidelidad = la de OCIO, coste en runtime = cero.
2. **Transforms incluidas** (v1):
   - Input: ACES2065-1, ACEScg, ACEScct, ACEScc, Linear Rec.709/sRGB, sRGB, Rec.709,
     logs de cámara principales (ARRI LogC3/LogC4, Sony S-Log3, RED Log3G10, Canon Log, …).
   - Output ACES 2.0: sRGB, Rec.709 (100 nits), Display P3, **HDR PQ 1000 nits Rec.2100/P3**
     (si el navegador/pantalla lo soporta).
   - Views: ACES 2.0 SDR/HDR, Raw, Log (ACEScct), Un-tone-mapped.
3. **Fase opcional**: paquete `ocio-wasm` para cargar _configs custom_ del cliente en runtime
   (OCIO → GLSL → WGSL en el navegador con naga-wasm).
4. **Detección automática** del espacio de color: atributo `chromaticities` del EXR,
   metadatos `colr`/`nclx` del MP4; siempre sobrescribible por el usuario.

Validación: imágenes de referencia generadas con `ocioconvert` y comparación ΔE (ΔE2000 < 0.5
en SDR) en tests automáticos.

### 1.3 Integración: core headless + componentes Svelte + Web Component

```
@aces-player/core      TS puro, sin framework. Renderer, color, decoders, playback, scopes.
@aces-player/exr-wasm  OpenEXR → WASM + worker.
@aces-player/svelte    Componentes Svelte 5 (Viewer, Transport, Scopes, Panels…).
@aces-player/element   <aces-player> Web Component (compilado desde Svelte).
```

Tres niveles de integración:

- **Web Component** (lo fácil, cualquier framework o HTML plano, también por CDN):
  ```html
  <script type="module" src="https://cdn…/aces-player.js"></script>
  <aces-player
    src="shot_010.####.exr"
    input="ACEScg"
    display="sRGB"
    view="ACES 2.0 SDR"
    fps="24"
    tools="histogram,waveform,falsecolor"
  ></aces-player>
  ```
- **Svelte**: importar componentes sueltos y montar una UI propia.
- **Headless** (`core`): API JS para quien quiera su propia UI (React, Vue…).

**Svelte no complica, al contrario**: compila a JS sin runtime pesado y `customElement: true`
genera el Web Component directamente. Ojo con: Shadow DOM (estilos vía CSS custom properties
y `::part`), reflejo de atributos ↔ props, y fuentes dentro del shadow root.

Eventos y API del componente: `play()`, `pause()`, `seek(frame)`, `setColor({input, display,
view, exposure})`; eventos `frame`, `loaded`, `error`, `pixelprobe`.

### 1.4 Rendimiento: presupuesto y estrategias

- **Presupuesto por fotograma (4K @ 24 fps)**: subida a GPU + color + overlays < 8 ms;
  scopes < 2 ms (calculados sobre una versión reducida, p. ej. 1/4, y a ~15 Hz).
- **Workers**: pool de N decoders EXR (N = `hardwareConcurrency - 2`). Datos con
  _transferables_; `SharedArrayBuffer` solo si la web anfitriona tiene COOP/COEP (opcional,
  nunca obligatorio → si no, se rompe la "integración fácil").
- **Render en worker** con `OffscreenCanvas` (WebGPU funciona en workers) → el main thread
  de la web anfitriona no provoca tirones.
- **Caché de fotogramas** en GPU (ring buffer de texturas `rgba16float`) + caché en RAM
  comprimida; barra de caché en la timeline. Límite de memoria configurable.
- **Secuencias EXR**: realista en tiempo real 2K a 24 fps; 4K DWAA depende de la máquina →
  decodificación a media resolución / proxies / "cachea y luego reproduce" como en RV.
  4K half RGBA = 70 MB por fotograma: no se puede cachear una secuencia larga entera.
- **ProRes (formato de primera clase)**: es intra-frame (cada fotograma es independiente),
  así que se paraleliza **por fotograma** en un pool de workers sin necesitar
  SharedArrayBuffer ni COOP/COEP. Si la web sí tiene COOP/COEP, se usa además el modo
  multihilo de TurboRes (más rápido).
  - Referencia publicada de TurboRes (Apple M4): 4K 422 HQ ≈ 42 fps en **un solo hilo**,
    ≈ 250 fps multihilo; FFmpeg nativo en un hilo ≈ 15 fps. → **4K 422 HQ a 24 fps es
    viable con 1–2 workers**; 4444 XQ 4K y 8K hay que medirlos en la Fase 0.
  - Salida YUV planar 10/12 bits (I422P10, I444AP12…) → texturas `r16uint` → conversión en WGSL.
  - Ancho de banda: 4K 4:2:2 a 16 bits ≈ 35 MB por fotograma → ≈ 850 MB/s a 24 fps; asumible.
  - Plan de futuro: decoder ProRes en **WebGPU compute** (entropía por slice + IDCT en GPU),
    como el decoder Vulkan que tiene FFmpeg. Implementación propia: el de FFmpeg es LGPL y
    portarlo arrastraría la licencia.
  - Fuera de alcance de la v1: **ProRes RAW** (necesita debayer; fase opcional).
- **Otros vídeos**: H.264/HEVC/AV1 10 bits vía WebCodecs (hardware).
- Solo se usa float32 donde hace falta (probe de píxel); el resto, half.

---

## 2. Funcionalidades

### Visualización

- Zoom (fit, 1:1, 2:1…), pan, píxel a píxel (nearest a partir de 1:1).
- Exposición (± stops), gamma, saturación de visualización (sin tocar los datos).
- Aislar canales: R, G, B, A, luma; alfa sobre damero/negro/color.
- **Capas/AOVs** de EXR multicanal (beauty, diffuse, spec, Z, normales…), multiparte.
- Data window vs display window (overscan visible).
- Selectores de color: **Input / Display / View / Look**; carga de **LUT .cube** y **CDL**.
- Salida **HDR** en pantallas compatibles (canvas `rgba16float` + `extended`).

### Análisis (pro)

- **Histograma** RGB / luma, escala lineal y logarítmica, en espacio de escena o de display.
- **Waveform** luma y RGB Parade; **vectorscopio** con dianas 75 %/100 %.
- **Falso color**: presets (ARRI-like, EL Zone por stops alrededor de 18 % gris) + escala editable.
- **Zebra**: dos umbrales configurables (p. ej. 95 % y 70 %), rayas animadas.
- **Indicadores de clipping**: sobre/subexposición, NaN/Inf (en EXR de render pasa).
- **Pixel probe / cuentagotas**: valores scene-linear, ACEScct, display y nits; media de
  un área; muestras fijadas.
- **Focus peaking**.
- Guías: zonas seguras (title/action), máscaras de aspecto (2.39, 1.85, 9:16…), retícula
  de tercios, centro.

### Comparación

- A/B con **wipe**, lado a lado, **diferencia** (con ganancia) y "flicker".

### Reproducción

- Play/pause, frame a frame, **J/K/L**, velocidad, bucle, puntos **in/out**.
- Timecode / número de frame, fps del contenido, audio (vídeo) sincronizado.
- Secuencias `####`/`%04d`, ficheros sueltos, arrastrar y soltar, carpetas (File System Access).

### Metadatos

- Panel con cabecera EXR (canales, compresión, chromaticities, ventanas, atributos custom),
  datos del códec de vídeo, espacio de color detectado.

### Opcional (fases tardías)

- Anotaciones/dibujo por frame con export, playlists OTIO, sincronización de sesión entre
  usuarios, ocio-wasm, fallback WebGL2.

---

## 3. Diseño de UI

### Principios

- **Gris neutro** (no tintado) en toda la interfaz: el color de la UI no debe influir en la
  percepción de la imagen. Fondo del visor configurable (negro, gris 18 %, damero).
- **La imagen manda**: los paneles se colapsan; modo "clean" con una tecla (`Tab`).
- **Teclado primero**, atajos al estilo RV/Resolve; todo accesible también con el ratón.
- **Dos densidades**: _Full_ (herramienta de revisión) y _Compact_ (embebido en una web,
  solo transporte + pocos controles). Se elige con un atributo `layout="full|compact"`.
- **Theming** con CSS custom properties (`--ap-bg`, `--ap-accent`…) y `::part()`.
- Accesible: contraste AA en controles, foco visible, ARIA en transporte y sliders.

### Layout (modo Full)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ shot_010.1001.exr   Input [ACEScg ▾]  Display [sRGB ▾]  View [ACES 2.0 ▾]   │  barra superior
│                     EV [-1 ━━●━━ +1]  γ 1.0   Canal [RGB ▾]  Capa [beauty ▾]│
├───┬───────────────────────────────────────────────────────┬─────────────────┤
│ ⌖ │                                                       │ ▾ Histograma    │
│ ◐ │                                                       │ ▁▂▅▇█▆▃▂▁       │
│ ▦ │                    VISOR                              │ ▾ Waveform      │
│ ⟷ │              (zoom/pan, overlays,                     │ ▤▤▤▤▤▤          │
│ ▭ │               zebra, falso color)                     │ ▾ Vectorscopio  │
│ ✎ │                                                       │ ◎               │
│   │                         probe: R 0.18 G 0.18 B 0.18   │ ▸ Info / Meta   │
├───┴───────────────────────────────────────────────────────┴─────────────────┤
│ ⏮ ◀| ▶ |▶ ⏭  🔁  1x   [ in ]━━━━━━━━●━━━━━━━━━━━━━━[ out ]   01:00:04:12  1108 │  transporte
│                       ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░ (barra de caché)                   │
└─────────────────────────────────────────────────────────────────────────────┘
 Barra izquierda: probe, falso color, zebra, comparación A/B, guías, anotaciones.
```

### Modo Compact (embebido)

```
┌───────────────────────────────────────────┐
│                  VISOR                     │
│                                       [⚙]  │  ⚙ = popover con color, scopes, overlays
├───────────────────────────────────────────┤
│ ▶  ━━━━━━●━━━━━━━━━━━  00:00:04:12   ⛶     │
└───────────────────────────────────────────┘
```

### Entregables de diseño (Fase 1)

1. Design tokens (colores neutros, tipografía mono para valores, espaciados, iconos).
2. Wireframes Full y Compact + estados (vacío/drop, cargando, error, sin WebGPU).
3. Diseño de cada scope y overlay (escalas, leyenda del falso color, colores de zebra).
4. Prototipo navegable y mapa de atajos de teclado.
   Herramienta: Pencil o Figma; los tokens se exportan a CSS variables del paquete `svelte`.

---

## 4. Plan por fases

Estimaciones para 1 desarrollador a tiempo completo; orientativas.

| Fase                                   | Contenido                                                                                                                                                                                                                                                                                                                                             | Entregable                                                       | Semanas |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| **0. Spikes técnicos**                 | Pruebas de concepto con números: (a) decodificar EXR DWAA/PIZ en WASM (MB/s, 2K/4K); (b) WebGPU: subida de `rgba16float` y su coste; (c) **ProRes con Mediabunny + TurboRes** en Chrome/Safari/Firefox, con y sin COOP/COEP (2K/4K, 422 HQ y 4444 XQ) y WebCodecs 10 bits → textura; (d) bake OCIO → GLSL → WGSL de un ODT ACES 2.0 + comparación ΔE. | Informe con benchmarks y decisiones confirmadas o cambiadas.     | 2       |
| **1. Fundamentos + diseño UI**         | Repo público en GitHub (sección 6), monorepo (pnpm, Vite, TS, Svelte 5, Vitest, Playwright), CI, builds WASM/OCIO en Docker. Design system + wireframes (sección 3).                                                                                                                                                                                  | Repo esqueleto + diseño validado.                                | 2       |
| **2. Core render + EXR (imagen fija)** | Renderer WebGPU, zoom/pan, worker EXR, capas/AOVs, canales, exposición, metadatos.                                                                                                                                                                                                                                                                    | Visor EXR que funciona.                                          | 3       |
| **3. Pipeline de color ACES**          | Sistema de bake OCIO, IDTs/ODTs/views, LUT .cube/CDL, detección de espacio de color, salida HDR, tests ΔE contra OCIO.                                                                                                                                                                                                                                | Color fiel a OCIO.                                               | 3       |
| **4. Herramientas de análisis**        | Compute shaders: histograma, waveform/parade, vectorscopio. Overlays: falso color, zebra, clipping/NaN, peaking, guías. Pixel probe.                                                                                                                                                                                                                  | Scopes y overlays < 2 ms.                                        | 3       |
| **5. Vídeo**                           | Demux con Mediabunny, **ProRes con TurboRes** en pool de workers, WebCodecs para H.264/HEVC/AV1, YUV→RGB propio (matrices 709/2020, rango, 10/12 bits, alfa), reloj de reproducción, audio (WebAudio) sincronizado, seek preciso, caché de fotogramas.                                                                                                | Reproducción de ProRes (hasta 4444 con alfa) y HEVC/AV1 10 bits. | 4       |
| **6. Secuencias EXR**                  | Pool de workers, prefetch, caché GPU/RAM, barra de caché, media resolución, render en `OffscreenCanvas`.                                                                                                                                                                                                                                              | 2K en tiempo real.                                               | 2–3     |
| **7. UI completa Svelte**              | Todos los componentes según el diseño, modos Full/Compact, atajos, theming, accesibilidad.                                                                                                                                                                                                                                                            | UI final.                                                        | 3       |
| **8. Web Component + API pública**     | `<aces-player>`, atributos/props/eventos, build CDN (ESM) + npm, wrapper React fino.                                                                                                                                                                                                                                                                  | Integración en 1 línea.                                          | 1–2     |
| **9. Comparación A/B y extras**        | Wipe, lado a lado, diferencia; muestras de probe fijadas.                                                                                                                                                                                                                                                                                             | —                                                                | 1–2     |
| **10. Calidad y lanzamiento**          | Matriz de navegadores, tests de regresión visual, benchmarks automáticos, docs (Storybook/VitePress), demos, licencias (OpenEXR/OCIO BSD-3, ACES).                                                                                                                                                                                                    | v1.0                                                             | 2       |
| **12–17. Grading (v2)**                | Motor de grade (intérprete WGSL), primarias/curvas/HSL, cualificador y ventanas, exportar el look (CDL/CLF/.cube/AMF), render en el cliente (WebCodecs, EXR). Ver sección 8.                                                                                                                                                                          | Herramienta de grading en el navegador.                          | ~12 + 4 |
| **11. Opcional**                       | Decoder ProRes en WebGPU compute, ProRes RAW, ocio-wasm (configs custom), fallback WebGL2, anotaciones, OTIO, sesiones sincronizadas.                                                                                                                                                                                                                 | —                                                                | —       |

**Total v1 ≈ 26–29 semanas.** Un **MVP útil** (visor EXR + ACES + scopes + web component)
sale con las fases 0–4 + 8: ~13–14 semanas.

### Puntos de decisión (gates)

- Después de la **Fase 0**: si WebCodecs 10 bits no da la precisión o el soporte necesarios
  en los navegadores objetivo → plan B (`<video>` + `importExternalTexture`, con límite de
  8 bits) o un decoder WASM (dav1d para AV1).
- Si el bake OCIO→WGSL falla para ACES 2.0 → port manual del DRT a WGSL con tablas
  precalculadas en TS (más trabajo: +2 semanas).

---

## 5. Riesgos

| Riesgo                                                                 | Mitigación                                                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGPU aún no está en todos los navegadores                            | Fallback WebGL2 de visualización básica; mensaje claro.                                                                                       |
| 4K EXR en tiempo real                                                  | Proxies, media resolución, "cachear antes de reproducir".                                                                                     |
| TurboRes: proyecto de una sola persona (lo creó "como experimento")    | Aislarlo tras una interfaz `Decoder` propia; si se abandona, se mantiene un fork (MPL-2.0 lo permite) o se adelanta el decoder WebGPU propio. |
| Sin decoder de referencia ni tests de conformidad de Apple para ProRes | Comparar fotograma a fotograma con FFmpeg y con la decodificación de Apple (AVFoundation) en CI de macOS.                                     |
| HEVC no disponible en algún navegador/SO                               | Recomendar AV1 10 bits; detección de capacidades con `VideoDecoder.isConfigSupported`.                                                        |
| Precisión de color de vídeo                                            | Conversión YUV propia; tests con cartas de color de referencia.                                                                               |
| Tamaño del bundle                                                      | WASM y transforms cargados bajo demanda (lazy); core < 150 KB gz sin WASM.                                                                    |
| Webs anfitrionas sin COOP/COEP                                         | Nunca depender de SharedArrayBuffer.                                                                                                          |

---

## 6. Proyecto open source (GitHub)

### Licencia

- **Apache-2.0** (recomendada): permisiva como MIT, pero con **concesión de patentes**, que
  importa en un terreno con patentes de códecs y color. Compatible con todas las dependencias.
- Dependencias y sus licencias (todas compatibles):

  | Dependencia                                       | Licencia                                                                                                                              |
  | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
  | OpenEXR                                           | BSD-3-Clause                                                                                                                          |
  | OpenColorIO (solo build-time; ocio-wasm opcional) | BSD-3-Clause                                                                                                                          |
  | Transforms ACES (aces-aswf)                       | Academy/ASWF, permisiva (mantener avisos)                                                                                             |
  | Mediabunny + TurboRes (ProRes)                    | MPL-2.0 (copyleft solo por fichero: usarlos sin modificar no afecta a nuestra licencia; si los modificamos, publicamos esos ficheros) |
  | dav1d (plan B de AV1)                             | BSD-2-Clause                                                                                                                          |
  | Svelte                                            | MIT                                                                                                                                   |

- **Evitar FFmpeg** (LGPL/GPL según el build): complica distribuirlo como WASM empaquetado.
  Si se usa un demuxer basado en FFmpeg, que sea opcional y en un paquete aparte.
- Fichero `THIRD_PARTY_NOTICES.md` generado automáticamente en cada release.

### Nombre

- **"ACES" es marca de la Academy** (tiene un programa de logos y certificación). No poner
  ACES como nombre del proyecto ni usar su logo: mejor un nombre propio y "ACES" en la
  descripción ("ACES-managed web player").
- Comprobar que el nombre esté libre en npm, en GitHub y como dominio antes de publicar.
- **Decidido (19/11/2026): `scenegrade`** (scene-linear + grade). Paquetes `@scenegrade/*`,
  elemento `<scenegrade-player>`, tokens CSS `--sg-*`. Libre en npm y sin repos con ese nombre
  en GitHub. Pendiente: crear la organización `@scenegrade` en npm y el repo en GitHub.

### Estructura del repo

```
/packages/core  /packages/exr-wasm  /packages/svelte  /packages/element
/tools/ocio-bake        script Python que genera los shaders WGSL
/apps/demo              demo pública (GitHub Pages)
/apps/docs              documentación (VitePress)
LICENSE  README.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md
THIRD_PARTY_NOTICES.md  CHANGELOG.md
.github/  (workflows CI, plantillas de issues/PR, CODEOWNERS, dependabot)
```

### Infraestructura (GitHub)

- **CI (GitHub Actions)**: lint + tipos + tests unitarios + Playwright con WebGPU (Chrome
  headless con flags) + tests ΔE de color + benchmarks (avisa si hay regresión).
- **Builds reproducibles**: el WASM de OpenEXR y el bake de OCIO se generan en CI (Docker
  con Emscripten y OCIO fijados por versión), nunca binarios subidos a mano.
- **Releases**: Changesets → versionado semver por paquete, CHANGELOG, publicación en npm
  con **provenance**; el CDN (jsDelivr/unpkg) sale gratis desde npm.
- **Demo y docs** en GitHub Pages (COOP/COEP no disponible ahí → buena prueba de que
  funcionamos sin SharedArrayBuffer).

### Material de prueba

- Imágenes de **openexr-images** (ASWF) y material de muestra con licencia abierta.
  Nada de material de clientes en el repo.
- Las imágenes de referencia de color (salida de OCIO) se generan en CI, no se versionan.

### Comunidad

- README con GIF/demo, "quick start" de una línea y matriz de navegadores.
- Etiquetas `good first issue` y un roadmap público (GitHub Projects) a partir de las fases.
- Más adelante: valorar proponerlo como proyecto _sandbox_ de la Academy Software
  Foundation (ASWF), que ya aloja OpenEXR, OCIO y ACES.

---

## 7. Primeros pasos concretos

0. Elegir nombre, comprobar npm/GitHub, crear el repo con licencia Apache-2.0 y los ficheros
   de comunidad.
1. Fase 0 (a): compilar OpenEXRCore con Emscripten y medir el decode de un EXR 4K DWAA.
2. Fase 0 (d): script OCIO que exporte el shader del ODT ACES 2.0 sRGB y transpilarlo a WGSL.
3. Elegir herramienta de diseño y arrancar wireframes en paralelo.

---

## 8. Grading (v2): etalonar en cualquier sitio

Objetivo: una herramienta de **grading completa en el navegador**. Abres un enlace, etalonas
con color ACES fiel y exportas el look o el render, sin instalar nada. No sustituye a la sala
de color. Cubre lo que hoy exige un equipo con Resolve: on-set, dailies, look development,
revisión remota y etalonaje de piezas cortas.

Estado de partida (v1): el pipeline ya etalona en ACEScct en la GPU (exposición, saturación,
CDL, LUT .cube), y los scopes evalúan la misma cadena WGSL que el visor.

### 8.1 Modelo de grade

- **Espacio de trabajo:** ACEScct por defecto (operaciones "log", como Resolve/Baselight) y
  ACEScg para operaciones lineales (exposición, balance de blancos en linear, mezcla de canales).
- **Grafo de nodos en serie** (v2.0), con paralelo y capa más adelante. Cada nodo tiene:
  - operaciones primarias, curvas, cualificador, ventanas y su máscara combinada;
  - mezcla (opacidad) y bypass.
- **Intérprete en GPU** (decidido en la fase 12, en lugar de compilar el grafo a WGSL): una
  única función WGSL recorre los nodos empaquetados y ramifica por flags uniformes. Editar el
  grade, incluso añadir o quitar nodos, nunca recompila un pipeline. Los valores van en un
  storage buffer; las curvas se hornean como tabla `r32float` de 1024 muestras por curva.
  Coste medido: 3 nodos completos, 2,4 ms en 3 Mpx. Detalle en `docs/grading.md`.
- **Datos:** el grade es JSON serializable y versionado: `Grade { version, nodes[], ... }`.
  Puede ser por clip, por plano (rango de frames) o con keyframes por parámetro.
  - Es determinista: la misma entrada da los mismos píxeles en GPU y en la referencia CPU
    (tests).

### 8.2 Herramientas (por prioridad)

| Grupo       | Herramientas                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primarias   | Ruedas lift/gamma/gain/offset (y log: shadow/mid/high con rangos), contraste + pivote, saturación, temperatura/tinte, balance por cuentagotas, mezclador de canales |
| Curvas      | Curvas custom (Y + RGB), curvas HSL: hue vs hue/sat/lum, lum vs sat, sat vs sat                                                                                     |
| Secundarias | Cualificador HSL con soft/blur/denoise de máscara, vista de máscara (highlight), keyer de luminancia                                                                |
| Ventanas    | Círculo, rectángulo, polígono y bézier, con softness, inversión y combinación; tracking (punto/planar) en fase tardía                                               |
| Otros       | Blur/sharpen, viñeta, grano (estático, determinista), match de planos por estadísticas, galería de stills (grabar y aplicar grades)                                 |

### 8.3 UI (página "Color")

- **Layout Grade**, nuevo modo junto a `full`/`compact`:
  - visor y scopes grandes;
  - debajo, **paleta** con pestañas: Primarias · Curvas · HSL · Cualificador · Ventanas · Nodos;
  - a la izquierda, galería de stills; a la derecha, editor de nodos.
- **Ruedas:** arrastre normal más fino con `Shift`, doble clic para resetear, rueda del ratón
  sobre el anillo para el master y valores numéricos editables.
- **Control surfaces:**
  - **WebHID/WebMIDI** para Tangent, Blackmagic Micro/Mini Panel y controladores MIDI (fase
    tardía; Tangent necesita el mapeo del protocolo);
  - **Gamepad API** como opción barata.
- **Historial:** undo/redo de todo, y comparación del grade contra el original (bypass global)
  y contra stills de la galería con el wipe que ya existe.
- **Táctil:** paleta usable en tablet (iPad con Safari WebGPU), para on-set.

### 8.4 Interoperabilidad (exportar el look)

| Formato                      | Uso                                                                               | Fidelidad                            |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| ASC CDL (.cdl/.cc/.ccc, EDL) | Estándar de on-set → post. Se exporta el **nodo CDL** o una aproximación ajustada | Exacta solo para operaciones CDL     |
| **ACES CLF** (.clf)          | Look completo (LUTs + matrices + CDL), formato oficial de ACES y OCIO             | Alta                                 |
| .cube 3D (33/65)             | Universal (Resolve, Premiere, cámaras, monitores)                                 | Muestreada (error medido y mostrado) |
| ACES AMF                     | Metadatos de pipeline ACES (IDT/LMT/ODT) para el intercambio entre herramientas   | Referencias                          |
| Proyecto (.json)             | Grade nativo, con nodos y keyframes                                               | Exacta                               |

Importar: CDL/CC/CCC, .cube, CLF y AMF, para seguir en la web un look hecho en el set.

### 8.5 Render en el cliente

Pipeline: `decode → grade + view (GPU) → readback → VideoEncoder / encoder WASM → Mediabunny mux`.
El audio se copia sin recodificar.

| Salida                         | Cómo                                                   | Notas                                                     |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------------------------- |
| H.264 / HEVC (8/10 bits) / AV1 | WebCodecs `VideoEncoder`, normalmente por hardware     | 10 bits según hardware; detección con `isConfigSupported` |
| EXR (secuencia, ACES AP0/AP1)  | OpenEXR WASM (añadir el writer), en un pool de workers | Render "graded scene-linear" para VFX                     |
| ProRes 422/4444                | Encoder WASM (FFmpeg `prores_ks`, LGPL)                | Lento (medir). Paquete opcional, cargado bajo demanda     |
| PNG/TIFF 16 bits / stills      | Readback + encoder en worker                           | Grabs para la galería y referencias                       |

- **Ficheros grandes:** escritura en streaming con la File System Access API (Chrome/Edge);
  en otros navegadores, descarga por partes.
- **Lotes:** render de varios clips o planos con su grade.
- **Opciones de render:** resolución, view o espacio de salida (display-referred o
  scene-linear) y quemar overlays (TC, marca de agua).
- **Rendimiento:** se rinde en un `OffscreenCanvas` o en una textura sin presentar, y la
  readback es asíncrona con doble buffer. Objetivo: 1080p HEVC ≥ tiempo real en M-series y
  4K ≥ 0,5×.

### 8.6 Persistencia y colaboración

- **Local primero:** el proyecto vive en OPFS/IndexedDB; abrir y guardar `.json` del proyecto.
  Los medios no se copian; se referencian con File System Access handles o URLs.
- **API para el anfitrión:**
  - eventos `gradechange` y métodos `getGrade()`, `setGrade()` y `render()`;
  - cualquier plataforma (MAM, review tools) puede guardar el grade en su backend.
- **Opcional:** sesiones en vivo (WebRTC/WebSocket), en las que el colorista etalona y el
  cliente ve el resultado sincronizado; y comentarios por frame.

### 8.7 Fases

| Fase                                     | Contenido                                                                                         | Semanas |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| **12. Motor de grade** ✅                | Modelo de datos, intérprete WGSL, referencia CPU y tests, undo/redo, API `getGrade/setGrade`      | 3       |
| **13. Primarias + curvas + UI Grade** ✅ | Ruedas, log wheels, contraste/pivote, temperatura/tinte, curvas Y/RGB y HSL, layout Grade, stills | 4       |
| **14. Exportar e importar el look** ◐    | CDL/CC/CCC, CLF, .cube con error medido, AMF, proyecto .json                                      | 2       |
| **15. Render en el cliente**             | VideoEncoder (H.264/HEVC/AV1) + mux + audio, writer EXR, File System Access, cola de render       | 3       |
| **16. Secundarias**                      | Cualificador HSL, ventanas con softness, vista de máscara, nodos con mezcla, keyframes            | 4       |
| **17. Extras**                           | ProRes encoder WASM, tracking, control surfaces (WebHID/MIDI), match de planos, sesiones en vivo  | —       |

**Grading útil (12–15) ≈ 12 semanas.**

### 8.8 Riesgos específicos

| Riesgo                                                 | Mitigación                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| El shader crece con muchos nodos y secundarias         | Compilar solo lo usado; por encima de N nodos, multipass con texturas intermedias rgba16float             |
| Diferencias de look entre la web y Resolve al exportar | CLF como formato principal; tests de ida y vuelta con OCIO (`ociochecklut`); error del .cube visible      |
| Readback lenta en 4K                                   | Readback asíncrona en anillo de buffers; encoder alimentado desde `VideoFrame` de textura cuando se pueda |
| Sin encoder ProRes nativo                              | Paquete WASM opcional; recomendar HEVC 10 bits o EXR para entrega intermedia                              |
| Memoria de pestaña en lotes largos                     | Streaming a disco, frames liberados en cuanto se codifican, sin caché de salida                           |
| Control surfaces propietarias                          | Empezar por MIDI genérico y Gamepad; Tangent/Blackmagic cuando sea posible                                |

## 9. Estado y pendientes (2026-11-23)

**Hecho:** v1 (player) y fases 12–13 (grade). Publicado en npm 0.1.0 (`@scenegrade/core`, `svelte`,
`element`, `exr-wasm`) con Trusted Publishing (`scripts/publish.sh`, `release.yml`, sin NPM_TOKEN).
Demo en https://hitaboy.github.io/scenegrade/. CI verde en `main`. Split compare (mismo fotograma
etalonado vs original: `Player.setCompareOriginal`, interruptor Split en GradePanel).

**Pendiente:**

- **Fase 14** (exportar/importar CDL, CLF, .cube, AMF): siguiente paso propuesto, sin confirmar.
- **npm:** confirmar que cada paquete tiene el Trusted Publisher configurado en npmjs.com.
  Opcional: `npm deprecate @scenegrade/element@0.0.0-stage`.
- **Dependabot:** el PR de `npm_and_yarn` (typescript, @types/node, vitest) falla en CI; revisar
  antes de fusionar.
- **Media del README:** se capturan con `apps/demo/scripts/readme-media.mjs` a partir de los
  masters ACEScct de hitazot (`/srv/ai/projectes/bateria-*/masters-acescct/`), copiados en
  `apps/demo/public/media/local/` (gitignored). El usuario prefiere una mujer joven en pantalla;
  en hitazot solo hay fotos fijas (Núria, `outputs/guio/el-far/`). Propuesta sin lanzar: still →
  MiniMax i2v → sdr2hdr a ACEScct (~1 h de GPU en la RTX 4070); pedir confirmación antes, la GPU
  se comparte con otros trabajos.
- **Acceso a hitazot:** `ssh hitazot` (clave `~/.ssh/hitazot_ed25519`); documentación en `/srv/ai`
  (README.md, COMMENTS.md).

## 10. Plan de mejoras (2026-11-28)

Basado en el estado del repo a esta fecha. Por prioridad; cada bloque es independiente.

### P0 — Higiene (≈ 1 día)

- **`packages/svelte/.svelte-kit/` está versionado** (42 ficheros, copia vieja de los componentes:
  `ScenePlayer.svelte` 492 líneas vs 565 en `src`). Añadir `.svelte-kit/` a `.gitignore` y
  `git rm -r --cached`.
- **Dependabot: 8 PRs abiertos.** Fusionar los verdes (#7, #8 mediabunny 1.66.2; #1–#5 actions,
  comprobando cambios de inputs en `setup-node@7` y `changesets/action@2`). **#9 falla** porque
  sube TypeScript a 7 y `svelte-check` exige TS 6 + `--tsgo`: fijar `typescript` a `~6.0` en
  `dependabot.yml` (ignore major) hasta que svelte-check soporte TS 7.
- `npm deprecate @scenegrade/element@0.0.0-stage` y confirmar Trusted Publisher por paquete.

### P1 — Calidad de imagen y producto

- ~~**HEVC 10 bits pasa a RGBA8**~~ — medido el 2026-11-28: todas las vías de Chrome (copyTo,
  copyExternalImageToTexture a 10/16 bits, importExternalTexture) dan 8 bits con el decoder
  hardware de macOS. No se puede arreglar desde nuestro lado; ver `docs/benchmarks.md`.
- **Fase 14 (exportar/importar look)** — hecho el 2026-11-28: proyecto .json, ASC CDL
  (.cc/.ccc/.cdl, exacto o ajustado con error medido), .cube 33/65 con error medido, importar CDL
  como nodos (`docs/grading.md`). **Pendiente:** CLF y AMF.
- ~~**Tamaño del bundle**~~ — hecho el 2026-11-28: Mediabunny (53 % del JS) se carga al abrir un
  vídeo. `scenegrade-player.js` pasa de 199.7 a 99.7 KB gz; el chunk de vídeo son 116 KB gz.
- ~~**Timestamp queries de GPU**~~ — hecho el 2026-11-28: `Renderer.timer` (decode, display,
  scopes), `stats.gpuMs` y en la barra de transporte. ProRes 1080p ≈ 1.1 ms de GPU por frame.

- ~~**e2e en CI**~~ — hecho el 2026-11-28: se saltaban todos (sin adaptador) y en los PR el canvas
  no se presentaba. Arreglado con ANGLE sobre SwiftShader; en CI ahora falla si no hay adaptador.

### P2 — Mantenibilidad

- Ficheros grandes a partir: `player/player.ts` (1151), `GradePanel.svelte` (1029),
  `gpu/renderer.ts` (812). Separar en `player`: fuentes/caché/reloj/compare; en `GradePanel`:
  una sección por herramienta.
- **Tests**: solo 6 ficheros de unit + 1 e2e. Añadir tests de `video-source.ts` (seek, bucle,
  dropped frames) y de regresión visual (capturas del visor por transform, con tolerancia ΔE).
- Medir cobertura en CI (`vitest --coverage`) sin umbral al principio.

### P3 — Alcance (según interés)

- Fase 15 (render en el cliente) tras la 14.
- Compatibilidad: probar Safari 26 y Firefox en la matriz de e2e (hoy solo Chrome).
- Media del README con persona (ver §9), pendiente de confirmar uso de GPU de hitazot.
