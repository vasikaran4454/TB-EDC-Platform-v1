/* Backend adapter. Loaded AFTER the main script in index.html.
   Replaces browser-only storage/login with the server API (Express + SQLite). */
const api=async(m,u,b)=>{try{const r=await fetch(u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});
 const j=await r.json().catch(()=>({}));if(!r.ok)return{error:j.error||'Request failed ('+r.status+').',status:r.status};return j}
 catch(e){return{error:'Cannot reach the server. Is it running?'}}};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const KINDS=['subjects','forms','queries','audit'];
let _snap={},_syncQ=Promise.resolve(),_pending=0,_err=false;
function takeSnap(){_snap={};KINDS.forEach(k=>{_snap[k]={};state.data[k].forEach(r=>{_snap[k][r.id]=JSON.stringify(r)})})}
function syncSubjects(){state.data.forms.forEach(f=>{const s=state.data.subjects.find(x=>x.id===f.subjectId);if(!s)return;const v=f.fields||{};
 if(f.formName==='Demography')['dob','sex','ethnicity','race','initials'].forEach(k=>{if(v[k])s[k]=v[k]});
 if(f.formName==='Informed Consent'&&v.consentDate)s.consentDate=v.consentDate})}
async function loadData(){let r=await api('GET','/api/data');if(r.error)return false;
 if(!r.subjects.length){const s=await api('POST','/api/seed',{data:seedData()});if(s.error)return false;r=await api('GET','/api/data');if(r.error)return false}
 state.data=r;takeSnap();return true}
async function pushChanges(){const ch={};let n=0;
 KINDS.forEach(k=>{ch[k]=state.data[k].filter(r=>_snap[k][r.id]!==JSON.stringify(r));n+=ch[k].length});if(!n)return;
 const r=await api('POST','/api/batch',ch);if(r.error){_err=true;toast(r.error,'err')}}
async function refresh(force){const r=await api('GET','/api/data');
 if(r.error){if(r.status===401&&state.user){state.user=null;renderLogin();toast('Session expired. Please sign in again.','err')}return}
 const changed=JSON.stringify(r)!==JSON.stringify(state.data);state.data=r;takeSnap();
 if((changed||force)&&state.user&&!document.getElementById('modalOverlay').classList.contains('show')){renderView();updateNavBadges()}}
function saveData(){syncSubjects();_pending++;
 _syncQ=_syncQ.then(async()=>{try{await pushChanges()}finally{_pending--;if(_pending===0){const f=_err;_err=false;await refresh(f)}}}).catch(e=>console.error(e))}
async function resetData(){const r=await api('POST','/api/seed',{data:seedData(),force:true});if(r.error){toast(r.error,'err');return}await refresh(true);toast('Practice data reset to seed values.','ok')}
async function loadSession(){const r=await api('GET','/api/me');if(r.error)return false;state.user=r;return true}
function saveSession(){}
function enterApp(){document.getElementById('loginScreen').style.display='none';document.getElementById('app').classList.add('show');renderHeader();navTo('dashboard')}
async function login(username,password){const r=await api('POST','/api/login',{username,password});
 if(r.error){const e=document.getElementById('loginError');e.textContent=r.error;e.classList.add('show');return false}
 state.user=r;if(!await loadData()){toast('Could not load study data.','err');return false}
 enterApp();toast('Welcome, '+r.name.split(' ')[0]+'. You are signed in as '+r.title+'.','ok');return true}
document.getElementById('logoutBtn').addEventListener('click',()=>{api('POST','/api/logout')});

/* Fixed versions of sign / unlock (original unlock referenced an undefined variable, sign logged the wrong old value) */
function handleSign(){const formEl=document.getElementById('ecrfForm'),formId=formEl.dataset.formId,formName=formEl.dataset.formName;
 const f=state.data.forms.find(x=>x.id===formId);if(!f){toast('Save the form first.','warn');return}
 const openQ=state.data.queries.filter(q=>q.formId===formId&&q.status==='open').length;
 if(openQ>0){toast('Cannot sign: '+openQ+' open '+(openQ>1?'queries':'query')+' must be resolved first.','err');return}
 const fails=runEditChecks(formName,f.fields,{});if(fails.length){toast('Cannot sign: '+fails.length+' edit check failure(s). Fix the data first.','err');return}
 const prev=f.status;f.status='signed';
 state.data.audit.push({id:uid('a'),formId,subjectId:f.subjectId,formName,visitId:f.visitId,fieldKey:'__form__',fieldName:'Form signature',oldValue:prev,newValue:'signed',user:state.user.username,ts:nowTs(),reason:'Electronic signature applied by '+state.user.title});
 saveData();toast('Form signed and locked. Only a DM can unlock it.','ok');renderView()}
function handleUnlock(){const formId=document.getElementById('ecrfForm').dataset.formId;
 const f=state.data.forms.find(x=>x.id===formId);if(!f)return;
 f.status='complete';
 state.data.audit.push({id:uid('a'),formId,subjectId:f.subjectId,formName:f.formName,visitId:f.visitId,fieldKey:'__form__',fieldName:'Form signature',oldValue:'signed',newValue:'complete',user:state.user.username,ts:nowTs(),reason:'Signature revoked / form re-opened'});
 saveData();toast('Form unlocked. It can be edited again.','warn');renderView()}

/* Enrol a new subject (so real practice data can be entered) */
function addSubject(){const ini=(prompt('Subject initials (2-3 capital letters)','')||'').trim().toUpperCase();
 if(!ini)return;if(!/^[A-Z]{2,3}$/.test(ini)){toast('Initials must be 2-3 letters.','err');return}
 const site=(prompt('Site number (1 or 2)','1')||'').trim();if(site!=='1'&&site!=='2'){toast('Site must be 1 or 2.','err');return}
 let n=state.data.subjects.length+1;while(state.data.subjects.some(s=>s.id==='001-'+String(n).padStart(4,'0')))n++;
 const id='001-'+String(n).padStart(4,'0');
 state.data.subjects.push({id,screeningNum:'SCR-'+String(n).padStart(3,'0'),initials:ini,dob:'',sex:'',ethnicity:'',race:'',consentDate:'',status:'Screening',site:'TB Site 0'+site});
 saveData();toast('Subject '+id+' enrolled.','ok');renderView()}
const _viewSubjects=window.viewSubjects,_viewSubject=window.viewSubject,_bind=window.bindViewEvents;
window.viewSubjects=()=>_viewSubjects().replace('<div class="subject-grid">','<div style="margin-bottom:14px"><button class="btn btn-sign" data-add-subject>+ Enrol subject</button></div><div class="subject-grid">');
window.viewSubject=()=>_viewSubject().replace('null yrs','\u2014 yrs');
window.bindViewEvents=()=>{_bind();document.querySelectorAll('[data-add-subject]').forEach(b=>b.addEventListener('click',addSubject))};

/* Boot: resume an existing server session */
(async()=>{if(await loadSession()&&await loadData())enterApp()})();
