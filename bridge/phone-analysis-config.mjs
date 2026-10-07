import {readFile,lstat} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,dirname,isAbsolute,sep} from 'node:path';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';

export const PHONE_ANALYSIS_ENGINE='pocketsphinx-5.0.4-allphone-live';
export const PHONE_ANALYSIS_FORMAT='pocketsphinx-allphone-live-v1';
export const PHONE_ANALYSIS_FRONTEND=Object.freeze({inputSampleRate:24000,analysisSampleRate:16000,
  frameRate:100,cmn:'live',dither:false,removeNoise:false,resampler:'causal-fir61-up2-down3',
  resamplerDelaySeconds:.000625,confirmationPackets:2,stableTailSeconds:.04});
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const inside=(root,path)=>{const part=relative(root,path);return part===''||(!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+sep));};
const real=p=>{try{return realpathSync.native(p);}catch{return resolve(p);}};
const same=(a,b)=>process.platform==='win32'?real(a).toLowerCase()===real(b).toLowerCase():real(a)===real(b);
const path=value=>absoluteRuntimeOverride(value,'Phone-analysis asset');

export function validatePhoneAnalysisConfig(config){
  if(!object(config)||config.version!==1||config.engine!==PHONE_ANALYSIS_ENGINE||config.format!==PHONE_ANALYSIS_FORMAT)
    throw Error('Expected an explicit resident phone-analysis configuration');
  if(!object(config.runtime)||!object(config.dependency)||config.dependency.name!=='pocketsphinx'
      ||config.dependency.version!=='5.0.4'||!Array.isArray(config.files)||config.files.length<8||config.files.length>64)
    throw Error('Phone analysis requires its pinned native dependency and asset manifest');
  const runtime={};
  for(const name of ['pythonExecutable','workerPath','dependencyDirectory','acousticModelDirectory','phoneModelPath']){
    runtime[name]=path(config.runtime[name]);if(!runtime[name])throw Error('Phone analysis paths cannot fall back to development or PATH');
  }
  if(!object(config.scientific)||!['numpy','scipy'].every(name=>typeof config.scientific[name]==='string'
      &&/^\d+\.\d+\.\d+(?:[a-z0-9.+-]*)?$/i.test(config.scientific[name])))throw Error('Phone analysis requires pinned scientific dependency versions');
  const files=config.files.map(file=>{
    if(!object(file)||!['python','worker','dependency','acoustic','phone-model'].includes(file.kind)
        ||!sha(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>1_000_000_000)
      throw Error('Invalid phone-analysis asset identity');
    const absolute=path(file.path);if(!absolute)throw Error('Missing phone-analysis asset path');
    const expected=file.kind==='python'?runtime.pythonExecutable:file.kind==='worker'?runtime.workerPath:
      file.kind==='phone-model'?runtime.phoneModelPath:null;
    if(expected?!same(absolute,expected):!inside(file.kind==='dependency'?runtime.dependencyDirectory:runtime.acousticModelDirectory,absolute))
      throw Error('Phone-analysis manifest escaped its explicit asset roots');
    return Object.freeze({...file,path:absolute});
  });
  if(new Set(files.map(file=>process.platform==='win32'?file.path.toLowerCase():file.path)).size!==files.length
      ||['python','worker','phone-model'].some(kind=>files.filter(file=>file.kind===kind).length!==1)
      ||!files.some(file=>file.kind==='dependency'&&/[/\\]_pocketsphinx[^/\\]+\.pyd$/i.test(file.path))
      ||files.filter(file=>file.kind==='acoustic').length<5)
    throw Error('Phone-analysis manifest is incomplete or duplicated');
  return Object.freeze({version:1,engine:PHONE_ANALYSIS_ENGINE,format:PHONE_ANALYSIS_FORMAT,
    runtime:Object.freeze(runtime),dependency:Object.freeze({name:'pocketsphinx',version:'5.0.4'}),
    scientific:Object.freeze({...config.scientific}),files:Object.freeze(files),frontend:PHONE_ANALYSIS_FRONTEND});
}

async function unlinkedFile(file){
  for(let current=file;;current=dirname(current)){
    const info=await lstat(current);
    if(info.isSymbolicLink())throw Error('Linked phone-analysis assets are unsupported');
    if(current===file&&!info.isFile())throw Error('Phone-analysis asset is not a regular file');
    if(current===dirname(current))break;
  }
}
export async function verifyPhoneAnalysisAssets(config){
  const validated=validatePhoneAnalysisConfig(config);
  for(const file of validated.files){
    await unlinkedFile(file.path);const bytes=await readFile(file.path);
    if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)
      throw Error('Phone-analysis asset differs from its prepared identity');
  }
  return validated;
}
