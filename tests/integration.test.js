// Pruebas de integración con jsdom y un Firestore falso en memoria.
// Ejecutar: JSDOM_PATH=/ruta/a/node_modules/jsdom node tests/integration.test.js   (o con jsdom instalado: node tests/integration.test.js)
const fs = require('fs'), path = require('path'), A = require('assert');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const clone = o => JSON.parse(JSON.stringify(o));
const store = { podcasts:{}, attempts:{} };
let failWrites = false;
const xlsxCalls = [];
function fakeFirebase(){
  const snap = (name, filter)=>({ docs: Object.entries(store[name]).filter(([id,d])=>!filter || filter(d)).map(([id,d])=>({ id, data:()=>clone(d), ref:{ name, id } })) });
  const col = name => ({
    orderBy: ()=>({ get: async()=>{ const s = snap(name); const k = name==='podcasts' ? 'createdAt' : 'date'; s.docs.sort((a,b)=>(b.data()[k]||0)-(a.data()[k]||0)); return s; } }),
    get: async()=>snap(name),
    where: (f,op,v)=>({ get: async()=>snap(name, d=>d[f]===v),
      onSnapshot: (cb)=>{ cb(snap(name, d=>d[f]===v)); return ()=>{}; } }),
    doc: id=>({
      get: async()=>({ exists: !!store[name][id], id, data:()=>clone(store[name][id]) }),
      set: async d=>{ if(failWrites) throw new Error('offline'); store[name][id] = clone(d); },
      update: async d=>{ if(failWrites) throw new Error('offline'); store[name][id] = { ...store[name][id], ...clone(d) }; },
      delete: async()=>{ delete store[name][id]; }
    })
  });
  return {
    initializeApp: ()=>({}),
    firestore: ()=>({ collection: col, batch: ()=>({ update(){}, delete(){}, commit: async()=>{} }) }),
    storage: ()=>({ ref: ()=>({ child: ()=>({ put: async()=>{}, getDownloadURL: async()=>'http://example.test/audio.mp3' }) }), refFromURL: ()=>({ delete: async()=>{} }) })
  };
}
const results = []; 
function ok(name, cond, extra){ results.push([name, !!cond]); console.log(cond ? '  ok   ' : '  FALLA', name, cond ? '' : (extra||'')); }
const sleep = ms => new Promise(r=>setTimeout(r, ms));
async function waitFor(fn, ms=4000){ const t0 = Date.now(); while(Date.now()-t0 < ms){ try{ if(await fn()) return true; }catch(e){} await sleep(25); } return false; }

