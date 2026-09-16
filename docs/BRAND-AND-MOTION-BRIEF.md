# Ocelin: marca y evolución de Clawd

Actualizado el 17 de septiembre de 2026. **Ocelin es el nombre elegido por el usuario.** Este documento recoge la dirección vigente del rebranding. Las propuestas anteriores quedan como exploración histórica.

## Criterio de marca

El nombre debe funcionar como producto de software: corto, fácil de pronunciar, cómodo en un comando, reconocible en un icono de Windows y ajeno a un proveedor concreto. Puede tener una raíz española o latinoamericana y una relación sutil con un animal. La personalidad debe sentirse cuidada y competente, con humor discreto.

La mascota actual ya aporta identidad. La nueva marca debe evolucionar a partir de Clawd y de su lenguaje visual, conservando la familiaridad de la figura compacta, las formas geométricas, los ojos simples y los gestos legibles. La dirección propuesta usa Ocelin tanto para el producto como para el personaje: una identidad compartida cuyo vínculo con el ocelote se expresa mediante rasgos discretos y movimiento.

## Nombre elegido: Ocelin

**Ocelin** es una propuesta creativa inspirada en la palabra ocelote. No se presenta como un término indígena ni como una etimología histórica. Es breve, permite el identificador ASCII `ocelin` y puede acompañar a una criatura geométrica con detalles felinos discretos.

La dirección visual preferida es Ocelot: una evolución de Clawd con volumen compacto, ojos expresivos y el mismo vocabulario de movimiento. El usuario pidió un pelaje naranja y un acabado de pixel art más cuidado. El animal es una influencia visual; la legibilidad del personaje a tamaño pequeño tiene prioridad sobre el realismo.

