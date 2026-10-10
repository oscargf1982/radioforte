// Pruebas de la lógica pura (sin DOM). Ejecutar: node tests/pure.test.js
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.split('/*PURE-START*/')[1].split('/*PURE-END*/')[0];
const api = new Function(src + `
return { COMP_IDS, COMPETENCIES, normalizeQuestion, normalizePodcast, validateQuestion, competencyDistribution,
  resolveDetailMeta, firstAttempts, computeCompetencyStats, competencyStatus, reliabilityOf, recommendPractice,
  attemptCompetencyRows, attemptModality, attemptKind, levelsAreMixed, legacyLevel, testBalance, TEST_TOTAL };`)();
const A = require('assert');
let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); pass++; console.log('  ok  ', name); }catch(e){ fail++; console.log('  FALLA', name, '\n       ', e.message); } }

/* 1. Podcast antiguo sin competencias */
t('podcast antiguo se normaliza sin perder datos y sin inventar competencia', ()=>{
  const old = { id:'p1', title:'Viejo', transcript:['a','b'], questions:[
    { id:'q1', text:'¿Quién?', options:['a','b','c','d'], correct:1, difficulty:'facil', explanation:'porque' },
    { id:'q2', text:'¿Por qué?', options:['a','b','c','d'], correct:0, difficulty:'inferencia' } ] };
  const p = api.normalizePodcast(old);
  A.strictEqual(p.questions.length, 2);
  A.strictEqual(p.questions[0].text, '¿Quién?'); A.strictEqual(p.questions[0].correct, 1); A.strictEqual(p.questions[0].explanation, 'porque');
  A.strictEqual(p.questions[0].competency, null);               // no se inventa
  A.strictEqual(p.questions[1].competency, null);
  A.strictEqual(p.questions[1].suggestedCompetency, 'C2');      // solo sugerencia
  A.strictEqual(p.questions[0].level, 'inicial'); A.strictEqual(p.questions[0].levelDerived, true);
  A.strictEqual(p.questions[1].level, 'intermedia');
  A.strictEqual(p.config.modality, 'apoyo');                    // tenía transcripción => se conserva el apoyo textual
  A.strictEqual(old.questions[0].competency, undefined);        // no muta el original
});
t('podcast antiguo sin transcripción => modalidad global', ()=>{
  A.strictEqual(api.normalizePodcast({ id:'x', questions:[] }).config.modality, 'global');
});
t('competencia inválida o sin revisar no cuenta como revisada', ()=>{
  A.strictEqual(api.normalizeQuestion({ options:[], competency:'C9', classReviewed:true }).competency, null);
  A.strictEqual(api.normalizeQuestion({ options:[], competency:'C1' }).classReviewed, false);
  A.strictEqual(api.normalizeQuestion({ options:[], competency:'C1', classReviewed:true }).classReviewed, true);
});
t('dificultad nueva explícita prevalece sobre la antigua', ()=>{
  const q = api.normalizeQuestion({ options:[], difficulty:'facil', level:'avanzada' });
  A.strictEqual(q.level, 'avanzada'); A.strictEqual(q.levelDerived, false);
});

/* 2. Validación */
const good = { text:'¿Dónde?', options:['Lugo','Vigo','Ourense','Pontevedra'], correct:0, competency:'C1', secondary:[], level:'inicial', reviewed:true, explanation:'lo dice el audio' };
t('pregunta válida no tiene errores', ()=>A.deepStrictEqual(api.validateQuestion(good).errors, []));
t('falta competencia => error; pendiente => permitido', ()=>{
  A.ok(api.validateQuestion({ ...good, competency:null }).errors.length > 0);
  A.deepStrictEqual(api.validateQuestion({ ...good, competency:null, pending:true }).errors, []);
});
t('menos de 3 opciones, correcta vacía y repetidas => error', ()=>{
  A.ok(api.validateQuestion({ ...good, options:['a','b','',''] }).errors.some(e=>/3 opci/.test(e)));
  A.ok(api.validateQuestion({ ...good, correct:3, options:['a','b','c',''] }).errors.length > 0);
  A.ok(api.validateQuestion({ ...good, options:['a','A','c','d'] }).errors.some(e=>/repetidas/.test(e)));
  A.ok(api.validateQuestion({ ...good, correct:null }).errors.length > 0);
});
t('avisos: opción correcta mucho más larga, pista que revela, sin justificación', ()=>{
  const long = api.validateQuestion({ ...good, options:['Esta es la respuesta correcta y es larguísima','No','Sí','Tal vez'] });
  A.ok(long.warnings.some(w=>/lonxitude/.test(w)));
  A.ok(api.validateQuestion({ ...good, options:['Monforte de Lemos','Vigo','Ourense','Pontevedra'], hint:'es Monforte de Lemos' }).warnings.some(w=>/pista/.test(w)));
  A.ok(api.validateQuestion({ ...good, explanation:'' }).warnings.some(w=>/xustificación/.test(w)));
});

