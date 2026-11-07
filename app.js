/* Fiches du labo : appli web installable, recettes stockées dans Supabase. */
'use strict';
const CFG = window.FDL_CONFIG || {};
const BASE_CATS = ['Entremets','Verrines','Bases','Glaçages'];
let RECIPES = [], byId = {};
let SB = null, USER = null, editable = false, loadState = 'loading';
let editing = null;
let URLS = {};   // 'sb:chemin' -> {u: url signée, x: expiration}

/* ---------- Outils ---------- */
const $ = (s,el=document)=>el.querySelector(s);
const esc = s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const num = v=>{const n=parseFloat(String(v==null?'':v).replace(/\s/g,'').replace(',','.'));return isFinite(n)?n:0};
const fmt = n=>{ if(n==null||!isFinite(n)) return '—'; const a=Math.abs(n);
  if(a>=20) return Math.round(n).toLocaleString('fr-FR');
  return (Math.round(n*10)/10).toLocaleString('fr-FR',{maximumFractionDigits:1}); };
const fmtF = f=>isFinite(f)?'×'+(Math.round(f*100)/100).toLocaleString('fr-FR',{maximumFractionDigits:2}):'×—';
const norm = s=>String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
const fullName = r=>r.name+(r.variant?' ('+r.variant+')':'');
const uid = ()=>Math.random().toString(36).slice(2,8);
const uuid = ()=> (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+uid()+uid());
const slug = s=>norm(s).replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'recette';
const store={get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}},del(k){try{localStorage.removeItem(k)}catch(e){}}};
let checked = new Set(store.get('fiches.checked',[]));
const saveChecked = ()=>store.set('fiches.checked',[...checked]);
URLS = store.get('fiches.urls',{});
const photoSrc = p=>{ if(typeof p!=='string') return ''; if(p.startsWith('sb:')){ const e=URLS[p]; return e&&e.x>Date.now()?e.u:''; } return ''; };
const photoTag = (p,alt,extra='')=>`<img data-photo="${esc(p)}" src="${esc(photoSrc(p))}" alt="${esc(alt||'')}" ${extra}>`;
function toast(msg,ms=3500){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>t.hidden=true,ms); }
const online = ()=>navigator.onLine!==false;
function needOnline(){ if(online()) return true; toast('Hors connexion : reconnectez-vous à internet pour enregistrer.'); return false; }

const compBase = c=>(c.ing||[]).reduce((s,i)=>s+(i.u==='g'&&i.q?i.q:0),0);
const totalBase = r=>r.comps.reduce((s,c)=>s+compBase(c),0);
const compById = (r,id)=>r.comps.find(c=>c.id===id);
const yieldLabel = r=>{ const y=r.yield; if(!y) return 'Fiche de base'; if(y.type==='units') return y.label; return y.formats.map(f=>f.label).join(' · '); };
function catsOrder(){ const extra=[...new Set(RECIPES.map(r=>r.cat))].filter(c=>!BASE_CATS.includes(c)).sort((a,b)=>a.localeCompare(b,'fr')); return [...BASE_CATS,...extra]; }

/* ---------- Données ---------- */
function sanitize(id,d){
  const r = {id, name:String(d.name||'Sans nom'), variant:d.variant||'', cat:String(d.cat||'Autres'),
    photos:Array.isArray(d.photos)?d.photos.filter(p=>typeof p==='string'):[], notes:Array.isArray(d.notes)?d.notes:[], refs:Array.isArray(d.refs)?d.refs:[],
    journal:(Array.isArray(d.journal)?d.journal:[]).filter(j=>j&&j.t).map(j=>({t:String(j.t),at:num(j.at)})),
    comps:(Array.isArray(d.comps)?d.comps:[]).map((c,ci)=>({id:c.id||('c'+ci), name:c.name||'Composant', group:c.group||'', note:c.note||'',
      ing:(Array.isArray(c.ing)?c.ing:[]).map(i=>({n:String(i.n||''), q:(i.q==null||i.q==='')?null:num(i.q), u:i.u||'g', inter:!!i.inter, note:i.note||''}))}))};
  const y=d.yield;
  if(y&&y.type==='units'&&num(y.base)>0) r.yield={type:'units',base:num(y.base),unit:y.unit||'unités',one:y.one||y.unit||'unité',label:y.label||(y.base+' '+(y.unit||'unités'))};
  else if(y&&y.type==='formats'&&Array.isArray(y.formats)&&y.formats.length){
    const ids=(y.mousse||[]).filter(id=>r.comps.some(c=>c.id===id));
    r.yield={type:'formats',what:y.what||'préparation',mousse:ids.length?ids:r.comps.map(c=>c.id),formats:y.formats.map((f,i)=>({id:f.id||('f'+i),label:f.label||'Format',per:num(f.per)||1,mass:num(f.mass)}))};
  }
  return r;
}
function toStored(r){ // fiche telle qu'enregistrée (sans l'id)
  const d={name:r.name, cat:r.cat, photos:r.photos, notes:r.notes, refs:r.refs, journal:r.journal,
    comps:r.comps.map(c=>{ const o={id:c.id,name:c.name,ing:c.ing.map(i=>{ const x={n:i.n,q:i.q,u:i.u}; if(i.inter)x.inter=1; if(i.note)x.note=i.note; return x; })}; if(c.group)o.group=c.group; if(c.note)o.note=c.note; return o; })};
  if(r.variant) d.variant=r.variant; if(r.yield) d.yield=r.yield; return d;
}
function setRecipes(rows){
  RECIPES = rows.map(x=>sanitize(x.id,x.data||{}));
  byId = Object.fromEntries(RECIPES.map(r=>[r.id,r]));
}
let lastLoad=0;
async function loadRecipes(){
  if(!SB||!USER) return;
  lastLoad=Date.now();
  const {data,error} = await SB.from('recettes').select('id,data,updated_at').not('id','like','prod:%').not('id','like','meta:%');
  if(error){ if(!RECIPES.length) loadState = online()?'error':'offline'; renderAll(); return; }
  const prevShown = shown && shown.id;
  setRecipes(data);
  store.set('fiches.cache',{user:USER.id, at:Date.now(), rows:data});
  loadState='ready';
  if(prevShown && byId[prevShown] && shown && JSON.stringify(toStored(byId[prevShown]))===JSON.stringify(toStored(shown))){ shown=byId[prevShown]; renderList(); }
  else renderAll();
  resolveUrls();
  applyFixes();
}
/* Corrections ponctuelles des fiches, appliquées une seule fois pour tout le compte. */
const FIXES = [
  {id:'2026-11-07-tiramisu-sublime-piedmont', run(){
    const out=[];
    const order=(rid,idx)=>{ const r=byId[rid]; if(r&&r.photos.length===4){ const d=toStored(r); d.photos=idx.map(i=>r.photos[i]); out.push([rid,d]); } };
    order('tiramisu-cadres',[2,3,0,1]); order('tiramisu-verrines',[3,2,1,0]);
    const s=byId['sublime']; if(s && !s.refs.some(x=>x.id==='glacage-miroir-noir')){ const d=toStored(s); d.refs=[...s.refs,{label:'Glaçage miroir noir',id:'glacage-miroir-noir'}]; out.push(['sublime',d]); }
    const p=byId['piedmont']; if(p){ const d=toStored(p); d.refs=[{label:'Dacquoise noisette / amande',id:'dacquoise'}, ...p.refs.filter(x=>x.id!=='dacquoise' && !/succ[eè]s/i.test(x.label))]; out.push(['piedmont',d]); }
    return out; }},
];
let fixing=false;
async function applyFixes(){
  if(fixing||!editable||!online()||!RECIPES.length) return;
  fixing=true;
  try{
    const {data,error}=await SB.from('recettes').select('id,data').eq('id','meta:fixes');
    if(error) return;
    const done=(data&&data[0]&&data[0].data&&data[0].data.applied)||[];
    const todo=FIXES.filter(f=>!done.includes(f.id)); if(!todo.length) return;
    for(const f of todo){ for(const [rid,doc] of f.run()) await saveRecipe(rid,doc); done.push(f.id); }
    await SB.from('recettes').upsert({id:'meta:fixes', data:{applied:done}, updated_at:new Date().toISOString()});
    renderAll(); resolveUrls();
  }catch(_){ } finally{ fixing=false; }
}
async function saveRecipe(id, doc){
  const {error} = await SB.from('recettes').upsert({id, data:doc, updated_at:new Date().toISOString()});
  if(error) throw error;
  const r = sanitize(id,doc); const i = RECIPES.findIndex(x=>x.id===id);
  if(i>=0) RECIPES[i]=r; else RECIPES.push(r); byId[id]=r;
  store.set('fiches.cache',{user:USER.id, at:Date.now(), rows:RECIPES.map(x=>({id:x.id,data:toStored(x)}))});
  return r;
}
async function resolveUrls(){
  if(!SB||!USER||!online()) return;
  const now=Date.now(), need=new Set();
  const all=[...RECIPES.flatMap(r=>r.photos), ...(editing?editing.draft.photos:[])];
  for(const p of all) if(p.startsWith('sb:') && !(URLS[p]&&URLS[p].x>now+86400000)) need.add(p);
  const list=[...need];
  for(let i=0;i<list.length;i+=100){
    const chunk=list.slice(i,i+100);
    const {data,error} = await SB.storage.from('photos').createSignedUrls(chunk.map(p=>p.slice(3)), 7*86400);
    if(error||!data) continue;
    data.forEach(d=>{ if(d.signedUrl) URLS['sb:'+d.path]={u:d.signedUrl, x:now+7*86400000-60000}; });
  }
  store.set('fiches.urls',URLS);
  document.querySelectorAll('img[data-photo]').forEach(img=>{ const u=photoSrc(img.dataset.photo); if(u && img.getAttribute('src')!==u) img.src=u; });
}

