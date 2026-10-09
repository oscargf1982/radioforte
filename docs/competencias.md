# En Antena · Sistema de competencias de comprensión oral

## Estructura de datos (todo compatible hacia atrás)

**Pregunta** (dentro de `podcasts/{id}.questions[]`). Campos antiguos conservados: `id, text, options, correct, difficulty, explanation`. Campos nuevos (todos opcionales):

| Campo | Significado |
|---|---|
| `competency` | `C1`..`C6` o `null` (pendiente) |
| `secondary` | competencias secundarias (array) |
| `level` | `inicial` / `intermedia` / `avanzada` (independiente de la competencia) |
| `classReviewed` | `true` si el docente ha revisado/confirmado la clasificación |
| `evidence` | qué debe comprender el alumno |
| `explanation` | (existente) ahora = justificación de la respuesta correcta |
| `distractors[]` | por qué cada opción incorrecta puede confundir (alineado con `options`) |
| `hint` | pista opcional |
| `format` | `multiple_choice` |

**Podcast**: `schemaVersion: 2` y `config { modality: global|revision|apoyo, context, anticipation, showPre, showReview, showCompetencyLabels }`.

**Intento** (`attempts/{id}`): campos antiguos intactos + `schemaVersion:2`, `modality`, `mode` (`alumno`/`grupo`), `hintsUsed`, `competencySummary`, y en cada `details[]`: `qid, competency, secondary, level, levelDerived, evidence, distractorNote, hintUsed`. La clasificación se **copia en el intento** (`null` si estaba sin clasificar o sin revisar), así los informes no cambian si luego se edita la pregunta.

## Migración (sin escribir nada a ciegas)
- Al **leer**, `normalizePodcast` rellena valores por defecto en memoria; los podcasts antiguos siguen funcionando sin recrearlos.
- `facil → inicial`, `inferencia → intermedia` se muestran como **derivados** (no se guardan hasta que el docente guarda la pregunta). La competencia **nunca** se deduce: las antiguas "inferencia" solo muestran una *sugerencia* C2 en el editor.
- Podcasts antiguos con transcripción → modalidad `apoyo` (conservan sus subtítulos y se registra honestamente). Sin transcripción → `global`.
- Los 4 podcasts precargados reciben **propuestas** de clasificación solo para preguntas de dato literal (C1) y dos de inferencia explícita (C2), con `classReviewed:false`; el resto queda pendiente. Las propuestas **no cuentan** en los informes hasta que el docente pulsa "Confirmar clasificaciones propuestas" (o revisa cada pregunta) y guarda. Si el docente ya tocó alguna clasificación, no se sobrescribe nada.
- Intentos antiguos: se atribuyen a una competencia solo si la pregunta (por `qid` o enunciado exacto) tiene clasificación revisada; si no, "sin clasificar".

## Reglas de los informes
- Usa solo el **primer intento** de cada alumno/grupo, podcast y modalidad (repetir el cuestionario no infla los datos); los reintentos se ven en la evolución.
- Siempre se muestra `n`. `n<3` → "datos insuficientes"; 3–5 → orientativo; ≥6 → más fiable. Se distingue "sin evidencia" de "bajo rendimiento".
- Avisos cuando se mezclan modalidades, niveles de dificultad o grupos con alumnado individual.
- Las recomendaciones solo salen con `n≥3` y <60 %, explican el motivo y proponen únicamente podcasts existentes con ≥2 preguntas revisadas de esa competencia; si no hay, indican que el catálogo debe ampliarse.

## Pruebas
```
node tests/pure.test.js                                   # lógica pura (sin dependencias)
JSPDF_PATH=/ruta/node_modules/jspdf JSDOM_PATH=/ruta/node_modules/jsdom node tests/integration.test.js   # app completa con Firestore simulado (JSPDF_PATH activa as probas do caderniño PDF)
```

## Limitaciones y cambios externos
- **Reglas de Firebase**: siguen abiertas (como antes). Los resultados individuales son legibles por cualquiera con la URL de la app. Para protegerlos hay que activar Firebase Authentication y escribir reglas que restrinjan lectura de `attempts` al profesorado; **no se puede resolver solo desde el HTML**. La contraseña de profesor existente sigue siendo solo una barrera de interfaz (no se ha añadido ninguna nueva).
- Los saltos a "fragmentos relevantes" no se han implementado: no hay marcas de tiempo reales en las transcripciones. Sí hay repetir/adelantar 10 s, reiniciar y barra de búsqueda.
- La transcripción se sincroniza por proporción de palabras (aproximado).
- Formatos de respuesta: solo elección múltiple.
- Las validaciones de calidad (longitud, "todas las anteriores", pista que revela la respuesta…) son avisos heurísticos; que la respuesta sea justificable desde el audio sigue requiriendo criterio docente.
- Las propuestas de clasificación de los 4 podcasts precargados deben ser revisadas por el docente.

## Regla para generar preguntas
Cada pregunta nueva debe llevar **una competencia principal (C1–C6)**, un nivel de dificultad, evidencia de aprendizaje y justificación basada en la transcripción real. Cada podcast debe tener **al menos 2 preguntas de cada competencia**. Los 4 podcasts precargados incluyen ya preguntas adicionales (ids `k1…`) para cumplirlo; se añaden una sola vez (`seedExtrasVersion`) y no se tocan las preguntas editadas por el docente. Quedan como *propuesta* hasta que el docente las confirme.

## Estilo das preguntas e caderniño PDF
Ver `docs/estilo-proba-diagnostico.md` (estilo da proba de diagnóstico de 4.º EP aplicado a En Antena e funcionamento do caderniño descargable).