/* 3. Distribución y concentración */
t('distribución cuenta por competencia y avisa de concentración', ()=>{
  const qs = [ ...Array(4).fill({ competency:'C1', classReviewed:true }), { competency:'C2', classReviewed:true }, { competency:null } ];
  const d = api.competencyDistribution(qs);
  A.strictEqual(d.counts.C1, 4); A.strictEqual(d.counts.C2, 1); A.strictEqual(d.pending, 1); A.strictEqual(d.classified, 5);
  A.ok(d.warning && /C1/.test(d.warning));
  A.strictEqual(api.competencyDistribution([{competency:'C1',classReviewed:true},{competency:'C1',classReviewed:true}]).warning, null); // pocas preguntas: sin aviso
});

/* 4. Atribución y porcentajes */
const pod = { id:'p', questions:[
  { id:'q1', text:'T1', competency:'C1', classReviewed:true, level:'inicial' },
  { id:'q2', text:'T2', competency:'C2', classReviewed:false, level:'intermedia' },
  { id:'q3', text:'T3', competency:null } ] };
const mk = (id, name, date, details, extra={})=>({ id, studentName:name, className:'3A', podcastId:'p', date, modality:'global', details, ...extra });
t('respuesta correcta se atribuye a la competencia adecuada (snapshot)', ()=>{
  const a = mk('a1','Noa',1,[ {competency:'C1',level:'inicial',isCorrect:true}, {competency:'C1',level:'inicial',isCorrect:false}, {competency:'C4',level:'avanzada',isCorrect:true} ]);
  const s = api.computeCompetencyStats([a], { p:pod });
  A.strictEqual(s.byComp.C1.n, 2); A.strictEqual(s.byComp.C1.correct, 1);
  A.strictEqual(s.byComp.C4.n, 1); A.strictEqual(s.byComp.C4.correct, 1); A.strictEqual(s.byComp.C4.levels.avanzada, 1);
  A.strictEqual(s.byComp.C2.n, 0);
});
t('preguntas sin clasificar o sin revisar NO se cuentan en ninguna competencia', ()=>{
  const a = mk('a1','Noa',1,[ {text:'T2',qid:'q2',isCorrect:true}, {text:'T3',qid:'q3',isCorrect:true}, {competency:null,isCorrect:false} ]);
  const s = api.computeCompetencyStats([a], { p:pod });
  A.strictEqual(api.COMP_IDS.reduce((n,c)=>n+s.byComp[c].n,0), 0);
  A.strictEqual(s.unclassified.n, 3); A.strictEqual(s.total.n, 3);
});
t('intento antiguo se resuelve por id/enunciado solo si la clasificación está revisada', ()=>{
  const a = mk('a1','Noa',1,[ {text:'T1',isCorrect:true}, {qid:'q2',text:'otro',isCorrect:true} ]);
  const s = api.computeCompetencyStats([a], { p:pod });
  A.strictEqual(s.byComp.C1.n, 1);        // q1 revisada
  A.strictEqual(s.byComp.C2.n, 0);        // q2 sin revisar
  A.strictEqual(s.unclassified.n, 1);
});
t('un intento hecho con la pregunta sin revisar se atribuye cuando el docente la confirma después', ()=>{
  const a = mk('a1','Noa',1,[ {qid:'q1',text:'T1',competency:null,isCorrect:true}, {qid:'q2',text:'T2',competency:null,isCorrect:true} ]);
  const s = api.computeCompetencyStats([a], { p:pod });
  A.strictEqual(s.byComp.C1.n, 1); A.strictEqual(s.byComp.C2.n, 0); A.strictEqual(s.unclassified.n, 1);
});
t('porcentajes y fiabilidad: n<3 insuficiente, 3-5 orientativo, >=6 fiable', ()=>{
  A.strictEqual(api.competencyStatus({n:0,correct:0}).key, 'sin_evidencia');
  A.strictEqual(api.competencyStatus({n:2,correct:2}).key, 'insuficiente');  // 100 % con 2 preguntas NO es dominio
  A.strictEqual(api.competencyStatus({n:2,correct:2}).pct, null);
  const o = api.competencyStatus({n:4,correct:3}); A.strictEqual(o.pct, 75); A.strictEqual(o.rel, 'orientativo'); A.strictEqual(o.key, 'progreso');
  A.strictEqual(api.competencyStatus({n:6,correct:5}).key, 'consolidada');
  A.strictEqual(api.competencyStatus({n:5,correct:2}).key, 'practica');
  A.strictEqual(api.competencyStatus({n:5,correct:2}).pct, 40);
});
t('solo cuenta el primer intento por alumno, podcast y modalidad', ()=>{
  const a1 = mk('a1','Noa',10,[{competency:'C1',isCorrect:false}], {attemptNumber:1});
  const a2 = mk('a2','Noa',20,[{competency:'C1',isCorrect:true}], {attemptNumber:2});
  const a3 = mk('a3','Noa',30,[{competency:'C1',isCorrect:true}], {modality:'apoyo'});
  const f = api.firstAttempts([a2,a1,a3]).map(a=>a.id).sort();
  A.deepStrictEqual(f, ['a1','a3']);
});
t('modalidad y tipo se conservan; sin dato se marca como tal', ()=>{
  A.strictEqual(api.attemptModality({modality:'revision'}), 'revision');
  A.strictEqual(api.attemptModality({}), 'sin_dato');
  A.strictEqual(api.attemptKind({mode:'grupo'}), 'grupo');
  A.strictEqual(api.attemptKind({}), 'sin_dato');
});
t('mezcla de niveles se detecta', ()=>{
  A.strictEqual(api.levelsAreMixed({inicial:2,intermedia:0,avanzada:0,sin_nivel:3}), false);
  A.strictEqual(api.levelsAreMixed({inicial:2,intermedia:1,avanzada:0,sin_nivel:0}), true);
});

