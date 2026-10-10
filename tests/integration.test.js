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
      if(process.env.JSPDF_PATH){ const J = require(process.env.JSPDF_PATH).jsPDF; w.__saved = []; w.__pdfs = []; w.jspdf = { jsPDF: class extends J { constructor(...a){ super(...a); this.save = n=>{ w.__saved.push(n); w.__pdfs.push(Buffer.from(this.output('arraybuffer'))); }; } } }; }
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
  ok('arranque: la app carga y crea los 8 podcasts precargados', await waitFor(()=>Object.keys(store.podcasts).length === 8 && Object.values(store.podcasts).every(p=>p.schemaVersion===2)));
  const cuba = store.podcasts['seed-un-pais-en-podcast-cuba'];
  ok('semilla Cuba: 55 líneas de transcripción literal conservadas', cuba.transcript.length === 55);
  const cres = cuba.reserveQuestions || [];
  ok('semilla: las preguntas de reserva conservan las originales ambiguas (sin competencia) y no se pierden', cres.length === 7 && cres.filter(q=>q.id==='q7' || q.id==='q8').every(q=>q.competency === null));
  ok('semilla: no se guardan campos derivados (nivel/suggested) en las originales', [...cuba.questions, ...cres].filter(q=>/^q\d+$/.test(q.id)).every(q=>q.levelDerived===undefined && q.suggestedCompetency===undefined && q.level===undefined));

  // Cada podcast precargado: test de 18 preguntas, 3 de cada competencia, ordenadas C1→C6, revisadas y bien formadas
  const seedIds = Object.keys(store.podcasts).filter(id=>id.startsWith('seed-'));
  for(const id of seedIds){
    const p = store.podcasts[id];
    const dist = E(`competencyDistribution(${JSON.stringify(p.questions)})`);
    ok(`test ${id}: 18 preguntas, exactamente 3 de cada competencia C1-C6`, p.questions.length === 18 && ['C1','C2','C3','C4','C5','C6'].every(c=>dist.counts[c] === 3), JSON.stringify(dist.counts));
    ok(`test ${id}: testBalance lo da por equilibrado`, E(`testBalance(${JSON.stringify(p.questions)})`).ok === true);
    ok(`test ${id}: ordenadas por competencia C1→C6 y clasificadas (revisadas)`, p.questions.map(q=>q.competency).join('') === 'C1C1C1C2C2C2C3C3C3C4C4C4C5C5C5C6C6C6' && p.questions.every(q=>q.classReviewed === true));
    ok(`test ${id}: ids únicos y preguntas válidas`, new Set(p.questions.map(q=>q.id)).size === p.questions.length && p.questions.every(q=>q.options.length === 4 && q.options[q.correct] && q.explanation));
    ok(`test ${id}: las etiquetas de competencia están activadas`, p.config.showCompetencyLabels === true);
    ok(`test ${id}: nada se pierde (las que sobran van a reserva sin duplicar ids)`, Array.isArray(p.reserveQuestions) && !p.reserveQuestions.some(r=>p.questions.some(q=>q.id === r.id)));
  }
  const nBefore0 = JSON.stringify(Object.values(store.podcasts).map(p=>p.questions.length));
  await E(`upgradeSeedExtras()`); await E(`upgradeSeedInference()`); await E(`upgradeSeedTest18()`);
  ok('las mejoras no se duplican al recargar', JSON.stringify(Object.values(store.podcasts).map(p=>p.questions.length)) === nBefore0);
  // un podcast ya existente (con 8 originales, una editada por el docente) recibe las mejoras sin tocar lo suyo
  { const c0 = store.podcasts['seed-un-pais-en-podcast-cuba'];
    const originals = [...c0.questions, ...c0.reserveQuestions].filter(q=>/^q\d+$/.test(q.id)).sort((a,b)=>a.id.localeCompare(b.id)).map(q=>q.id==='q2' ? { ...q, text:'EDITADA POR EL DOCENTE' } : q);
    store.podcasts['seed-un-pais-en-podcast-cuba'] = { ...c0, questions: originals, reserveQuestions: undefined };
    delete store.podcasts['seed-un-pais-en-podcast-cuba'].reserveQuestions;
    ['seedExtrasVersion','seedInferenceVersion','seedTestVersion'].forEach(k=>delete store.podcasts['seed-un-pais-en-podcast-cuba'][k]);
    await E(`upgradeSeedExtras()`);
    ok('podcast existente: +9 propuestas y se respeta la edición del docente', store.podcasts['seed-un-pais-en-podcast-cuba'].questions.length === 17 && store.podcasts['seed-un-pais-en-podcast-cuba'].questions.find(q=>q.id==='q2').text === 'EDITADA POR EL DOCENTE');
    await E(`upgradeSeedInference()`); await E(`upgradeSeedTest18()`);
    const cu = store.podcasts['seed-un-pais-en-podcast-cuba'];
    ok('podcast existente: queda en 18 (3 por competencia), la edición del docente se conserva y lo demás va a reserva', cu.questions.length === 18 && cu.questions.find(q=>q.id==='q2').text === 'EDITADA POR EL DOCENTE' && cu.reserveQuestions.length === 7); }

  // Fondo con la bandera del país
  ok('semilla Cuba: lleva país CU', cuba.country === 'CU');
  E(`openPlayer('seed-un-pais-en-podcast-cuba')`);
  await waitFor(()=>activeView()==='view-student-player');
  ok('país: la bandera aparece de fondo en el reproductor', $('#countryBg').classList.contains('show') && $('#countryBg svg') && $('#playerCountry').textContent.includes('Cuba'));
  E(`goHome()`);
  ok('país: el fondo desaparece en la portada', !$('#countryBg').classList.contains('show'));
  E(`openPlayer('seed-ovello-dos-contos')`);
  await waitFor(()=>activeView()==='view-student-player');
  ok('podcast sin país: sin fondo ni insignia', !$('#countryBg').classList.contains('show') && $('#playerCountry').innerHTML === '');
  E(`goHome()`);
  const flagsOk = E(`Object.keys(COUNTRIES)`).filter(k=>['CU','PT','GB','RU','UA'].includes(k)).length === 5;
  ok('banderas de Cuba, Portugal, Reino Unido, Rusia y Ucraína disponibles', flagsOk);

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
  set($('#pTitle'), 'Podcast nuevo'); set($('#pModality'), 'global'); set($('#pCountry'), 'PT'); set($('#pContext'), 'Hablaremos de animales.'); set($('#pAnticipation'), '¿Qué animales conoces?');
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
  ok('editor: guarda el país del podcast', store.podcasts[newId].country === 'PT');
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
  ok('lista docente: muestra todos los podcasts', $$('#teacherPodcastList .podcast-card').length === 10, String($$('#teacherPodcastList .podcast-card').length));
  await E(`cloudSoftDeletePodcast('legacy1')`); ok('papelera: eliminar suave', store.podcasts['legacy1'].deleted === true);
  await E(`cloudRestorePodcast('legacy1')`); ok('papelera: restaurar', store.podcasts['legacy1'].deleted === false);
  await E(`printWorksheet('${newId}', true)`); ok('ficha imprimible con respuestas', $('#printSheet').textContent.includes('Clave de respostas'));
  await E(`renderStudentList()`); await waitFor(()=>$$('#studentPodcastList .podcast-card').length>0);
  ok('lista del alumnado: se muestran podcasts', $$('#studentPodcastList .podcast-card').length >= 5);
  await E(`viewClassification('${newId}')`);
  ok('clasificación: lista a los participantes con su mejor intento', await waitFor(()=>$('#classificationList').textContent.includes('Noa')));

  // ---------- 9. Caderniño PDF ----------
  if(process.env.JSPDF_PATH){
    ok('radio libre: tildes e signos restaurados nas preguntas orixinais', store.podcasts['seed-radio-libre-libros'].questions[0].text.startsWith('¿Quién'));
    ok('caderniño: botón na lista do alumnado', $$('#studentPodcastList button').some(b=>b.textContent.includes('Caderniño PDF')));
    await E(`renderTeacherList()`);
    ok('caderniño: botóns na lista docente (con e sen notas)', $$('#teacherPodcastList button').some(b=>b.textContent.includes('Con notas docentes')) && $$('#teacherPodcastList button').some(b=>b.textContent.includes('Caderniño PDF')));
    for(const id of seedIds){
      w.__saved.length = 0; w.__pdfs.length = 0;
      await E(`downloadBooklet('${id}', false)`); await E(`downloadBooklet('${id}', true)`);
      ok(`caderniño ${id}: descarga alumnado e docente con nome de ficheiro`, w.__saved.length === 2 && w.__saved[0].endsWith('.pdf') && w.__saved[1].endsWith('-docente.pdf'));
      const s0 = w.__pdfs[0].toString('latin1'), s1 = w.__pdfs[1].toString('latin1');
      const pages = s => (s.match(/\/Type \/Page\b/g) || []).length;
      ok(`caderniño ${id}: o do docente ten máis páxinas (notas aparte)`, pages(s1) > pages(s0) && pages(s0) >= 4, pages(s0)+' vs '+pages(s1));
      ok(`caderniño ${id}: o do alumnado non contén a clave`, !s0.includes('NOTAS PARA O DOCENTE') && s1.includes('NOTAS PARA O DOCENTE'));
    }
    w.__saved.length = 0;
    const jsp = w.jspdf; w.jspdf = undefined;
    await E(`downloadBooklet('${seedIds[0]}', false)`);
    ok('caderniño: sen librería PDF avisa sen romper', w.__saved.length === 0 && /PDF/.test(lastToast()));
    w.jspdf = jsp;
  }

  // ---------- 10. Preguntas de inferir (>= 1/3 de cada test) ----------
  for(const id of seedIds){
    const p = store.podcasts[id];
    const inf = p.questions.filter(q=>q.competency === 'C2' || /^i\d+$/.test(q.id));
    ok(`inferencia ${id}: polo menos un terzo das 18 preguntas son de inferir (${inf.length}/18)`, inf.length * 3 >= p.questions.length);
    const mine = p.questions.filter(q=>/^[in]\d+$/.test(q.id));
    ok(`escritas ${id}: con evidencia, xustificación e nota por distractor (${mine.length})`, mine.length >= 8 && mine.every(q=>q.classReviewed === true && q.competency && q.evidence && q.explanation && q.distractors.filter(Boolean).length === 3 && q.distractors[q.correct] === ''));
    const transcript = p.transcript.join(' ').replace(/[«»"“”]/g,'').replace(/\s+/g,' ').toLowerCase();
    const lit = mine.every(q=>q.evidence.split(' / ').every(part=>part.split('...').every(fr=>{ const f = fr.replace(/[«»"“”]/g,'').replace(/\s+/g,' ').trim().replace(/\.$/,'').toLowerCase(); return f.length < 4 || transcript.includes(f); })));
    ok(`escritas ${id}: as citas de evidencia son literais da transcrición`, lit);
    ok(`escritas ${id}: 4 opcións e posición da correcta variada`, mine.every(q=>q.options.length === 4) && new Set(mine.map(q=>q.correct)).size >= 3);
  }

  // ---------- 11. Cuba: nombre Sajani y sin preguntas sobre el padre ----------
  { const raw = JSON.stringify(store.podcasts['seed-un-pais-en-podcast-cuba']);
    ok('Cuba: ya no queda "Sahani" en ningún sitio y el nombre es Sajani', !/sahani/i.test(raw) && raw.includes('Sajani'));
    const mentions = q => /\b(padre|papá|papa)\b/i.test([q.text, ...q.options, q.explanation, q.evidence].join(' '));
    const cc = store.podcasts['seed-un-pais-en-podcast-cuba'];
    ok('Cuba: ninguna pregunta (test ni reserva) menciona al padre', !cc.questions.some(mentions) && !cc.reserveQuestions.some(mentions));
    // documento antiguo ya guardado: con "Sahani" y la pregunta del padre dentro del test
    const old = JSON.parse(JSON.stringify(cc).replace(/Sajani/g, 'Sahani'));
    const dad = { id:'k2', text:'¿Por qué el padre de Sahani salía «protegido»?', options:['Porque había riesgo','Porque hacía frío','Porque iba a una fiesta','Porque era guardia'], correct:0, explanation:'Sahani cuenta que su papá salía protegido.', competency:'C2', secondary:[], level:'intermedia', classReviewed:true, format:'multiple_choice', evidence:'mi papá cada vez que salía', distractors:['','','',''] };
    old.questions = old.questions.filter(q=>q.id !== 'k1').concat([dad]);   // C2: i2, i3, k2 ; k1 en la reserva
    old.reserveQuestions = [...old.reserveQuestions, cc.questions.find(q=>q.id==='k1')];
    delete old.seedCubaFixVersion;
    store.podcasts['seed-un-pais-en-podcast-cuba'] = old;
    await E(`upgradeSeedCubaFix()`);
    const fx = store.podcasts['seed-un-pais-en-podcast-cuba'];
    ok('Cuba (doc antiguo): Sahani→Sajani en transcripción, preguntas y reserva', !/sahani/i.test(JSON.stringify(fx)) && fx.transcript.some(l=>l.includes('Sajani')));
    ok('Cuba (doc antiguo): la pregunta del padre desaparece y se repone otra de C2 (sigue 18, 3 por competencia)', !fx.questions.some(q=>q.id==='k2') && fx.questions.length === 18 && E(`testBalance(${JSON.stringify(fx.questions)})`).ok);
    await E(`upgradeSeedCubaFix()`);
    ok('Cuba: la corrección es idempotente', JSON.stringify(store.podcasts['seed-un-pais-en-podcast-cuba'].questions) === JSON.stringify(fx.questions)); }

  // ---------- 12. Podcast en inglés: Filipinas ----------
  { const ph = store.podcasts['seed-un-pais-en-podcast-filipinas'];
    ok('Filipinas: país PH, 2º ciclo, modalidad con revisión', ph.country === 'PH' && ph.cycle === '2º ciclo' && ph.config.modality === 'revision');
    ok('Filipinas: transcripción con la corrección "Monforte de Lemos" y sin anotaciones editoriales', ph.transcript.some(l=>l.includes('She come to Monforte de Lemos help us learn English')) && !ph.transcript.some(l=>/Morto demos|^\[|^Pregunta:|^Respuesta:/.test(l)) && ph.transcript.length === 34);
    ok('Filipinas: audio enlazado y bandera disponible', E(`SEED_AUDIO_FILES['seed-un-pais-en-podcast-filipinas']`) === 'audio/filipinas_yanni_en_podcast.mp3' && E(`Object.keys(COUNTRIES).includes('PH')`));
    ok('Filipinas: preguntas en inglés sencillo (enunciados cortos y opciones cortas)', ph.questions.every(q=>q.text.split(/\s+/).length <= 16 && q.options.every(o=>o.split(/\s+/).length <= 11)));
    E(`openPlayer('seed-un-pais-en-podcast-filipinas')`); await waitFor(()=>activeView()==='view-student-player');
    ok('Filipinas: la bandera sale de fondo en el reproductor', $('#countryBg').classList.contains('show') && $('#playerCountry').textContent.includes('Filipinas'));
    E(`goHome()`);
    w.__saved.length = 0; await E(`downloadBooklet('seed-un-pais-en-podcast-filipinas', true)`);
    ok('Filipinas: el cuadernillo PDF se genera con 18 preguntas', w.__saved.length === 1 && w.__saved[0].includes('filipinas')); }

  // ---------- 13. Senegal ----------
  { const sn = store.podcasts['seed-un-pais-en-podcast-senegal'];
    ok('Senegal: país SN, bandera y audio enlazados', sn.country === 'SN' && E(`Object.keys(COUNTRIES).includes('SN')`) && E(`SEED_AUDIO_FILES['seed-un-pais-en-podcast-senegal']`) === 'audio/senegal_un_pais_en_podcast.mp3');
    ok('Senegal: 18 preguntas, 3 por competencia, sin verdadero/falso', sn.questions.length === 18 && E(`testBalance(${JSON.stringify(sn.questions)})`).ok && sn.questions.every(q=>q.options.length === 4 && q.format === 'multiple_choice'));
    ok('Senegal: al menos un tercio son de inferir', sn.questions.filter(q=>q.competency === 'C2' || /^i\d+$/.test(q.id)).length >= 6);
    ok('Senegal: sin anotaciones [..] ni preguntas sobre el padre', !sn.transcript.some(l=>/\[|\]/.test(l)) && !sn.questions.some(q=>/\b(pai|padre)\b/i.test(JSON.stringify(q))));
    ok('Senegal: cada cita de evidencia sale literal de la transcrición', sn.questions.every(q=>(q.evidence.match(/«([^»]*)»/g)||[]).every(m=>sn.transcript.join(' ').includes(m.slice(1,-1).replace(/\.$/,'')))));
    w.__saved.length = 0; await E(`downloadBooklet('seed-un-pais-en-podcast-senegal', true)`);
    ok('Senegal: el cuadernillo PDF se genera', w.__saved.length === 1 && w.__saved[0].includes('senegal')); }

  // ---------- 14. Radio Forte: Ramadán ----------
  { const rm = store.podcasts['seed-radio-forte-ramadan'];
    ok('Ramadán: 3º ciclo, audio enlazado y modalidad con revisión', rm.cycle === '3º ciclo' && rm.config.modality === 'revision' && E(`SEED_AUDIO_FILES['seed-radio-forte-ramadan']`) === 'audio/ramadan_radio_forte.mp3');
    ok('Ramadán: 18 preguntas, 3 por competencia, sin verdadero/falso', rm.questions.length === 18 && E(`testBalance(${JSON.stringify(rm.questions)})`).ok && rm.questions.every(q=>q.options.length === 4 && q.format === 'multiple_choice'));
    ok('Ramadán: al menos un tercio son de inferir', rm.questions.filter(q=>q.competency === 'C2' || /^i\d+$/.test(q.id)).length >= 6);
    ok('Ramadán: transcripción sin anotaciones [..] y evidencias literales', !rm.transcript.some(l=>/\[|\]/.test(l)) && rm.questions.every(q=>(q.evidence.match(/«([^»]*)»/g)||[]).every(m=>rm.transcript.join(' ').includes(m.slice(1,-1).replace(/\.$/,'')))));
    w.__saved.length = 0; await E(`downloadBooklet('seed-radio-forte-ramadan', true)`);
    ok('Ramadán: el cuadernillo PDF se genera', w.__saved.length === 1 && w.__saved[0].includes('ramad')); }

  // ---------- 15. Venezuela ----------
  { const ve = store.podcasts['seed-un-pais-en-podcast-venezuela'];
    ok('Venezuela: país VE, bandera y audio enlazados', ve.country === 'VE' && E(`Object.keys(COUNTRIES).includes('VE')`) && E(`SEED_AUDIO_FILES['seed-un-pais-en-podcast-venezuela']`) === 'audio/venezuela_un_pais_en_podcast.mp3');
    ok('Venezuela: 18 preguntas, 3 por competencia, sin verdadero/falso', ve.questions.length === 18 && E(`testBalance(${JSON.stringify(ve.questions)})`).ok && ve.questions.every(q=>q.options.length === 4 && q.format === 'multiple_choice'));
    ok('Venezuela: al menos un tercio son de inferir', ve.questions.filter(q=>q.competency === 'C2' || /^i\d+$/.test(q.id)).length >= 6);
    ok('Venezuela: transcripción sin marcas de tiempo ni [..] y evidencias literales', !ve.transcript.some(l=>/\[|\]|\d\d:\d\d:\d\d/.test(l)) && ve.questions.every(q=>(q.evidence.match(/«([^»]*)»/g)||[]).every(m=>ve.transcript.join(' ').includes(m.slice(1,-1).replace(/\.$/,'')))));
    E(`openPlayer('seed-un-pais-en-podcast-venezuela')`); await waitFor(()=>activeView()==='view-student-player');
    ok('Venezuela: la bandera sale de fondo en el reproductor', $('#countryBg').classList.contains('show') && $('#playerCountry').textContent.includes('Venezuela'));
    E(`goHome()`);
    w.__saved.length = 0; await E(`downloadBooklet('seed-un-pais-en-podcast-venezuela', true)`);
    ok('Venezuela: el cuadernillo PDF se genera', w.__saved.length === 1 && w.__saved[0].includes('venezuela')); }

  const bad = results.filter(r=>!r[1]).length;
  console.log(`\n${results.length - bad} superadas, ${bad} falladas`);
  if(errors.length) console.log('Errores de la página:', errors.slice(0,5));
  process.exit(bad ? 1 : 0);
})().catch(e=>{ console.error('ERROR en la prueba:', e); process.exit(2); });