El cuarto estudio conserva el pixel art sutil del anterior y refuerza los rasgos de ocelote. El pelaje pasa a dorado, con cuatro pequeñas marcas marrones por encima de los ojos. El usuario rechazó las manchas abiertas de la parte inferior porque parecían mejillas; se eliminan también de los iconos y se deja la cara despejada. Las orejas siguen siendo discretas y la cola incorpora dos bandas y una punta oscura. La [referencia del San Diego Zoo](https://animals.sandiegozoo.org/animals/ocelot) describe el pelaje dorado, las manchas oscuras y las bandas de la cola. Se mantienen los ojos planos, sin contornos oscuros, hocico dibujado ni brillos.

La raíz de la cola queda fija y solapada bajo el cuerpo; solo se mueve el tramo exterior. Así se evita la separación visual del estudio anterior, incluso durante la animación. La paleta tiene cinco colores compartidos por el cuerpo, la cola y los iconos.

El quinto estudio corrige la anatomía de las animaciones: siempre hay cuatro extremidades. Las patas delanteras se levantan para sujetar objetos; el cuerpo sube y se apoya en dos patas traseras. Reposo, espera, bloqueo y sueño conservan las cuatro patas en el suelo. Una sombra de un píxel de dibujo define las puntas de las patas. El [módulo de movimiento](../ui/ocelin/ocelot-motion.mjs) redibuja los objetos sobre la misma cuadrícula y coordina las manos con la escritura, la lectura y la lupa. El movimiento reducido muestra directamente la pose final.

El [arte de Ocelot](../ui/ocelin/ocelot-art.mjs) usa SVG editables sin dependencias y una cuadrícula de píxeles enteros. Los iconos tienen dibujos específicos para 16 y 24 píxeles; el de 32 amplía el de 16 a escala entera. Los accesorios mantienen los ojos despejados y las piezas añadidas respetan el movimiento reducido o desactivado.

Las búsquedas iniciales de la grafía exacta junto a software, app y coding agent no mostraron un producto equivalente claramente identificable. Sí existen otros usos del nombre. La elección del nombre no establece disponibilidad de dominio, paquete ni marca.

También se investigaron nombres que se descartaron por coincidencias cercanas: [Nimbo](https://github.com/gscalzo/Nimbo) ya es un agente de programación, [Rondar](https://swarmkit.dev/) coordina sesiones de Codex, y [Zarco](https://www.zarco.uk/) ofrece una plataforma de agentes y aprobaciones. Las propuestas previas como Tlacu, Cleto y Don Tejón no satisfacen el tono solicitado.

## Base técnica verificada

La referencia canónica es [clawd-playground-v16.html](../reference/clawd-playground-v16.html). La implementación actual está en [clawd-element.mjs](../ui/clawd/clawd-element.mjs), con estilos y animaciones en [clawd.styles.mjs](../ui/clawd/clawd.styles.mjs). La [derivación de estados](../ui/shared/clawd-state.mjs) es independiente de la presentación.

La [galería actual](../ui/clawd-gallery.html) muestra once estados. El componente usa HTML, CSS y un elemento personalizado con Shadow DOM. Esta base permite producir animaciones editables, escalables y conectadas a eventos reales, manteniendo cero dependencias en la UI. No necesita una secuencia de imágenes generadas para cada estado.

## Trabajo de mascota y animación incluido

El rebranding incluye diseñar y programar la nueva mascota, sus movimientos, accesorios y transiciones. La primera entrega visual debe ser una comparación animada con Clawd, antes de integrar el diseño elegido en toda la aplicación.

| Estado existente | Intención que debe conservar la nueva animación |
| --- | --- |
| sleeping | Reposo claro, ojos relajados, movimiento mínimo |
| thinking | Mirada y gesto de concentración |
| idle | Vigilancia tranquila; paseo opcional en superficies amplias |
| reading | Lectura reconocible con un accesorio legible |
| coding | Trabajo sostenido con movimiento discreto de manos |
| inspecting | Comprobación mediante barrido visual o lupa |
| reviewing | Revisión deliberada y distinta de inspeccionar |
| waiting | Espera de una operación externa, distinguible de necesitar al usuario |
| attention | Petición de atención con gesto breve y señal persistente |
| blocked | Bloqueo visible que permanezca hasta que cambie el estado |
| success | Celebración breve ligada a un resultado confirmado |

El estado de finalización no debe inferirse del mero silencio del agente. La falta de datos y la antigüedad de una señal deben indicarse sin fingir actividad ni éxito.

## Entregables y criterios de aceptación

1. Tres variantes visuales cercanas a Clawd, comparadas con la referencia: Continuity, Ocelot y Signal. El nombre Ocelin está elegido; Ocelot es la dirección preferida y se refina en naranja antes de su integración.
2. Galería con los once estados, transiciones interrumpibles y modos de movimiento completo, reducido y desactivado.
3. Adaptación a las tres superficies seleccionables: icono de bandeja, barra flotante y dashboard. La bandeja usará una silueta simplificada y señales discretas; los accesorios completos corresponden a tamaños mayores.
4. Verificación en temas claro y oscuro, escalado de Windows, espacios estrechos, navegación por teclado y cambios rápidos de estado. Ningún accesorio debe tapar los ojos, el mensaje o las acciones.
5. Integración gradual con la referencia v16 conservada como comparación. Los cambios de nombre público no deben romper la lectura de configuración, las sesiones guardadas ni los comandos anteriores durante la migración.

El icono debe reconocerse a 16 y 24 píxeles; la mascota de la barra debe funcionar a 32 y 48 píxeles; el dashboard puede mostrar más detalle. Los estados importantes deben tener texto o símbolo además de color. Las superficies ocultas no deben sostener trabajo de animación innecesario.

La primera [galería animada de Ocelin](../ui/ocelin-studies.html) compara las tres variantes con Clawd en los once estados. Permite revisar tema, movimiento, barra flotante e iconos pequeños. Son estudios de diseño con estados simulados; la mascota de producción y la referencia v16 permanecen como base de comparación.
