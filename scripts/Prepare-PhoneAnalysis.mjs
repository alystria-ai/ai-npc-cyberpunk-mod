// Stage a pinned local analyser without loading a TTS or acoustic model.
import {readFile,writeFile,mkdir,rename,readdir,stat} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validatePhoneAnalysisConfig,PHONE_ANALYSIS_ENGINE,PHONE_ANALYSIS_FORMAT,
  PHONE_ANALYSIS_FRONTEND} from '../bridge/phone-analysis-config.mjs';
import {absoluteRuntimeOverride} from '../bridge/runtime-paths.mjs';
const execute=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=Object.fromEntries(process.argv.slice(2).reduce((list,value,index,all)=>{
  if(index%2===0){if(!value.startsWith('--')||!all[index+1])throw Error('Expected named path arguments');list.push([value.slice(2),all[index+1]]);}return list;
},[]));
const required=name=>{const path=absoluteRuntimeOverride(args[name],name);if(!path)throw Error(`Missing --${name}`);return path;};
const python=required('python'),source=required('dependency-source'),destination=required('dependency-destination'),
  acoustic=required('acoustic-model'),phone=required('phone-model'),output=required('output'),worker=resolve(project,'bridge/phone-analysis-worker.py');
const metadata=await readFile(join(source,'pocketsphinx-5.0.4.dist-info/METADATA'),'utf8');
if(!/^Name: pocketsphinx$/m.test(metadata)||!/^Version: 5\.0\.4$/m.test(metadata))throw Error('Expected the pinned PocketSphinx distribution');
const native=(await readdir(join(source,'pocketsphinx'))).filter(name=>/^_pocketsphinx.*\.pyd$/i.test(name));
if(native.length!==1)throw Error('Expected one pinned Windows native extension');
const distributionFiles=[];
async function distributionFile(name){
  const location=join(source,'pocketsphinx-5.0.4.dist-info',name),info=await stat(location);
  if(info.isFile())distributionFiles.push(name);
  else if(info.isDirectory())for(const child of await readdir(location))await distributionFile(join(name,child));
}
for(const name of await readdir(join(source,'pocketsphinx-5.0.4.dist-info')))
  if(/^(METADATA|LICENSE[^/\\]*)$/i.test(name))await distributionFile(name);
const selected=['pocketsphinx/__init__.py','pocketsphinx/lm.py','pocketsphinx/segmenter.py',`pocketsphinx/${native[0]}`,
  ...distributionFiles.map(name=>`pocketsphinx-5.0.4.dist-info/${name}`)];
const files=[];
async function identity(kind,path){const bytes=await readFile(path);return{kind,path,sha256:hash(bytes),bytes:bytes.length};}
for(const name of selected){
  const target=resolve(destination,name),part=relative(destination,target);
  if(isAbsolute(part)||part==='..'||part.startsWith('..'+sep))throw Error('Dependency copy escaped destination');
  const bytes=await readFile(join(source,name)),existing=await readFile(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(existing&&hash(existing)!==hash(bytes))throw Error('Prepared dependency destination contains another revision');
  if(!existing){await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});}
  files.push(await identity('dependency',target));
}
// The wheel's Config wrapper calls find_spec('pocketsphinx.model') even when
// every decoder model path is explicit. Retain only an empty hashed namespace
// sentinel; do not copy its unrelated default weights.
const namespacePath=join(destination,'pocketsphinx/model/__init__.py');
const namespaceBytes=Buffer.from('# Explicit external acoustic assets only; no package default models.\n');
const existingNamespace=await readFile(namespacePath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(existingNamespace&&hash(existingNamespace)!==hash(namespaceBytes))throw Error('Phone-analysis model namespace belongs to another revision');
if(!existingNamespace){await mkdir(dirname(namespacePath),{recursive:true});await writeFile(namespacePath,namespaceBytes,{flag:'wx'});}
files.push(await identity('dependency',namespacePath));
files.push(await identity('python',python),await identity('worker',worker),await identity('phone-model',phone));
for(const name of (await readdir(acoustic)).sort()){
  const path=join(acoustic,name);if((await stat(path)).isFile())files.push(await identity('acoustic',path));
}
const {stdout}=await execute(python,['-B','-I','-c',
  'import importlib.metadata,json; print(json.dumps({name:importlib.metadata.version(name) for name in ("numpy","scipy")}))'],
  {windowsHide:true,timeout:10000,maxBuffer:2000});
const config={version:1,engine:PHONE_ANALYSIS_ENGINE,format:PHONE_ANALYSIS_FORMAT,
  runtime:{pythonExecutable:python,workerPath:worker,dependencyDirectory:destination,acousticModelDirectory:acoustic,phoneModelPath:phone},
  dependency:{name:'pocketsphinx',version:'5.0.4'},scientific:JSON.parse(stdout),files,frontend:PHONE_ANALYSIS_FRONTEND};
validatePhoneAnalysisConfig(config);await mkdir(dirname(output),{recursive:true});
const temporary=output+`.${process.pid}.tmp`;
await writeFile(temporary,JSON.stringify(config,null,2)+'\n',{flag:'wx'});await rename(temporary,output);
console.log(JSON.stringify({version:1,status:'prepared',modelExecution:false,output,dependencyFiles:files.filter(file=>file.kind==='dependency').length,
  nativeSha256:files.find(file=>/\.pyd$/i.test(file.path)).sha256,
  acousticBytes:files.filter(file=>['acoustic','phone-model'].includes(file.kind)).reduce((sum,file)=>sum+file.bytes,0)}));