/* ---------- Connexion ---------- */
async function boot(){
  if(!CFG.supabaseUrl || /COLLER/.test(CFG.supabaseUrl) || !window.supabase){
    loadState='setup'; showApp(false); $('#login').hidden=false;
    $('#login-form').hidden=true; $('#setup-msg').hidden=false; return;
  }
  SB = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {auth:{persistSession:true, autoRefreshToken:true}});
  const {data:{session}} = await SB.auth.getSession();
  SB.auth.onAuthStateChange((ev,s)=>{ if(ev==='SIGNED_OUT'){ USER=null; signedOut(); } });
  if(session && session.user) signedIn(session.user); else signedOut();
}
function showApp(on){ $('#app').hidden=!on; $('#login').hidden=on; }
function signedIn(user){
  USER=user; editable=true;
  showApp(true); $('#addbar').hidden=false; $('#acct').hidden=false; $('#who').textContent=user.email||'';
  const c=store.get('fiches.cache',null);
  if(c && c.user===user.id){ setRecipes(c.rows||[]); loadState=online()?'loading':'ready'; }
  renderAll();
  if(online()){ loadRecipes(); flushPending(); } else { loadState='ready'; renderAll(); toast('Hors connexion : vous consultez la dernière version enregistrée.'); }
}
function signedOut(){
  editable=false; RECIPES=[]; byId={}; shown=null; editing=null;
  store.del('fiches.cache'); store.del('fiches.urls'); URLS={};
  showApp(false); $('#login-form').hidden=false; $('#setup-msg').hidden=true;
}
$('#login-form').addEventListener('submit',async e=>{
  e.preventDefault(); const err=$('#login-err'); err.textContent='';
  if(!online()){ err.textContent='Connectez-vous à internet pour la première connexion.'; return; }
  const btn=$('#login-btn'); btn.disabled=true; btn.textContent='Connexion…';
  const {data,error} = await SB.auth.signInWithPassword({email:$('#login-email').value.trim(), password:$('#login-pass').value});
  btn.disabled=false; btn.textContent='Se connecter';
  if(error){ err.textContent = /invalid/i.test(error.message)?'Email ou mot de passe incorrect.':'Connexion impossible : '+error.message; return; }
  $('#login-pass').value=''; signedIn(data.user);
});
$('#btn-logout').addEventListener('click',async()=>{ await SB.auth.signOut(); signedOut(); });

/* ---------- Index ---------- */
function renderList(){
  const q = norm($('#q').value.trim());
  const cur = shown && shown.id;
  if(!RECIPES.length){
    const msg = {loading:'Chargement des recettes…', offline:'Hors connexion. Vos recettes s’afficheront dès le retour de la connexion.',
      error:'Les recettes ne peuvent pas être chargées. Vérifiez la connexion puis rouvrez l’appli.',
      ready:'Aucune recette pour l’instant. Pour reprendre vos fiches, utilisez « Restaurer une sauvegarde » en bas de cette colonne. Vous pouvez aussi ajouter une recette ou importer une fiche Word.'}[loadState]||'';
    $('#list').innerHTML = `<p class="empty">${esc(msg)}</p>`;
    $('#count').textContent = loadState==='ready'?'0 fiche':'';
    return;
  }
  $('#count').textContent = `${RECIPES.length} fiches`+(!online()?' · hors connexion':'');
  let html='';
  for(const cat of catsOrder()){
    const items = RECIPES.filter(r=>r.cat===cat && (!q || norm(fullName(r)).includes(q) || r.comps.some(c=>norm(c.name).includes(q)||c.ing.some(i=>norm(i.n).includes(q)))))
      .sort((a,b)=>fullName(a).localeCompare(fullName(b),'fr'));
    if(!items.length) continue;
    html += `<div class="cat"><h2><span>${esc(cat)}</span><span>${items.length}</span></h2>`+items.map(r=>{
      const th = r.photos[0] ? photoTag(r.photos[0],'','class="thumb" loading="lazy"') : `<span class="thumb">${esc(r.name[0]||'?')}</span>`;
      return `<a class="item" href="#${esc(r.id)}" aria-current="${r.id===cur}">${th}<span><b>${esc(fullName(r))}</b><small>${esc(yieldLabel(r))}</small></span></a>`;
    }).join('')+`</div>`;
  }
  $('#list').innerHTML = html || `<p class="empty">Aucune recette ne contient « ${esc($('#q').value)} ».</p>`;
}