(async()=>{
  const vc = new VirtualConsole(); // errores de consola de la página no ensucian la salida
  const errors = []; vc.on('jsdomError', e=>errors.push(e.message));
  const dom = new JSDOM(html, { runScripts:'dangerously', pretendToBeVisual:true, url:'http://localhost/', virtualConsole:vc,
    beforeParse(w){
      w.firebase = fakeFirebase();
      w.XLSX = { utils:{ json_to_sheet: rows=>{ xlsxCalls.push(rows); return {}; }, book_new:()=>({}), book_append_sheet:()=>{} }, writeFile:()=>{} };
      w.HTMLCanvasElement.prototype.getContext = ()=>new Proxy({}, { get:()=>()=>{} , set:()=>true });
      w.Audio = function(){ return { addEventListener(){}, play(){ this.paused = false; return Promise.resolve(); }, pause(){ this.paused = true; }, paused:true, currentTime:0, duration:100, set src(v){}, get src(){return '';} }; };
      w.scrollTo = ()=>{}; w.Element.prototype.scrollIntoView = ()=>{}; w.print = ()=>{};
    }});
  const w = dom.window, d = w.document;
  const $ = s => d.querySelector(s), $$ = s => [...d.querySelectorAll(s)];
  const ev = (el, type)=>el.dispatchEvent(new w.Event(type, { bubbles:true }));
  const set = (el, v)=>{ el.value = v; ev(el,'input'); ev(el,'change'); };
  const E = code => w.eval(code);
  const lastToast = ()=>{ const t = $('#toast') || $('.toast'); return t ? t.textContent : ''; };
  const activeView = ()=>$('.view.active').id;

  // ---------- 1. Arranque y semillas ----------
  ok('arranque: la app carga y crea los 4 podcasts precargados', await waitFor(()=>Object.keys(store.podcasts).length === 4 && Object.values(store.podcasts).every(p=>p.schemaVersion===2)));
  const cuba = store.podcasts['seed-un-pais-en-podcast-cuba'];
  ok('semilla Cuba: 55 líneas de transcripción literal conservadas', cuba.transcript.length === 55);
  ok('semilla: propuesta C1 sin revisar en preguntas de dato literal', cuba.questions[0].competency === 'C1' && cuba.questions[0].classReviewed === false);
  ok('semilla: pregunta ambigua (inferencia) queda PENDIENTE, sin competencia', cuba.questions[6].competency === null && cuba.questions[7].competency === null);
  ok('semilla: no se guardan campos derivados (nivel/suggested)', cuba.questions.every(q=>q.levelDerived===undefined && q.suggestedCompetency===undefined && q.level===undefined));

  // ---------- 2. Podcast antiguo ----------
  store.podcasts['legacy1'] = { createdAt: 5, title:'Antiguo', cycle:'2º ciclo', desc:'d', transcript:['Hola a todos','Adiós'], mimeType:'audio/mpeg', audioURL:'http://example.test/a.mp3',
    questions:[ { id:'a', text:'¿Qué saludo se oye?', options:['Hola','Bos días','Hello','Ciao'], correct:0, difficulty:'facil', explanation:'Se oye "Hola".' },
                { id:'b', text:'¿Cómo se despiden?', options:['Adiós','Hasta luego','Chao','Nos vemos'], correct:0, difficulty:'inferencia' } ] };
  E(`openPlayer('legacy1')`);
  ok('podcast antiguo: se abre el reproductor', await waitFor(()=>activeView()==='view-student-player'));
  ok('podcast antiguo: conserva subtítulos (apoyo textual derivado)', $('#subtitleToggleBtn').style.display !== 'none' && $$('#subtitlePanel .sub-line').length === 2);
  ok('fase A: sin contexto => no hay panel "antes de escuchar"', $('#prePanel').innerHTML === '');
  // identificación solo al responder
  ok('escuchar no pide identificación', activeView() === 'view-student-player');
  E(`requestQuiz()`);
  ok('al pulsar responder aparece la identificación', activeView() === 'view-student-name');
  E(`confirmIdentityAndStartQuiz()`);
  ok('grupo sin curso => no avanza', activeView() === 'view-student-name');
  set($('#sClass'), '3º B'); E(`confirmIdentityAndStartQuiz()`);
  ok('modo Grupo clase => preguntas', activeView() === 'view-student-questions');
  ok('modalidad apoyo: mini-reproductor y transcripción disponibles en el cuestionario', !!$('#quizSupport .mini-player') && !!$('#quizSupport details'));
  E(`selectOption(0,0); selectOption(1,1);`);
  // doble clic en comprobar => un solo intento
  E(`submitAnswers(); submitAnswers();`);
  ok('intento guardado una sola vez pese al doble clic', await waitFor(()=>Object.keys(store.attempts).length === 1));
  const a1 = Object.values(store.attempts)[0];
  ok('intento: guarda modalidad, tipo, grupo y fecha', a1.modality==='apoyo' && a1.mode==='grupo' && a1.studentName==='Grupo 3º B' && a1.className==='3º B' && a1.date > 0);
  ok('intento antiguo: preguntas sin clasificar guardan competencia null (no inventada)', a1.details.every(x=>x.competency === null));
  ok('intento: 1/2 acertos y esquema v2', a1.score === 1 && a1.total === 2 && a1.schemaVersion === 2);
  ok('resumen visible tras guardar', await waitFor(()=>activeView()==='view-student-summary'));
  ok('fase D: panel de revisión con reproductor', !!$('#reviewPanel .mini-player'));
  ok('fase E: muestra explicación de la respuesta correcta', $('#summaryDetail').innerHTML.includes('Se oye'));

  // ---------- 3. Editor: crear podcast nuevo con competencias ----------
  E(`goTeacherEditor()`);
  set($('#pTitle'), 'Podcast nuevo'); set($('#pModality'), 'global'); set($('#pContext'), 'Hablaremos de animales.'); set($('#pAnticipation'), '¿Qué animales conoces?');
  E(`pendingAudio = { name:'n.mp3', type:'audio/mpeg' }`);
  const fillBlock = (b, o)=>{
    set(b.querySelector('.q-text'), o.text);
    o.opts.forEach((t,i)=>set(b.querySelectorAll('.q-opt')[i], t));
    b.querySelectorAll('.q-correct')[o.correct].checked = true; ev(b.querySelectorAll('.q-correct')[o.correct],'change');
    if(o.comp) set(b.querySelector('.q-competency'), o.comp);
    if(o.level) set(b.querySelector('.q-level'), o.level);
    if(o.exp) set(b.querySelector('.q-explanation'), o.exp);
    if(o.hint) set(b.querySelector('.q-hint-input'), o.hint);
    if(o.evidence) set(b.querySelector('.q-evidence'), o.evidence);
    (o.dist||[]).forEach((t,i)=>{ if(t) set(b.querySelectorAll('.q-distractor')[i], t); });
  };
  let blocks = $$('#questionsContainer .question-block');
  fillBlock(blocks[0], { text:'¿Qué animal sale?', opts:['Perro','Gato','Pez','Ave'], correct:1, comp:'C1', level:'inicial', exp:'Dicen "gato".', hint:'Piensa en bigotes', evidence:'Localizar el dato', dist:['Es del otro cuento','','Otro programa',''] });
  // guardar con segunda pregunta SIN competencia => bloqueado
  E(`addQuestionBlock()`);
  blocks = $$('#questionsContainer .question-block');
  fillBlock(blocks[1], { text:'¿Por qué corre?', opts:['Tiene prisa','Por miedo','Por juego','Por sed'], correct:1 });
  const before = Object.keys(store.podcasts).length;
  await E(`savePodcast()`);
  ok('validación: no guarda una pregunta sin competencia principal', Object.keys(store.podcasts).length === before && $('.question-block:nth-child(2) .q-msgs .err'));
  set(blocks[1].querySelector('.q-competency'), 'C2'); set(blocks[1].querySelector('.q-level'), 'avanzada'); set(blocks[1].querySelector('.q-explanation'), 'Se asusta.');
  ok('distribución: cuenta C1=1, C2=1', $('#compDistribution').textContent.includes('C1 · Información explícita: 1') && $('#compDistribution').textContent.includes('C2 · Inferencia e interpretación: 1'));
  // duplicar conserva metadatos
  E(`duplicateQuestionBlock($$('#questionsContainer .question-block')[0].querySelector('.q-tools button'))`.replace('$$','document.querySelectorAll'));
  blocks = $$('#questionsContainer .question-block');
  ok('duplicar: 3 preguntas y la copia conserva competencia, nivel, pista y distractores', blocks.length === 3 && blocks[1].querySelector('.q-competency').value === 'C1' && blocks[1].querySelector('.q-hint-input').value === 'Piensa en bigotes' && blocks[1].querySelectorAll('.q-distractor')[0].value === 'Es del otro cuento' && blocks[1].dataset.qid !== blocks[0].dataset.qid);
  // concentración
  blocks[1].remove(); E(`renumberQuestions(); refreshEditorSummary()`);
  // vista previa
  E(`previewQuiz()`);
  ok('vista previa: renderiza preguntas y botón de pista', $('#previewModal').classList.contains('show') && $$('#previewBody .q-card').length === 2 && $$('#previewBody .hint-btn').length === 1);
  E(`document.getElementById('previewModal').classList.remove('show')`);
  await E(`savePodcast()`);
  const newId = Object.keys(store.podcasts).find(id=>store.podcasts[id].title === 'Podcast nuevo');
  ok('editor: el podcast nuevo se guarda', !!newId, JSON.stringify(Object.keys(store.podcasts)));
  const np = store.podcasts[newId];
  ok('guardado: competencia, nivel, justificación, pista, evidencia y distractores', np.questions[0].competency==='C1' && np.questions[0].level==='inicial' && np.questions[0].explanation==='Dicen "gato".' && np.questions[0].hint==='Piensa en bigotes' && np.questions[0].evidence==='Localizar el dato' && np.questions[0].distractors[0]==='Es del otro cuento' && np.questions[0].classReviewed===true);
  ok('guardado: competencia secundaria/nivel de la 2ª pregunta y config', np.questions[1].competency==='C2' && np.questions[1].level==='avanzada' && np.config.modality==='global' && np.config.context==='Hablaremos de animales.' && np.schemaVersion===2);

  // ---------- 4. Editar sin perder metadatos ----------
  await E(`editPodcast('${newId}')`);
  set($('#pTitle'), 'Podcast nuevo (editado)');
  await E(`savePodcast()`);
  const ed = store.podcasts[newId];
  ok('editar: título cambia y no se pierden preguntas ni metadatos', ed.title.includes('editado') && ed.questions.length === 2 && ed.questions[0].hint==='Piensa en bigotes' && ed.questions[1].competency==='C2' && ed.config.anticipation==='¿Qué animales conoces?');
  // editar un antiguo no borra sus preguntas
  await E(`editPodcast('legacy1')`);
  ok('podcast antiguo en el editor: competencias pendientes + sugerencia C2 solo como aviso', $$('#questionsContainer .q-competency')[0].value==='PEND' && $$('#questionsContainer .hint').some(h=>h.textContent.includes('suxírese C2')));
  ok('podcast antiguo: dificultad derivada marcada para revisión', $$('#questionsContainer .q-level')[0].value==='inicial' && $$('#questionsContainer .hint').some(h=>h.textContent.includes('derivado')));
  await E(`savePodcast()`);
  ok('podcast antiguo guardado conserva 2 preguntas, explicación y sigue sin competencias inventadas', store.podcasts['legacy1'].questions.length===2 && store.podcasts['legacy1'].questions[0].explanation==='Se oye "Hola".' && store.podcasts['legacy1'].questions.every(q=>q.competency===null || q.competency===undefined));

  // ---------- 5. Alumno individual en modalidad global, con pista y distractores ----------
  E(`student = { name:'', className:'', mode:'' }`);
  E(`openPlayer('${newId}')`);
  await waitFor(()=>activeView()==='view-student-player');
  ok('fase A: panel con contexto y pregunta de anticipación', $('#prePanel').textContent.includes('animales') && $('#prePanel').textContent.includes('conoces'));
  ok('modalidad global: sin subtítulos', $('#subtitleToggleBtn').style.display === 'none' && $('#subtitlePanel').style.display === 'none');
  E(`requestQuiz()`);
  E(`setIdentityMode('alumno')`); set($('#sName'), 'Noa'); set($('#sClass'), '3º B');
  E(`confirmIdentityAndStartQuiz()`);
  ok('modalidad global: sin reproductor ni transcripción durante el cuestionario', activeView()==='view-student-questions' && $('#quizSupport').innerHTML === '');
  ok('estudiante no ve etiquetas técnicas C1/C2 por defecto', !/\bC[1-6]\b/.test($('#questionsRunner').textContent));
  E(`showHint(0)`);
  // contesta mal la 1ª (opción distinta de la correcta)
  const q0 = E(`sessionQuestions[0]`); const wrong = [0,1,2,3].find(i=>i !== q0.correct);
  E(`selectOption(0, ${wrong}); selectOption(1, sessionQuestions[1].correct);`);
  await E(`submitAnswers()`);
  await waitFor(()=>Object.keys(store.attempts).length === 2);
  const a2 = Object.values(store.attempts).find(a=>a.studentName==='Noa');
  ok('intento individual: modalidad global, tipo alumno, pista contada', a2 && a2.modality==='global' && a2.mode==='alumno' && a2.hintsUsed===1);
  ok('detalle: la respuesta atribuye la competencia correcta (C1 fallada, C2 acertada)', a2.details.some(x=>x.competency==='C1' && !x.isCorrect) && a2.details.some(x=>x.competency==='C2' && x.isCorrect));
  ok('detalle: guarda nivel, evidencia y pista usada', a2.details.every(x=>x.level) && a2.details.find(x=>x.competency==='C1').hintUsed === true);
  ok('resumen en lenguaje de alumno, sin códigos C1..C6', await waitFor(()=>!/\bC[1-6]\b/.test($('#competencyFeedback').textContent) && $('#competencyFeedback').textContent.includes('Atopar datos')));
  ok('recomendación con pocos datos NO se presenta como diagnóstico', $('#competencyFeedback').textContent.includes('Aínda non hai datos abondo'));
  // distractor tras barajar: la nota corresponde a la opción elegida
  E(`retryQuiz()`);
  const sq = E(`sessionQuestions`).map(q=>({ text:q.text, options:q.options, distractors:q.distractors, correct:q.correct }));
  const idx = sq.findIndex(q=>q.text==='¿Qué animal sale?');
  const q = sq[idx];
  const pick = q.options.findIndex(o=>o==='Perro');
  E(`selectOption(${idx}, ${pick}); selectOption(${1-idx}, sessionQuestions[${1-idx}].correct);`);
  await E(`submitAnswers()`);
  await waitFor(()=>Object.keys(store.attempts).length === 3);
  const a3 = Object.values(store.attempts).find(a=>a.attemptNumber===2 && a.studentName==='Noa');
  ok('barajado: la explicación del distractor sigue a su opción ("Perro" => "Es del otro cuento")', a3.details.find(x=>x.text==='¿Qué animal sale?').distractorNote === 'Es del otro cuento');

  // ---------- 6. Errores de conexión ----------
  E(`student = { name:'Noa', className:'3º B', mode:'alumno' }`);
  E(`goToQuestions()`);
  E(`selectOption(0, sessionQuestions[0].correct); selectOption(1, sessionQuestions[1].correct);`);
  failWrites = true;
  await E(`submitAnswers()`);
  ok('sin conexión: NO se presenta como guardado y se avisa claramente', await waitFor(()=>!!$('#saveStatus .save-warn')) && Object.keys(store.attempts).length === 3);
  failWrites = false;
  await E(`retrySaveAttempt()`); await E(`retrySaveAttempt()`);
  ok('reintento de guardado: se guarda y no duplica (mismo id)', Object.keys(store.attempts).length === 4);
  failWrites = true;
  const nBefore = Object.keys(store.podcasts).length;
  await E(`editPodcast('${newId}')`); set($('#pTitle'), 'No debería guardarse');
  await E(`savePodcast()`);
  failWrites = false;
  ok('error al guardar podcast: no cambia nada y avisa con un mensaje comprensible', store.podcasts[newId].title.includes('editado') && lastToast().includes('NON se gardou'), lastToast());

  // ---------- 7. Informes ----------
  await E(`goReportView()`);
  await waitFor(()=>$('#repByComp table'));
  ok('informe: tabla por competencia con n y sin porcentaje engañoso', !!$('#repByComp table') && $('#repByComp').textContent.includes('Datos insuficientes'));
  ok('informe: avisa de modalidades distintas (apoyo + global)', $('#repNotices').textContent.includes('modalidades distintas'));
  ok('informe: avisa de que usa el primer intento', $('#repNotices').textContent.includes('primeiro intento'));
  set($('#repModality'), 'global');
  ok('filtro por modalidad: ya no avisa de mezcla', !$('#repNotices').textContent.includes('modalidades distintas'));
  set($('#repStudent'), 'Noa');
  const rowsC1 = [...$$('#repByComp tbody tr')].find(tr=>tr.textContent.trim().startsWith('C1'));
  ok('informe: C1 de Noa = 0/1 pregunta, indicador "datos insuficientes" (n=1)', rowsC1 && rowsC1.children[1].textContent.trim() === '1' && rowsC1.children[2].textContent.trim() === '0' && rowsC1.textContent.includes('Datos insuficientes'), rowsC1 && rowsC1.textContent);
  E(`openStudentCard(0)`);
  ok('ficha de alumno: evolución, recomendaciones y aviso de orientación', $('#repStudentCard').style.display==='block' && $('#repStudentCard').textContent.includes('Evolución entre intentos') && $('#repStudentCard').textContent.includes('non diagnósticos'));
  ok('ficha: separa ausencia de evidencia de bajo rendimiento', $('#repStudentCard').textContent.includes('Sen datos suficientes'));
  set($('#repStudent'), 'all'); set($('#repModality'), 'all'); set($('#repComp'), 'C2');
  ok('filtro por competencia: solo una fila', $$('#repByComp tbody tr').length === 2); // C2 + "sin clasificar"
  set($('#repComp'), 'all');
  set($('#repFrom'), '2999-01-01');
  ok('filtro por fecha futura: sin datos', $('#repByComp').textContent.includes('Non hai intentos'));
  set($('#repFrom'), '');
  // exportación
  xlsxCalls.length = 0;
  await E(`exportReportToExcel()`);
  ok('exportación del informe: incluye modalidad, tipo y competencia', xlsxCalls.length === 2 && 'Modalidade de escoita' in xlsxCalls[0][0] && 'Tipo' in xlsxCalls[0][0] && xlsxCalls[1].some(r=>'Competencia' in r && String(r['Competencia']).startsWith('C1')));
  xlsxCalls.length = 0;
  await E(`renderResults()`);
  await E(`exportResultsToExcel()`);
  ok('exportación clásica de resultados con campos nuevos', xlsxCalls.length === 2 && 'Modalidade de escoita' in xlsxCalls[0][0]);
  ok('exportación: % solo con n>=3 (si no, "datos insuficientes")', xlsxCalls[1].every(r=>typeof r['% acertos']==='string' ? r['% acertos']==='datos insuficientes' : r.Preguntas >= 3));

  // ---------- 8. Regresión de funciones docentes ----------
  await E(`renderTeacherList()`);
  ok('lista docente: muestra todos los podcasts', $$('#teacherPodcastList .podcast-card').length === 6, String($$('#teacherPodcastList .podcast-card').length));
  await E(`cloudSoftDeletePodcast('legacy1')`); ok('papelera: eliminar suave', store.podcasts['legacy1'].deleted === true);
  await E(`cloudRestorePodcast('legacy1')`); ok('papelera: restaurar', store.podcasts['legacy1'].deleted === false);
  await E(`printWorksheet('${newId}', true)`); ok('ficha imprimible con respuestas', $('#printSheet').textContent.includes('Clave de respostas'));
  await E(`renderStudentList()`); await waitFor(()=>$$('#studentPodcastList .podcast-card').length>0);
  ok('lista del alumnado: se muestran podcasts', $$('#studentPodcastList .podcast-card').length >= 5);
  await E(`viewClassification('${newId}')`);
  ok('clasificación: lista a los participantes con su mejor intento', await waitFor(()=>$('#classificationList').textContent.includes('Noa')));

  const bad = results.filter(r=>!r[1]).length;
  console.log(`\n${results.length - bad} superadas, ${bad} falladas`);
  if(errors.length) console.log('Errores de la página:', errors.slice(0,5));
  process.exit(bad ? 1 : 0);
})().catch(e=>{ console.error('ERROR en la prueba:', e); process.exit(2); });