/* 5. Recomendaciones */
t('recomendación solo con datos suficientes, con motivo, y sin inventar actividades', ()=>{
  const by = {}; api.COMP_IDS.forEach(c=>by[c]={n:0,correct:0,levels:{}});
  by.C2 = {n:4,correct:1,levels:{}}; by.C1 = {n:2,correct:0,levels:{}}; by.C3 = {n:6,correct:6,levels:{}};
  const pods = [ { id:'x', title:'Con C2', questions:[{competency:'C2',classReviewed:true},{competency:'C2',classReviewed:true}] },
                 { id:'y', title:'Sin revisar', questions:[{competency:'C2',classReviewed:false},{competency:'C2',classReviewed:false}] } ];
  const r = api.recommendPractice(by, pods, []);
  A.strictEqual(r.length, 1);                 // C1 (n=2) no genera recomendación; C3 va bien
  A.strictEqual(r[0].comp, 'C2'); A.ok(/1 acertos en 4/.test(r[0].reason));
  A.deepStrictEqual(r[0].podcasts.map(p=>p.id), ['x']);   // solo clasificaciones revisadas
  const none = api.recommendPractice(by, [], []);
  A.strictEqual(none[0].catalogGap, true); A.deepStrictEqual(none[0].podcasts, []);
});

/* 6. Exportación por competencia */
t('filas por competencia de un intento', ()=>{
  const a = mk('a1','Noa',1,[ {competency:'C1',isCorrect:true},{competency:'C1',isCorrect:false},{competency:null,isCorrect:true} ]);
  const r = api.attemptCompetencyRows(a, { p:pod });
  A.deepStrictEqual(r.C1, {n:2,correct:1}); A.deepStrictEqual(r.SEN_CLASIFICAR, {n:1,correct:1});
});

t('testBalance: solo es correcto con 18 preguntas, 3 de cada competencia', ()=>{
  const mk = (c,n)=>Array.from({length:n},()=>({competency:c}));
  const ok = [].concat(...['C1','C2','C3','C4','C5','C6'].map(c=>mk(c,3)));
  A.strictEqual(api.testBalance(ok).ok, true); A.strictEqual(api.TEST_TOTAL, 18);
  const off = ok.slice(0,17).concat([{competency:'C1'}]);        // C1 x4, C6 x2
  const b = api.testBalance(off); A.strictEqual(b.ok, false); A.deepStrictEqual(b.off.sort(), ['C1','C6']);
  A.strictEqual(api.testBalance(ok.concat([{competency:null}])).ok, false);   // 19 y una sin competencia
  A.strictEqual(api.testBalance([]).ok, false);
});

console.log(`\n${pass} superadas, ${fail} falladas`);
process.exit(fail ? 1 : 0);
