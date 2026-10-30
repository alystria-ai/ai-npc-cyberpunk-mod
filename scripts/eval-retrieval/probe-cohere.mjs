// One tiny call per Cohere endpoint on the trial key: which models answer, with what dimensions, round trip, and the limit headers.
import {cohereCall} from './lib.mjs';
const out = [];
async function probe(label, path, body) {
  try {
    const {json, ms, headers} = await cohereCall(path, body, {retries: 0});
    out.push({label, ok: true, ms: Math.round(ms), headers, shape: path === '/v2/embed' ? {dims: json.embeddings?.float?.[0]?.length, meta: json.meta?.billed_units} : path === '/v2/rerank' ? {meta: json.meta?.billed_units, top: json.results?.[0]} : {meta: json.usage}});
  } catch (error) { out.push({label, ok: false, status: error.status, error: String(error.message).slice(0, 200)}); }
}
await probe('embed-v5.0-pro', '/v2/embed', {model: 'embed-v5.0-pro', input_type: 'search_query', texts: ['where did we park the car'], embedding_types: ['float']});
await probe('embed-v5.0-fast', '/v2/embed', {model: 'embed-v5.0-fast', input_type: 'search_query', texts: ['where did we park the car'], embedding_types: ['float']});
await probe('rerank-v5.0-pro', '/v2/rerank', {model: 'rerank-v5.0-pro', query: 'where did we park the car', documents: ['we left the Thorton at the Afterlife', 'V likes black coffee']});
await probe('rerank-v5.0-fast', '/v2/rerank', {model: 'rerank-v5.0-fast', query: 'where did we park the car', documents: ['we left the Thorton at the Afterlife', 'V likes black coffee']});
console.log(JSON.stringify(out, null, 1));