/* ---------- Calcul ---------- */
const calcs = {};
function getCalc(r){
  if(!calcs[r.id]){
    const first = r.comps.flatMap((c,ci)=>c.ing.map((i,ii)=>({i,key:ci+':'+ii}))).find(x=>x.i.q&&x.i.u==='g'&&!x.i.inter);
    calcs[r.id]={mode:'base', fmt:Object.fromEntries((r.yield&&r.yield.formats||[]).map((f,i)=>[f.id,i===0?1:0])),
      units:r.yield&&r.yield.base||1, poids:Math.round(totalBase(r)), ing:first?first.key:'', ingVal:first?first.i.q:0, coef:1, over:{}, open:{}};
  }
  const c=calcs[r.id];
  if(c.ing){ const [ci,ii]=c.ing.split(':').map(Number); if(!r.comps[ci]||!r.comps[ci].ing[ii]) { delete calcs[r.id]; return getCalc(r); } }
  return c;
}
const needMass=(r,c)=>r.yield.formats.reduce((s,f)=>s+num(c.fmt[f.id])*f.mass/f.per,0);
function factor(r,c){
  switch(c.mode){
    case 'formats': return needMass(r,c)/r.yield.mousse.reduce((s,id)=>s+compBase(compById(r,id)||{ing:[]}),0);
    case 'units': return num(c.units)/r.yield.base;
    case 'poids': return num(c.poids)/totalBase(r);
    case 'ing': { if(!c.ing) return 1; const [ci,ii]=c.ing.split(':').map(Number); return num(c.ingVal)/r.comps[ci].ing[ii].q; }
    case 'coef': return num(c.coef);
    default: return 1;
  }
}
const compFactor=(r,c,comp,f)=> c.over[comp.id]!=null ? num(c.over[comp.id])/compBase(comp) : f;
function modesFor(r){
  const m=[['base','Fiche']];
  if(r.yield&&r.yield.type==='formats') m.push(['formats','Formats']);
  if(r.yield&&r.yield.type==='units') m.push(['units',r.yield.unit[0].toUpperCase()+r.yield.unit.slice(1)]);
  m.push(['poids','Poids voulu']);
  if(r.comps.some(c=>c.ing.some(i=>i.q&&i.u==='g'&&!i.inter))) m.push(['ing','Selon un ingrédient']);
  m.push(['coef','Coefficient']);
  return m;
}
function stepper(id,val,step){ return `<div class="stepper"><button type="button" data-step="${id}" data-d="-${step}" aria-label="Moins">−</button><input id="${id}" inputmode="decimal" value="${esc(val)}"><button type="button" data-step="${id}" data-d="${step}" aria-label="Plus">+</button></div>`; }
function inputsHTML(r,c){
  switch(c.mode){
    case 'base': return `<p class="hint">Quantités de la fiche d'origine${r.yield?' ('+esc(r.yield.type==='units'?r.yield.label:'une fournée')+')':''}. Choisissez un mode pour recalculer.</p>`;
    case 'formats': return r.yield.formats.map(f=>`<div class="field"><label for="f-${esc(f.id)}">${esc(f.label)}<small>${f.per>1?`${f.per} = ${fmt(f.mass)} g · ${fmt(f.mass/f.per)} g pièce`:`${fmt(f.mass)} g l'unité`}</small></label>${stepper('f-'+f.id,c.fmt[f.id],1)}</div>`).join('')
      + `<p class="hint">Les autres composants suivent le même coefficient. Utilisez « Ajuster » sur un composant pour le régler à part.</p>`;
    case 'units': return `<div class="field"><label for="in-units">Nombre de ${esc(r.yield.unit)}<small>Fiche d'origine : ${esc(r.yield.label)}</small></label>${stepper('in-units',c.units,1)}</div>`;
    case 'poids': return `<div class="field wide"><label for="in-poids">Poids total voulu (g)<small>Fiche d'origine : ${fmt(totalBase(r))} g</small></label><input id="in-poids" inputmode="decimal" value="${esc(c.poids)}"></div>`;
    case 'ing': {
      const opts = r.comps.flatMap((comp,ci)=>comp.ing.map((i,ii)=>i.q&&i.u==='g'&&!i.inter?`<option value="${ci}:${ii}" ${c.ing===ci+':'+ii?'selected':''}>${esc(i.n)} (${esc(comp.name)})</option>`:'')).join('');
      return `<div class="field"><label for="in-ingsel">Ingrédient</label><select id="in-ingsel">${opts}</select></div>
        <div class="field wide"><label for="in-ingval">Quantité disponible (g)<small id="ing-base"></small></label><input id="in-ingval" inputmode="decimal" value="${esc(c.ingVal)}"></div>`;
    }
    case 'coef': return `<div class="field wide"><label for="in-coef">Coefficient</label><input id="in-coef" inputmode="decimal" value="${esc(String(c.coef).replace('.',','))}"></div>
      <div class="quick">${[0.5,1.5,2,3].map(v=>`<button type="button" data-coef="${v}">×${String(v).replace('.',',')}</button>`).join('')}</div>`;
  }
}
function readoutWhat(r,c){
  switch(c.mode){
    case 'base': return r.yield&&r.yield.type==='units'?r.yield.label:'Fiche d’origine';
    case 'formats': return `${fmt(needMass(r,c))} g de ${r.yield.what} à produire`;
    case 'units': { const n=num(c.units); return `${fmt(n)} ${n>1?r.yield.unit:r.yield.one} au lieu de ${r.yield.base}`; }
    case 'poids': return `Recette calée sur ${fmt(num(c.poids))} g`;
    case 'ing': { const [ci,ii]=c.ing.split(':').map(Number); return `Calée sur ${fmt(num(c.ingVal))} g de ${r.comps[ci].ing[ii].n.toLowerCase()}`; }
    case 'coef': return 'Coefficient libre';
  }
}

/* ---------- Fiche ---------- */
let shown = null;
function renderSheet(r){
  const c = getCalc(r);
  const refs = r.refs.map(x=>x.id&&byId[x.id]?`<a class="chip" href="#${esc(x.id)}">${esc(x.label)} →</a>`:`<span class="chip off">${esc(x.label)} · fiche à ajouter</span>`).join('');
  const photos = r.photos.map((p,i)=>`<button type="button" data-img="${esc(p)}" aria-label="Agrandir la photo ${i+1}">${photoTag(p,fullName(r)+', photo '+(i+1))}</button>`).join('');
  const notes = r.notes.filter(n=>String(n).trim()).map(n=>`<li>${esc(n)}</li>`).join('');
  const comps = r.comps.map((comp,ci)=>`
    <section class="comp">
      <header>
        ${comp.group?`<p class="grp">${esc(comp.group)}</p>`:''}
        <h3>${esc(comp.name)}</h3>
        ${comp.note?`<p class="cnote">${esc(comp.note)}</p>`:''}
        <div class="ctot"><span>Total <b data-ct="${ci}"></b></span><span style="display:flex;gap:8px;align-items:center"><span class="ovr" data-ovr="${ci}" hidden>ajusté à part</span><button type="button" class="adj" data-adj="${ci}" aria-expanded="${!!c.open[comp.id]}">Ajuster</button></span></div>
        <div class="adjbox" data-box="${ci}" ${c.open[comp.id]?'':'hidden'}>
          <label for="ov-${ci}">Poids voulu pour ce composant (g) <input id="ov-${ci}" data-ov="${ci}" inputmode="decimal" value="${c.over[comp.id]!=null?esc(c.over[comp.id]):''}" placeholder="${fmt(compBase(comp))}"></label>
          <button type="button" data-unov="${ci}">Suivre la recette</button>
        </div>
      </header>
      <ul class="ing">${comp.ing.map((i,ii)=>{const k=r.id+'|'+comp.id+'|'+ii;return `
        <li><button type="button" class="row" data-k="${esc(k)}" aria-pressed="${checked.has(k)}">
          <span class="tick" aria-hidden="true"></span>
          <span class="n">${esc(i.n)}${i.inter?' <span class="inter">(préparée ci-dessus)</span>':''}${i.note?` <span class="inter">(${esc(i.note)})</span>`:''}</span><span class="lead"></span>
          <span class="q"><span data-q="${ci}:${ii}"></span><small>${i.q==null?'':esc(i.u)}</small></span>
        </button></li>`}).join('')}</ul>
    </section>`).join('');
  const jl = r.journal.length;
  $('#main').innerHTML = `<article class="sheet">
    <button type="button" class="back" id="back">← Toutes les recettes</button>
    <div class="head">
      <div><p class="eyebrow">${esc(r.cat)}</p><h1>${esc(fullName(r))}</h1><p class="yield">${r.yield?'Fiche pour '+esc(r.yield.type==='units'?r.yield.label:'une fournée · '+yieldLabel(r)):'Fiche de base'} · ${fmt(totalBase(r))} g au total</p></div>
      <div class="head-side">${editable?`<button type="button" class="btn" id="btn-edit">Modifier la fiche</button>`:''}${refs?`<div class="refs"><span class="l">Voir aussi</span>${refs}</div>`:''}</div>
    </div>
    ${photos?`<div class="photos">${photos}</div>`:''}
    <section class="prod" aria-label="Calcul de production">
      <h2>Production <small>Toutes les quantités se recalculent en direct</small></h2>
      <div class="modes" role="group" aria-label="Mode de calcul">${modesFor(r).map(([k,l])=>`<button type="button" data-mode="${k}" aria-pressed="${c.mode===k}">${esc(l)}</button>`).join('')}</div>
      <div class="inputs" id="inputs">${inputsHTML(r,c)}</div>
      <div class="readout" aria-live="polite"><span class="coef" id="coef"></span><p id="what"></p><p class="tot" id="tot"></p>
        ${editable?`<button type="button" class="btn prodbtn" id="prod-open">Enregistrer cette production</button>`:''}</div>
      ${editable?`<div class="prodform" id="prodform" hidden>
        <label class="lab" for="prod-date">Date et heure<input class="inp" id="prod-date" type="datetime-local"></label>
        <label class="lab" for="prod-note">Remarque <span>facultatif</span><input class="inp" id="prod-note" placeholder="ex. mousse un peu ferme"></label>
        <div class="prodform-actions"><button type="button" class="btn primary" id="prod-save">Enregistrer dans l’historique</button><button type="button" class="btn" id="prod-cancel">Annuler</button></div>
      </div>`:''}
    </section>
    ${notes?`<ul class="notes">${notes}</ul>`:''}
    <div class="comps">${comps}</div>
    <section class="journal">
      <div class="totals-head"><h2>Notes</h2><span class="jcount">${jl?jl+' note'+(jl>1?'s':''):''}</span></div>
      ${jl?`<ol class="jlist">${r.journal.map((j,ji)=>({j,ji})).sort((a,b)=>b.j.at-a.j.at).map(({j,ji})=>`
        <li><div class="jmeta"><time>${j.at?esc(new Date(j.at).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'})):''}</time>${editable?`<button type="button" class="linkbtn" data-note-del="${ji}">Supprimer</button>`:''}</div><p>${esc(j.t)}</p></li>`).join('')}</ol>`
        :`<p class="empty">${editable?'Aucune note. Notez un essai, un réglage de cuisson, un fournisseur…':'Aucune note sur cette fiche.'}</p>`}
      ${editable?`<div class="jadd"><label class="vh" for="note-in">Nouvelle note</label><textarea id="note-in" class="inp" placeholder="ex. 12/11 : gélatine réduite à 36 g, tenue parfaite"></textarea><button type="button" class="btn primary" id="note-add">Ajouter la note</button></div>`:''}
    </section>
    <section class="totals">
      <div class="totals-head"><h2>À sortir</h2><button type="button" class="linkbtn" id="uncheck">Effacer les coches de cette recette</button></div>
      <p>Ingrédients regroupés pour toute la production, préparations intermédiaires exclues.</p>
      <div class="tablewrap"><table><tbody id="tbody"></tbody></table></div>
    </section>
  </article>`;
  update(r);
}
function update(r){
  const c=getCalc(r), f=factor(r,c);
  let total=0; const agg=new Map();
  r.comps.forEach((comp,ci)=>{
    const cf=compFactor(r,c,comp,f);
    comp.ing.forEach((i,ii)=>{
      const q = i.q==null?null:i.q*cf;
      $(`[data-q="${ci}:${ii}"]`).textContent = q==null?'selon goût':fmt(q);
      if(q!=null && !i.inter){ const key=norm(i.n)+'|'+i.u; const a=agg.get(key)||{n:i.n,u:i.u,q:0}; a.q+=q; agg.set(key,a); }
    });
    const ct=compBase(comp)*cf; total+=ct;
    $(`[data-ct="${ci}"]`).textContent = fmt(ct)+' g';
    $(`[data-ovr="${ci}"]`).hidden = c.over[comp.id]==null;
  });
  $('#coef').textContent = fmtF(f);
  $('#what').textContent = readoutWhat(r,c);
  $('#tot').textContent = `Poids total ${fmt(total)} g`+(Object.keys(c.over).length?' · composants ajustés à part inclus':'');
  const ib=$('#ing-base'); if(ib&&c.ing){ const [ci,ii]=c.ing.split(':').map(Number); ib.textContent=`Fiche d'origine : ${fmt(r.comps[ci].ing[ii].q)} g`; }
  $('#tbody').innerHTML = [...agg.values()].sort((a,b)=>(a.u===b.u?b.q-a.q:a.u==='g'?-1:1)).map(a=>`<tr><td>${esc(a.n)}</td><td class="v">${fmt(a.q)} ${esc(a.u)}</td></tr>`).join('');
}

/* ---------- Formulaire ---------- */
const emptyIng = ()=>({n:'',q:'',u:'g',inter:false,note:''});
const emptyComp = ()=>({id:'c'+uid(),name:'',group:'',note:'',ing:[emptyIng()]});
function toDraft(r){
  const y=r&&r.yield;
  return {
    id:r?r.id:null, name:r?r.name:'', variant:r?r.variant:'', cat:r?r.cat:'Entremets',
    photos:r?[...r.photos]:[], refs:r?r.refs.map(x=>({...x})):[], notesText:r?r.notes.join('\n'):'', journal:r?r.journal.map(j=>({...j})):[],
    yield:{type:y?y.type:'none', base:y&&y.type==='units'?y.base:'', unit:y&&y.type==='units'?y.unit:'cadres', one:y&&y.type==='units'?y.one:'cadre', label:y&&y.type==='units'?y.label:'',
      what:y&&y.type==='formats'?y.what:'mousse', mousse:y&&y.type==='formats'?[...y.mousse]:[],
      formats:y&&y.type==='formats'?y.formats.map(f=>({...f})):[{id:'plaque',label:"Plaque d'individuels",per:1,mass:''},{id:'t1',label:'T1',per:8,mass:''},{id:'t2',label:'T2',per:4,mass:''}]},
    comps:r?r.comps.map(c=>({...c, ing:c.ing.map(i=>({...i, q:i.q==null?'':String(i.q).replace('.',',')}))})):[emptyComp()]
  };
}
function startEdit(r){
  editing = {draft:toDraft(r), isNew:!r, importInfo:null, newAssets:[], removedAssets:[], confirmDel:false, err:''};
  $('#app').classList.add('is-sheet');
  renderEditor(); window.scrollTo(0,0);
}
function renderEditor(){
  const e=editing, d=e.draft, y=d.yield;
  const cats=catsOrder();
  const compsHTML = d.comps.map((c,ci)=>`
    <div class="ed-comp">
      <div class="ed-comp-head"><b>${esc(c.name||'Composant '+(ci+1))}</b>
        <span class="tools"><button type="button" class="icon" data-ed="up-comp" data-ci="${ci}" aria-label="Monter" ${ci===0?'disabled':''}>↑</button><button type="button" class="icon" data-ed="down-comp" data-ci="${ci}" aria-label="Descendre" ${ci===d.comps.length-1?'disabled':''}>↓</button><button type="button" class="icon" data-ed="del-comp" data-ci="${ci}" aria-label="Supprimer le composant">✕</button></span></div>
      <div class="grid">
        <label class="lab">Nom du composant<input class="inp" data-b="comps.${ci}.name" value="${esc(c.name)}" placeholder="ex. Mousse chocolat noir"></label>
        <label class="lab">Groupe <span>facultatif</span><input class="inp" data-b="comps.${ci}.group" value="${esc(c.group)}" placeholder="ex. Mousse chocolat"></label>
        <label class="lab">Remarque <span>facultatif</span><input class="inp" data-b="comps.${ci}.note" value="${esc(c.note)}" placeholder="ex. Cuire à 109 °C"></label>
      </div>
      <div class="ing-ed">
        <div class="ing-row ing-headrow"><span>Ingrédient</span><span>Quantité</span><span>Unité</span><span></span><span></span></div>
        ${c.ing.map((i,ii)=>`<div class="ing-row">
          <input class="inp" data-b="comps.${ci}.ing.${ii}.n" value="${esc(i.n)}" placeholder="Ingrédient" aria-label="Ingrédient">
          <input class="inp num" data-b="comps.${ci}.ing.${ii}.q" value="${esc(i.q)}" inputmode="decimal" placeholder="—" aria-label="Quantité">
          <input class="inp" data-b="comps.${ci}.ing.${ii}.u" value="${esc(i.u)}" aria-label="Unité">
          <label class="tiny" title="Préparation faite dans la même recette, exclue de la liste à sortir"><input type="checkbox" data-b="comps.${ci}.ing.${ii}.inter" ${i.inter?'checked':''}>intermédiaire</label>
          <button type="button" class="icon" data-ed="del-ing" data-ci="${ci}" data-ii="${ii}" aria-label="Supprimer l'ingrédient">✕</button>
        </div>`).join('')}
        <div><button type="button" class="btn" data-ed="add-ing" data-ci="${ci}">+ Ingrédient</button></div>
      </div>
    </div>`).join('');
  const yieldHTML = y.type==='units' ? `
      <div class="grid">
        <label class="lab">Quantité de la fiche<input class="inp num" data-b="yield.base" value="${esc(y.base)}" inputmode="decimal" placeholder="5"></label>
        <label class="lab">Unité (pluriel)<input class="inp" data-b="yield.unit" value="${esc(y.unit)}" placeholder="cadres"></label>
        <label class="lab">Unité (singulier)<input class="inp" data-b="yield.one" value="${esc(y.one)}" placeholder="cadre"></label>
        <label class="lab">Libellé <span>facultatif</span><input class="inp" data-b="yield.label" value="${esc(y.label)}" placeholder="5 cadres hauts"></label>
      </div>`
    : y.type==='formats' ? `
      <p class="help">Indiquez combien de préparation il faut pour chaque format. Exemple : 8 T1 demandent 3 700 g de mousse.</p>
      <label class="lab" style="max-width:280px">Préparation calculée<input class="inp" data-b="yield.what" value="${esc(y.what)}" placeholder="mousse"></label>
      ${y.formats.map((f,fi)=>`<div class="fmt-row">
        <label class="lab">Format<input class="inp" data-b="yield.formats.${fi}.label" value="${esc(f.label)}" placeholder="T1"></label>
        <label class="lab">Pièces<input class="inp num" data-b="yield.formats.${fi}.per" value="${esc(f.per)}" inputmode="decimal"></label>
        <label class="lab">Poids (g)<input class="inp num" data-b="yield.formats.${fi}.mass" value="${esc(f.mass)}" inputmode="decimal"></label>
        <button type="button" class="icon" data-ed="del-fmt" data-fi="${fi}" aria-label="Supprimer le format">✕</button></div>`).join('')}
      <div><button type="button" class="btn" data-ed="add-fmt">+ Format</button></div>
      <p class="help">Composants qui forment cette préparation :</p>
      <div class="checks">${d.comps.map(c=>`<label><input type="checkbox" data-mousse="${esc(c.id)}" ${y.mousse.includes(c.id)?'checked':''}>${esc(c.name||'Sans nom')}</label>`).join('')}</div>`
    : `<p class="help">Sans rendement, la fiche se recalcule par poids total, par ingrédient ou par coefficient.</p>`;
  $('#main').innerHTML = `<form class="editor" id="ed" novalidate>
    <div><p class="eyebrow">${e.isNew?'Nouvelle recette':'Modifier la fiche'}</p><h1>${esc(d.name||'Sans nom')}</h1></div>
    ${e.importInfo?`<p class="banner"><b>Fiche importée de « ${esc(e.importInfo.file)} »</b>${esc(e.importInfo.msg)}</p>`:''}
    <fieldset class="sec"><legend>Fiche</legend>
      <div class="grid">
        <label class="lab">Nom<input class="inp" data-b="name" value="${esc(d.name)}" required placeholder="ex. Forêt noire"></label>
        <label class="lab">Variante <span>facultatif</span><input class="inp" data-b="variant" value="${esc(d.variant)}" placeholder="ex. cadres"></label>
        <label class="lab">Catégorie<input class="inp" data-b="cat" value="${esc(d.cat)}" list="cats"></label>
      </div>
      <datalist id="cats">${cats.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>
    </fieldset>
    <fieldset class="sec"><legend>Photos</legend>
      <p class="help">La première photo sert de vignette dans la liste. Utilisez les flèches pour changer l’ordre.</p>
      <div class="ed-photos">${d.photos.map((p,pi)=>`<div class="ed-photo">${photoTag(p,'')}<button type="button" class="ph-del" data-ed="del-photo" data-pi="${pi}" aria-label="Retirer la photo">✕</button>
          <span class="ph-move"><button type="button" data-ed="photo-left" data-pi="${pi}" aria-label="Avancer la photo" ${pi===0?'disabled':''}>‹</button><button type="button" data-ed="photo-right" data-pi="${pi}" aria-label="Reculer la photo" ${pi===d.photos.length-1?'disabled':''}>›</button></span></div>`).join('')}
        <label class="btn" for="photo-in">+ Ajouter des photos</label></div>
    </fieldset>
    <fieldset class="sec"><legend>Voir aussi</legend>
      <p class="help">Les fiches utilisées dans cette recette (biscuit, glaçage…). Elles apparaissent en liens en haut de la fiche.</p>
      <div class="checks refs-ed">${[...d.refs.filter(x=>!x.id||!byId[x.id]).map(x=>`<label><input type="checkbox" data-ref-orphan="${esc(x.label)}" checked>${esc(x.label)} <span class="inter">(fiche à ajouter)</span></label>`),
        ...[...RECIPES].filter(r=>r.id!==d.id).sort((a,b)=>fullName(a).localeCompare(fullName(b),'fr')).map(r=>`<label><input type="checkbox" data-ref="${esc(r.id)}" ${d.refs.some(x=>x.id===r.id)?'checked':''}>${esc(fullName(r))}</label>`)].join('')}</div>
    </fieldset>
    <fieldset class="sec"><legend>Rendement de la fiche</legend>
      <div class="radios" role="radiogroup">
        ${[['none','Aucun'],['units','Cadres, verrines, plaques…'],['formats','Formats (plaque, T1, T2…)']].map(([k,l])=>`<label><input type="radio" name="ytype" value="${k}" ${y.type===k?'checked':''}>${l}</label>`).join('')}
      </div>
      ${yieldHTML}
    </fieldset>
    <fieldset class="sec"><legend>Composants et ingrédients</legend>
      <p class="help">Quantités en grammes de la fiche d'origine. Laissez la quantité vide pour « selon goût » (vanille, colorant…).</p>
      ${compsHTML}
      <div><button type="button" class="btn" data-ed="add-comp">+ Composant</button></div>
    </fieldset>
    <fieldset class="sec"><legend>Remarques</legend>
      <label class="lab">Une remarque par ligne <span>cuisson, montage, conservation…</span><textarea class="inp" data-b="notesText">${esc(d.notesText)}</textarea></label>
    </fieldset>
    <div class="actions">
      <button type="submit" class="btn primary" id="save">Enregistrer</button>
      <button type="button" class="btn" data-ed="cancel">Annuler</button>
      ${e.err?`<p class="err" role="alert">${esc(e.err)}</p>`:''}
      <span class="sp"></span>
      ${!e.isNew ? (e.confirmDel ? `<span class="confirm">Supprimer définitivement cette fiche ? <button type="button" class="btn danger" data-ed="del-yes">Oui, supprimer</button><button type="button" class="btn" data-ed="del-no">Non</button></span>`
        : `<button type="button" class="btn danger" data-ed="del">Supprimer la recette</button>`) : ''}
    </div>
  </form>`;
}
function setPath(obj,path,val){ const k=path.split('.'); let o=obj; for(let i=0;i<k.length-1;i++) o=o[k[i]]; o[k[k.length-1]]=val; }
function draftToDoc(d){
  const comps = d.comps.map(c=>{
    const o={id:c.id, name:String(c.name).trim()||'Composant', ing:c.ing.filter(i=>String(i.n).trim()).map(i=>{
      const raw=String(i.q).trim(); const x={n:String(i.n).trim(), q:raw===''?null:num(raw), u:String(i.u||'').trim()||'g'};
      if(i.inter) x.inter=1; if(i.note) x.note=i.note; return x; })};
    if(String(c.group||'').trim()) o.group=String(c.group).trim();
    if(String(c.note||'').trim()) o.note=String(c.note).trim();
    return o;
  }).filter(c=>c.ing.length);
  const doc={name:String(d.name).trim(), cat:String(d.cat).trim()||'Autres', comps, photos:d.photos,
    notes:String(d.notesText).split('\n').map(s=>s.trim()).filter(Boolean), refs:d.refs, journal:d.journal||[]};
  if(String(d.variant||'').trim()) doc.variant=String(d.variant).trim();
  const y=d.yield;
  if(y.type==='units'){ const b=num(y.base); const unit=String(y.unit).trim()||'unités';
    doc.yield={type:'units',base:b,unit,one:String(y.one).trim()||unit.replace(/s$/,''),label:String(y.label).trim()||`${fmt(b)} ${unit}`}; }
  if(y.type==='formats'){
    const formats=y.formats.filter(f=>num(f.mass)>0).map((f,i)=>({id:f.id||('f'+i),label:String(f.label).trim()||'Format',per:num(f.per)||1,mass:num(f.mass)}));
    const ids=comps.map(c=>c.id); const m=y.mousse.filter(id=>ids.includes(id));
    doc.yield={type:'formats',what:String(y.what).trim()||'préparation',mousse:m.length?m:ids,formats};
  }
  return doc;
}
function validate(doc){
  if(!doc.name) return 'Donnez un nom à la recette.';
  if(!doc.comps.length) return 'Ajoutez au moins un ingrédient avec son nom.';
  if(doc.yield&&doc.yield.type==='units'&&!(doc.yield.base>0)) return 'Indiquez la quantité de la fiche (par exemple 5 cadres).';
  if(doc.yield&&doc.yield.type==='formats'&&!doc.yield.formats.length) return 'Indiquez le poids d’au moins un format.';
  return '';
}
async function removePhotos(keys){ const paths=keys.filter(k=>String(k).startsWith('sb:')).map(k=>k.slice(3)); if(paths.length){ try{ await SB.storage.from('photos').remove(paths); }catch(_){} } }
async function save(){
  const e=editing, doc=draftToDoc(e.draft), msg=validate(doc);
  if(msg){ e.err=msg; renderEditor(); return; }
  if(!needOnline()) return;
  const id = e.draft.id || (slug(doc.name)+'-'+uid());
  const btn=$('#save'); btn.disabled=true; btn.textContent='Enregistrement…';
  try{
    await saveRecipe(id, doc);
    await removePhotos(e.removedAssets);
    editing=null; toast('Fiche enregistrée');
    if(location.hash.slice(1)===id) route(); else location.hash=id;
  }catch(err){
    e.err = 'L’enregistrement a échoué'+(err&&err.message?' ('+err.message+')':'')+'. Vérifiez la connexion et réessayez.';
    renderEditor();
  }
}
async function cancelEdit(){ const e=editing; editing=null; await removePhotos(e.newAssets); route(); }
async function deleteRecipe(){
  if(!needOnline()) return;
  const e=editing, id=e.draft.id;
  const {error} = await SB.from('recettes').delete().eq('id',id);
  if(error){ e.err='La suppression a échoué. Réessayez.'; e.confirmDel=false; renderEditor(); return; }
  await removePhotos(e.draft.photos.concat(e.removedAssets));
  RECIPES=RECIPES.filter(r=>r.id!==id); delete byId[id];
  store.set('fiches.cache',{user:USER.id, at:Date.now(), rows:RECIPES.map(x=>({id:x.id,data:toStored(x)}))});
  editing=null; toast('Fiche supprimée'); shown=null; location.hash=''; route();
}
async function shrink(blob){
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, 1400/Math.max(bmp.width,bmp.height));
  const cv = document.createElement('canvas'); cv.width=Math.round(bmp.width*s); cv.height=Math.round(bmp.height*s);
  cv.getContext('2d').drawImage(bmp,0,0,cv.width,cv.height);
  return await new Promise(res=>cv.toBlob(res,'image/jpeg',0.82));
}
async function uploadPhoto(blob, raw){
  const body = raw ? blob : await shrink(blob);
  const path = `${USER.id}/${uuid()}.jpg`;
  const {error} = await SB.storage.from('photos').upload(path, body, {contentType:'image/jpeg', upsert:false});
  if(error) throw error;
  return 'sb:'+path;
}
$('#photo-in').addEventListener('change',async ev=>{
  if(!editing) return; const files=[...ev.target.files]; ev.target.value='';
  if(!needOnline()) return;
  toast(files.length>1?`Envoi de ${files.length} photos…`:'Envoi de la photo…');
  for(const f of files){
    try{ const key=await uploadPhoto(f); if(!editing) break; editing.newAssets.push(key); editing.draft.photos.push(key); }
    catch(err){ toast('Une photo n’a pas pu être envoyée.'); }
  }
  if(editing){ renderEditor(); resolveUrls(); }
});

/* ---------- Import Word ---------- */
const ING_RE = /^(\d+(?:[.,]\d+)?)\s*(kg|grammes?|gr|g|litres?|l|cl|ml|cuill[eè]res?|c\.?\s?à\s?s|pi[eè]ces?)?\.?\s+(?:de\s+|d['’]\s*|des\s+|du\s+)?(.*[A-Za-zÀ-ÿŒœ].*)$/i;
function parseIngredient(s){
  if(s.includes(':')) return null;
  const m = s.match(ING_RE); if(!m) return null;
  let q=num(m[1]), u=(m[2]||'').toLowerCase(), note='';
  let name=m[3].trim().replace(/\s+/g,' ');
  if(/^kg/.test(u)){ q*=1000; u='g'; }
  else if(/^(l|litre)/.test(u)){ note=fmt(q)+' L sur la fiche'; q*=1000; u='g'; }
  else if(u==='cl'){ q*=10; u='g'; }
  else if(u==='ml'||/^g/.test(u)) u='g';
  else if(/^cuill|^c\.?\s?à/.test(u)) u='cuil.';
  else if(/^pi/.test(u)) u='pièce';
  else u='g';
  name = name.charAt(0).toUpperCase()+name.slice(1);
  return {n:name,q,u,inter:false,note};
}
function docxLines(xml){
  xml = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g,'')
    .replace(/<wp:posOffset>[\s\S]*?<\/wp:posOffset>/g,'').replace(/<wp:align>[\s\S]*?<\/wp:align>/g,'')
    .replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g,'')
    .replace(/<w:tab\/>/g,'\t').replace(/<w:br[^>]*\/>/g,'\n').replace(/<w:cr\/>/g,'\n').replace(/<\/w:p>/g,'\n').replace(/<[^>]+>/g,'');
  const ta=document.createElement('textarea'); ta.innerHTML=xml;
  return ta.value.split('\n').map(l=>l.replace(/ /g,' ')).filter(l=>l.trim());
}
function setUnits(r,um){ const n=num(um[1]); let unit=um[2].toLowerCase(); if(!unit.endsWith('s')&&unit!=='entremets') unit+='s';
  r.yield.type='units'; r.yield.base=n; r.yield.unit=unit; r.yield.one=unit.replace(/s$/,''); r.yield.label=(um[1]+' '+um[2]+(um[3]||'')).replace(/\s+/g,' ').trim(); }
function addFormat(r,fm){
  const per=num(fm[1])||1; let label=fm[2].replace(/\s+/g,' ').trim(); let mass=num(fm[3]); if(/kg/i.test(fm[4]||'')) mass*=1000;
  r.yield.type='formats'; r.yield.formats.push({id:'f'+uid(),label:label.charAt(0).toUpperCase()+label.slice(1),per,mass});
}
function parseRecipe(lines, fileName){
  const r={id:null,name:'', variant:'', cat:'Entremets', photos:[], refs:[], notesText:'', journal:[], comps:[],
    yield:{type:'none',base:'',unit:'cadres',one:'cadre',label:'',what:'mousse',mousse:[],formats:[]}};
  const notes=[]; let cur=null, cols=[], inQty=false, group='';
  const unitRe=/(\d+)\s+(cadres?|verrines?|plaques?|pi[eè]ces?|bacs?|moules?|entremets)\b([^()]*)/i;
  const fmtRe=/^\s*(\d+)?\s*([^:]+?)\s*:\s*(\d+(?:[.,]\d+)?)\s*(kg|gr|g)?/i;
  const header = s=>{ const m=s.match(/^([^\d:][^:]*?)\s*:\s*(.*)$/); return m && !parseIngredient(s) ? {name:m[1].trim(), rest:m[2].trim()} : null; };
  const newComp=(h,indented)=>{ const c={id:'c'+uid(), name:h.name, group:indented?group:'', note:h.rest.replace(/^\(\s*|\s*\)$/g,''), ing:[]}; r.comps.push(c); return c; };
  lines.forEach(raw=>{
    const chunks = raw.split(/\t+/).map(s=>s.trim()).filter(Boolean);
    if(!chunks.length) return;
    if(!r.name){ r.name = chunks[0].replace(/\s*:\s*$/,'').replace(/^0+/,'').trim();
      const rest = chunks.slice(1).join(' '); const um = rest.match(unitRe); if(um) setUnits(r,um);
      const hm = chunks.slice(1).map(header).filter(Boolean); if(hm.length){ cur=newComp(hm[0]); cols=[cur]; }
      return; }
    const um = raw.match(unitRe);
    if(um && !r.comps.some(c=>c.ing.length) && r.yield.type==='none' && !parseIngredient(chunks[0])){ setUnits(r,um); if(!header(chunks[0])) return; }
    const heads = chunks.map(header);
    if(heads.length>1 && heads.every(Boolean)){ inQty=false; cols=heads.map(h=>newComp(h)); cur=cols[0]; return; }
    if(heads[0] && (chunks.length===1 || (!parseIngredient(chunks[0]) && heads.slice(1).every(h=>!h)))){
      const h=heads[0];
      if(/quantit/i.test(h.name)){ inQty=true; return; }
      if(inQty){ const fm=raw.match(fmtRe); if(fm){ addFormat(r,fm); return; } }
      inQty=false;
      const indented=/^\s/.test(raw);
      if(cur && !cur.ing.length && !cur.note && !indented){ group=cur.name; r.comps.pop(); cur=newComp(h,true); }
      else cur=newComp(h, indented && !!group);
      cols=[cur]; return;
    }
    if(inQty){ const fm=raw.match(fmtRe); if(fm){ addFormat(r,fm); return; } }
    let used=false;
    chunks.forEach((ch,ci)=>{
      const ing=parseIngredient(ch); if(!ing) return;
      let target = cols.length>1 ? cols[ci] : cur;
      if(!target){ target=cur=newComp({name:'Préparation',rest:''}); cols=[cur]; }
      target.ing.push(ing); used=true;
    });
    if(used) return;
    const text = chunks.join(' ');
    if(/^vanille$|^colorant|^sel$/i.test(text) && cur){ cur.ing.push({n:text.charAt(0).toUpperCase()+text.slice(1),q:'',u:'g',inter:false,note:''}); return; }
    if(cur && !cur.ing.length) cur.note = (cur.note?cur.note+' ':'')+text.replace(/^\(\s*|\s*\)$/g,'');
    else notes.push(text.replace(/^\(\s*|\s*\)$/g,''));
  });
  r.comps = r.comps.filter(c=>c.ing.length || c.note).map(c=>({...c, ing:c.ing.length?c.ing:[emptyIng()]}));
  r.comps.forEach(c=>c.ing.forEach(i=>{ i.q = i.q===''?'':String(i.q).replace('.',','); }));
  if(r.yield.type==='formats'){
    const m=r.comps.filter(c=>/mousse|sabayon|cr[eé]meux|bavarois/i.test(c.name)).map(c=>c.id);
    r.yield.mousse = m.length?m.slice(0,1):(r.comps[0]?[r.comps[0].id]:[]);
    const nm = r.comps.find(c=>c.id===r.yield.mousse[0]); if(nm) r.yield.what = /sabayon/i.test(nm.name)?'sabayon':/cr[eé]meux/i.test(nm.name)?'crémeux':'mousse';
  } else r.yield.formats=[{id:'plaque',label:"Plaque d'individuels",per:1,mass:''},{id:'t1',label:'T1',per:8,mass:''},{id:'t2',label:'T2',per:4,mass:''}];
  r.notesText = notes.join('\n');
  if(!r.name) r.name = fileName.replace(/\.docx$/i,'');
  if(!r.comps.length) r.comps=[emptyComp()];
  return r;
}
async function importDocx(file){
  if(typeof JSZip==='undefined'){ toast('Le lecteur de fichiers Word n’a pas pu se charger. Rouvrez l’appli.'); return; }
  if(editing){ toast('Enregistrez ou annulez la fiche en cours.'); return; }
  toast('Lecture de « '+file.name+' »…');
  let zip; try{ zip = await JSZip.loadAsync(file); }catch(_){ toast('Ce fichier n’est pas un document Word (.docx) lisible.'); return; }
  const docFile = zip.file('word/document.xml'); if(!docFile){ toast('Ce fichier n’est pas un document Word (.docx) lisible.'); return; }
  const xml = await docFile.async('string');
  const draft = parseRecipe(docxLines(xml), file.name);
  const newAssets=[];
  if(online()){
    const relsF = zip.file('word/_rels/document.xml.rels'); const rels = relsF? await relsF.async('string') : '';
    const map={}; rels.replace(/<Relationship\b[^>]*>/g,tag=>{ const id=(tag.match(/Id="([^"]+)"/)||[])[1], t=(tag.match(/Target="([^"]+)"/)||[])[1]; if(id&&t) map[id]=t; return tag; });
    const order=[]; xml.replace(/r:embed="([^"]+)"/g,(m,id)=>{ const t=map[id]; if(t && !order.includes(t)) order.push(t); return m; });
    const media = order.map(t=>'word/'+t.replace(/^\.?\//,'')).filter(p=>/\.(jpe?g|png|gif|webp)$/i.test(p));
    for(const p of media){ const f=zip.file(p); if(!f) continue;
      try{ const type=/png$/i.test(p)?'image/png':/gif$/i.test(p)?'image/gif':/webp$/i.test(p)?'image/webp':'image/jpeg';
        const key=await uploadPhoto(new Blob([await f.async('arraybuffer')],{type})); newAssets.push(key); draft.photos.push(key); }catch(_){}
    }
  }
  const pm = newAssets.length ? ` ${newAssets.length} photo${newAssets.length>1?'s':''} récupérée${newAssets.length>1?'s':''}.` : '';
  editing = {draft, isNew:true, importInfo:{file:file.name, msg:` Vérifiez le nom, les quantités et le rendement, puis enregistrez. Les tableaux de la fiche Word ne sont pas repris : l'appli recalcule tout.${pm}`}, newAssets, removedAssets:[], confirmDel:false, err:''};
  $('#app').classList.add('is-sheet'); renderEditor(); resolveUrls(); window.scrollTo(0,0);
}
$('#docx').addEventListener('change',ev=>{ const f=ev.target.files[0]; ev.target.value=''; if(f) importDocx(f); });
$('#btn-new').addEventListener('click',()=>{ if(editing){ toast('Enregistrez ou annulez la fiche en cours.'); return; } startEdit(null); });

/* ---------- Sauvegarde et restauration ---------- */
const toDataURL = blob=>new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(blob); });
async function exportBackup(){
  if(!RECIPES.length){ toast('Aucune recette à sauvegarder.'); return; }
  if(!needOnline()) return;
  const btn=$('#btn-backup'); btn.disabled=true; btn.textContent='Préparation…';
  try{
    const images={}; let missing=0;
    for(const r of RECIPES) for(const p of r.photos) if(p.startsWith('sb:') && !images[p]){
      const {data,error} = await SB.storage.from('photos').download(p.slice(3));
      if(error||!data){ missing++; continue; } images[p]=await toDataURL(data);
    }
    const out={format:'fiches-du-labo', version:1, date:new Date().toISOString(), images, recipes:RECIPES.map(r=>({id:r.id, ...toStored(r)}))};
    const blob=new Blob([JSON.stringify(out)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`sauvegarde-recettes-${out.date.slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },4000);
    toast(missing?`Sauvegarde créée. ${missing} photo(s) n’ont pas pu être incluses.`:'Sauvegarde créée avec toutes vos recettes et photos.');
  }catch(_){ toast('La sauvegarde a échoué. Réessayez.'); }
  finally{ btn.disabled=false; btn.textContent='Sauvegarder mes recettes'; }
}
async function importBackup(file){
  if(!needOnline()) return;
  let data; try{ data=JSON.parse(await file.text()); }catch(_){ toast('Ce fichier n’est pas une sauvegarde lisible.'); return; }
  if(!data || data.format!=='fiches-du-labo' || !Array.isArray(data.recipes)){ toast('Ce fichier n’est pas une sauvegarde de Coup de fouet.'); return; }
  const imgs=data.images||{}; const done={}; let n=0, fail=0;
  for(const rec of data.recipes){
    n++; toast(`Restauration ${n} / ${data.recipes.length}…`, 60000);
    const photos=[];
    for(const p of (rec.photos||[])){
      if(done[p]){ photos.push(done[p]); continue; }
      if(imgs[p]){ try{ const blob=await (await fetch(imgs[p])).blob(); const key=await uploadPhoto(blob,true); done[p]=key; photos.push(key); }catch(_){ } }
    }
    const {id, ...doc} = rec; doc.photos=photos;
    try{ await saveRecipe(id||slug(doc.name)+'-'+uid(), sanitizeForSave(doc)); }catch(_){ fail++; }
  }
  toast(fail?`Restauration terminée : ${n-fail} recettes, ${fail} en échec.`:`Restauration terminée : ${n} recettes.`, 6000);
  loadRecipes();
}
function sanitizeForSave(doc){ return toStored(sanitize('x',doc)); }
$('#btn-backup').addEventListener('click',exportBackup);
$('#restore-in').addEventListener('change',ev=>{ const f=ev.target.files[0]; ev.target.value=''; if(f) importBackup(f); });

/* ---------- Historique de production ---------- */
let view='sheet';
const pad2=n=>String(n).padStart(2,'0');
const dateInput=d=>`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const localInput=d=>`${dateInput(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtKg=g=>g>=1000?(Math.round(g/100)/10).toLocaleString('fr-FR',{maximumFractionDigits:1})+' kg':fmt(g)+' g';
let PENDING = store.get('fiches.pending',[]);
const HIST = {from:'', to:'', range:'month', rows:[], loading:false, err:'', confirmDel:null};
function setRange(k){
  const now=new Date(), y=now.getFullYear(), m=now.getMonth(); let a=now, b=now;
  if(k==='7') a=new Date(y,m,now.getDate()-6);
  else if(k==='month') a=new Date(y,m,1);
  else if(k==='lastmonth'){ a=new Date(y,m-1,1); b=new Date(y,m,0); }
  else if(k==='year') a=new Date(y,0,1);
  HIST.from=dateInput(a); HIST.to=dateInput(b); HIST.range=k;
}
setRange('month');
function qtyLabel(q){
  if(!q) return '';
  if(q.kind==='formats') return q.items.map(x=>`${fmt(x.n)} ${x.label}`).join(' + ')||'—';
  if(q.kind==='units') return `${fmt(q.n)} ${q.n>1?q.unit:q.one}`;
  return fmtF(q.f);
}
function prodSnapshot(r,c){
  const f=factor(r,c); const agg=new Map(); let total=0; const comps=[];
  r.comps.forEach(comp=>{ const cf=compFactor(r,c,comp,f); const ct=compBase(comp)*cf; total+=ct; comps.push({n:comp.name,g:Math.round(ct)});
    comp.ing.forEach(i=>{ if(i.q==null||i.inter) return; const k=norm(i.n)+'|'+i.u; const a=agg.get(k)||{n:i.n,u:i.u,q:0}; a.q+=i.q*cf; agg.set(k,a); }); });
  const y=r.yield; let qty;
  if(y&&y.type==='formats'&&c.mode==='formats') qty={kind:'formats',items:y.formats.map(fm=>({label:fm.label,n:num(c.fmt[fm.id])})).filter(x=>x.n>0)};
  else if(y&&y.type==='units') qty={kind:'units',unit:y.unit,one:y.one,n:Math.round(f*y.base*100)/100};
  else qty={kind:'coef',f:Math.round(f*1000)/1000};
  return {recipe:fullName(r), cat:r.cat, factor:Math.round(f*10000)/10000, total:Math.round(total), qty, comps,
    ing:[...agg.values()].map(a=>({n:a.n,u:a.u,q:Math.round(a.q*10)/10})),
    calc:JSON.parse(JSON.stringify({mode:c.mode,fmt:c.fmt,units:c.units,poids:c.poids,ing:c.ing,ingVal:c.ingVal,coef:c.coef,over:c.over}))};
}
async function recordProduction(r,c,btn){
  const when=$('#prod-date').value ? new Date($('#prod-date').value) : new Date();
  if(isNaN(when)){ toast('Date invalide.'); return; }
  const row={recipe_id:r.id, produced_at:when.toISOString(), data:{...prodSnapshot(r,c), note:$('#prod-note').value.trim()}};
  btn.disabled=true;
  const tmp=uuid(); let sent=false;
  if(online()){ const {error}=await SB.from('recettes').upsert(prodRow(row,tmp)); sent=!error; }
  if(!sent){ PENDING.push({...row, tmp}); store.set('fiches.pending',PENDING); }
  btn.disabled=false; $('#prodform').hidden=true; $('#prod-note').value='';
  HIST.loaded=false;
  toast(sent?`Production enregistrée : ${qtyLabel(row.data.qty)} de ${row.data.recipe}.`:'Hors connexion : production gardée sur l’appareil, elle sera envoyée au retour du réseau.',5000);
}
// Les productions sont rangées avec les recettes, sous un identifiant « prod:… » (aucune table à créer).
const prodRow=(row,tmp)=>({id:'prod:'+tmp, data:{...row.data, type:'production', recipe_id:row.recipe_id, produced_at:row.produced_at}, updated_at:new Date().toISOString()});
async function flushPending(){
  if(!PENDING.length||!SB||!USER||!online()) return;
  const left=[];
  for(const p of PENDING){ const {tmp,...row}=p; const {error}=await SB.from('recettes').upsert(prodRow(row,tmp)); if(error) left.push(p); }
  const sent=PENDING.length-left.length; PENDING=left; store.set('fiches.pending',PENDING);
  if(sent){ toast(`${sent} production${sent>1?'s':''} en attente envoyée${sent>1?'s':''}.`); HIST.loaded=false; if(view==='history') loadHistory(); }
}
async function loadHistory(){
  if(!SB||!USER) return;
  HIST.loading=true; HIST.err=''; renderHistory();
  const from=new Date(HIST.from+'T00:00:00'), to=new Date(HIST.to+'T23:59:59.999');
  if(isNaN(from)||isNaN(to)){ HIST.loading=false; HIST.err='Choisissez une date de début et une date de fin.'; renderHistory(); return; }
  const {data,error}=await SB.from('recettes').select('id,data').like('id','prod:%').gte('data->>produced_at',from.toISOString()).lte('data->>produced_at',to.toISOString()).limit(5000);
  HIST.loading=false;
  if(error){ HIST.err = online()?'L’historique ne peut pas être chargé. Vérifiez la connexion et réessayez.':'Hors connexion : l’historique s’affichera au retour du réseau.'; HIST.rows=[]; }
  else { HIST.rows=data.map(x=>({id:x.id, recipe_id:x.data.recipe_id, produced_at:x.data.produced_at, data:x.data})); HIST.loaded=true; }
  const pend=PENDING.filter(p=>{ const d=new Date(p.produced_at); return d>=from&&d<=to; }).map(p=>({id:'pending:'+p.tmp, recipe_id:p.recipe_id, produced_at:p.produced_at, data:p.data, pending:true}));
  HIST.rows=[...pend,...HIST.rows].sort((a,b)=>b.produced_at.localeCompare(a.produced_at));
  renderHistory();
}
function histSummary(rows){
  const byRec=new Map(), ing=new Map(); let total=0;
  for(const p of rows){
    const d=p.data||{}; total+=d.total||0;
    const e=byRec.get(p.recipe_id)||{id:p.recipe_id,name:d.recipe||p.recipe_id,count:0,g:0,fmt:new Map(),units:new Map(),coef:0};
    e.count++; e.g+=d.total||0; e.name=e.name||d.recipe;
    const q=d.qty||{};
    if(q.kind==='formats') q.items.forEach(x=>e.fmt.set(x.label,(e.fmt.get(x.label)||0)+x.n));
    else if(q.kind==='units'){ const k=q.unit+'|'+q.one; e.units.set(k,(e.units.get(k)||0)+q.n); }
    else e.coef+=q.f||0;
    byRec.set(p.recipe_id,e);
    (d.ing||[]).forEach(i=>{ const k=norm(i.n)+'|'+i.u; const a=ing.get(k)||{n:i.n,u:i.u,q:0}; a.q+=i.q; ing.set(k,a); });
  }
  const recs=[...byRec.values()].map(e=>({...e, label:[
      ...[...e.fmt].map(([l,n])=>`${fmt(n)} ${l}`),
      ...[...e.units].map(([k,n])=>{ const [u,o]=k.split('|'); return `${fmt(n)} ${n>1?u:o}`; }),
      ...(e.coef?[`${fmtF(e.coef)} (fiche)`]:[])].join(' + ')}))
    .sort((a,b)=>b.g-a.g);
  const ings=[...ing.values()].sort((a,b)=>a.u===b.u?b.q-a.q:a.u==='g'?-1:1);
  return {recs, ings, total};
}
function renderHistory(){
  const rows=HIST.rows, s=histSummary(rows);
  const fromTxt=new Date(HIST.from+'T12:00').toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'});
  const toTxt=new Date(HIST.to+'T12:00').toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'});
  const ranges=[['today','Aujourd’hui'],['7','7 derniers jours'],['month','Ce mois-ci'],['lastmonth','Mois dernier'],['year','Cette année']];
  const days=new Map();
  rows.forEach(p=>{ const d=new Date(p.produced_at); const k=dateInput(d); if(!days.has(k)) days.set(k,[]); days.get(k).push(p); });
  const journal=[...days].map(([k,list])=>`
    <div class="hday"><h3>${esc(new Date(k+'T12:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'}))}</h3>
      <ul class="hlist">${list.map(p=>{ const d=p.data||{}; const t=new Date(p.produced_at);
        return `<li class="hrow${p.pending?' pending':''}">
          <span class="htime">${pad2(t.getHours())}:${pad2(t.getMinutes())}</span>
          <span class="hmain"><b>${byId[p.recipe_id]?`<a href="#${esc(p.recipe_id)}">${esc(d.recipe||p.recipe_id)}</a>`:esc(d.recipe||p.recipe_id)}</b>
            <span class="hqty">${esc(qtyLabel(d.qty))} · ${fmtKg(d.total||0)}</span>
            ${d.note?`<span class="hnote">${esc(d.note)}</span>`:''}${p.pending?'<span class="hnote">En attente d’envoi (hors connexion)</span>':''}</span>
          <span class="hact">${byId[p.recipe_id]&&d.calc?`<button type="button" class="linkbtn" data-h="redo" data-id="${esc(p.id)}">Refaire</button>`:''}
            ${p.pending?'':(HIST.confirmDel===p.id?`<span class="confirm">Supprimer ? <button type="button" class="btn danger" data-h="del-yes" data-id="${esc(p.id)}">Oui</button><button type="button" class="btn" data-h="del-no">Non</button></span>`
              :`<button type="button" class="linkbtn" data-h="del" data-id="${esc(p.id)}">Supprimer</button>`)}</span>
        </li>`; }).join('')}</ul></div>`).join('');
  $('#main').innerHTML=`<article class="sheet hist">
    <button type="button" class="back" id="back">← Toutes les recettes</button>
    <div class="head"><div><p class="eyebrow">Suivi</p><h1>Historique de production</h1><p class="yield">Du ${esc(fromTxt)} au ${esc(toTxt)}</p></div></div>
    <section class="hfilter" aria-label="Période">
      <div class="quickr">${ranges.map(([k,l])=>`<button type="button" class="chip${HIST.range===k?' on':''}" data-h="range" data-v="${k}">${l}</button>`).join('')}</div>
      <div class="hdates"><label class="lab" for="h-from">Depuis le<input class="inp" type="date" id="h-from" value="${esc(HIST.from)}"></label>
        <label class="lab" for="h-to">Jusqu’au<input class="inp" type="date" id="h-to" value="${esc(HIST.to)}"></label></div>
    </section>
    ${HIST.err?`<p class="banner">${esc(HIST.err)}</p>`:''}
    ${HIST.loading&&!rows.length?`<p class="empty">Chargement de l’historique…</p>`:''}
    ${!HIST.loading&&!HIST.err&&!rows.length?`<p class="empty">Aucune production enregistrée sur cette période. Sur une fiche, calculez la quantité puis touchez « Enregistrer cette production ».</p>`:''}
    ${rows.length?`
    <div class="kpis">
      <div class="kpi"><span>Productions</span><b>${rows.length}</b></div>
      <div class="kpi"><span>Recettes différentes</span><b>${s.recs.length}</b></div>
      <div class="kpi"><span>Poids total produit</span><b>${fmtKg(s.total)}</b></div>
    </div>
    <section class="totals"><div class="totals-head"><h2>Par recette</h2><button type="button" class="btn" data-h="csv">Exporter pour Excel</button></div>
      <div class="tablewrap"><table class="htable"><thead><tr><th>Recette</th><th>Fois</th><th>Quantité produite</th><th class="v">Poids</th></tr></thead><tbody>
      ${s.recs.map(e=>`<tr><td>${byId[e.id]?`<a href="#${esc(e.id)}">${esc(e.name)}</a>`:esc(e.name)}</td><td class="v">${e.count}</td><td>${esc(e.label)}</td><td class="v">${fmtKg(e.g)}</td></tr>`).join('')}
      </tbody></table></div></section>
    <section class="totals"><div class="totals-head"><h2>Ingrédients utilisés</h2></div>
      <p>Total sur la période, préparations intermédiaires exclues. Pratique pour les commandes.</p>
      <div class="tablewrap"><table><tbody>${s.ings.map(a=>`<tr><td>${esc(a.n)}</td><td class="v">${a.u==='g'?fmtKg(a.q):fmt(a.q)+' '+esc(a.u)}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="totals"><div class="totals-head"><h2>Journal</h2></div>${journal}</section>`:''}
  </article>`;
}
async function historyClick(t){
  const h=t.dataset.h; if(!h) return;
  if(h==='range'){ setRange(t.dataset.v); loadHistory(); return; }
  if(h==='del'){ HIST.confirmDel=t.dataset.id; renderHistory(); return; }
  if(h==='del-no'){ HIST.confirmDel=null; renderHistory(); return; }
  if(h==='del-yes'){ if(!needOnline()) return; const id=t.dataset.id; if(!id.startsWith('prod:')) return; const {error}=await SB.from('recettes').delete().eq('id',id);
    HIST.confirmDel=null; if(error){ toast('La suppression a échoué. Réessayez.'); renderHistory(); return; }
    HIST.rows=HIST.rows.filter(p=>p.id!==id); toast('Production supprimée de l’historique.'); renderHistory(); return; }
  if(h==='redo'){ const p=HIST.rows.find(x=>x.id===t.dataset.id); if(!p||!byId[p.recipe_id]) return;
    const r=byId[p.recipe_id]; const base=getCalc(r); calcs[r.id]={...base, ...JSON.parse(JSON.stringify(p.data.calc)), open:{}};
    location.hash=r.id; return; }
  if(h==='csv'){ const s=histSummary(HIST.rows); const q=v=>'"'+String(v).replace(/"/g,'""')+'"'; const n=v=>String(Math.round(v*10)/10).replace('.',',');
    const lines=[`Historique de production du ${HIST.from} au ${HIST.to}`,'', 'Recette;Nombre de productions;Quantité produite;Poids (g)',
      ...s.recs.map(e=>[q(e.name),e.count,q(e.label),n(e.g)].join(';')),'','Ingrédient;Quantité;Unité',
      ...s.ings.map(a=>[q(a.n),n(a.q),a.u].join(';')),'','Date;Heure;Recette;Quantité;Poids (g);Remarque',
      ...HIST.rows.map(p=>{ const d=new Date(p.produced_at); return [dateInput(d),`${pad2(d.getHours())}:${pad2(d.getMinutes())}`,q(p.data.recipe),q(qtyLabel(p.data.qty)),n(p.data.total||0),q(p.data.note||'')].join(';'); })];
    const blob=new Blob(['﻿'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`production_${HIST.from}_${HIST.to}.csv`; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },4000); return; }
}

/* ---------- Navigation ---------- */
function route(){
  if(editing){ renderEditor(); return; }
  if(location.hash==='#historique' && editable){
    view='history'; shown=null; renderList(); $('#app').classList.add('is-sheet');
    document.querySelectorAll('#nav-hist').forEach(a=>a.setAttribute('aria-current','true'));
    renderHistory(); window.scrollTo(0,0); if(!HIST.loaded) loadHistory(); return;
  }
  view='sheet'; document.querySelectorAll('#nav-hist').forEach(a=>a.setAttribute('aria-current','false'));
  let r=byId[location.hash.slice(1)]||null;
  const desktop = matchMedia('(min-width: 900px)').matches;
  $('#app').classList.toggle('is-sheet', !!r);
  if(!r && desktop) r=[...RECIPES].sort((a,b)=>catsOrder().indexOf(a.cat)-catsOrder().indexOf(b.cat)||fullName(a).localeCompare(fullName(b),'fr'))[0]||null;
  const changed = !shown || !r || r.id!==shown.id;
  shown=r; renderList();
  if(r){ renderSheet(r); if(changed) window.scrollTo(0,0); }
  else $('#main').innerHTML = '';
}
function renderAll(){ if(editing){ renderList(); return; } route(); }
let lastHash = location.hash;
addEventListener('hashchange',()=>{
  if(editing){ history.replaceState(null,'',lastHash||'#'); toast('Enregistrez ou annulez la fiche en cours.'); return; }
  lastHash=location.hash; route();
});
$('#q').addEventListener('input',renderList);
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible' && USER && online() && !editing && Date.now()-lastLoad>30000) loadRecipes(); });
addEventListener('online',()=>{ if(USER){ toast('Connexion rétablie.'); loadRecipes(); flushPending(); } });
addEventListener('offline',()=>{ if(USER){ toast('Hors connexion : consultation uniquement.'); renderList(); } });

$('#main').addEventListener('click',e=>{
  const t=e.target.closest('button'); if(!t) return;
  if(editing){
    const ed=t.dataset.ed; if(!ed) return; const d=editing.draft; const ci=+t.dataset.ci, ii=+t.dataset.ii;
    switch(ed){
      case 'add-ing': d.comps[ci].ing.push(emptyIng()); break;
      case 'del-ing': d.comps[ci].ing.splice(ii,1); if(!d.comps[ci].ing.length) d.comps[ci].ing.push(emptyIng()); break;
      case 'add-comp': d.comps.push(emptyComp()); break;
      case 'del-comp': d.comps.splice(ci,1); if(!d.comps.length) d.comps.push(emptyComp()); break;
      case 'up-comp': if(ci>0) d.comps.splice(ci-1,0,d.comps.splice(ci,1)[0]); break;
      case 'down-comp': if(ci<d.comps.length-1) d.comps.splice(ci+1,0,d.comps.splice(ci,1)[0]); break;
      case 'add-fmt': d.yield.formats.push({id:'f'+uid(),label:'',per:1,mass:''}); break;
      case 'del-fmt': d.yield.formats.splice(+t.dataset.fi,1); break;
      case 'photo-left': { const i=+t.dataset.pi; if(i>0) d.photos.splice(i-1,0,d.photos.splice(i,1)[0]); break; }
      case 'photo-right': { const i=+t.dataset.pi; if(i<d.photos.length-1) d.photos.splice(i+1,0,d.photos.splice(i,1)[0]); break; }
      case 'del-photo': { const p=d.photos.splice(+t.dataset.pi,1)[0]; const k=editing.newAssets.indexOf(p); if(k>=0){ editing.newAssets.splice(k,1); removePhotos([p]); } else editing.removedAssets.push(p); break; }
      case 'cancel': cancelEdit(); return;
      case 'del': editing.confirmDel=true; break;
      case 'del-no': editing.confirmDel=false; break;
      case 'del-yes': deleteRecipe(); return;
    }
    renderEditor(); return;
  }
  if(view==='history'){ if(t.id==='back'){ location.hash=''; return; } historyClick(t); return; }
  const r=shown; if(!r) return; const c=getCalc(r);
  if(t.id==='back'){ location.hash=''; return; }
  if(t.id==='btn-edit'){ startEdit(r); return; }
  if(t.id==='prod-open'){ if(!isFinite(factor(r,c))||factor(r,c)<=0){ toast('Indiquez d’abord une quantité à produire.'); return; } $('#prodform').hidden=false; $('#prod-date').value=localInput(new Date()); $('#prod-note').focus(); return; }
  if(t.id==='prod-cancel'){ $('#prodform').hidden=true; return; }
  if(t.id==='prod-save'){ recordProduction(r,c,t); return; }
  if(t.id==='note-add'){ const ta=$('#note-in'); const txt=ta.value.trim(); if(!txt){ ta.focus(); return; } if(!needOnline()) return;
    t.disabled=true; const doc=toStored(r); doc.journal=[...r.journal,{t:txt,at:Date.now()}];
    saveRecipe(r.id,doc).then(nr=>{ toast('Note ajoutée'); shown=nr; renderSheet(nr); }).catch(()=>{ t.disabled=false; toast('La note n’a pas pu être enregistrée. Réessayez.'); }); return; }
  if(t.dataset.noteDel!=null){ if(!needOnline()) return; const doc=toStored(r); doc.journal=r.journal.filter((_,i)=>i!==+t.dataset.noteDel);
    saveRecipe(r.id,doc).then(nr=>{ toast('Note supprimée'); shown=nr; renderSheet(nr); }).catch(()=>toast('La suppression a échoué. Réessayez.')); return; }
  if(t.dataset.mode){ c.mode=t.dataset.mode; document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',b===t)); $('#inputs').innerHTML=inputsHTML(r,c); update(r); return; }
  if(t.dataset.step){ const inp=document.getElementById(t.dataset.step); inp.value=Math.max(0,num(inp.value)+num(t.dataset.d)); inp.dispatchEvent(new Event('input',{bubbles:true})); return; }
  if(t.dataset.coef){ c.coef=num(t.dataset.coef); $('#in-coef').value=String(c.coef).replace('.',','); update(r); return; }
  if(t.dataset.adj!=null){ const comp=r.comps[t.dataset.adj]; c.open[comp.id]=!c.open[comp.id]; $(`[data-box="${t.dataset.adj}"]`).hidden=!c.open[comp.id]; t.setAttribute('aria-expanded',!!c.open[comp.id]); if(c.open[comp.id]) document.getElementById('ov-'+t.dataset.adj).focus(); return; }
  if(t.dataset.unov!=null){ const comp=r.comps[t.dataset.unov]; delete c.over[comp.id]; document.getElementById('ov-'+t.dataset.unov).value=''; update(r); return; }
  if(t.dataset.k){ const k=t.dataset.k; checked.has(k)?checked.delete(k):checked.add(k); t.setAttribute('aria-pressed',checked.has(k)); saveChecked(); return; }
  if(t.id==='uncheck'){ [...checked].filter(k=>k.startsWith(r.id+'|')).forEach(k=>checked.delete(k)); saveChecked(); document.querySelectorAll('.row').forEach(b=>b.setAttribute('aria-pressed','false')); return; }
  if(t.dataset.img){ const u=photoSrc(t.dataset.img); if(!u) return; const lb=$('#lb'); lb.querySelector('img').src=u; lb.hidden=false; return; }
});
$('#main').addEventListener('input',e=>{
  const t=e.target;
  if(editing){
    if(t.dataset.b){ setPath(editing.draft, t.dataset.b, t.type==='checkbox'?t.checked:t.value);
      if(t.dataset.b==='name'){ const h=$('#ed h1'); if(h) h.textContent=t.value||'Sans nom'; } }
    if(t.dataset.ref){ const id=t.dataset.ref, refs=editing.draft.refs; const i=refs.findIndex(x=>x.id===id);
      if(t.checked&&i<0&&byId[id]) refs.push({label:fullName(byId[id]),id}); if(!t.checked&&i>=0) refs.splice(i,1); return; }
    if(t.dataset.refOrphan!=null && !t.checked){ editing.draft.refs=editing.draft.refs.filter(x=>!(x.label===t.dataset.refOrphan&&(!x.id||!byId[x.id]))); return; }
    if(t.dataset.mousse){ const m=editing.draft.yield.mousse; const i=m.indexOf(t.dataset.mousse); if(t.checked&&i<0) m.push(t.dataset.mousse); if(!t.checked&&i>=0) m.splice(i,1); }
    return;
  }
  const r=shown; if(!r) return; const c=getCalc(r);
  if(t.id.startsWith('f-')) c.fmt[t.id.slice(2)]=t.value;
  else if(t.id==='in-units') c.units=t.value;
  else if(t.id==='in-poids') c.poids=t.value;
  else if(t.id==='in-ingval') c.ingVal=t.value;
  else if(t.id==='in-coef') c.coef=t.value;
  else if(t.dataset.ov!=null){ const comp=r.comps[t.dataset.ov]; if(t.value.trim()==='') delete c.over[comp.id]; else c.over[comp.id]=t.value; }
  else return;
  update(r);
});
$('#main').addEventListener('change',e=>{
  const t=e.target;
  if(view==='history'){ if(t.id==='h-from'||t.id==='h-to'){ HIST[t.id==='h-from'?'from':'to']=t.value; HIST.range=''; loadHistory(); } return; }
  if(editing){
    if(t.name==='ytype'){ editing.draft.yield.type=t.value; renderEditor(); }
    else if(t.type==='checkbox' && t.dataset.b) setPath(editing.draft, t.dataset.b, t.checked);
    else if(t.dataset.b && t.dataset.b.endsWith('.name')) renderEditor();
    return;
  }
  const r=shown; if(!r||t.id!=='in-ingsel') return; const c=getCalc(r);
  c.ing=t.value; const [ci,ii]=c.ing.split(':').map(Number); c.ingVal=r.comps[ci].ing[ii].q; $('#in-ingval').value=c.ingVal; update(r);
});
$('#main').addEventListener('submit',e=>{ e.preventDefault(); if(editing) save(); });
$('#lb').addEventListener('click',()=>{$('#lb').hidden=true});
addEventListener('keydown',e=>{ if(e.key==='Escape') $('#lb').hidden=true; });

if('serviceWorker' in navigator && location.protocol==='https:'){
  // Une nouvelle version publiée prend la main : on recharge une fois pour l'afficher (sauf si une fiche est en cours de saisie).
  const hadController = !!navigator.serviceWorker.controller; let reloaded=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{ if(!hadController||reloaded) return; if(editing){ toast('Nouvelle version disponible : elle s’affichera à la prochaine ouverture.'); return; } reloaded=true; location.reload(); });
  navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>{
    document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') reg.update().catch(()=>{}); });
  }).catch(()=>{});
}
boot();
